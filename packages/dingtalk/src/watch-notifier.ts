import type {Database,DbContext} from '../../storage/src/database.js';
import type {WatchNotifier,WatchRenewalNotifier} from '../../watches/src/cycle.js';
import type {WatchNotificationOutcome} from '../../watches/src/store.js';
import type {SendResult} from './sender.js';

export interface WatchNotificationSender {
 sendProactive(
  target:{kind:'PRIVATE_USER';externalId:string},
  text:string,
  signal:AbortSignal,
  beforePhysical?:()=>Promise<boolean>,
 ):Promise<SendResult>;
}

type NotifyInput=Parameters<WatchNotifier['notify']>[1];
type RenewalInput=Parameters<WatchRenewalNotifier['notifyRenewal']>[1];
type Target={externalId:string};
/** DingTalk staff ids are opaque provider identifiers; only reject empty,
 * oversized or control-character values rather than guessing a grammar. */
const externalIdPattern=/^[^\u0000-\u001f\u007f]{1,512}$/;

/** Deterministic notification text from the persisted observation only. No
 * model call and no source fetch happens in the delivery path. */
export function renderWatchNotification(input:NotifyInput):string{
 const observation=input.observation;
 const value=observation.state==='OBSERVED'?JSON.stringify(observation.value):'UNKNOWN';
 return [
  '条件监控触发',
  `监控：${input.watchId}`,
  `条件：${input.predicate.operator} ${JSON.stringify(input.predicate.expected)}`,
  `观察值：${value}`,
  `观测时间：${observation.asOf}`,
  `通知：${input.notificationId}`,
 ].join('\n');
}

/** Advance warning for one finite watch. Renewal itself stays an explicit
 * owner action; this text never claims a new expiry or extended authority. */
export function renderWatchRenewal(input:RenewalInput):string{
 return [
  '条件监控即将到期',
  `监控：${input.watchId}`,
  `到期：${input.expiresAt}`,
  '到期后将停止检查，本监控不会自动续期。如需继续，请在到期前重新创建并绑定已认证数据来源。',
 ].join('\n');
}

/**
 * Sends one reserved condition-watch notification to the watch owner over the
 * existing proactive sender. Before dispatch it rechecks, under owner RLS, that
 * the exact notification is still PENDING for the same watch/policy/value, the
 * owner and tenant remain active, and the tenant still belongs to the bound
 * corporation. The guard runs again after token acquisition immediately before
 * the physical POST. Provider acceptance maps to APPLIED_UNVERIFIED, never to
 * CONFIRMED; a lost or ambiguous response stays UNKNOWN.
 */
export class DingTalkWatchNotifier implements WatchNotifier,WatchRenewalNotifier {
 constructor(
  private readonly db:Database,
  private readonly sender:WatchNotificationSender,
  private readonly binding:Readonly<{corpId:string}>,
 ){}

 private async current(ctx:DbContext,input:NotifyInput,signal:AbortSignal):Promise<Target|null>{
  signal.throwIfAborted();
  if(input.valueHash===null)return null;
  try{
   return await this.db.scope(ctx,async c=>{
    const row=(await c.query(
     `SELECT w.lifecycle,w.notification_state,w.policy_hash,
       n.state notification_state_row,n.value_hash notification_value_hash,
       u.external_user_id,u.status user_status,t.status tenant_status,t.corp_id
      FROM condition_watches w
      JOIN condition_watch_notifications n ON n.tenant_id=w.tenant_id AND n.watch_id=w.id AND n.id=$2
      JOIN users u ON u.tenant_id=w.tenant_id AND u.id=w.owner_id
      JOIN tenants t ON t.tenant_id=w.tenant_id
      WHERE w.tenant_id=$1 AND w.id=$3`,
     [ctx.tenantId,input.notificationId,input.watchId],
    )).rows[0] as Record<string,unknown>|undefined;
    if(!row)return null;
    if(row.lifecycle!=='ACTIVE'||row.notification_state!=='PENDING'||row.notification_state_row!=='PENDING')return null;
    if(row.policy_hash!==input.policyHash||row.notification_value_hash!==input.valueHash)return null;
    if(row.user_status!=='ACTIVE'||row.tenant_status!=='ACTIVE'||row.corp_id!==this.binding.corpId)return null;
    const externalId=row.external_user_id;
    if(typeof externalId!=='string'||!externalIdPattern.test(externalId))return null;
    return Object.freeze({externalId});
   });
  }catch{
   signal.throwIfAborted();
   return null;
  }
 }

