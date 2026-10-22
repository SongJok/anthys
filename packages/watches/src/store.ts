import {createHash,randomUUID} from 'node:crypto';
import type {Database,DbContext} from '../../storage/src/database.js';
import {evaluateWatchSchedulePolicy,watchSchedulePolicySchema,type WatchSchedulePolicy} from './schedule-policy.js';
import {watchObservationSchema,type WatchObservation} from './predicate.js';

export type WatchClaim=Readonly<{watchId:string;checkId:string;fence:number;policyHash:string;policy:WatchSchedulePolicy}>;
export type WatchCheckResult=Readonly<{status:'PENDING'|'SUPPRESSED'|'DEFERRED'|'STOPPED'|'LEASE_LOST';reason:string;notificationId:string|null;valueHash:string|null;nextCheckAt:string|null}>;
export type WatchNotificationOutcome='CONFIRMED'|'APPLIED_UNVERIFIED'|'FAILED'|'UNKNOWN';
export type WatchRenewalNotice=Readonly<{watchId:string;noticeId:string;policyHash:string;policy:WatchSchedulePolicy;expiresAt:string}>;
const policyDigest=(policy:WatchSchedulePolicy)=>createHash('sha256').update('anthys.watch.schedule-policy.v1\0'+JSON.stringify(policy)).digest('hex');
const instant=(value:unknown)=>value===null||value===undefined?null:new Date(value as string|Date).toISOString();
const numeric=(value:unknown)=>Number(value);
const stopReasons=new Set(['EXPIRED','CHECK_LIMIT_REACHED','NOTIFICATION_LIMIT_REACHED']);
function storedPolicy(value:unknown):WatchSchedulePolicy{
 const parsed=watchSchedulePolicySchema.safeParse(value);if(!parsed.success)throw Error('WATCH_STORED_POLICY_INVALID');return parsed.data;
}
/** Rebuilds the exact pure-policy state from durable columns. No TTL or
 * inferred value is invented; a missing observation stays absent. */
function storedState(row:Record<string,unknown>){
 return {
  schemaVersion:1 as const,lifecycle:row.lifecycle as 'ACTIVE'|'PAUSED'|'CANCELLED',
  checksStarted:numeric(row.checks_started),notificationsReserved:numeric(row.notifications_reserved),
  lastCheckStartedAt:instant(row.last_check_started_at),lastNotificationAt:instant(row.last_notification_at),
  lastNotificationValueHash:(row.last_notification_value_hash as string|null)??null,
  notificationState:row.notification_state as 'IDLE'|'PENDING'|'UNKNOWN',
 };
}
/**
 * Durable owner-scoped condition monitor. Persistence, leases, counters, value
 * dedupe and UNKNOWN reconciliation live here; the pure schedule policy remains
 * the sole eligibility authority. This class never fetches, models or sends.
 */
