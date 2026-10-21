import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {evaluateWatchPredicate} from '../../packages/watches/src/predicate.js';
import {evaluateWatchSchedulePolicy,watchSchedulePolicySchema,watchScheduleStateSchema} from '../../packages/watches/src/schedule-policy.js';
const now='2026-10-20T12:00:00.000Z',earlier='2026-10-20T11:55:00.000Z',sourceHash='a'.repeat(64);
const policy=()=>({schemaVersion:1,predicate:{schemaVersion:1,operator:'GT',expected:0},tz:'UTC',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-30T00:00:00.000Z',intervalSeconds:300,cooldownSeconds:600,maxChecks:100,maxNotifications:10,quietWindow:null as null|{start:string;end:string},misfire:'MONITOR_CURRENT',notificationRule:'VALUE_CHANGE_ONLY'});
const empty=()=>({schemaVersion:1,lifecycle:'ACTIVE',checksStarted:0,notificationsReserved:0,lastCheckStartedAt:null as string|null,lastNotificationAt:null as string|null,lastNotificationValueHash:null as string|null,notificationState:'IDLE'});
const checked=()=>({...empty(),checksStarted:1,lastCheckStartedAt:earlier});
const observation=(value=3,asOf=now)=>({schemaVersion:1,state:'OBSERVED',value,asOf,sourceHash});
const check=(p:unknown=policy(),s:unknown=empty(),at=now)=>evaluateWatchSchedulePolicy(p,s,{phase:'CHECK',now:at});
const notify=(p:unknown=policy(),s:unknown=checked(),at=now,o:unknown=observation(3,at))=>evaluateWatchSchedulePolicy(p,s,{phase:'NOTIFY',now:at,observation:o});
const valueHash=(value:number)=>evaluateWatchPredicate(policy().predicate,observation(value)).valueHash!;
const reserved=()=>({...checked(),notificationsReserved:1,lastNotificationAt:earlier,lastNotificationValueHash:valueHash(2)});
const digest=(domain:string,value:unknown)=>createHash('sha256').update(domain+'\0'+JSON.stringify(value)).digest('hex');
describe('watch schedule policy: pure eligibility, not authorization or persistent scheduling',()=>{
 it('allows the first current check and matching current change, with frozen bounded audit summaries',()=>{
  expect(check()).toMatchObject({state:'ELIGIBLE',reason:'CHECK_CURRENT',phase:'CHECK',sourceHash:null,valueHash:null,retryAt:null,localTime:'2026-10-20T12:00:00',tz:'UTC'});
  const p=policy(),s=checked(),result=notify(p,s),comparison=evaluateWatchPredicate(p.predicate,observation());
  expect(result).toMatchObject({state:'ELIGIBLE',reason:'NOTIFY_CURRENT_CHANGE',asOf:now,sourceHash,valueHash:comparison.valueHash,predicateHash:comparison.predicateHash,policyHash:digest('open_aider.watch.schedule-policy.v1',watchSchedulePolicySchema.parse(p)),stateHash:digest('open_aider.watch.schedule-state.v1',watchScheduleStateSchema.parse(s))});
  expect(Object.isFrozen(result)).toBe(true);expect(Object.hasOwn(result,'value')).toBe(false);expect(Object.hasOwn(result,'authorization')).toBe(false);
 });
 it('is deterministic under input key order, does not read Date.now, mutate state, or consume any quota',()=>{
  const p=policy(),s=checked(),before=JSON.stringify({p,s}),clock=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('AMBIENT_CLOCK_FORBIDDEN');});
  try{const first=notify(p,s);expect(notify(Object.fromEntries(Object.entries(p).reverse()),Object.fromEntries(Object.entries(s).reverse()))).toEqual(first);expect(notify(p,s)).toEqual(first);expect(JSON.stringify({p,s})).toBe(before);expect(clock).not.toHaveBeenCalled();}finally{clock.mockRestore();}
 });
 it.each(['CHECK','NOTIFY'] as const)('%s rejects cancelled/expired and defers paused/not-yet-active, without extending expiry',phase=>{
  const evaluate=(p:unknown,s:unknown,at=now)=>phase==='CHECK'?check(p,s,at):notify(p,s,at);
  expect(evaluate(policy(),{...checked(),lifecycle:'CANCELLED'})).toMatchObject({state:'STOP',reason:'CANCELLED',retryAt:null});
  expect(evaluate({...policy(),expiresAt:now},checked())).toMatchObject({state:'STOP',reason:'EXPIRED'});
  expect(evaluate(policy(),{...checked(),lifecycle:'PAUSED'})).toMatchObject({state:'DEFER',reason:'PAUSED',retryAt:null});
  expect(evaluate({...policy(),validFrom:'2026-10-21T00:00:00Z'},checked())).toMatchObject({state:'DEFER',reason:'NOT_STARTED',retryAt:'2026-10-21T00:00:00.000Z'});
  expect(evaluate({...policy(),expiresAt:now},{...checked(),lifecycle:'PAUSED'}).reason).toBe('EXPIRED');
 });
 it('enforces >=5-minute source-independent interval with an inclusive due boundary and no historical backfill',()=>{
  const state={...checked(),lastCheckStartedAt:'2026-10-20T11:55:00.001Z'};
  expect(check(policy(),state)).toMatchObject({state:'DEFER',reason:'INTERVAL_WAIT',retryAt:'2026-10-20T12:00:00.001Z'});
  expect(check(policy(),state,'2026-10-20T12:00:00.001Z').state).toBe('ELIGIBLE');
  const result=check(policy(),{...checked(),lastCheckStartedAt:'2026-10-01T00:00:00Z'});expect(result.reason).toBe('CHECK_CURRENT');expect(Object.hasOwn(result,'occurrences')).toBe(false);expect(Object.hasOwn(result,'missedChecks')).toBe(false);
 });
 it('stops exhausted checks, allows the last completed check to notify, and stops all work at the notification cap',()=>{
  const p={...policy(),maxChecks:1};expect(check(p,checked())).toMatchObject({state:'STOP',reason:'CHECK_LIMIT_REACHED'});expect(notify(p).state).toBe('ELIGIBLE');
  const state={...reserved(),checksStarted:10,notificationsReserved:10};
  expect(check(policy(),state)).toMatchObject({state:'STOP',reason:'NOTIFICATION_LIMIT_REACHED'});expect(notify(policy(),state).reason).toBe('NOTIFICATION_LIMIT_REACHED');
 });
 it.each(['PENDING','UNKNOWN'])('%s blocks both phases even after value/time changes; pure evaluation never clears or retries it',notificationState=>{
  const state={...reserved(),notificationState},p={...policy(),cooldownSeconds:0};
  for(const at of [now,'2026-10-21T12:00:00Z']){expect(check(p,state,at)).toMatchObject({state:'DEFER',reason:notificationState==='PENDING'?'NOTIFICATION_PENDING':'NOTIFICATION_UNKNOWN'});expect(notify(p,state,at,observation(999,at)).state).toBe('DEFER');}
  expect(state.notificationState).toBe(notificationState);
 });
 it('deduplicates the actual predicate value hash, never treating the sourceHash alone as a change or proof',()=>{
  const state={...reserved(),lastNotificationValueHash:valueHash(3)},p={...policy(),cooldownSeconds:0};
  expect(notify(p,state)).toMatchObject({state:'SUPPRESS',reason:'VALUE_ALREADY_RESERVED'});
  expect(notify(p,state,now,{...observation(),sourceHash:'b'.repeat(64)}).reason).toBe('VALUE_ALREADY_RESERVED');
  expect(notify(p,state,now,observation(4))).toMatchObject({state:'ELIGIBLE',reason:'NOTIFY_CURRENT_CHANGE'});
 });
 it('applies cooldown to changed matching values and allows its exact boundary',()=>{
  expect(notify(policy(),reserved())).toMatchObject({state:'DEFER',reason:'COOLDOWN_WAIT',retryAt:'2026-10-20T12:05:00.000Z'});
  expect(notify(policy(),reserved(),'2026-10-20T12:05:00Z').state).toBe('ELIGIBLE');
  expect(notify({...policy(),cooldownSeconds:0},reserved()).state).toBe('ELIGIBLE');
 });
 it('never schedules notifications for no check, nonmatches, unknown/unavailable, cross-type, stale or future observations',()=>{
  expect(notify(policy(),empty()).reason).toBe('NO_RECORDED_CHECK');
  expect(notify(policy(),checked(),now,observation(0))).toMatchObject({state:'SUPPRESS',reason:'PREDICATE_NO_MATCH'});
  for(const o of [{schemaVersion:1,state:'UNKNOWN',reason:'NOT_OBSERVED',asOf:now,sourceHash},{schemaVersion:1,state:'UNAVAILABLE',reason:'SOURCE_ERROR',asOf:now,sourceHash},{...observation(),value:'3'}])expect(notify(policy(),checked(),now,o)).toMatchObject({state:'SUPPRESS',reason:'PREDICATE_UNKNOWN'});
  expect(notify(policy(),checked(),now,observation(3,'2026-10-20T11:54:59Z')).reason).toBe('OBSERVATION_BEFORE_CHECK');
  expect(notify(policy(),checked(),now,observation(3,'2026-10-20T12:00:00.001Z')).reason).toBe('OBSERVATION_FROM_FUTURE');
 });
 it('uses half-open quiet minutes and only delays notification, not the current check',()=>{
  const p={...policy(),quietWindow:{start:'12:00',end:'13:00'}};
  expect(check(p).state).toBe('ELIGIBLE');expect(notify(p)).toMatchObject({state:'DEFER',reason:'QUIET_WINDOW',retryAt:'2026-10-20T13:00:00.000Z'});
  expect(notify(p,checked(),'2026-10-20T12:59:59.999Z').state).toBe('DEFER');expect(notify(p,checked(),'2026-10-20T13:00:00Z').state).toBe('ELIGIBLE');
  expect(notify({...p,quietWindow:{start:'11:00',end:'12:00'}}).state).toBe('ELIGIBLE');
 });
 it.each(['2026-10-20T14:00:00Z','2026-10-20T22:59:59.999Z'])('handles Asia/Shanghai cross-midnight quiet window at %s',at=>{
  const p={...policy(),tz:'Asia/Shanghai',quietWindow:{start:'22:00',end:'07:00'}};
  expect(notify(p,checked(),at)).toMatchObject({state:'DEFER',reason:'QUIET_WINDOW',retryAt:'2026-10-20T23:00:00.000Z'});
  expect(notify(p,checked(),'2026-10-20T23:00:00Z').state).toBe('ELIGIBLE');
 });
 it.each(['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'])('keeps both repeated New York 01:30 instants quiet: %s',at=>{
  const p={...policy(),tz:'America/New_York',quietWindow:{start:'01:00',end:'02:00'}},s={...checked(),lastCheckStartedAt:'2026-11-01T05:00:00Z'};
  expect(notify(p,s,at)).toMatchObject({state:'DEFER',reason:'QUIET_WINDOW',localTime:'2026-11-01T01:30:00',retryAt:'2026-11-01T07:00:00.000Z'});
 });
 it('projects spring DST gaps without inventing nonexistent local times or shifting a fake observation',()=>{
  const p={...policy(),validFrom:'2026-03-01T00:00:00Z',tz:'America/New_York',quietWindow:{start:'01:30',end:'02:30'}},s={...checked(),lastCheckStartedAt:'2026-03-08T06:30:00Z'};
  expect(notify(p,s,'2026-03-08T06:45:00Z')).toMatchObject({state:'DEFER',reason:'QUIET_WINDOW',retryAt:'2026-03-08T07:00:00.000Z'});
  expect(notify(p,s,'2026-03-08T07:00:00Z')).toMatchObject({state:'ELIGIBLE',localTime:'2026-03-08T03:00:00'});
  const missing={...p,quietWindow:{start:'02:15',end:'02:45'}};expect(notify(missing,s,'2026-03-08T07:15:00Z').state).toBe('ELIGIBLE');
 });
 it.each(['2026-04-04T14:45:00Z','2026-04-04T15:15:00Z'])('handles Lord Howe half-hour overlap without a one-hour DST assumption: %s',at=>{
  const p={...policy(),validFrom:'2026-04-01T00:00:00Z',tz:'Australia/Lord_Howe',quietWindow:{start:'01:30',end:'02:00'}},s={...checked(),lastCheckStartedAt:'2026-04-04T14:30:00Z'};
  expect(notify(p,s,at)).toMatchObject({state:'DEFER',localTime:'2026-04-05T01:45:00',retryAt:'2026-04-04T15:30:00.000Z'});
 });
 it('never returns retryAt at/after expiry, including expiry inside a quiet window or cooldown',()=>{
  expect(notify({...policy(),quietWindow:{start:'12:00',end:'13:00'},expiresAt:'2026-10-20T12:30:00Z'})).toMatchObject({state:'DEFER',reason:'QUIET_WINDOW',retryAt:null});
  expect(notify({...policy(),expiresAt:'2026-10-20T12:05:00Z'},reserved())).toMatchObject({reason:'COOLDOWN_WAIT',retryAt:null});
  expect(check({...policy(),expiresAt:'2026-10-20T12:00:00.001Z'},{...checked(),lastCheckStartedAt:'2026-10-20T11:55:00.001Z'}).retryAt).toBeNull();
 });
 it('requires explicit finite validity and policy fields; 30 days is a creation default elsewhere, not a silent parser default',()=>{
  const p=policy();for(const key of Object.keys(p)){const copy:Record<string,unknown>={...p};delete copy[key];expect(watchSchedulePolicySchema.safeParse(copy).success).toBe(false);}
  expect(watchSchedulePolicySchema.safeParse({...p,expiresAt:p.validFrom}).success).toBe(false);
  expect(watchSchedulePolicySchema.safeParse({...p,expiresAt:'2026-09-30T00:00:00Z'}).success).toBe(false);
  expect(watchSchedulePolicySchema.safeParse({...p,expiresAt:'2027-10-01T00:00:00Z'}).success).toBe(true);
 });
 it.each(['Mars/Olympus','PST','GMT','+08:00','UTC+8','Asia/Not_A_Zone','', ' America/New_York'])('rejects unknown or ambiguous timezone %s',tz=>{
  expect(watchSchedulePolicySchema.safeParse({...policy(),tz}).success).toBe(false);
 });
 it.each(['2026-02-30T00:00:00Z','2026-10-20','2026-10-20T12:00:00','2026-10-20T20:00:00+08:00','0000-01-01T00:00:00Z','2026-10-20T24:00:00Z','2016-12-31T23:59:60Z','2026-10-20T12:00:00.0001Z'])('requires real strict UTC at decision boundary: %s',at=>{
  expect(()=>check(policy(),empty(),at)).toThrow(/^WATCH_SCHEDULE_INPUT_INVALID$/);
  expect(watchSchedulePolicySchema.safeParse({...policy(),expiresAt:at}).success).toBe(false);
  expect(watchScheduleStateSchema.safeParse({...checked(),lastCheckStartedAt:at}).success).toBe(false);
 });
 it('rejects wide/missing/extra controls, equal quiet boundaries, malformed wall minutes and unsafe arithmetic',()=>{
  for(const patch of [{schemaVersion:2},{intervalSeconds:299},{intervalSeconds:1.5},{intervalSeconds:Number.MAX_SAFE_INTEGER},{cooldownSeconds:-1},{maxChecks:0},{maxNotifications:0},{maxChecks:Infinity},{maxChecks:Number.MAX_SAFE_INTEGER+1},{misfire:'BACKFILL'},{notificationRule:'ALWAYS'},{targets:['all']},{quietWindow:{start:'00:00',end:'00:00'}},{quietWindow:{start:'24:00',end:'07:00'}},{quietWindow:{start:'22:00',end:'07:00',override:true}}])expect(watchSchedulePolicySchema.safeParse({...policy(),...patch}).success).toBe(false);
  expect(()=>check({...policy(),secret:'SYNTHETIC_DO_NOT_ECHO'})).toThrow(/^WATCH_SCHEDULE_POLICY_INVALID$/);
 });
 it('rejects counters/times that cannot describe the supplied history instead of guessing zero/null or refunding',()=>{
  for(const patch of [{checksStarted:-1},{checksStarted:0.5},{checksStarted:NaN},{checksStarted:1},{lastCheckStartedAt:earlier},{notificationsReserved:1},{lastNotificationValueHash:valueHash(3)},{lastNotificationAt:earlier},{notificationState:'UNKNOWN'},{notificationState:'APPLIED'},{extra:true}])expect(watchScheduleStateSchema.safeParse({...empty(),...patch}).success).toBe(false);
  expect(watchScheduleStateSchema.safeParse({...reserved(),checksStarted:0,lastCheckStartedAt:null}).success).toBe(false);
  expect(watchScheduleStateSchema.safeParse({...reserved(),lastNotificationAt:'2026-10-20T11:54:59Z'}).success).toBe(false);
  for(const state of [{...checked(),lastCheckStartedAt:'2026-10-20T12:00:00.001Z'},{...reserved(),lastNotificationAt:'2026-10-20T12:00:00.001Z'},{...checked(),checksStarted:101},{...reserved(),checksStarted:11,notificationsReserved:11}])expect(()=>notify(policy(),state)).toThrow(/^WATCH_SCHEDULE_STATE_INVALID$/);
 });
 it('accepts lower-case SHA only and requires strict observation branches without fabricated values',()=>{
  expect(watchScheduleStateSchema.safeParse({...reserved(),lastNotificationValueHash:'A'.repeat(64)}).success).toBe(false);
  for(const candidate of [{schemaVersion:1,state:'UNKNOWN',reason:'NOT_OBSERVED',asOf:now,sourceHash,value:null},{...observation(),value:undefined},{...observation(),asOf:'2026-02-30T00:00:00Z'},{...observation(),extra:'x'}])expect(()=>notify(policy(),checked(),now,candidate)).toThrow(/^WATCH_SCHEDULE_INPUT_INVALID$/);
 });
 it('freezes parsed nested policy snapshots and accepts plain null-prototype JSON records',()=>{
  const raw={...policy(),quietWindow:{start:'22:00',end:'07:00'}},parsed=watchSchedulePolicySchema.parse(raw);raw.quietWindow.start='23:00';raw.predicate.expected=10;
  expect(parsed.quietWindow!.start).toBe('22:00');expect(parsed.predicate.expected).toBe(0);expect(Object.isFrozen(parsed)).toBe(true);expect(Object.isFrozen(parsed.quietWindow)).toBe(true);expect(Object.isFrozen(parsed.predicate)).toBe(true);
  expect(check(Object.assign(Object.create(null),policy()),Object.assign(Object.create(null),empty())).state).toBe('ELIGIBLE');
 });
 it('rejects getters/toJSON, Proxy traps, custom prototypes, arrays, sparse arrays and cycles without executing data',()=>{
  let calls=0;const getter=()=>{calls++;throw Error('GETTER');};const p=policy();Object.defineProperty(p,'tz',{get:getter,enumerable:true});expect(watchSchedulePolicySchema.safeParse(p).success).toBe(false);
  const nested={...policy(),quietWindow:{start:'22:00',end:'07:00'}};Object.defineProperty(nested.quietWindow,'end',{get:getter,enumerable:true});expect(watchSchedulePolicySchema.safeParse(nested).success).toBe(false);
  expect(watchSchedulePolicySchema.safeParse({...policy(),toJSON:getter}).success).toBe(false);
  const handler={get:getter,ownKeys:getter,getPrototypeOf:getter,getOwnPropertyDescriptor:getter};for(const raw of [new Proxy(policy(),handler),{...policy(),predicate:new Proxy(policy().predicate,handler)}])expect(watchSchedulePolicySchema.safeParse(raw).success).toBe(false);
  const revoked=Proxy.revocable(empty(),{});revoked.revoke();expect(watchScheduleStateSchema.safeParse(revoked.proxy).success).toBe(false);
  for(const raw of [new Date(),new Array(3),[],Object.assign(Object.create({extra:true}),policy())])expect(watchSchedulePolicySchema.safeParse(raw).success).toBe(false);
  const cycle:Record<string,unknown>={...policy()};cycle.extra=cycle;expect(watchSchedulePolicySchema.safeParse(cycle).success).toBe(false);
  const state=empty();Object.defineProperty(state,'lifecycle',{get:getter});expect(()=>check(policy(),state)).toThrow(/^WATCH_SCHEDULE_STATE_INVALID$/);
  const input={phase:'CHECK',now};Object.defineProperty(input,'now',{get:getter});expect(()=>evaluateWatchSchedulePolicy(policy(),empty(),input)).toThrow(/^WATCH_SCHEDULE_INPUT_INVALID$/);expect(calls).toBe(0);
 });
 it('bounds complete UTF8 JSON, symbols/hidden keys, and never accepts expressions/paths/URLs as policy',()=>{
  for(const patch of [{tz:'x'.repeat(4097)},{[Symbol('hidden')]:1},{expression:'process.exit()'},{path:'../../private'},{url:'https://example.invalid'},JSON.parse('{"__proto__":{"polluted":true}}')])expect(watchSchedulePolicySchema.safeParse({...policy(),...patch}).success).toBe(false);
  const raw=policy();Object.defineProperty(raw,'hidden',{value:true,enumerable:false});expect(watchSchedulePolicySchema.safeParse(raw).success).toBe(false);
  expect(watchSchedulePolicySchema.safeParse({...policy(),predicate:{schemaVersion:1,operator:'EQ',expected:'\0'.repeat(4000)}}).success).toBe(false);
  expect(Object.hasOwn(Object.prototype,'polluted')).toBe(false);
 });
});
