import {randomUUID} from 'node:crypto';
import {CalendarScheduler,type BusyInterval,type CalendarConnector} from '../../packages/office/src/scheduling.js';

const now=Date.parse('2026-10-21T00:00:00.000Z'),attendees=[randomUUID()],sourceHash='a'.repeat(64);
const request={title:'Synthetic review',attendees,durationMinutes:30,windowStart:'2026-10-21T10:00:00.000Z',windowEnd:'2026-10-21T12:00:00.000Z'};
const busy=(start:string,end:string):BusyInterval=>({attendee:attendees[0]!,start,end});
class SyntheticCalendar implements CalendarConnector{
 busy:BusyInterval[]=[];created:Parameters<CalendarConnector['create']>[0][]=[];updated:Parameters<CalendarConnector['update']>[0][]=[];
 failUpdate=false;failRead=false;failReadOn=-1;readCalls=0;mutateReadOn=-1;
 mutateRead:((event:{eventId:string;title:string;start:string;end:string;attendees:string[]})=>typeof event)|undefined;
 private readonly events=new Map<string,{eventId:string;title:string;start:string;end:string;attendees:string[]}>();
 async queryBusy(input:{attendees:string[];start:string;end:string}){const start=Date.parse(input.start),end=Date.parse(input.end);return {busy:this.busy.filter(i=>Date.parse(i.start)<end&&Date.parse(i.end)>start),asOf:new Date(now).toISOString(),sourceHash};}
 async create(input:Parameters<CalendarConnector['create']>[0]){this.created.push(input);const eventId=randomUUID();this.events.set(eventId,{eventId,title:input.title,start:input.start,end:input.end,attendees:[...input.attendees]});return {eventId};}
 async update(input:Parameters<CalendarConnector['update']>[0]){this.updated.push(input);if(this.failUpdate)throw Error('SYNTHETIC_UPDATE_FAILED');const event=this.events.get(input.eventId)!;this.events.set(input.eventId,{...event,title:input.title,start:input.start,end:input.end,attendees:[...input.attendees]});return {eventId:input.eventId};}
 async read({eventId}:{eventId:string}){this.readCalls++;if(this.failRead||this.readCalls===this.failReadOn)throw Error('SYNTHETIC_READ_FAILED');const event=this.events.get(eventId)!;return this.mutateRead&&(this.mutateReadOn<0||this.readCalls===this.mutateReadOn)?this.mutateRead({...event}):event;}
}
const targetStart='2026-10-22T10:00:00.000Z',targetEnd='2026-10-22T10:30:00.000Z';
const reschedule=(eventId:string)=>({eventId,start:targetStart,end:targetEnd});
async function createEvent(scheduler:CalendarScheduler){
 const proposal=await scheduler.propose(request,new AbortController().signal);if(proposal.status!=='PROPOSED')throw Error(proposal.status);
 const result=await scheduler.confirm(proposal.proposalId,new AbortController().signal);if(result.status!=='VERIFIED')throw Error(result.status);
 return result.eventId;
}

it('T113 proposes the earliest free slot from current busy/free data',async()=>{
 const calendar=new SyntheticCalendar();calendar.busy=[busy('2026-10-21T10:00:00.000Z','2026-10-21T10:30:00.000Z'),busy('2026-10-21T11:00:00.000Z','2026-10-21T11:30:00.000Z')];
 const scheduler=new CalendarScheduler({connector:calendar,now:()=>now});
 expect(await scheduler.propose(request,new AbortController().signal)).toMatchObject({status:'PROPOSED',start:'2026-10-21T10:30:00.000Z',end:'2026-10-21T11:00:00.000Z',attendees,sourceHash});
});

it('re-queries before creating and reports a slot that became busy without submitting anything',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now});
 const proposal=await scheduler.propose(request,new AbortController().signal);if(proposal.status!=='PROPOSED')throw Error(proposal.status);
 calendar.busy=[busy(proposal.start,proposal.end)];
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'CALENDAR_SLOT_NO_LONGER_FREE',asOf:'2026-10-21T00:00:00.000Z'});
 expect(calendar.created).toEqual([]);
});

it('verifies the created event title, time and exact participant set and consumes the proposal once',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now});
 const proposal=await scheduler.propose(request,new AbortController().signal);if(proposal.status!=='PROPOSED')throw Error(proposal.status);
 const verified=await scheduler.confirm(proposal.proposalId,new AbortController().signal);
 expect(verified).toMatchObject({status:'VERIFIED',start:proposal.start,end:proposal.end,attendees});
 expect(calendar.created).toHaveLength(1);expect(calendar.created[0]).toMatchObject({requestHash:proposal.requestHash,attendees});
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_UNKNOWN'});
});