export class ConditionWatchStore {
 constructor(readonly db:Database,private readonly clock:()=>number=Date.now,private readonly leaseMs=60_000){}
 private now(){return this.clock();}
 async create(ctx:DbContext,rawPolicy:unknown){
  const policy=watchSchedulePolicySchema.parse(rawPolicy),id=randomUUID(),policyHash=policyDigest(policy);
  await this.db.scope(ctx,c=>c.query(`INSERT INTO condition_watches(tenant_id,id,owner_id,policy,policy_hash,next_check_at,max_checks,max_notifications,interval_seconds,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[ctx.tenantId,id,ctx.actorId,JSON.stringify(policy),policyHash,policy.validFrom,policy.maxChecks,policy.maxNotifications,policy.intervalSeconds,policy.expiresAt]));
  return {watchId:id,policyHash};
 }
 /** Claims due checks with FOR UPDATE SKIP LOCKED and a monotonic fence. The
  * counter is consumed at claim, before any external call can begin. */
 async claimDue(ctx:DbContext,limit=10):Promise<WatchClaim[]>{
  const asOf=this.now(),iso=new Date(asOf).toISOString(),size=Math.min(50,Math.max(1,Math.trunc(limit)));
  return this.db.scope(ctx,async c=>{
   const rows=(await c.query(`SELECT * FROM condition_watches WHERE lifecycle='ACTIVE' AND notification_state='IDLE' AND next_check_at IS NOT NULL AND next_check_at<=$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,[iso,size])).rows;
   const claims:WatchClaim[]=[];
   for(const row of rows){
    const policy=storedPolicy(row.policy),state=storedState(row);
    let decision;try{decision=evaluateWatchSchedulePolicy(policy,state,{phase:'CHECK',now:iso});}catch{decision=null;}
    if(!decision||decision.state!=='ELIGIBLE'||decision.reason!=='CHECK_CURRENT'){
     if(decision?.state==='STOP'){
      const reason=stopReasons.has(decision.reason)?decision.reason:'CHECK_LIMIT_REACHED';
      await c.query("UPDATE condition_watches SET stop_reason=$2,next_check_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$3",[ctx.tenantId,reason,row.id]);
     }else{
      const retry=decision?.retryAt??new Date(asOf+numeric(row.interval_seconds)*1000).toISOString();
      await c.query("UPDATE condition_watches SET next_check_at=$2,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$3",[ctx.tenantId,retry,row.id]);
     }
     continue;
    }
    const fence=numeric(row.lease_fence)+1,checkId=randomUUID(),checkAt=new Date(asOf).toISOString(),leaseUntil=new Date(asOf+this.leaseMs).toISOString(),nextCheckAt=new Date(asOf+policy.intervalSeconds*1000).toISOString();
    const updated=(await c.query(`UPDATE condition_watches SET checks_started=checks_started+1,last_check_started_at=$1,next_check_at=$2,lease_fence=$3,lease_owner=$4,lease_until=$5,updated_at=clock_timestamp()
     WHERE tenant_id=$6 AND id=$7 AND lease_fence=$8 AND (lease_until IS NULL OR lease_until<=$1) RETURNING checks_started`,[checkAt,nextCheckAt,fence,ctx.actorId,leaseUntil,ctx.tenantId,row.id,numeric(row.lease_fence)])).rows[0];
    if(!updated)continue;
    await c.query("INSERT INTO condition_watch_checks(tenant_id,id,watch_id,owner_id,fence,state) VALUES($1,$2,$3,$4,$5,'CHECKING')",[ctx.tenantId,checkId,row.id,ctx.actorId,fence]);
    claims.push(Object.freeze({watchId:row.id as string,checkId,fence,policyHash:row.policy_hash as string,policy}));
   }
   return claims;
  });
 }
 /** Completes one claimed check. A fence mismatch or expired lease is rejected
  * without settling the check; the observation is only accepted once. */
 async completeCheck(ctx:DbContext,input:{watchId:string;checkId:string;fence:number;observation:WatchObservation}):Promise<WatchCheckResult>{
  const observation=watchObservationSchema.parse(input.observation),asOf=this.now(),iso=new Date(asOf).toISOString();
  return this.db.scope(ctx,async c=>{
   const row=(await c.query('SELECT * FROM condition_watches WHERE id=$1 FOR UPDATE',[input.watchId])).rows[0] as Record<string,unknown>|undefined;
   if(!row||numeric(row.lease_fence)!==input.fence||row.lease_owner!==ctx.actorId||instant(row.lease_until)===null||Date.parse(instant(row.lease_until)!)<=asOf){
    if(instant(row?.lease_until??null)!==null&&Date.parse(instant(row!.lease_until)!)<=asOf)await c.query("UPDATE condition_watch_checks SET state='FAILED',outcome='LEASE_EXPIRED',completed_at=clock_timestamp() WHERE id=$1 AND watch_id=$2 AND state='CHECKING'",[input.checkId,input.watchId]);
    return Object.freeze({status:'LEASE_LOST',reason:'FENCE_OR_LEASE_INVALID',notificationId:null,valueHash:null,nextCheckAt:null});
   }
   const check=(await c.query("SELECT id FROM condition_watch_checks WHERE id=$1 AND watch_id=$2 AND fence=$3 AND state='CHECKING'",[input.checkId,input.watchId,input.fence])).rows[0];
   if(!check)return Object.freeze({status:'LEASE_LOST',reason:'CHECK_NOT_CURRENT',notificationId:null,valueHash:null,nextCheckAt:null});
   const policy=storedPolicy(row.policy),decision=evaluateWatchSchedulePolicy(policy,storedState(row),{phase:'NOTIFY',now:iso,observation});
   const valueHash=decision.valueHash,nextCheckAt=new Date(asOf+policy.intervalSeconds*1000).toISOString(),settled=JSON.stringify(observation);
   const finish=async(result:WatchCheckResult,checkState:'COMPLETED'|'SUPPRESSED'|'FAILED')=>{
    await c.query("UPDATE condition_watch_checks SET state=$2,outcome=$3,observation=$4,completed_at=clock_timestamp() WHERE id=$1 AND state='CHECKING'",[input.checkId,checkState,decision.reason,settled]);
    return result;
   };
   const release='lease_owner=NULL,lease_until=NULL,last_observation=$3,last_value_hash=$4,updated_at=clock_timestamp()';
   if(decision.state==='STOP'){
    const reason=stopReasons.has(decision.reason)?decision.reason:'CHECK_LIMIT_REACHED';
    await c.query(`UPDATE condition_watches SET ${release},next_check_at=NULL,stop_reason=$5 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,input.watchId,settled,valueHash,reason]);
    return finish(Object.freeze({status:'STOPPED',reason,notificationId:null,valueHash,nextCheckAt:null}),'FAILED');
   }
   if(decision.state==='ELIGIBLE'&&decision.reason==='NOTIFY_CURRENT_CHANGE'&&valueHash!==null){
    const notificationId=randomUUID(),at=new Date(asOf).toISOString();
    await c.query("INSERT INTO condition_watch_notifications(tenant_id,id,watch_id,owner_id,check_id,value_hash,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$7)",[ctx.tenantId,notificationId,input.watchId,ctx.actorId,input.checkId,valueHash,at]);
    await c.query(`UPDATE condition_watches SET ${release},next_check_at=NULL,notifications_reserved=notifications_reserved+1,last_notification_at=$5,last_notification_value_hash=$6,notification_state='PENDING' WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,input.watchId,settled,valueHash,at,valueHash]);
    return finish(Object.freeze({status:'PENDING',reason:decision.reason,notificationId,valueHash,nextCheckAt:null}),'COMPLETED');
   }
   const next=decision.state==='DEFER'?decision.retryAt??nextCheckAt:nextCheckAt;
   await c.query(`UPDATE condition_watches SET ${release},next_check_at=$5 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,input.watchId,settled,valueHash,next]);
   return finish(Object.freeze({status:decision.state==='DEFER'?'DEFERRED':'SUPPRESSED',reason:decision.reason,notificationId:null,valueHash,nextCheckAt:next}),decision.state==='DEFER'?'COMPLETED':'SUPPRESSED');
  });
 }
 /** Settles a reservation. UNKNOWN blocks all further notification until an
  * explicit reconcile; every settled attempt retains value dedupe and budget. */
 async settleNotification(ctx:DbContext,input:{notificationId:string;outcome:WatchNotificationOutcome}){
  const asOf=this.now(),iso=new Date(asOf).toISOString();
  return this.db.scope(ctx,async c=>{
   const row=(await c.query('SELECT * FROM condition_watch_notifications WHERE id=$1 FOR UPDATE',[input.notificationId])).rows[0] as Record<string,unknown>|undefined;
   if(!row)throw Error('WATCH_NOTIFICATION_NOT_FOUND');
   const previous=row.state as string;
   if(previous===input.outcome)return {notificationId:input.notificationId,state:previous,changed:false};
   if(previous==='CONFIRMED'||previous==='APPLIED_UNVERIFIED'||previous==='FAILED'||(previous==='UNKNOWN'&&input.outcome==='UNKNOWN'))throw Error('WATCH_NOTIFICATION_ALREADY_SETTLED');
   const watch=(await c.query('SELECT * FROM condition_watches WHERE id=$1 FOR UPDATE',[row.watch_id])).rows[0] as Record<string,unknown>|undefined;
   if(!watch)throw Error('WATCH_NOT_FOUND');
   await c.query("UPDATE condition_watch_notifications SET state=$2,updated_at=$3,settled_at=$3 WHERE id=$1",[input.notificationId,input.outcome,iso]);
   if(input.outcome==='UNKNOWN'){
    await c.query("UPDATE condition_watches SET notification_state='UNKNOWN',next_check_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,row.watch_id]);
   }else{
    const next=watch.lifecycle==='ACTIVE'&&watch.stop_reason===null?new Date(asOf+numeric(watch.interval_seconds)*1000).toISOString():null;
    await c.query("UPDATE condition_watches SET notification_state='IDLE',next_check_at=$3,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,row.watch_id,next]);
   }
   return {notificationId:input.notificationId,state:input.outcome,changed:true};
  });
 }
 /** A pending reservation without a confirmed physical result becomes UNKNOWN
  * after the caller timeout; retries never silently duplicate that send. */
 async sweepUnconfirmed(ctx:DbContext,olderThanMs=300_000){
  const cutoff=new Date(this.now()-Math.max(0,olderThanMs)).toISOString(),at=new Date(this.now()).toISOString();
  return this.db.scope(ctx,async c=>{
   const rows=(await c.query("SELECT id,watch_id FROM condition_watch_notifications WHERE state='PENDING' AND updated_at<=$1 ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 50",[cutoff])).rows;
   for(const row of rows){
    await c.query("UPDATE condition_watch_notifications SET state='UNKNOWN',updated_at=$2,settled_at=$2 WHERE id=$1",[row.id,at]);
    await c.query("UPDATE condition_watches SET notification_state='UNKNOWN',next_check_at=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND notification_state='PENDING'",[ctx.tenantId,row.watch_id]);
   }
   return rows.map(row=>row.id as string);
  });
 }
 /** Reserves the single advance notice for active watches nearing expiry.
  * Nothing is sent here and no check or notification budget is consumed.
  * A definite FAILED attempt may be retried at most three times, one hour
  * apart; CONFIRMED/APPLIED_UNVERIFIED/UNKNOWN are terminal. */
 async claimRenewals(ctx:DbContext,horizonMs=7*86_400_000,limit=10):Promise<WatchRenewalNotice[]>{
  if(!Number.isSafeInteger(horizonMs)||horizonMs<=0)return [];
  const asOf=this.now(),nowIso=new Date(asOf).toISOString(),horizonIso=new Date(asOf+horizonMs).toISOString(),retryBefore=new Date(asOf-3_600_000).toISOString(),size=Math.min(50,Math.max(1,Math.trunc(limit)));
  return this.db.scope(ctx,async c=>{
   const rows=(await c.query(`SELECT w.*,n.id notice_id,n.state notice_state,n.attempts notice_attempts FROM condition_watches w LEFT JOIN condition_watch_renewal_notices n ON n.tenant_id=w.tenant_id AND n.watch_id=w.id
    WHERE w.lifecycle='ACTIVE' AND w.expires_at>$1 AND w.expires_at<=$2 AND (n.id IS NULL OR (n.state='FAILED' AND n.attempts<3 AND n.updated_at<=$3))
    ORDER BY w.expires_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT $4`,[nowIso,horizonIso,retryBefore,size])).rows;
   const notices:WatchRenewalNotice[]=[];
   for(const row of rows){
    const policy=storedPolicy(row.policy),expiresAt=instant(row.expires_at);
    if(expiresAt===null)continue;
    let noticeId:string;
    if(row.notice_id===null||row.notice_id===undefined){
     noticeId=randomUUID();
     const inserted=await c.query("INSERT INTO condition_watch_renewal_notices(tenant_id,id,watch_id,owner_id,policy_hash,expires_at,state,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'PENDING',1,$7,$7) ON CONFLICT(tenant_id,watch_id) DO NOTHING RETURNING id",[ctx.tenantId,noticeId,row.id,ctx.actorId,row.policy_hash,expiresAt,nowIso]);
     if(!inserted.rowCount)continue;
    }else{
     const retried=await c.query("UPDATE condition_watch_renewal_notices SET state='PENDING',attempts=attempts+1,settled_at=NULL,updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND state='FAILED' AND attempts<3 RETURNING id",[ctx.tenantId,row.notice_id,nowIso]);
     if(!retried.rowCount)continue;
     noticeId=row.notice_id as string;
    }
    notices.push(Object.freeze({watchId:row.id as string,noticeId,policyHash:row.policy_hash as string,policy,expiresAt}));
   }
   return notices;
  });
 }
 async settleRenewalNotification(ctx:DbContext,input:{noticeId:string;outcome:WatchNotificationOutcome}){
  const iso=new Date(this.now()).toISOString();
  return this.db.scope(ctx,async c=>{
   const row=(await c.query('SELECT * FROM condition_watch_renewal_notices WHERE id=$1 FOR UPDATE',[input.noticeId])).rows[0] as Record<string,unknown>|undefined;
   if(!row)throw Error('WATCH_RENEWAL_NOT_FOUND');
   const previous=row.state as string;
   if(previous===input.outcome)return {noticeId:input.noticeId,state:previous,changed:false};
   if(previous!=='PENDING')throw Error('WATCH_RENEWAL_ALREADY_SETTLED');
   await c.query("UPDATE condition_watch_renewal_notices SET state=$2,updated_at=$3,settled_at=$3 WHERE id=$1",[input.noticeId,input.outcome,iso]);
   return {noticeId:input.noticeId,state:input.outcome,changed:true};
  });
 }
 /** A reservation abandoned before any physical attempt is UNKNOWN, never
  * silently retried; this does not stop or alter the watch itself. */
 async sweepRenewals(ctx:DbContext,olderThanMs=300_000){
  const cutoff=new Date(this.now()-Math.max(0,olderThanMs)).toISOString(),at=new Date(this.now()).toISOString();
  return this.db.scope(ctx,async c=>{
   const rows=(await c.query("UPDATE condition_watch_renewal_notices SET state='UNKNOWN',updated_at=$2,settled_at=$2 WHERE tenant_id=$1 AND owner_id=$3 AND state='PENDING' AND updated_at<=$4 RETURNING id",[ctx.tenantId,at,ctx.actorId,cutoff])).rows;
   return rows.map(row=>row.id as string);
  });
 }
 async pause(ctx:DbContext,id:string){return this.transition(ctx,id,"lifecycle='PAUSED',next_check_at=NULL,lease_owner=NULL,lease_until=NULL",['ACTIVE']);}
 async resume(ctx:DbContext,id:string){return this.transition(ctx,id,"lifecycle='ACTIVE',stop_reason=NULL,next_check_at=$4",['PAUSED'],new Date(this.now()).toISOString());}
 async cancel(ctx:DbContext,id:string){return this.transition(ctx,id,"lifecycle='CANCELLED',next_check_at=NULL,lease_owner=NULL,lease_until=NULL",['ACTIVE','PAUSED']);}
 private async transition(ctx:DbContext,id:string,set:string,from:string[],nextAt?:string){
  return this.db.scope(ctx,async c=>{
   const params:unknown[]=nextAt===undefined?[ctx.tenantId,id,from]:[ctx.tenantId,id,from,nextAt];
   const row=(await c.query(`UPDATE condition_watches SET ${set},updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND lifecycle=ANY($3::text[]) RETURNING id,lifecycle,stop_reason,next_check_at`,params)).rows[0];
   if(row)return {found:true,changed:true,...row};
   const exists=(await c.query('SELECT lifecycle,stop_reason,next_check_at FROM condition_watches WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,id])).rows[0];
   return exists?{found:true,changed:false,...exists}:{found:false,changed:false};
  });
 }
 /** Owner-visible durable state. Counters, stop reason and an unconfirmed
  * notification are disclosed so a finite monitor cannot appear to run on. */
 async get(ctx:DbContext,id:string){
  return this.db.scope(ctx,async c=>{
   const row=(await c.query('SELECT * FROM condition_watches WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,id])).rows[0] as Record<string,unknown>|undefined;
   if(!row)return null;
   const checks=(await c.query('SELECT id,fence,state,outcome,observation,created_at,completed_at FROM condition_watch_checks WHERE tenant_id=$1 AND watch_id=$2 ORDER BY created_at DESC,id DESC LIMIT 5',[ctx.tenantId,id])).rows;
   const notifications=(await c.query('SELECT id,check_id,value_hash,state,attempts,created_at,updated_at,settled_at FROM condition_watch_notifications WHERE tenant_id=$1 AND watch_id=$2 ORDER BY created_at DESC,id DESC LIMIT 5',[ctx.tenantId,id])).rows;
   return {
    id:row.id,lifecycle:row.lifecycle,stopReason:row.stop_reason,notificationState:row.notification_state,
    checksStarted:numeric(row.checks_started),notificationsReserved:numeric(row.notifications_reserved),
    maxChecks:numeric(row.max_checks),maxNotifications:numeric(row.max_notifications),
    intervalSeconds:numeric(row.interval_seconds),expiresAt:instant(row.expires_at),nextCheckAt:instant(row.next_check_at),
    policyHash:row.policy_hash,createdAt:instant(row.created_at),lastObservation:row.last_observation,lastValueHash:row.last_value_hash,
    lastCheckStartedAt:instant(row.last_check_started_at),lastNotificationAt:instant(row.last_notification_at),
    lastNotificationValueHash:row.last_notification_value_hash,checks,notifications,
   };
  });
 }
 async list(ctx:DbContext,limit=50){
  const size=Math.min(100,Math.max(1,Math.trunc(limit)));
  return this.db.scope(ctx,async c=>(await c.query('SELECT id,lifecycle,stop_reason,notification_state,checks_started,notifications_reserved,max_checks,max_notifications,next_check_at,expires_at,policy_hash,created_at FROM condition_watches WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',[ctx.tenantId,ctx.actorId,size])).rows.map(row=>({
   id:row.id,lifecycle:row.lifecycle,stopReason:row.stop_reason,notificationState:row.notification_state,
   checksStarted:numeric(row.checks_started),notificationsReserved:numeric(row.notifications_reserved),
   maxChecks:numeric(row.max_checks),maxNotifications:numeric(row.max_notifications),
   nextCheckAt:instant(row.next_check_at),expiresAt:instant(row.expires_at),policyHash:row.policy_hash,createdAt:instant(row.created_at),
  })));
 }
}
