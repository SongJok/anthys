import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {ConditionWatchStore} from '../../packages/watches/src/store.js';
import {DingTalkWatchNotifier,renderWatchNotification,renderWatchRenewal,type WatchNotificationSender} from '../../packages/dingtalk/src/watch-notifier.js';
import type {SendResult} from '../../packages/dingtalk/src/sender.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
afterAll(async()=>{await db.close();await root.end();});
const start=Date.parse('2026-10-20T10:00:00.000Z'),sourceHash='a'.repeat(64);
function policy(){
 return {schemaVersion:1 as const,predicate:{schemaVersion:1 as const,operator:'GT' as const,expected:10},tz:'UTC',validFrom:new Date(start).toISOString(),expiresAt:new Date(start+86_400_000).toISOString(),intervalSeconds:300,cooldownSeconds:0,maxChecks:5,maxNotifications:2,quietWindow:null,misfire:'MONITOR_CURRENT' as const,notificationRule:'VALUE_CHANGE_ONLY' as const};
}
const observation={schemaVersion:1 as const,state:'OBSERVED' as const,value:15,asOf:new Date(start).toISOString(),sourceHash};
async function world(){
 const tenantId=randomUUID(),actorId=randomUUID(),otherId=randomUUID(),corpId='synthetic-watch-corp-'+tenantId;
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic watch notifier','ACTIVE','UTC')",[tenantId,corpId]);
 for(const id of [actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic watch notifier owner','ACTIVE')",[tenantId,id,'synthetic-watch-'+id]);
 let now=start;
 const store=new ConditionWatchStore(db,()=>now);
 return {tenantId,actorId,corpId,ctx:{tenantId,actorId},other:{tenantId,actorId:otherId},store,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
async function reserve(w:Awaited<ReturnType<typeof world>>){
 const p=policy(),created=await w.store.create(w.ctx,p),claim=(await w.store.claimDue(w.ctx))[0]!;
 const result=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation});
 if(result.status!=='PENDING'||result.notificationId===null)throw Error('SYNTHETIC_NOTIFICATION_NOT_RESERVED');
 return {policy:p,created,result,input:{watchId:created.watchId,notificationId:result.notificationId,policyHash:created.policyHash,predicate:p.predicate,observation,valueHash:result.valueHash}};
}
type Sent={target:{kind:string;externalId:string};text:string;guard:boolean|null};
function senderFor(reply:SendResult|(()=>Promise<SendResult>),hook?:()=>Promise<void>){
 const sent:Sent[]=[];
 const sender:WatchNotificationSender={
  sendProactive:async(target,text,_signal,beforePhysical)=>{
   let guard:boolean|null=null;
   if(beforePhysical){await hook?.();guard=await beforePhysical();if(!guard)return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};}
   sent.push({target,text,guard});
   return typeof reply==='function'?reply():reply;
  },
 };
 return {sender,sent};
}

it('T055/T058 sends one reserved notification to the live owner and records provider acceptance without claiming delivery',async()=>{
 const w=await world(),r=await reserve(w),{sender,sent}=senderFor({state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-provider-receipt',requestId:'synthetic-request'});
 const notifier=new DingTalkWatchNotifier(db,sender,{corpId:w.corpId});
 await expect(notifier.notify(w.ctx,r.input,new AbortController().signal)).resolves.toBe('APPLIED_UNVERIFIED');
 expect(sent).toHaveLength(1);
 expect(sent[0]).toMatchObject({target:{kind:'PRIVATE_USER',externalId:'synthetic-watch-'+w.actorId},guard:true});
 expect(sent[0]!.text).toContain('GT 10');
 expect(sent[0]!.text).toContain('15');
 expect(sent[0]!.text).toContain(r.created.watchId);
 expect(sent[0]!.text).toContain(r.result.notificationId!);
 expect(sent[0]!.text).toBe(renderWatchNotification(r.input));
 await expect(w.store.settleNotification(w.ctx,{notificationId:r.result.notificationId!,outcome:'APPLIED_UNVERIFIED'})).resolves.toMatchObject({state:'APPLIED_UNVERIFIED',changed:true});
 expect(await w.store.get(w.ctx,r.created.watchId)).toMatchObject({notificationState:'IDLE',notificationsReserved:1,nextCheckAt:new Date(start+300_000).toISOString()});
 expect((await w.store.get(w.ctx,r.created.watchId))!.notifications[0]).toMatchObject({id:r.result.notificationId,state:'APPLIED_UNVERIFIED'});
 await expect(w.store.settleNotification(w.ctx,{notificationId:r.result.notificationId!,outcome:'APPLIED_UNVERIFIED'})).resolves.toMatchObject({state:'APPLIED_UNVERIFIED',changed:false});
 await expect(w.store.settleNotification(w.ctx,{notificationId:r.result.notificationId!,outcome:'CONFIRMED'})).rejects.toThrow('WATCH_NOTIFICATION_ALREADY_SETTLED');
});

it('T058 keeps FAILED definite and UNKNOWN blocking, while explicit reconciliation may accept provider evidence',async()=>{
 const w=await world(),first=await reserve(w),none=senderFor({state:'FAILED',reason:'TOKEN_UNAVAILABLE'}),notifier=new DingTalkWatchNotifier(db,none.sender,{corpId:w.corpId});
 await expect(notifier.notify(w.ctx,first.input,new AbortController().signal)).resolves.toBe('FAILED');
 await w.store.settleNotification(w.ctx,{notificationId:first.result.notificationId!,outcome:'FAILED'});
 expect(await w.store.get(w.ctx,first.created.watchId)).toMatchObject({notificationState:'IDLE',nextCheckAt:new Date(start+300_000).toISOString()});
 w.advance(300_000);
 const at=new Date(w.now()).toISOString(),p=policy(),claim=(await w.store.claimDue(w.ctx))[0]!,observed={...observation,value:20,asOf:at},second=await w.store.completeCheck(w.ctx,{watchId:claim.watchId,checkId:claim.checkId,fence:claim.fence,observation:observed});
 expect(second.status).toBe('PENDING');
 const lost=senderFor({state:'UNKNOWN',reason:'RESPONSE_LOST'}),secondNotifier=new DingTalkWatchNotifier(db,lost.sender,{corpId:w.corpId});
 await expect(secondNotifier.notify(w.ctx,{watchId:first.created.watchId,notificationId:second.notificationId!,policyHash:first.created.policyHash,predicate:p.predicate,observation:observed,valueHash:second.valueHash},new AbortController().signal)).resolves.toBe('UNKNOWN');
 await w.store.settleNotification(w.ctx,{notificationId:second.notificationId!,outcome:'UNKNOWN'});
 expect(await w.store.get(w.ctx,first.created.watchId)).toMatchObject({notificationState:'UNKNOWN',nextCheckAt:null});
 await expect(w.store.settleNotification(w.ctx,{notificationId:second.notificationId!,outcome:'APPLIED_UNVERIFIED'})).resolves.toMatchObject({state:'APPLIED_UNVERIFIED',changed:true});
 expect(await w.store.get(w.ctx,first.created.watchId)).toMatchObject({notificationState:'IDLE'});
});

it('T055 rejects stale, foreign, inactive or mismatched reservations before any physical send and honours abort',async()=>{
 const w=await world(),r=await reserve(w),{sender,sent}=senderFor({state:'APPLIED_UNVERIFIED'}),notifier=new DingTalkWatchNotifier(db,sender,{corpId:w.corpId}),signal=()=>new AbortController().signal;
 await expect(notifier.notify(w.ctx,{...r.input,policyHash:'b'.repeat(64)},signal())).resolves.toBe('FAILED');
 await expect(notifier.notify(w.ctx,{...r.input,valueHash:'c'.repeat(64)},signal())).resolves.toBe('FAILED');
 await expect(notifier.notify(w.ctx,{...r.input,notificationId:randomUUID()},signal())).resolves.toBe('FAILED');
 await expect(notifier.notify(w.ctx,{...r.input,watchId:randomUUID()},signal())).resolves.toBe('FAILED');
 await expect(notifier.notify(w.other,r.input,signal())).resolves.toBe('FAILED');
 await root.query("UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId]);
 await expect(notifier.notify(w.ctx,r.input,signal())).resolves.toBe('FAILED');
 await root.query("UPDATE users SET status='ACTIVE' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId]);
 await root.query("UPDATE tenants SET status='SUSPENDED' WHERE tenant_id=$1",[w.tenantId]);
 await expect(notifier.notify(w.ctx,r.input,signal())).resolves.toBe('FAILED');
 await root.query("UPDATE tenants SET status='ACTIVE',corp_id=$2 WHERE tenant_id=$1",[w.tenantId,'synthetic-foreign-corp-'+w.tenantId]);
 await expect(notifier.notify(w.ctx,r.input,signal())).resolves.toBe('FAILED');
 await root.query("UPDATE tenants SET corp_id=$2 WHERE tenant_id=$1",[w.tenantId,w.corpId]);
 expect(sent).toHaveLength(0);
 const aborted=new AbortController();aborted.abort();
 await expect(notifier.notify(w.ctx,r.input,aborted.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(sent).toHaveLength(0);
 expect(await w.store.get(w.ctx,r.created.watchId)).toMatchObject({notificationState:'PENDING'});
 await expect(notifier.notify(w.ctx,r.input,signal())).resolves.toBe('APPLIED_UNVERIFIED');
 expect(sent).toHaveLength(1);
});

it('T058 rechecks the owner and reservation after token acquisition and before the physical send',async()=>{
 const w=await world(),r=await reserve(w);
 const suspended=senderFor({state:'APPLIED_UNVERIFIED'},async()=>{await root.query("UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId]);});
 await expect(new DingTalkWatchNotifier(db,suspended.sender,{corpId:w.corpId}).notify(w.ctx,r.input,new AbortController().signal)).resolves.toBe('FAILED');
 expect(suspended.sent).toHaveLength(0);
 await root.query("UPDATE users SET status='ACTIVE',external_user_id=$3 WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId,'synthetic-rebound-'+w.actorId]);
 const rebound=senderFor({state:'APPLIED_UNVERIFIED'});
 await expect(new DingTalkWatchNotifier(db,rebound.sender,{corpId:w.corpId}).notify(w.ctx,r.input,new AbortController().signal)).resolves.toBe('APPLIED_UNVERIFIED');
 expect(rebound.sent[0]?.target.externalId).toBe('synthetic-rebound-'+w.actorId);
 const changed=senderFor({state:'APPLIED_UNVERIFIED'},async()=>{await root.query('UPDATE users SET external_user_id=$3 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.actorId,'synthetic-moved-'+w.actorId]);});
 await w.store.settleNotification(w.ctx,{notificationId:r.result.notificationId!,outcome:'UNKNOWN'});
 expect(await w.store.settleNotification(w.ctx,{notificationId:r.result.notificationId!,outcome:'FAILED'})).toMatchObject({state:'FAILED'});
 const second=await reserve(w);
 const moved=senderFor({state:'APPLIED_UNVERIFIED'},async()=>{await root.query('UPDATE users SET external_user_id=$3 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.actorId,'synthetic-moved-'+w.actorId]);});
 await expect(new DingTalkWatchNotifier(db,moved.sender,{corpId:w.corpId}).notify(w.ctx,second.input,new AbortController().signal)).resolves.toBe('FAILED');
 expect(moved.sent).toHaveLength(0);
 const foreignNotifier=new DingTalkWatchNotifier(db,changed.sender,{corpId:'synthetic-other-corp'});
 await expect(foreignNotifier.notify(w.ctx,second.input,new AbortController().signal)).resolves.toBe('FAILED');
});

it('R12 advance renewal warns the live owner once before expiry, never extends it and refuses a watch cancelled before the guarded send',async()=>{
 const w=await world(),expiresAt=new Date(start+30*86_400_000).toISOString(),created=await w.store.create(w.ctx,{...policy(),expiresAt});
 w.advance(23*86_400_000);
 const notice=(await w.store.claimRenewals(w.ctx,7*86_400_000))[0]!;
 const input={watchId:created.watchId,noticeId:notice.noticeId,policyHash:created.policyHash,expiresAt};
 const {sender,sent}=senderFor({state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-renewal-receipt',requestId:'synthetic-renewal-request'});
 const notifier=new DingTalkWatchNotifier(db,sender,{corpId:w.corpId});
 await expect(notifier.notifyRenewal(w.ctx,input,new AbortController().signal)).resolves.toBe('APPLIED_UNVERIFIED');
 expect(sent).toHaveLength(1);
 expect(sent[0]).toMatchObject({target:{kind:'PRIVATE_USER',externalId:'synthetic-watch-'+w.actorId},guard:true});
 expect(sent[0]!.text).toContain(created.watchId);expect(sent[0]!.text).toContain(expiresAt);expect(sent[0]!.text).toContain('不会自动续期');
 expect(sent[0]!.text).toBe(renderWatchRenewal(input));
 await w.store.settleRenewalNotification(w.ctx,{noticeId:notice.noticeId,outcome:'APPLIED_UNVERIFIED'});
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({lifecycle:'ACTIVE',expiresAt,checksStarted:0,notificationsReserved:0,notificationState:'IDLE'});
 await expect(notifier.notifyRenewal(w.ctx,input,new AbortController().signal)).resolves.toBe('FAILED');
 expect(sent).toHaveLength(1);
 const cancelled=await world(),cancelledPolicy={...policy(),expiresAt},cancelledWatch=await cancelled.store.create(cancelled.ctx,cancelledPolicy);
 cancelled.advance(23*86_400_000);
 const cancelledNotice=(await cancelled.store.claimRenewals(cancelled.ctx,7*86_400_000))[0]!;
 await cancelled.store.cancel(cancelled.ctx,cancelledWatch.watchId);
 const cancelledSender=senderFor({state:'APPLIED_UNVERIFIED'});
 await expect(new DingTalkWatchNotifier(db,cancelledSender.sender,{corpId:cancelled.corpId}).notifyRenewal(cancelled.ctx,{watchId:cancelledWatch.watchId,noticeId:cancelledNotice.noticeId,policyHash:cancelledWatch.policyHash,expiresAt},new AbortController().signal)).resolves.toBe('FAILED');
 expect(cancelledSender.sent).toHaveLength(0);
 const guarded=await world(),guardedWatch=await guarded.store.create(guarded.ctx,{...policy(),expiresAt});
 guarded.advance(23*86_400_000);
 const guardedNotice=(await guarded.store.claimRenewals(guarded.ctx,7*86_400_000))[0]!;
 const guardedSender=senderFor({state:'APPLIED_UNVERIFIED'},async()=>{await guarded.store.cancel(guarded.ctx,guardedWatch.watchId);});
 await expect(new DingTalkWatchNotifier(db,guardedSender.sender,{corpId:guarded.corpId}).notifyRenewal(guarded.ctx,{watchId:guardedWatch.watchId,noticeId:guardedNotice.noticeId,policyHash:guardedWatch.policyHash,expiresAt},new AbortController().signal)).resolves.toBe('FAILED');
 expect(guardedSender.sent).toHaveLength(0);
});
