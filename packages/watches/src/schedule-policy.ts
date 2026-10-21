import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import {evaluateWatchPredicate,watchObservationSchema,watchPredicateSchema} from './predicate.js';

const maxBytes=16384,maxNodes=128,maxSeconds=Math.floor(Number.MAX_SAFE_INTEGER/1000);
/** Bounded JSON records only: reject Proxy before reflection and never call accessors/toJSON. */
function snapshot(raw:unknown):unknown{
 let nodes=0;
 const copy=(value:unknown,depth:number):unknown=>{
  if(++nodes>maxNodes||depth>5)throw Error('INVALID_DATA');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){if(Buffer.byteLength(value,'utf8')>4096)throw Error('INVALID_DATA');return value;}
  if(typeof value==='number'&&Number.isSafeInteger(value))return Object.is(value,-0)?0:value;
  if(typeof value!=='object'||value===null||types.isProxy(value)||Array.isArray(value))throw Error('INVALID_DATA');
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw Error('INVALID_DATA');
  const keys=Reflect.ownKeys(value);if(keys.length>24)throw Error('INVALID_DATA');
  const result=Object.create(null) as Record<string,unknown>;
  for(const key of keys){
   if(typeof key!=='string'||key.length>64)throw Error('INVALID_DATA');
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error('INVALID_DATA');
   result[key]=copy(descriptor.value,depth+1);
  }
  return result;
 };
 const result=copy(raw,0);if(Buffer.byteLength(JSON.stringify(result),'utf8')>maxBytes)throw Error('INVALID_DATA');return result;
}
const data=(code:string)=>z.unknown().transform((raw,ctx)=>{try{return snapshot(raw);}catch{ctx.addIssue({code:'custom',message:code});return z.NEVER;}});
const utc=z.string().max(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).refine(value=>{
 const stamp=Date.parse(value);return !value.startsWith('0000')&&Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,19)===value.slice(0,19);
},'INVALID_UTC_DATE').transform(value=>new Date(value).toISOString());
const hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().safe();
const seconds=z.number().int().nonnegative().max(maxSeconds);
const hhmm=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const zone=z.string().max(128).refine(value=>{
 if(value!=='UTC'&&!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(value))return false;
 try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
},'INVALID_IANA_TIMEZONE');
const policyShape=z.object({
 schemaVersion:z.literal(1),predicate:watchPredicateSchema,tz:zone,validFrom:utc,expiresAt:utc,
 intervalSeconds:seconds.min(300),cooldownSeconds:seconds,
 maxChecks:count.min(1),maxNotifications:count.min(1),
 quietWindow:z.object({start:hhmm,end:hhmm}).strict().refine(value=>value.start!==value.end,'AMBIGUOUS_EQUAL_QUIET_BOUNDARIES').nullable(),
 misfire:z.literal('MONITOR_CURRENT'),notificationRule:z.literal('VALUE_CHANGE_ONLY'),
}).strict().refine(value=>Date.parse(value.expiresAt)>Date.parse(value.validFrom),'INVALID_VALIDITY_WINDOW');
export const watchSchedulePolicySchema=data('WATCH_SCHEDULE_POLICY_INVALID').pipe(policyShape).transform(value=>Object.freeze({...value,quietWindow:value.quietWindow?Object.freeze(value.quietWindow):null}));
export type WatchSchedulePolicy=z.infer<typeof watchSchedulePolicySchema>;
const stateShape=z.object({
 schemaVersion:z.literal(1),lifecycle:z.enum(['ACTIVE','PAUSED','CANCELLED']),
 checksStarted:count,notificationsReserved:count,lastCheckStartedAt:utc.nullable(),lastNotificationAt:utc.nullable(),
 lastNotificationValueHash:hash.nullable(),notificationState:z.enum(['IDLE','PENDING','UNKNOWN']),
}).strict().superRefine((value,ctx)=>{
 const checkPresent=value.lastCheckStartedAt!==null,notificationPresent=value.lastNotificationAt!==null&&value.lastNotificationValueHash!==null;
 if((value.checksStarted>0)!==checkPresent||(value.notificationsReserved>0)!==notificationPresent||
  (value.notificationsReserved===0&&(value.lastNotificationAt!==null||value.lastNotificationValueHash!==null))||
  value.notificationsReserved>value.checksStarted||(value.notificationState!=='IDLE'&&value.notificationsReserved===0)||
  (value.lastNotificationAt!==null&&value.lastCheckStartedAt!==null&&Date.parse(value.lastNotificationAt)<Date.parse(value.lastCheckStartedAt)&&value.notificationsReserved===value.checksStarted))ctx.addIssue({code:'custom',message:'INCONSISTENT_STATE'});
});
export const watchScheduleStateSchema=data('WATCH_SCHEDULE_STATE_INVALID').pipe(stateShape).transform(value=>Object.freeze(value));
export type WatchScheduleState=z.infer<typeof watchScheduleStateSchema>;
const inputShape=z.discriminatedUnion('phase',[
 z.object({phase:z.literal('CHECK'),now:utc}).strict(),
 z.object({phase:z.literal('NOTIFY'),now:utc,observation:watchObservationSchema}).strict(),
]);
export type WatchScheduleInput=z.input<typeof inputShape>;
export type WatchScheduleReason='CANCELLED'|'PAUSED'|'EXPIRED'|'NOT_STARTED'|'CHECK_LIMIT_REACHED'|'NOTIFICATION_LIMIT_REACHED'|'NOTIFICATION_PENDING'|'NOTIFICATION_UNKNOWN'|'INTERVAL_WAIT'|'CHECK_CURRENT'|'QUIET_WINDOW'|'COOLDOWN_WAIT'|'NO_RECORDED_CHECK'|'OBSERVATION_FROM_FUTURE'|'OBSERVATION_BEFORE_CHECK'|'PREDICATE_UNKNOWN'|'PREDICATE_NO_MATCH'|'VALUE_ALREADY_RESERVED'|'NOTIFY_CURRENT_CHANGE';
export type WatchScheduleDecision=Readonly<{
 state:'ELIGIBLE'|'DEFER'|'SUPPRESS'|'STOP';reason:WatchScheduleReason;phase:'CHECK'|'NOTIFY';asOf:string;
 policyHash:string;stateHash:string;predicateHash:string;sourceHash:string|null;valueHash:string|null;
 retryAt:string|null;localTime:string;tz:string;
}>;
const digest=(domain:string,value:unknown)=>createHash('sha256').update(domain+'\0'+JSON.stringify(value)).digest('hex');
function clock(tz:string){return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}
function local(format:Intl.DateTimeFormat,stamp:number){
 const parts=Object.fromEntries(format.formatToParts(stamp).map(part=>[part.type,part.value]));
 return `${parts.year!.padStart(4,'0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function quiet(window:WatchSchedulePolicy['quietWindow'],wall:string){
 if(!window)return false;const time=wall.slice(11,16);
 return window.start<window.end?time>=window.start&&time<window.end:time>=window.start||time<window.end;
}
/** Pure eligibility advice, never a reservation/authorization/send. Host must persist counters,
 * value dedup and UNKNOWN, serialize/CAS, and re-evaluate immediately before calls/sends.
 * UTC interval checks never backfill. Quiet windows only gate NOTIFY; DST overlap instants
 * are both quiet when their projected wall minute is quiet, and gaps invent no instants. */
export function evaluateWatchSchedulePolicy(rawPolicy:unknown,rawState:unknown,rawInput:unknown):WatchScheduleDecision{
 const p=watchSchedulePolicySchema.safeParse(rawPolicy);if(!p.success)throw Error('WATCH_SCHEDULE_POLICY_INVALID');
 const s=watchScheduleStateSchema.safeParse(rawState);if(!s.success)throw Error('WATCH_SCHEDULE_STATE_INVALID');
 const i=data('WATCH_SCHEDULE_INPUT_INVALID').pipe(inputShape).safeParse(rawInput);if(!i.success)throw Error('WATCH_SCHEDULE_INPUT_INVALID');
 const policy=p.data,state=s.data,input=i.data,now=Date.parse(input.now),expiry=Date.parse(policy.expiresAt),start=Date.parse(policy.validFrom);
 const checkedAt=state.lastCheckStartedAt===null?null:Date.parse(state.lastCheckStartedAt),notifiedAt=state.lastNotificationAt===null?null:Date.parse(state.lastNotificationAt);
 if((checkedAt!==null&&checkedAt>now)||(notifiedAt!==null&&notifiedAt>now)||state.checksStarted>policy.maxChecks||state.notificationsReserved>policy.maxNotifications)throw Error('WATCH_SCHEDULE_STATE_INVALID');
 const format=clock(policy.tz),wall=local(format,now),comparison=input.phase==='NOTIFY'?evaluateWatchPredicate(policy.predicate,input.observation):null;
 const summary={phase:input.phase,asOf:input.now,policyHash:digest('open_aider.watch.schedule-policy.v1',policy),stateHash:digest('open_aider.watch.schedule-state.v1',state),predicateHash:digest('open_aider.watch.predicate.v1',policy.predicate),sourceHash:comparison?.sourceHash??null,valueHash:comparison?.valueHash??null,localTime:wall,tz:policy.tz};
 const result=(decision:WatchScheduleDecision['state'],reason:WatchScheduleReason,retry:number|null=null):WatchScheduleDecision=>Object.freeze({state:decision,reason,...summary,retryAt:retry!==null&&retry<expiry?new Date(retry).toISOString():null});
 if(state.lifecycle==='CANCELLED')return result('STOP','CANCELLED');
 if(now>=expiry)return result('STOP','EXPIRED');
 if(state.lifecycle==='PAUSED')return result('DEFER','PAUSED');
 if(now<start)return result('DEFER','NOT_STARTED',start);
 if(state.notificationsReserved>=policy.maxNotifications)return result('STOP','NOTIFICATION_LIMIT_REACHED');
 if(state.notificationState==='UNKNOWN')return result('DEFER','NOTIFICATION_UNKNOWN');
 if(state.notificationState==='PENDING')return result('DEFER','NOTIFICATION_PENDING');
 if(input.phase==='CHECK'){
  if(state.checksStarted>=policy.maxChecks)return result('STOP','CHECK_LIMIT_REACHED');
  if(checkedAt!==null&&now-checkedAt<policy.intervalSeconds*1000)return result('DEFER','INTERVAL_WAIT',checkedAt+policy.intervalSeconds*1000);
  return result('ELIGIBLE','CHECK_CURRENT');
 }
 if(checkedAt===null)return result('SUPPRESS','NO_RECORDED_CHECK');
 const observationAt=Date.parse(input.observation.asOf);
 if(observationAt>now)return result('SUPPRESS','OBSERVATION_FROM_FUTURE');
 if(observationAt<checkedAt||observationAt<start)return result('SUPPRESS','OBSERVATION_BEFORE_CHECK');
 if(comparison!.state==='UNKNOWN')return result('SUPPRESS','PREDICATE_UNKNOWN');
 if(comparison!.state==='NO_MATCH')return result('SUPPRESS','PREDICATE_NO_MATCH');
 if(comparison!.valueHash===state.lastNotificationValueHash)return result('SUPPRESS','VALUE_ALREADY_RESERVED');
 if(quiet(policy.quietWindow,wall)){
  // Advisory minute-rounded future recheck; never constructs local->UTC occurrences.
  // Bound work at 72h (4320 probes), including date-line transitions. Recheck at retryAt.
  let retry:number|null=null;
  for(let probe=Math.floor(now/60000)*60000+60000,attempt=0;attempt<4320&&probe<expiry;probe+=60000,attempt++)if(!quiet(policy.quietWindow,local(format,probe))){retry=probe;break;}
  return result('DEFER','QUIET_WINDOW',retry);
 }
 if(notifiedAt!==null&&now-notifiedAt<policy.cooldownSeconds*1000)return result('DEFER','COOLDOWN_WAIT',notifiedAt+policy.cooldownSeconds*1000);
 return result('ELIGIBLE','NOTIFY_CURRENT_CHANGE');
}
