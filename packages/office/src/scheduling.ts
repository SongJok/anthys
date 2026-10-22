import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const instant=z.string().max(35).pipe(z.iso.datetime({offset:true})).transform(value=>new Date(value).toISOString());
const userId=z.uuid();
const eventId=z.string().trim().min(1).max(256);
export const busyIntervalSchema=z.strictObject({attendee:userId,start:instant,end:instant}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start),'CALENDAR_INTERVAL_INVALID');
export type BusyInterval=z.infer<typeof busyIntervalSchema>;
export const meetingRequestSchema=z.strictObject({title:z.string().trim().min(1).max(256),attendees:z.array(userId).min(1).max(100),durationMinutes:z.number().int().min(15).max(480),windowStart:instant,windowEnd:instant}).strict().superRefine((value,ctx)=>{
 if(new Set(value.attendees).size!==value.attendees.length)ctx.addIssue({code:'custom',message:'CALENDAR_ATTENDEES_NOT_UNIQUE'});
 const span=Date.parse(value.windowEnd)-Date.parse(value.windowStart);if(span<=0||span>7*86400000)ctx.addIssue({code:'custom',message:'CALENDAR_WINDOW_INVALID'});
});
export type MeetingRequest=z.infer<typeof meetingRequestSchema>;
export const rescheduleRequestSchema=z.strictObject({eventId,start:instant,end:instant});
export type RescheduleRequest=z.infer<typeof rescheduleRequestSchema>;
export const calendarEventSchema=z.strictObject({eventId,title:z.string().trim().min(1).max(256),start:instant,end:instant,attendees:z.array(userId).min(1).max(100)}).refine(value=>new Set(value.attendees).size===value.attendees.length,'CALENDAR_EVENT_INVALID');
export type CalendarEvent=z.infer<typeof calendarEventSchema>;
export interface CalendarConnector{
 queryBusy(input:{attendees:string[];start:string;end:string},signal:AbortSignal):Promise<{busy:BusyInterval[];asOf:string;sourceHash:string}>;
 create(input:{title:string;start:string;end:string;attendees:string[];requestHash:string},signal:AbortSignal):Promise<{eventId:string}>;
 update(input:{eventId:string;title:string;start:string;end:string;attendees:string[];requestHash:string},signal:AbortSignal):Promise<{eventId:string}>;
 read(input:{eventId:string},signal:AbortSignal):Promise<{eventId:string;title:string;start:string;end:string;attendees:string[]}>;
}
export type CalendarResult=
 |{status:'PROPOSED';proposalId:string;start:string;end:string;attendees:string[];asOf:string;sourceHash:string;requestHash:string}
 |{status:'PROPOSED_RESCHEDULE';proposalId:string;eventId:string;start:string;end:string;attendees:string[];asOf:string;sourceHash:string;requestHash:string}
 |{status:'VERIFIED';eventId:string;start:string;end:string;attendees:string[]}
 |{status:'RESCHEDULED';eventId:string;start:string;end:string;attendees:string[]}
 |{status:'CONFLICT';code:'CALENDAR_SLOT_BUSY'|'CALENDAR_SLOT_NO_LONGER_FREE';busy:BusyInterval[];asOf:string}
 |{status:'BLOCKED_EXTERNAL';code:'CALENDAR_CONNECTOR_UNAVAILABLE'|'CALENDAR_SOURCE_UNAVAILABLE'}
 |{status:'NO_SLOT';code:'CALENDAR_NO_FREE_SLOT'}
 |{status:'INVALID_PROPOSAL';code:'CALENDAR_PROPOSAL_UNKNOWN'|'CALENDAR_PROPOSAL_EXPIRED'|'CALENDAR_PROPOSAL_STALE'|'CALENDAR_REQUEST_INVALID'}
 |{status:'VERIFICATION_FAILED';code:'CALENDAR_READBACK_MISMATCH'|'CALENDAR_READBACK_UNAVAILABLE';eventId:string;effect:'UNKNOWN'}
 |{status:'UNKNOWN';code:'CALENDAR_CREATE_OUTCOME_UNKNOWN'|'CALENDAR_UPDATE_OUTCOME_UNKNOWN';effect:'UNKNOWN'};
