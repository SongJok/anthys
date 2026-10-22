import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {ConditionWatchStore} from '../../packages/watches/src/store.js';
import {runWatchCycle,runWatchRenewalCycle} from '../../packages/watches/src/cycle.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
afterAll(async()=>{await db.close();await root.end();});
const start=Date.parse('2026-10-20T10:00:00.000Z');
const sourceHash='a'.repeat(64);
function policy(overrides:Record<string,unknown>={}){
 return {schemaVersion:1,predicate:{schemaVersion:1,operator:'GT',expected:10},tz:'UTC',validFrom:new Date(start).toISOString(),expiresAt:new Date(start+86_400_000).toISOString(),intervalSeconds:300,cooldownSeconds:0,maxChecks:5,maxNotifications:2,quietWindow:null,misfire:'MONITOR_CURRENT',notificationRule:'VALUE_CHANGE_ONLY',...overrides};
}
const observation=(value:number,asOf:number)=>({schemaVersion:1 as const,state:'OBSERVED' as const,value,asOf:new Date(asOf).toISOString(),sourceHash});
async function world(){
 const tenantId=randomUUID(),actorId=randomUUID(),otherId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic condition watches','ACTIVE','UTC')",[tenantId,'synthetic-watch-'+tenantId]);
 for(const id of [actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic watch owner','ACTIVE')",[tenantId,id,'synthetic-watch-'+id]);
 let now=start;
 const store=new ConditionWatchStore(db,()=>now);
 return {ctx:{tenantId,actorId},other:{tenantId,actorId:otherId},store,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
it('T055/T056 five persisted checks notify only on value change, dedupe repeats and stop visibly at the notification budget',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy({maxNotifications:3}));
 let claim=(await w.store.claimDue(w.ctx))[0]!;expect(claim.watchId).toBe(created.watchId);
 let result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(15,w.now())});
 expect(result.status).toBe('PENDING');expect(result.valueHash).not.toBeNull();
 expect((await w.store.get(w.other,created.watchId))).toBeNull();
 expect(await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'CONFIRMED'})).toMatchObject({state:'CONFIRMED',changed:true});
 for(const [value,expected] of [[15,'SUPPRESSED'],[20,'PENDING'],[20,'SUPPRESSED'],[25,'PENDING']] as const){
  w.advance(300_000);claim=(await w.store.claimDue(w.ctx))[0]!;
  result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(value,w.now())});
  expect(result.status).toBe(expected);if(expected==='PENDING')await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'CONFIRMED'});
 }
 w.advance(300_000);expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
 const state=await w.store.get(w.ctx,created.watchId);
 expect(state).toMatchObject({lifecycle:'ACTIVE',stopReason:'NOTIFICATION_LIMIT_REACHED',notificationState:'IDLE',checksStarted:5,notificationsReserved:3,maxChecks:5,maxNotifications:3,nextCheckAt:null});
 expect((state!.checks as unknown[]).length).toBe(5);expect((state!.notifications as unknown[]).length).toBe(3);
 expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
});
it('T056 an exhausted check budget or expiry becomes a durable stop instead of invisible unlimited polling',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy({predicate:{schemaVersion:1,operator:'GT',expected:100},maxChecks:2}));
 for(let index=0;index<2;index++){
  w.advance(index===0?0:300_000);const claim=(await w.store.claimDue(w.ctx))[0]!;
  expect((await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(50,w.now())})).status).toBe('SUPPRESSED');
 }
 w.advance(300_000);expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({stopReason:'CHECK_LIMIT_REACHED',checksStarted:2,nextCheckAt:null});
 await w.store.resume(w.ctx,created.watchId);expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({stopReason:'CHECK_LIMIT_REACHED'});
 const expiring=await world(),second=await expiring.store.create(expiring.ctx,policy({predicate:{schemaVersion:1,operator:'GT',expected:100},expiresAt:new Date(start+300_000).toISOString()}));
 expiring.advance(300_000);expect(await expiring.store.claimDue(expiring.ctx)).toHaveLength(0);
 expect(await expiring.store.get(expiring.ctx,second.watchId)).toMatchObject({stopReason:'EXPIRED',nextCheckAt:null});
});
it('T057 a quiet window defers the notification, cooldown aggregates a second change and no reservation is written early',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy({quietWindow:{start:'09:00',end:'11:00'},cooldownSeconds:3600,maxChecks:10,maxNotifications:5}));
 let claim=(await w.store.claimDue(w.ctx))[0]!,result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(15,w.now())});
 expect(result).toMatchObject({status:'DEFERRED',reason:'QUIET_WINDOW',notificationId:null,nextCheckAt:new Date(start+3_600_000).toISOString()});
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({notificationsReserved:0,notificationState:'IDLE'});
 w.advance(3_600_000);claim=(await w.store.claimDue(w.ctx))[0]!;
 result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(15,w.now())});
 expect(result.status).toBe('PENDING');await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'CONFIRMED'});
 w.advance(300_000);claim=(await w.store.claimDue(w.ctx))[0]!;
 result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(20,w.now())});
 expect(result).toMatchObject({status:'DEFERRED',reason:'COOLDOWN_WAIT',notificationId:null,nextCheckAt:new Date(start+7_200_000).toISOString()});
 const state=await w.store.get(w.ctx,created.watchId);expect(state).toMatchObject({notificationsReserved:1,checksStarted:3});
 w.advance(3_600_000);claim=(await w.store.claimDue(w.ctx))[0]!;
 expect((await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(20,w.now())})).status).toBe('PENDING');
});
it('T058 a timed-out reservation becomes UNKNOWN, blocks repeats until explicit reconciliation and retains value dedupe',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy());
 const claim=(await w.store.claimDue(w.ctx))[0]!;
 const result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(15,w.now())});
 expect(result.status).toBe('PENDING');
 w.advance(300_001);expect(await w.store.sweepUnconfirmed(w.ctx,300_000)).toEqual([result.notificationId]);
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({notificationState:'UNKNOWN',nextCheckAt:null});
 w.advance(3_600_000);expect(await w.store.claimDue(w.ctx)).toHaveLength(0);expect(await w.store.sweepUnconfirmed(w.ctx,300_000)).toEqual([]);
 await expect(w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'UNKNOWN'})).resolves.toMatchObject({state:'UNKNOWN',changed:false});
 expect(await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'CONFIRMED'})).toMatchObject({state:'CONFIRMED',changed:true});
 w.advance(300_000);const afterReconcile=(await w.store.claimDue(w.ctx))[0]!;
 expect((await w.store.completeCheck(w.ctx,{watchId:afterReconcile.watchId,checkId:afterReconcile.checkId,fence:afterReconcile.fence,observation:observation(15,w.now())})).status).toBe('SUPPRESSED');
});
it('reconciliation after UNKNOWN resumes with the recorded value hash so the same value is not notified twice; stale fences cannot settle a check',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy());
 let claim=(await w.store.claimDue(w.ctx))[0]!;
 const result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(15,w.now())});
 await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'UNKNOWN'});
 expect(await w.store.settleNotification(w.ctx,{notificationId:result.notificationId!,outcome:'CONFIRMED'})).toMatchObject({state:'CONFIRMED',changed:true});
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({notificationState:'IDLE',nextCheckAt:new Date(start+300_000).toISOString()});
 w.advance(300_000);claim=(await w.store.claimDue(w.ctx))[0]!;
 expect(await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence-1,observation:observation(20,w.now())})).toMatchObject({status:'LEASE_LOST'});
 w.advance(60_000);
 expect(await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observation(20,w.now())})).toMatchObject({status:'LEASE_LOST',reason:'FENCE_OR_LEASE_INVALID'});
 w.advance(240_000);const second=(await w.store.claimDue(w.ctx))[0]!;expect(second.fence).toBe(claim.fence+1);
 expect((await w.store.completeCheck(w.ctx,{watchId:second.watchId,checkId:second.checkId,fence:second.fence,observation:observation(15,w.now())})).status).toBe('SUPPRESSED');
});
it('pause, resume and cancel are owner-scoped, idempotent and never scheduled while paused',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy());
 expect(await w.store.pause(w.ctx,created.watchId)).toMatchObject({changed:true,lifecycle:'PAUSED'});
 expect(await w.store.pause(w.ctx,created.watchId)).toMatchObject({changed:false,lifecycle:'PAUSED'});
 expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
 expect(await w.store.resume(w.ctx,created.watchId)).toMatchObject({changed:true,lifecycle:'ACTIVE'});
 expect(await w.store.claimDue(w.ctx)).toHaveLength(1);
 expect(await w.store.cancel(w.ctx,created.watchId)).toMatchObject({changed:true,lifecycle:'CANCELLED'});
 expect(await w.store.cancel(w.ctx,created.watchId)).toMatchObject({changed:false,lifecycle:'CANCELLED'});
 expect(await w.store.pause(w.ctx,created.watchId)).toMatchObject({changed:false,lifecycle:'CANCELLED'});
 expect(await w.store.pause(w.other,created.watchId)).toMatchObject({found:false,changed:false});
 expect(await w.store.list(w.ctx)).toHaveLength(1);expect(await w.store.list(w.other)).toHaveLength(0);
});
it('T055/T058 the explicit-scope cycle observes through an injected source, settles each delivery once and isolates source or delivery faults',async()=>{
 const w=await world(),foreign=await world();
 const healthy=await w.store.create(w.ctx,policy()),sourceDown=await w.store.create(w.ctx,policy()),deliveryLost=await w.store.create(w.ctx,policy()),other=await foreign.store.create(foreign.ctx,policy());
 const observed:string[]=[],notified:{watchId:string;notificationId:string;value:unknown;sourceHash:string}[]=[];
 const observer={observe:async(_ctx:unknown,input:{watchId:string})=>{observed.push(input.watchId);if(input.watchId===sourceDown.watchId)throw Error('SYNTHETIC_SOURCE_DOWN');return observation(15,w.now());}};
 const notifier={notify:async(_ctx:unknown,input:{watchId:string;notificationId:string;observation:{state:string;value?:unknown;sourceHash:string}})=>{if(input.watchId===deliveryLost.watchId)throw Error('SYNTHETIC_SEND_TIMEOUT');notified.push({watchId:input.watchId,notificationId:input.notificationId,value:input.observation.value,sourceHash:input.observation.sourceHash});return 'CONFIRMED' as const;}};
 const summary=await runWatchCycle([w.ctx],w.store,{observer,notifier,now:w.now},new AbortController().signal);
 expect(summary).toEqual({scopes:1,completedScopes:1,failedScopes:0,claimed:3,checksCompleted:3,pending:2,settled:2,deferred:0,suppressed:1,stopped:0,swept:0});
 expect(observed.sort()).toEqual([healthy.watchId,sourceDown.watchId,deliveryLost.watchId].sort());
 expect(notified).toHaveLength(1);expect(notified[0]).toMatchObject({watchId:healthy.watchId,value:15});
 expect(await w.store.get(w.ctx,healthy.watchId)).toMatchObject({notificationState:'IDLE',checksStarted:1,notificationsReserved:1,nextCheckAt:new Date(start+300_000).toISOString()});
 expect((await w.store.get(w.ctx,healthy.watchId))!.notifications[0]).toMatchObject({id:notified[0]!.notificationId,state:'CONFIRMED'});
 expect(await w.store.get(w.ctx,sourceDown.watchId)).toMatchObject({notificationState:'IDLE',checksStarted:1,notificationsReserved:0,lastObservation:{state:'UNAVAILABLE',reason:'SOURCE_UNAVAILABLE'},nextCheckAt:new Date(start+300_000).toISOString()});
 expect(await w.store.get(w.ctx,deliveryLost.watchId)).toMatchObject({notificationState:'UNKNOWN',checksStarted:1,notificationsReserved:1,nextCheckAt:null});
 expect((await w.store.get(w.ctx,deliveryLost.watchId))!.notifications[0]).toMatchObject({state:'UNKNOWN'});
 expect(await foreign.store.get(foreign.ctx,other.watchId)).toMatchObject({checksStarted:0,notificationsReserved:0,notificationState:'IDLE'});
 const aborted=await world(),created=await aborted.store.create(aborted.ctx,policy()),controller=new AbortController();controller.abort();
 await expect(runWatchCycle([aborted.ctx],aborted.store,{observer,notifier,now:aborted.now},controller.signal)).rejects.toBeDefined();
 expect(await aborted.store.get(aborted.ctx,created.watchId)).toMatchObject({checksStarted:0,nextCheckAt:new Date(start).toISOString()});
});
it('an advance renewal is reserved once per watch inside the horizon, only after definite failure retried, and consumes no check or notification budget',async()=>{
 const w=await world(),expiresAt=new Date(start+30*86_400_000).toISOString(),created=await w.store.create(w.ctx,policy({expiresAt}));
 expect(await w.store.claimRenewals(w.ctx,7*86_400_000)).toHaveLength(0);
 expect(await w.store.claimRenewals(w.other,7*86_400_000)).toHaveLength(0);
 w.advance(23*86_400_000);
 const claimed=await w.store.claimRenewals(w.ctx,7*86_400_000);
 expect(claimed).toHaveLength(1);expect(claimed[0]).toMatchObject({watchId:created.watchId,policyHash:created.policyHash,expiresAt});
 expect(await w.store.claimRenewals(w.ctx,7*86_400_000)).toHaveLength(0);
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({lifecycle:'ACTIVE',expiresAt,checksStarted:0,notificationsReserved:0,notificationState:'IDLE',nextCheckAt:new Date(start).toISOString()});
 await expect(w.store.settleRenewalNotification(w.ctx,{noticeId:claimed[0]!.noticeId,outcome:'UNKNOWN'})).resolves.toMatchObject({state:'UNKNOWN',changed:true});
 await expect(w.store.settleRenewalNotification(w.ctx,{noticeId:claimed[0]!.noticeId,outcome:'CONFIRMED'})).rejects.toThrow('WATCH_RENEWAL_ALREADY_SETTLED');
 w.advance(86_400_000);expect(await w.store.claimRenewals(w.ctx,7*86_400_000)).toHaveLength(0);
 const paused=await w.store.create(w.ctx,policy({expiresAt:new Date(w.now()+6*86_400_000).toISOString()}));
 await w.store.pause(w.ctx,paused.watchId);expect(await w.store.claimRenewals(w.ctx,7*86_400_000)).toHaveLength(0);
 await w.store.resume(w.ctx,paused.watchId);expect(await w.store.claimRenewals(w.ctx,7*86_400_000)).toHaveLength(1);
});
it('a definite renewal delivery failure is retried at most three times and the renewal cycle never extends expiry',async()=>{
 const w=await world(),expiresAt=new Date(start+30*86_400_000).toISOString(),created=await w.store.create(w.ctx,policy({expiresAt}));
 w.advance(23*86_400_000);
 const notice=(await w.store.claimRenewals(w.ctx))[0]!;
 await w.store.settleRenewalNotification(w.ctx,{noticeId:notice.noticeId,outcome:'FAILED'});
 for(let attempt=2;attempt<=3;attempt++){
  expect(await w.store.claimRenewals(w.ctx)).toHaveLength(0);
  w.advance(3_600_001);
  const retried=(await w.store.claimRenewals(w.ctx))[0]!;
  expect(retried.noticeId).toBe(notice.noticeId);expect(retried.watchId).toBe(created.watchId);
  await w.store.settleRenewalNotification(w.ctx,{noticeId:retried.noticeId,outcome:'FAILED'});
 }
 w.advance(3_600_001);expect(await w.store.claimRenewals(w.ctx)).toHaveLength(0);
 const cycle=await world(),target=await cycle.store.create(cycle.ctx,policy({expiresAt}));
 cycle.advance(23*86_400_000);
 const sent:string[]=[];
 const summary=await runWatchRenewalCycle([cycle.ctx],cycle.store,{notifier:{notifyRenewal:async(_ctx,input)=>{sent.push(input.noticeId);return 'APPLIED_UNVERIFIED';}}},new AbortController().signal);
 expect(summary).toEqual({scopes:1,completedScopes:1,failedScopes:0,claimed:1,settled:1,swept:0});
 expect(sent).toHaveLength(1);
 expect(await cycle.store.get(cycle.ctx,target.watchId)).toMatchObject({lifecycle:'ACTIVE',expiresAt,checksStarted:0,notificationsReserved:0,notificationState:'IDLE'});
 expect(await runWatchRenewalCycle([cycle.ctx],cycle.store,{notifier:{notifyRenewal:async()=>{throw Error('MUST_NOT_RESEND');}}},new AbortController().signal)).toMatchObject({claimed:0,settled:0});
});
