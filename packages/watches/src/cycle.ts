import {createHash} from 'node:crypto';
import type {DbContext} from '../../storage/src/database.js';
import {watchObservationSchema,type WatchObservation,type WatchPredicate} from './predicate.js';
import type {ConditionWatchStore,WatchClaim,WatchNotificationOutcome} from './store.js';

/** Every observation must come from a reviewed source adapter (for example a
 * company MCP template); the cycle itself never fetches, models or decides. */
export interface WatchObserver {
 observe(ctx:DbContext,input:Readonly<{watchId:string;policyHash:string;predicate:WatchPredicate}>,signal:AbortSignal):Promise<unknown>;
}
/** The sink performs one physical notification attempt. CONFIRMED means a
 * verified delivery, APPLIED_UNVERIFIED means the provider accepted it without
 * a delivery receipt, FAILED means no send happened, and UNKNOWN means it may
 * have been delivered. The notifier receives the owner scope so it can recheck
 * current authority instead of trusting the cycle's earlier claim. */
export interface WatchNotifier {
 notify(ctx:DbContext,input:Readonly<{watchId:string;notificationId:string;policyHash:string;predicate:WatchPredicate;observation:WatchObservation;valueHash:string|null}>,signal:AbortSignal):Promise<WatchNotificationOutcome>;
}
/** Advance expiry notices reuse the same guarded proactive sender and outcome
 * vocabulary, but never consume a check or condition-notification budget. */
export interface WatchRenewalNotifier {
 notifyRenewal(ctx:DbContext,input:Readonly<{watchId:string;noticeId:string;policyHash:string;expiresAt:string}>,signal:AbortSignal):Promise<WatchNotificationOutcome>;
}
export type WatchCycleSummary=Readonly<{
 scopes:number;completedScopes:number;failedScopes:number;claimed:number;checksCompleted:number;
 pending:number;settled:number;deferred:number;suppressed:number;stopped:number;swept:number;
}>;
function unavailable(watchId:string,reason:'SOURCE_UNAVAILABLE'|'SOURCE_ERROR',asOf:number):WatchObservation{
 const at=new Date(asOf).toISOString();
 return Object.freeze({schemaVersion:1 as const,state:'UNAVAILABLE' as const,reason,asOf:at,sourceHash:createHash('sha256').update(`anthys.watch.observation-unavailable.v1\0${watchId}\0${reason}\0${at}`).digest('hex')});
}
/** Failure never becomes an observed value: an adapter fault is recorded as
 * UNAVAILABLE so the pure policy suppresses it instead of notifying. */
async function observe(ctx:DbContext,claim:WatchClaim,observer:WatchObserver,now:()=>number,signal:AbortSignal):Promise<WatchObservation>{
 try{
  const raw=await observer.observe(ctx,Object.freeze({watchId:claim.watchId,policyHash:claim.policyHash,predicate:claim.policy.predicate}),signal);
  signal.throwIfAborted();
  const parsed=watchObservationSchema.safeParse(raw);
  return parsed.success?parsed.data:unavailable(claim.watchId,'SOURCE_ERROR',now());
 }catch{
  signal.throwIfAborted();
  return unavailable(claim.watchId,'SOURCE_UNAVAILABLE',now());
 }
}
/** One bounded pass over explicit owner scopes. Claims consume budget before
 * any external call; every reservation is settled here or left PENDING for an
 * explicit sweep. A failed owner cannot starve another owner's queue. */