const digest=(request:MeetingRequest,start:string,end:string)=>createHash('sha256').update(JSON.stringify([request.title,start,end,request.attendees])).digest('hex');
const rescheduleDigest=(input:{eventId:string;title:string;start:string;end:string;attendees:string[]})=>createHash('sha256').update('anthys.calendar.reschedule.v1\0'+JSON.stringify([input.eventId,input.title,input.start,input.end,input.attendees])).digest('hex');
const overlaps=(startMs:number,endMs:number,interval:BusyInterval)=>Date.parse(interval.start)<endMs&&Date.parse(interval.end)>startMs;
const sameSet=(a:string[],b:string[])=>a.length===b.length&&[...a].sort().every((value,index)=>value===[...b].sort()[index]);
const selfSlot=(interval:BusyInterval,start:string,end:string)=>interval.start===start&&interval.end===end;
type Proposal=
 |{action:'CREATE';request:MeetingRequest;start:string;end:string;requestHash:string;expiresAt:number;claimed:boolean}
 |{action:'RESCHEDULE';eventId:string;title:string;attendees:string[];previousStart:string;previousEnd:string;start:string;end:string;requestHash:string;expiresAt:number;claimed:boolean};
/** Proposes only from current busy/free data, rechecks the event and slot
 * immediately before the real write and verifies the result. No connector
 * means no fake slot; a changed event or slot is never silently overwritten. */
