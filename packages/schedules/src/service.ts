import {messageInput} from '../../dingtalk/src/message-input.js';
import {reminderCommand} from './commands.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {preview,ScheduleRuleError} from './rules.js';
import {ScheduleError,reminderPayload,createScheduleInput,scheduleListInput,scheduleEtag} from './model.js';
export function scheduleFailure(error:unknown):never{if(error instanceof ScheduleRuleError)throw new ScheduleError(error.code,400);if(error instanceof ScheduleError||error instanceof z.ZodError)throw error;throw new ScheduleError('SCHEDULE_UNAVAILABLE',503,{cause:error});}
export async function scheduleIdentity(c:pg.PoolClient,ctx:DbContext,sessionId?:string,allowLocalStop=false){
 if((await c.query("SELECT NOT public.oa_schedule_lifecycle_open() blocked")).rows[0].blocked)throw new ScheduleError('SCHEDULE_LIFECYCLE_BLOCKED');
 const row=(await c.query("SELECT u.auth_epoch,t.policy_version FROM users u JOIN tenants t ON t.tenant_id=u.tenant_id WHERE u.id=$1 AND u.status='ACTIVE' AND t.status='ACTIVE'",[ctx.actorId])).rows[0];if(!row)throw new ScheduleError('SCHEDULE_IDENTITY_INACTIVE');
 if(sessionId&&!(await c.query('SELECT id FROM sessions WHERE id=$1 AND owner_id=$2 AND auth_epoch=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[sessionId,ctx.actorId,row.auth_epoch])).rowCount)throw new ScheduleError('SCHEDULE_SESSION_INVALID',401);
 if(!allowLocalStop&&(await c.query("SELECT id FROM kill_switches WHERE enabled AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (scope_kind='TENANT' AND scope_id=$1 OR scope_kind='USER' AND scope_id=$2 OR scope_kind='CONNECTOR' AND scope_id IN ('CORE','SCHEDULER','DINGTALK_API')) LIMIT 1",[ctx.tenantId,ctx.actorId])).rowCount)throw new ScheduleError('SCHEDULE_STOPPED');
 return {authEpoch:Number(row.auth_epoch),policyVersion:row.policy_version as string};
}
export async function scheduleAudit(c:pg.PoolClient,ctx:DbContext,row:pg.QueryResultRow,operation:string){await c.query('INSERT INTO schedule_events(tenant_id,id,owner_id,schedule_id,revision,operation,state,payload_ref,payload_hash,next_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.tenantId,randomUUID(),ctx.actorId,row.id,row.revision,operation,row.state,JSON.stringify(row.payload_ref),row.payload_hash,row.next_due_at]);}
export async function revokeSchedule(c:pg.PoolClient,id:string){
 await c.query("UPDATE schedule_occurrences SET state='REVOKED',updated_at=clock_timestamp() WHERE schedule_id=$1 AND state IN ('QUEUED','STAGED')",[id]);
   await c.query("UPDATE deliveries SET state='SUPPRESSED',last_error='SCHEDULE_REVISION_REVOKED' WHERE id IN (SELECT delivery_id FROM schedule_occurrences WHERE schedule_id=$1) AND state='PENDING'",[id]);
   await c.query("UPDATE tasks SET status='CANCELLED',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) WHERE id IN (SELECT task_id FROM schedule_occurrences WHERE schedule_id=$1) AND control_kind='REMINDER' AND status IN ('OPEN','ACTIVE')",[id]);
   await c.query("UPDATE runs SET status='CANCELLED' WHERE id IN (SELECT run_id FROM schedule_occurrences WHERE schedule_id=$1) AND status='WAITING_USER'",[id]);
 await c.query("UPDATE outbox SET published_at=clock_timestamp() WHERE kind='SCHEDULE' AND aggregate_id IN (SELECT id FROM schedule_occurrences WHERE schedule_id=$1 AND state='REVOKED') AND published_at IS NULL",[id]);
}
export type ScheduleInboxResult={outcome:'CREATED'|'PAUSED'|'CANCELLED'|'CLARIFY'|'DENIED';scheduleId:string|null;revision:number|null;dueAt:string|null;tz:string|null;notice:string};
export class Schedules {
 constructor(readonly db:Database,readonly vault:Vault,readonly clock:()=>number=Date.now){}
 aad(ctx:DbContext,id:string){return `${ctx.tenantId}:${ctx.actorId}:schedule:${id}`;}
 open(ctx:DbContext,row:pg.QueryResultRow){try{const text=this.vault.open(row.payload_ref as Sealed,this.aad(ctx,row.id as string));if(hash(text)!==row.payload_hash)throw Error('HASH_MISMATCH');return reminderPayload.parse(JSON.parse(text));}catch(error){throw new ScheduleError('SCHEDULE_INTEGRITY',503,{cause:error});}}
 async transaction<T>(p:DbContext,signal:AbortSignal|undefined,fn:(c:pg.PoolClient)=>Promise<T>){
  if(signal?.aborted)throw new ScheduleError('SCHEDULE_CANCELLED',409);
  try{return await this.db.scope(p,async c=>{await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='12s'");signal?.throwIfAborted();const result=await fn(c);signal?.throwIfAborted();return result;});}catch(error){if(signal?.aborted)throw new ScheduleError('SCHEDULE_CANCELLED',409);scheduleFailure(error);}
 }
 async view(c:pg.PoolClient,p:DbContext,row:pg.QueryResultRow){
  const payload=this.open(p,row),last=(await c.query("SELECT o.scheduled_at,o.task_id,o.state,d.state delivery_state FROM schedule_occurrences o LEFT JOIN deliveries d ON d.tenant_id=o.tenant_id AND d.id=o.delivery_id WHERE o.schedule_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT 1",[row.id])).rows[0];
  return {id:row.id as string,ownerId:row.owner_id as string,revision:Number(row.revision),etag:scheduleEtag(row.id as string,Number(row.revision)),state:row.state as string,...payload,nextDueAt:row.next_due_at?(row.next_due_at as Date).toISOString():null,createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString(),lastOccurrence:last?{scheduledAt:(last.scheduled_at as Date).toISOString(),taskId:last.task_id as string|null,deliveryState:last.delivery_state??(last.state==='MISSED'?'MISSED':last.state==='REVOKED'?'SUPPRESSED':'PENDING'),verification:'UNVERIFIED' as const}:null};
 }
 async preview(p:Principal,raw:unknown,signal?:AbortSignal){const input=z.object({rule:reminderPayload.shape.rule}).strict().parse(raw);return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId);const asOf=new Date(this.clock()).toISOString(),rule=input.rule;if(rule.misfire.kind!=='REMINDER_LATEST'||rule.businessCalendar)throw new ScheduleError('PRIVATE_REMINDER_RULE_REQUIRED',400);return {rule,preview:preview(rule,{now:asOf}),asOf};});}
 async list(p:Principal,raw:unknown,signal?:AbortSignal){const q=scheduleListInput.parse(raw);return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId);const rows=(await c.query('SELECT * FROM schedules WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[q.cursor??null,q.limit+1])).rows,items=[];for(const row of rows.slice(0,q.limit))items.push(await this.view(c,p,row));return {items,nextCursor:rows.length>q.limit?rows[q.limit-1]!.id as string:null,asOf:new Date(this.clock()).toISOString()};});}
 async get(p:Principal,id:string,signal?:AbortSignal){z.uuid().parse(id);return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId);const row=(await c.query('SELECT * FROM schedules WHERE id=$1',[id])).rows[0];if(!row)throw new ScheduleError('SCHEDULE_NOT_FOUND',404);const asOf=new Date(this.clock()).toISOString();return {schedule:await this.view(c,p,row),preview:preview(this.open(p,row).rule,{now:asOf}),asOf};});}
 private async prior(c:pg.PoolClient,p:DbContext,key:string,intent:string){
  const row=(await c.query('SELECT * FROM schedule_requests WHERE id=$1',[key])).rows[0];if(!row)return null;if(row.intent_hash!==intent)throw new ScheduleError('SCHEDULE_REQUEST_CONFLICT',409);const schedule=(await c.query('SELECT * FROM schedules WHERE id=$1',[row.schedule_id])).rows[0];if(!schedule)throw new ScheduleError('SCHEDULE_INTEGRITY',503);return {schedule:await this.view(c,p,schedule),replayed:true};
 }
 private async receipt(c:pg.PoolClient,p:DbContext,key:string,id:string,intent:string){await c.query('INSERT INTO schedule_requests(tenant_id,id,owner_id,schedule_id,intent_hash) VALUES($1,$2,$3,$4,$5)',[p.tenantId,key,p.actorId,id,intent]);}
 async applyInbox(c:pg.PoolClient,ctx:DbContext,eventId:string,binding:{corpId:string;robotCode:string}):Promise<ScheduleInboxResult>{
  const row=(await c.query("SELECT e.payload_cipher_ref,t.corp_id,t.timezone,u.external_user_id FROM event_inbox e JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.owner_id JOIN tenants t ON t.tenant_id=e.tenant_id WHERE e.id=$1 AND e.owner_id=$2 AND e.source='DINGTALK' AND e.state='RECEIVED'",[eventId,ctx.actorId])).rows[0];if(!row)throw new ScheduleError('SCHEDULE_INBOX_INVALID');
  const event=JSON.parse(this.vault.open(JSON.parse(row.payload_cipher_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:inbox:${eventId}`)),input=messageInput(event);
  if(event.conversationType!=='1'||event.msgtype!=='text'||event.senderStaffId!==row.external_user_id||event.senderCorpId!==row.corp_id||event.chatbotCorpId!==row.corp_id||row.corp_id!==binding.corpId||event.robotCode!==binding.robotCode||input.attachments.length)throw new ScheduleError('SCHEDULE_INBOX_INVALID');
  const empty={scheduleId:null,revision:null,dueAt:null,tz:null};
  if(!Number.isSafeInteger(event.createAt)||Math.abs(this.clock()-Number(event.createAt))>300000)return {...empty,outcome:'CLARIFY',notice:'收到的提醒请求已延迟。请重述包含绝对日期、时间和时区的请求，避免把旧的相对时间改成新的日期。'};
  const command=reminderCommand(input.goal,{now:new Date(this.clock()).toISOString(),tz:row.timezone as string});if(!command)throw new ScheduleError('SCHEDULE_INBOX_INVALID');
  if(command.operation==='CLARIFY')return {...empty,outcome:'CLARIFY',notice:command.notice};
  await c.query('SAVEPOINT schedule_command');
  try{
   await scheduleIdentity(c,ctx,undefined,command.operation!=='CREATE');
   if(command.operation==='CREATE'){const saved=await this.register(c,ctx,{text:command.text,rule:command.rule},eventId),rule=saved.schedule.rule,future=preview(rule,{now:new Date(this.clock()).toISOString()}),workdays=rule.kind==='RRULE'&&rule.rrule.byWeekday?.join(',')==='MO,TU,WE,TH,FR';
    const notice=(workdays?'工作日仅按周一至周五，未使用企业法定调休日历。\n':'')+'未来规则候选：'+future.occurrences.map(item=>`${item.local}（UTC ${item.utc}）`).join('；')+'。不存在的本地时刻会跳过；重复时刻只取较早一次。投递结果以实际回执为准。';await c.query('RELEASE SAVEPOINT schedule_command');return {outcome:'CREATED',scheduleId:saved.schedule.id,revision:saved.schedule.revision,dueAt:saved.schedule.nextDueAt,tz:rule.tz,notice};}
   const prior=(await c.query('SELECT * FROM schedules WHERE id=$1 FOR UPDATE',[command.id])).rows[0];if(!prior)throw new ScheduleError('SCHEDULE_NOT_FOUND',404);
   if(command.operation==='CANCEL'){const updated=await this.stopLocal(c,ctx,command.id,scheduleEtag(command.id,Number(prior.revision)),eventId);await c.query('RELEASE SAVEPOINT schedule_command');return {outcome:'CANCELLED',scheduleId:updated.stopped.id,revision:updated.stopped.revision,dueAt:null,tz:null,notice:'停止不表示撤回在途或已发送消息；无需解密提醒正文。'};}
   if(prior.state==='PAUSED'){const tz=this.open(ctx,prior).rule.tz;await c.query('RELEASE SAVEPOINT schedule_command');return {outcome:'PAUSED',scheduleId:prior.id as string,revision:Number(prior.revision),dueAt:null,tz,notice:'这是当前已登记的停止状态，没有恢复或再次执行。'};}
   const updated=await this.mutateLocal(c,ctx,command.id,'PAUSE',{},scheduleEtag(command.id,Number(prior.revision)),eventId);await c.query('RELEASE SAVEPOINT schedule_command');return {outcome:'PAUSED',scheduleId:updated.schedule.id,revision:updated.schedule.revision,dueAt:null,tz:updated.schedule.rule.tz,notice:'在途外部消息可能已经发生，停止状态不表示撤回已发送内容。'};
  }catch(error){await c.query('ROLLBACK TO SAVEPOINT schedule_command');await c.query('RELEASE SAVEPOINT schedule_command');if(!(error instanceof ScheduleError)||error.status>=500)throw error;return {...empty,outcome:'DENIED',notice:'当前身份、目标、规则或授权条件不允许登记这项提醒操作。没有创建、恢复或发送提醒，请在本人工作台核对当前状态。'};}
 }
 async create(p:Principal,raw:unknown,key:string,signal?:AbortSignal){const {kind:_kind,...payload}=createScheduleInput.parse(raw);z.uuid().parse(key);return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId);return this.register(c,p,payload,key);});}
 private async register(c:pg.PoolClient,p:DbContext,raw:unknown,key:string){const payload=reminderPayload.parse(raw),intent=hash(canonical({operation:'CREATE',payload}));z.uuid().parse(key);
  const identity=await scheduleIdentity(c,p);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:schedule-request:${key}`]);const prior=await this.prior(c,p,key,intent);if(prior)return prior;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:schedule-owner-limit`]);
  const due=preview(payload.rule,{now:new Date(this.clock()).toISOString(),limit:1}).occurrences[0];if(!due)throw new ScheduleError('SCHEDULE_FUTURE_TIME_REQUIRED',400);
  const count=(await c.query("SELECT count(*)::int n FROM schedules WHERE state IN ('ACTIVE','PAUSED')")).rows[0].n as number;if(count>=100)throw new ScheduleError('SCHEDULE_OWNER_LIMIT',429);
  const id=randomUUID(),text=canonical(payload),row=(await c.query("INSERT INTO schedules(tenant_id,id,owner_id,payload_ref,payload_hash,auth_epoch,policy_version,state,next_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8) RETURNING *",[p.tenantId,id,p.actorId,JSON.stringify(this.vault.seal(text,this.aad(p,id))),hash(text),identity.authEpoch,identity.policyVersion,due.utc])).rows[0];await this.receipt(c,p,key,id,intent);await scheduleAudit(c,p,row,'CREATE');return {schedule:await this.view(c,p,row),replayed:false};

 }
 async cancel(p:Principal,id:string,raw:unknown,etag:string,key:string,signal?:AbortSignal){z.uuid().parse(id);z.uuid().parse(key);z.object({}).strict().parse(raw);return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId,true);return this.stopLocal(c,p,id,etag,key);});}
 private async stopLocal(c:pg.PoolClient,p:DbContext,id:string,etag:string,key:string){
  await scheduleIdentity(c,p,undefined,true);const intent=hash(canonical({id,operation:'CANCEL',payload:{},etag}));await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:schedule-request:${key}`]);
  const prior=(await c.query('SELECT * FROM schedule_requests WHERE id=$1',[key])).rows[0];if(prior&&(prior.intent_hash!==intent||prior.schedule_id!==id))throw new ScheduleError('SCHEDULE_REQUEST_CONFLICT',409);
  let row=(await c.query('SELECT * FROM schedules WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ScheduleError('SCHEDULE_NOT_FOUND',404);
  if(!prior){if(etag!==scheduleEtag(id,Number(row.revision)))throw new ScheduleError('SCHEDULE_REVISION_CONFLICT',409);await revokeSchedule(c,id);if(row.state!=='CANCELLED'){row=(await c.query("UPDATE schedules SET state='CANCELLED',revision=revision+1,next_due_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[id])).rows[0];await scheduleAudit(c,p,row,'CANCEL');}await this.receipt(c,p,key,id,intent);}
  if(row.state!=='CANCELLED')throw new ScheduleError('SCHEDULE_INTEGRITY',503);
  return {stopped:{id:row.id as string,ownerId:row.owner_id as string,revision:Number(row.revision),etag:scheduleEtag(id,Number(row.revision)),state:'CANCELLED' as const},replayed:!!prior};
 }
 async mutate(p:Principal,id:string,operation:'EDIT'|'PAUSE'|'RESUME',raw:unknown,etag:string,key:string,signal?:AbortSignal){
  z.uuid().parse(id);z.uuid().parse(key);const payload=operation==='EDIT'?reminderPayload.parse(raw):z.object({}).strict().parse(raw);
  return this.transaction(p,signal,async c=>{await scheduleIdentity(c,p,p.sessionId,operation==='PAUSE');return this.mutateLocal(c,p,id,operation,payload,etag,key);});
 }
 private async mutateLocal(c:pg.PoolClient,p:DbContext,id:string,operation:'EDIT'|'PAUSE'|'RESUME',payload:unknown,etag:string,key:string){const intent=hash(canonical({id,operation,payload,etag}));
const identity=await scheduleIdentity(c,p,undefined,operation==='PAUSE');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${p.actorId}:schedule-request:${key}`]);const prior=await this.prior(c,p,key,intent);if(prior)return prior;
   const row=(await c.query('SELECT * FROM schedules WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ScheduleError('SCHEDULE_NOT_FOUND',404);if(etag!==scheduleEtag(id,Number(row.revision)))throw new ScheduleError('SCHEDULE_REVISION_CONFLICT',409);
   if((row.state==='CANCELLED'||row.state==='BLOCKED')||operation==='RESUME'&&row.state!=='PAUSED'||operation==='PAUSE'&&row.state!=='ACTIVE'||operation==='EDIT'&&row.state==='COMPLETED')throw new ScheduleError('SCHEDULE_TRANSITION_DENIED',409);
   if(Number(row.auth_epoch)!==identity.authEpoch||row.policy_version!==identity.policyVersion)throw new ScheduleError('SCHEDULE_AUTHORITY_CHANGED');
   const current=operation==='EDIT'?reminderPayload.parse(payload):this.open(p,row),state=operation==='PAUSE'?'PAUSED':row.state==='PAUSED'&&operation==='EDIT'?'PAUSED':'ACTIVE';
   const due=state==='ACTIVE'?preview(current.rule,{now:new Date(this.clock()).toISOString(),limit:1}).occurrences[0]?.utc:null;if(state==='ACTIVE'&&!due)throw new ScheduleError('SCHEDULE_FUTURE_TIME_REQUIRED',400);
   await revokeSchedule(c,id);
   const text=canonical(current),updated=(await c.query('UPDATE schedules SET revision=revision+1,state=$2,next_due_at=$3,payload_ref=$4,payload_hash=$5,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',[id,state,due??null,JSON.stringify(this.vault.seal(text,this.aad(p,id))),hash(text)])).rows[0];await this.receipt(c,p,key,id,intent);await scheduleAudit(c,p,updated,operation);return {schedule:await this.view(c,p,updated),replayed:false};
 }

}