it('does not report success when read-back differs and marks the create effect unknown',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now});
 const proposal=await scheduler.propose(request,new AbortController().signal);if(proposal.status!=='PROPOSED')throw Error(proposal.status);
 calendar.mutateRead=event=>({...event,attendees:[...event.attendees,randomUUID()]});
 const result=await scheduler.confirm(proposal.proposalId,new AbortController().signal);
 expect(result).toMatchObject({status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',effect:'UNKNOWN'});
 if(result.status==='VERIFICATION_FAILED')expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
});

it('blocks without a configured connector and rejects an expired proposal',async()=>{
 expect(await new CalendarScheduler({connector:null}).propose(request,new AbortController().signal)).toMatchObject({status:'BLOCKED_EXTERNAL',code:'CALENDAR_CONNECTOR_UNAVAILABLE'});
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now,proposalTtlMs:0});
 const proposal=await scheduler.propose(request,new AbortController().signal);if(proposal.status!=='PROPOSED')throw Error(proposal.status);
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_EXPIRED'});
 expect(calendar.created).toEqual([]);
});

it('T113 reschedules only after rechecking the current event and target, then verifies the read-back once',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now});
 const eventId=await createEvent(scheduler),proposal=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);
 if(proposal.status!=='PROPOSED_RESCHEDULE')throw Error(proposal.status);
 expect(proposal).toMatchObject({eventId,start:targetStart,end:targetEnd,attendees});
 expect(calendar.updated).toHaveLength(0);
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'RESCHEDULED',eventId,start:targetStart,end:targetEnd,attendees});
 expect(calendar.updated).toHaveLength(1);expect(calendar.updated[0]).toMatchObject({eventId,title:request.title,start:targetStart,end:targetEnd,requestHash:proposal.requestHash});
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_UNKNOWN'});
 expect(calendar.updated).toHaveLength(1);
});

it('refuses a busy or unknown reschedule target without updating anything',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now}),eventId=await createEvent(scheduler);
 calendar.busy=[busy(targetStart,targetEnd)];
 expect(await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'CALENDAR_SLOT_BUSY',asOf:'2026-10-21T00:00:00.000Z'});
 expect(await scheduler.proposeReschedule(reschedule('missing-event'),new AbortController().signal)).toMatchObject({status:'BLOCKED_EXTERNAL',code:'CALENDAR_SOURCE_UNAVAILABLE'});
 expect(await scheduler.proposeReschedule({eventId,start:targetEnd,end:targetStart},new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'});
 const aborted=new AbortController();aborted.abort();
 expect(await scheduler.proposeReschedule(reschedule(eventId),aborted.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_REQUEST_INVALID'});
 expect(calendar.updated).toEqual([]);
});

it('refuses a reschedule when the event changed after the proposal or the target became busy',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now}),eventId=await createEvent(scheduler);
 const stale=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);if(stale.status!=='PROPOSED_RESCHEDULE')throw Error(stale.status);
 calendar.mutateRead=event=>({...event,title:'Changed elsewhere'});
 expect(await scheduler.confirm(stale.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'CALENDAR_PROPOSAL_STALE'});
 calendar.mutateRead=undefined;
 const proposal=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);if(proposal.status!=='PROPOSED_RESCHEDULE')throw Error(proposal.status);
 calendar.busy=[busy(targetStart,targetEnd)];
 expect(await scheduler.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'CALENDAR_SLOT_NO_LONGER_FREE'});
 expect(calendar.updated).toEqual([]);
});

it('marks an unknown reschedule update or failed read-back without claiming success',async()=>{
 const calendar=new SyntheticCalendar(),scheduler=new CalendarScheduler({connector:calendar,now:()=>now}),eventId=await createEvent(scheduler);
 calendar.failUpdate=true;
 const failed=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);if(failed.status!=='PROPOSED_RESCHEDULE')throw Error(failed.status);
 expect(await scheduler.confirm(failed.proposalId,new AbortController().signal)).toMatchObject({status:'UNKNOWN',code:'CALENDAR_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 calendar.failUpdate=false;calendar.readCalls=0;
 const unavailable=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);if(unavailable.status!=='PROPOSED_RESCHEDULE')throw Error(unavailable.status);
 calendar.failReadOn=3;
 expect(await scheduler.confirm(unavailable.proposalId,new AbortController().signal)).toMatchObject({status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_UNAVAILABLE',effect:'UNKNOWN'});
 calendar.failReadOn=-1;calendar.readCalls=0;calendar.mutateReadOn=3;calendar.mutateRead=event=>({...event,end:'2026-10-22T11:00:00.000Z'});
 const mismatched=await scheduler.proposeReschedule(reschedule(eventId),new AbortController().signal);if(mismatched.status!=='PROPOSED_RESCHEDULE')throw Error(mismatched.status);
 expect(await scheduler.confirm(mismatched.proposalId,new AbortController().signal)).toMatchObject({status:'VERIFICATION_FAILED',code:'CALENDAR_READBACK_MISMATCH',effect:'UNKNOWN'});
});