export class CalendarScheduler{
 private readonly proposals=new Map<string,Proposal>();
 constructor(private readonly options:{connector:CalendarConnector|null;now?:()=>number;proposalTtlMs?:number}){}
 async propose(raw:unknown,signal:AbortSignal):Promise<CalendarResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_CONNECTOR_UNAVAILABLE'};
  const parsed=meetingRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal))return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  const request=parsed.data,now=(this.options.now??Date.now)(),windowStart=Date.parse(request.windowStart),windowEnd=Date.parse(request.windowEnd),duration=request.durationMinutes*60000;
  let busy:BusyInterval[];let asOf:string;let sourceHash:string;
  try{const result=await this.options.connector.queryBusy({attendees:request.attendees,start:request.windowStart,end:request.windowEnd},signal);busy=z.array(busyIntervalSchema).parse(result.busy);asOf=instant.parse(result.asOf);sourceHash=z.string().regex(/^[a-f0-9]{64}$/).parse(result.sourceHash);}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  if(signal.aborted)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  let start=windowStart;
  for(const interval of [...busy].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))){if(overlaps(start,start+duration,interval))start=Math.max(start,Date.parse(interval.end));}
  if(start+duration>windowEnd)return {status:'NO_SLOT',code:'CALENDAR_NO_FREE_SLOT'};
  const startIso=new Date(start).toISOString(),endIso=new Date(start+duration).toISOString(),requestHash=digest(request,startIso,endIso),proposalId=randomUUID(),expiresAt=now+(this.options.proposalTtlMs??300000);
  this.proposals.set(proposalId,{action:'CREATE',request,start:startIso,end:endIso,requestHash,expiresAt,claimed:false});
  if(this.proposals.size>1024)this.proposals.delete(this.proposals.keys().next().value!);
  return {status:'PROPOSED',proposalId,start:startIso,end:endIso,attendees:request.attendees,asOf,sourceHash,requestHash};
 }
 async proposeReschedule(raw:unknown,signal:AbortSignal):Promise<CalendarResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_CONNECTOR_UNAVAILABLE'};
  const parsed=rescheduleRequestSchema.safeParse(raw);
  if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  const span=Date.parse(parsed.data.end)-Date.parse(parsed.data.start);
  if(span<=0||span>8*3600000)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  let current:CalendarEvent;
  try{current=calendarEventSchema.parse(await this.options.connector.read({eventId:parsed.data.eventId},signal));}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  if(signal.aborted)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  let busy:BusyInterval[];let asOf:string;let sourceHash:string;
  try{const result=await this.options.connector.queryBusy({attendees:current.attendees,start:parsed.data.start,end:parsed.data.end},signal);busy=z.array(busyIntervalSchema).parse(result.busy);asOf=instant.parse(result.asOf);sourceHash=z.string().regex(/^[a-f0-9]{64}$/).parse(result.sourceHash);}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  if(signal.aborted)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  const startMs=Date.parse(parsed.data.start),endMs=Date.parse(parsed.data.end),conflicts=busy.filter(interval=>overlaps(startMs,endMs,interval)&&!selfSlot(interval,current.start,current.end));
  if(conflicts.length)return {status:'CONFLICT',code:'CALENDAR_SLOT_BUSY',busy:conflicts,asOf};
  const requestHash=rescheduleDigest({eventId:current.eventId,title:current.title,start:parsed.data.start,end:parsed.data.end,attendees:current.attendees}),proposalId=randomUUID(),expiresAt=(this.options.now??Date.now)()+(this.options.proposalTtlMs??300000);
  this.proposals.set(proposalId,{action:'RESCHEDULE',eventId:current.eventId,title:current.title,attendees:current.attendees,previousStart:current.start,previousEnd:current.end,start:parsed.data.start,end:parsed.data.end,requestHash,expiresAt,claimed:false});
  if(this.proposals.size>1024)this.proposals.delete(this.proposals.keys().next().value!);
  return {status:'PROPOSED_RESCHEDULE',proposalId,eventId:current.eventId,start:parsed.data.start,end:parsed.data.end,attendees:current.attendees,asOf,sourceHash,requestHash};
 }
 async confirm(proposalId:string,signal:AbortSignal):Promise<CalendarResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_CONNECTOR_UNAVAILABLE'};
  const proposal=this.proposals.get(proposalId);if(!proposal||proposal.claimed)return {status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_UNKNOWN'};
  if(proposal.expiresAt<=(this.options.now??Date.now)())return {status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_EXPIRED'};
  if(!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'};
  proposal.claimed=true;
  return proposal.action==='CREATE'?this.confirmCreate(proposal,signal):this.confirmReschedule(proposal,signal);
 }
 private async confirmCreate(proposal:Extract<Proposal,{action:'CREATE'}>,signal:AbortSignal):Promise<CalendarResult>{
  let busy:BusyInterval[];let asOf:string;
  try{const result=await this.options.connector!.queryBusy({attendees:proposal.request.attendees,start:proposal.start,end:proposal.end},signal);busy=z.array(busyIntervalSchema).parse(result.busy);asOf=instant.parse(result.asOf);}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  if(busy.some(interval=>overlaps(Date.parse(proposal.start),Date.parse(proposal.end),interval)))return {status:'CONFLICT',code:'CALENDAR_SLOT_NO_LONGER_FREE',busy,asOf};
  let eventId:string;
  try{({eventId}=await this.options.connector!.create({title:proposal.request.title,start:proposal.start,end:proposal.end,attendees:proposal.request.attendees,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'CALENDAR_CREATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
  let raw:unknown;
  try{raw=await this.options.connector!.read({eventId},signal);}catch{return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_UNAVAILABLE',eventId,effect:'UNKNOWN'};}
  const checked=calendarEventSchema.safeParse(raw);
  if(!checked.success)return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',eventId,effect:'UNKNOWN'};
  const observed=checked.data;
  if(observed.eventId!==eventId||observed.title!==proposal.request.title||observed.start!==proposal.start||observed.end!==proposal.end||!sameSet(observed.attendees,proposal.request.attendees))return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',eventId,effect:'UNKNOWN'};
  return {status:'VERIFIED',eventId,start:proposal.start,end:proposal.end,attendees:proposal.request.attendees};
 }
 private async confirmReschedule(proposal:Extract<Proposal,{action:'RESCHEDULE'}>,signal:AbortSignal):Promise<CalendarResult>{
  let current:CalendarEvent;
  try{current=calendarEventSchema.parse(await this.options.connector!.read({eventId:proposal.eventId},signal));}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  if(current.eventId!==proposal.eventId||current.title!==proposal.title||current.start!==proposal.previousStart||current.end!==proposal.previousEnd||!sameSet(current.attendees,proposal.attendees))return {status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_STALE'};
  let busy:BusyInterval[];let asOf:string;
  try{const result=await this.options.connector!.queryBusy({attendees:proposal.attendees,start:proposal.start,end:proposal.end},signal);busy=z.array(busyIntervalSchema).parse(result.busy);asOf=instant.parse(result.asOf);}catch{return {status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'};}
  const startMs=Date.parse(proposal.start),endMs=Date.parse(proposal.end),conflicts=busy.filter(interval=>overlaps(startMs,endMs,interval)&&!selfSlot(interval,proposal.previousStart,proposal.previousEnd));
  if(conflicts.length)return {status:'CONFLICT',code:'CALENDAR_SLOT_NO_LONGER_FREE',busy:conflicts,asOf};
  let eventId:string;
  try{({eventId}=await this.options.connector!.update({eventId:proposal.eventId,title:proposal.title,start:proposal.start,end:proposal.end,attendees:proposal.attendees,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'CALENDAR_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
  if(eventId!==proposal.eventId)return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',eventId,effect:'UNKNOWN'};
  let observed:CalendarEvent;
  try{observed=calendarEventSchema.parse(await this.options.connector!.read({eventId},signal));}catch{return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_UNAVAILABLE',eventId,effect:'UNKNOWN'};}
  if(observed.eventId!==eventId||observed.title!==proposal.title||observed.start!==proposal.start||observed.end!==proposal.end||!sameSet(observed.attendees,proposal.attendees))return {status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',eventId,effect:'UNKNOWN'};
  return {status:'RESCHEDULED',eventId,start:proposal.start,end:proposal.end,attendees:proposal.attendees};
 }
}