 async notify(ctx:DbContext,input:NotifyInput,signal:AbortSignal):Promise<WatchNotificationOutcome>{
  signal.throwIfAborted();
  const target=await this.current(ctx,input,signal);
  signal.throwIfAborted();
  if(!target)return 'FAILED';
  const beforePhysical=async()=>{
   try{
    signal.throwIfAborted();
    const current=await this.current(ctx,input,signal);
    signal.throwIfAborted();
    return current!==null&&current.externalId===target.externalId;
   }catch{
    return false;
   }
  };
  let result:SendResult;
  try{
   result=await this.sender.sendProactive({kind:'PRIVATE_USER',externalId:target.externalId},renderWatchNotification(input),signal,beforePhysical);
  }catch{
   signal.throwIfAborted();
   return 'UNKNOWN';
  }
  if(result.state==='FAILED')return 'FAILED';
  if(result.state==='UNKNOWN')return 'UNKNOWN';
  if(result.state==='APPLIED_UNVERIFIED')return 'APPLIED_UNVERIFIED';
  return 'UNKNOWN';
 }

 private async currentRenewal(ctx:DbContext,input:RenewalInput,signal:AbortSignal):Promise<Target|null>{
  signal.throwIfAborted();
  try{
   return await this.db.scope(ctx,async c=>{
    const row=(await c.query(
     `SELECT w.lifecycle,w.policy_hash,w.expires_at,n.state,n.policy_hash renewal_policy_hash,n.expires_at renewal_expires_at,
       u.external_user_id,u.status user_status,t.status tenant_status,t.corp_id
      FROM condition_watch_renewal_notices n
      JOIN condition_watches w ON w.tenant_id=n.tenant_id AND w.id=n.watch_id AND w.owner_id=n.owner_id
      JOIN users u ON u.tenant_id=w.tenant_id AND u.id=w.owner_id
      JOIN tenants t ON t.tenant_id=w.tenant_id
      WHERE w.tenant_id=$1 AND w.id=$2 AND n.id=$3`,
     [ctx.tenantId,input.watchId,input.noticeId],
    )).rows[0] as Record<string,unknown>|undefined;
    if(!row)return null;
    if(row.lifecycle!=='ACTIVE'||row.state!=='PENDING')return null;
    if(row.policy_hash!==input.policyHash||row.renewal_policy_hash!==input.policyHash)return null;
    if(new Date(row.expires_at as Date).toISOString()!==input.expiresAt||new Date(row.renewal_expires_at as Date).toISOString()!==input.expiresAt)return null;
    if(row.user_status!=='ACTIVE'||row.tenant_status!=='ACTIVE'||row.corp_id!==this.binding.corpId)return null;
    const externalId=row.external_user_id;
    if(typeof externalId!=='string'||!externalIdPattern.test(externalId))return null;
    return Object.freeze({externalId});
   });
  }catch{
   signal.throwIfAborted();
   return null;
  }
 }

 /** Same authority recheck as condition notifications, but for the single
  * advance-expiry reservation. A cancelled, paused, expired or rebound watch
  * yields FAILED; provider acceptance remains APPLIED_UNVERIFIED. */
 async notifyRenewal(ctx:DbContext,input:RenewalInput,signal:AbortSignal):Promise<WatchNotificationOutcome>{
  signal.throwIfAborted();
  const target=await this.currentRenewal(ctx,input,signal);
  signal.throwIfAborted();
  if(!target)return 'FAILED';
  const beforePhysical=async()=>{
   try{
    signal.throwIfAborted();
    const current=await this.currentRenewal(ctx,input,signal);
    signal.throwIfAborted();
    return current!==null&&current.externalId===target.externalId;
   }catch{
    return false;
   }
  };
  let result:SendResult;
  try{
   result=await this.sender.sendProactive({kind:'PRIVATE_USER',externalId:target.externalId},renderWatchRenewal(input),signal,beforePhysical);
  }catch{
   signal.throwIfAborted();
   return 'UNKNOWN';
  }
  if(result.state==='FAILED')return 'FAILED';
  if(result.state==='UNKNOWN')return 'UNKNOWN';
  if(result.state==='APPLIED_UNVERIFIED')return 'APPLIED_UNVERIFIED';
  return 'UNKNOWN';
 }
}