export async function runWatchCycle(
 scopes:readonly DbContext[],
 store:ConditionWatchStore,
 options:Readonly<{observer:WatchObserver;notifier:WatchNotifier;now?:()=>number;claimLimit?:number;sweepAfterMs?:number;onFailure?:(index:number)=>void}>,
 signal:AbortSignal,
):Promise<WatchCycleSummary>{
 const now=options.now??Date.now,claimLimit=options.claimLimit??10,sweepAfterMs=options.sweepAfterMs??300_000;
 const counts={completedScopes:0,failedScopes:0,claimed:0,checksCompleted:0,pending:0,settled:0,deferred:0,suppressed:0,stopped:0,swept:0};
 for(const [index,ctx] of scopes.entries()){
  signal.throwIfAborted();
  try{
   counts.swept+=(await store.sweepUnconfirmed(ctx,sweepAfterMs)).length;
   for(const claim of await store.claimDue(ctx,claimLimit)){
    signal.throwIfAborted();
    counts.claimed++;
    const observation=await observe(ctx,claim,options.observer,now,signal);
    const result=await store.completeCheck(ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation});
    counts.checksCompleted++;
    if(result.status==='PENDING'&&result.notificationId===null)throw Error('WATCH_NOTIFICATION_ID_MISSING');
    if(result.status==='PENDING'&&result.notificationId!==null){
     counts.pending++;
     if(signal.aborted){
      // No physical attempt started, so FAILED is definite and does not block
      // the watch until the sweep timeout. Best effort during shutdown.
      await store.settleNotification(ctx,{notificationId:result.notificationId,outcome:'FAILED'}).catch(()=>{});
      signal.throwIfAborted();
     }
     let outcome:WatchNotificationOutcome='UNKNOWN';
     try{
      const reported=await options.notifier.notify(ctx,Object.freeze({watchId:claim.watchId,notificationId:result.notificationId,policyHash:claim.policyHash,predicate:claim.policy.predicate,observation,valueHash:result.valueHash}),signal);
      if(reported==='CONFIRMED'||reported==='APPLIED_UNVERIFIED'||reported==='FAILED'||reported==='UNKNOWN')outcome=reported;
     }catch{signal.throwIfAborted();outcome='UNKNOWN';}
     await store.settleNotification(ctx,{notificationId:result.notificationId,outcome});
     counts.settled++;
    }else if(result.status==='DEFERRED')counts.deferred++;
    else if(result.status==='SUPPRESSED')counts.suppressed++;
    else if(result.status==='STOPPED')counts.stopped++;
   }
   counts.completedScopes++;
  }catch{
   signal.throwIfAborted();
   counts.failedScopes++;options.onFailure?.(index);
  }
 }
 return Object.freeze({scopes:scopes.length,...counts});
}
export type WatchRenewalCycleSummary=Readonly<{
 scopes:number;completedScopes:number;failedScopes:number;claimed:number;settled:number;swept:number;
}>;
/** One bounded advance-notice pass over the same explicit owner scopes. The
 * watch never renews itself; this only warns the owner before expiry. */
export async function runWatchRenewalCycle(
 scopes:readonly DbContext[],
 store:ConditionWatchStore,
 options:Readonly<{notifier:WatchRenewalNotifier;now?:()=>number;horizonMs?:number;claimLimit?:number;sweepAfterMs?:number;onFailure?:(index:number)=>void}>,
 signal:AbortSignal,
):Promise<WatchRenewalCycleSummary>{
 const horizonMs=options.horizonMs??7*86_400_000,claimLimit=options.claimLimit??10,sweepAfterMs=options.sweepAfterMs??300_000;
 const counts={completedScopes:0,failedScopes:0,claimed:0,settled:0,swept:0};
 for(const [index,ctx] of scopes.entries()){
  signal.throwIfAborted();
  try{
   counts.swept+=(await store.sweepRenewals(ctx,sweepAfterMs)).length;
   for(const notice of await store.claimRenewals(ctx,horizonMs,claimLimit)){
    signal.throwIfAborted();
    counts.claimed++;
    let outcome:WatchNotificationOutcome='UNKNOWN';
    try{
     const reported=await options.notifier.notifyRenewal(ctx,Object.freeze({watchId:notice.watchId,noticeId:notice.noticeId,policyHash:notice.policyHash,expiresAt:notice.expiresAt}),signal);
     if(reported==='CONFIRMED'||reported==='APPLIED_UNVERIFIED'||reported==='FAILED'||reported==='UNKNOWN')outcome=reported;
    }catch{signal.throwIfAborted();outcome='UNKNOWN';}
    await store.settleRenewalNotification(ctx,{noticeId:notice.noticeId,outcome});
    counts.settled++;
   }
   counts.completedScopes++;
  }catch{
   signal.throwIfAborted();
   counts.failedScopes++;options.onFailure?.(index);
  }
 }
 return Object.freeze({scopes:scopes.length,...counts});
}
