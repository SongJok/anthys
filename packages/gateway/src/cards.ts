import {killed} from './controls.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import type {CardTemplate,CardTransport,CardResult} from '../../dingtalk/src/cards.js';
import {cardCancellationHash} from '../../dingtalk/src/card-actions.js';
const targetSchema=z.object({kind:z.enum(['PRIVATE_USER','GROUP']),targetId:z.string(),membershipVersion:z.number().optional()}).passthrough();
const statuses:Record<string,string>={OPEN:'任务已接收',ACTIVE:'正在处理',COMPLETED:'处理完成，请在个人工作台查看结果',CANCELLED:'任务已停止',EXPIRED:'任务已到期'};
export function safeStreamStatus(taskStatus:string,runStatus:unknown,phase:unknown,fragments:unknown):string {
 if(taskStatus!=='ACTIVE')return statuses[taskStatus]??'任务状态已更新';
 const waiting:Record<string,string>={WAITING_AUTH:'等待补充授权',WAITING_APPROVAL:'等待审批',WAITING_USER:'等待你核对未决事项',RETRY_SCHEDULED:'连接中断，等待受控重试',PARTIAL:'本轮处理未完成，请在个人工作台查看原因',FAILED:'本轮处理失败，请在个人工作台查看原因'};if(typeof runStatus==='string'&&waiting[runStatus])return waiting[runStatus]!;
 if(phase==='STARTED')return '正在等待模型回复';if(phase==='RECEIVING')return `正在接收回复片段（${/^\d+$/.test(String(fragments))?String(fragments):'0'}），内容尚未核验`;if(phase==='COMPLETE')return '模型返回已接收，正在核对结果';if(phase==='INTERRUPTED')return '连接中断，等待受控恢复';return statuses[taskStatus]!;
}
export class CardCoordinator {
 private scanCursors=new Map<string,string>();
 constructor(private db:Database,private vault:Vault,private transport:CardTransport,private binding:{corpId:string;appOrigin:string;template:CardTemplate},private clock:()=>number=Date.now){}
 private async task(ctx:DbContext,taskId:string){return this.db.scope(ctx,async c=>{
  const q=await c.query('SELECT t.*,u.auth_epoch current_epoch,u.status user_status,u.external_user_id,org.corp_id,org.status tenant_status,r.status run_status,p.phase stream_phase,p.content_fragments FROM tasks t JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id LEFT JOIN LATERAL(SELECT id,status FROM runs WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true LEFT JOIN model_stream_progress p ON p.run_id=r.id AND p.tenant_id=t.tenant_id WHERE t.id=$1',[taskId]);const row=q.rows[0];
  if(!row||!row.source_event_id||row.cancel_requested_at||row.user_status!=='ACTIVE'||row.tenant_status!=='ACTIVE'||row.corp_id!==this.binding.corpId||String(row.auth_epoch)!==String(row.current_epoch)||new Date(row.expires_at as string).getTime()<=this.clock())return null;
  if(await killed(c,ctx,{taskId,audience:row.audience as Record<string,unknown>},'DINGTALK_API',true))return null;
  const target=targetSchema.parse(row.audience);if(target.kind==='PRIVATE_USER'&&target.targetId!==ctx.actorId)return null;
  if(target.kind==='GROUP'){const grant=await c.query("SELECT id FROM resource_grants WHERE capability_id='dingtalk.cards.status' AND resource_id=$1 AND audience_kind='GROUP' AND audience_id=$1 AND membership_version=$2 AND revoked_at IS NULL AND expires_at>now()",[target.targetId,target.membershipVersion??null]);if(!grant.rowCount)return null;}
  return {...row,target};
 });}
 async observe(ctx:DbContext,taskId:string):Promise<string|null>{
  const task=await this.task(ctx,taskId);if(!task){await this.db.scope(ctx,c=>c.query("UPDATE card_instances SET state='SUPPRESSED',last_error='AUTHORIZATION_OR_TASK_INVALID' WHERE task_id=$1 AND state IN ('NEW','ACTIVE')",[taskId]));return null;}
  const summary=safeStreamStatus(task.status as string,task.run_status,task.stream_phase,task.content_fragments)+(task.target.kind==='GROUP'?'；信息来源仅为 @机器人消息。':''),final=['COMPLETED','CANCELLED','EXPIRED'].includes(task.status as string);
  return this.db.scope(ctx,async c=>{
   const existing=await c.query('SELECT id FROM card_instances WHERE task_id=$1 FOR UPDATE',[taskId]);if(existing.rowCount){await c.query("UPDATE card_instances SET desired_content=$2,desired_version=desired_version+1,finalize_requested=$3,updated_at=now() WHERE task_id=$1 AND state IN ('NEW','ACTIVE') AND (desired_content<>$2 OR finalize_requested<>$3)",[taskId,summary,final]);return existing.rows[0].id as string;}
   const id=randomUUID(),token=randomBytes(32).toString('base64url'),url=new URL('/tasks',this.binding.appOrigin);url.searchParams.set('task',taskId);
   const data={[this.binding.template.statusKey]:summary,[this.binding.template.taskUrlKey]:url.toString(),[this.binding.template.cancelTokenKey]:token};
   const insert=await c.query("INSERT INTO card_instances(tenant_id,id,owner_id,task_id,out_track_id,template_id,external_target,target_kind,state,desired_content,finalize_requested,initial_data_ref) VALUES($1,$2,$3,$4,$2,$5,$6,$7,'NEW',$8,$9,$10) ON CONFLICT(tenant_id,task_id) DO NOTHING RETURNING id",[ctx.tenantId,id,ctx.actorId,taskId,this.binding.template.templateId,task.target.kind==='PRIVATE_USER'?task.external_user_id:task.target.targetId,task.target.kind,summary,final,JSON.stringify(this.vault.seal(JSON.stringify(data),`${ctx.tenantId}:${ctx.actorId}:card:${id}`))]);
   if(!insert.rowCount)return (await c.query('SELECT id FROM card_instances WHERE task_id=$1',[taskId])).rows[0].id as string;
   await c.query("INSERT INTO card_action_tokens(tenant_id,id,owner_id,task_id,card_id,token_hash,action,args_hash,auth_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,'CANCEL',$7,$8,least($9,now()+interval '20 minutes'))",[ctx.tenantId,randomUUID(),ctx.actorId,taskId,id,hash(token),cardCancellationHash(taskId,task.audience,task.auth_epoch),task.auth_epoch,task.expires_at]);return id;
  });
 }
 async due(ctx:DbContext):Promise<string[]>{return this.db.scope(ctx,async c=>{
  await c.query("UPDATE card_instances SET state='UNKNOWN',last_error='CARD_SENDER_INTERRUPTED' WHERE (state='CREATING' OR stream_state='SENDING') AND sending_at<now()-interval '60 seconds'");
  const q=await c.query("SELECT id FROM card_instances WHERE next_at<=$1 AND (state='NEW' OR state='ACTIVE' AND stream_state='IDLE' AND (desired_version>applied_version OR finalize_requested)) ORDER BY next_at,id LIMIT 50",[new Date(this.clock())]);return q.rows.map(r=>r.id as string);
 });}
 async process(ctx:DbContext,id:string,signal:AbortSignal):Promise<string>{
  const attempt=randomUUID();const claimed=await this.db.scope(ctx,async c=>{const q=await c.query("UPDATE card_instances SET state=CASE WHEN state='NEW' THEN 'CREATING' ELSE state END,stream_state='SENDING',attempt_id=$2,sending_at=now(),sent_version=desired_version WHERE id=$1 AND next_at<=$3 AND stream_state='IDLE' AND (state='NEW' OR state='ACTIVE' AND (desired_version>applied_version OR finalize_requested)) RETURNING *",[id,attempt,new Date(this.clock())]);return q.rows[0]??null;});if(!claimed)return 'NOT_CLAIMED';
  const task=await this.task(ctx,claimed.task_id as string);if(!task||claimed.template_id!==this.binding.template.templateId||claimed.target_kind!==task.target.kind||claimed.external_target!==(task.target.kind==='PRIVATE_USER'?task.external_user_id:task.target.targetId)){
   await this.db.scope(ctx,c=>c.query("UPDATE card_instances SET state='SUPPRESSED',stream_state='IDLE',last_error='AUTHORIZATION_REVOKED' WHERE id=$1 AND attempt_id=$2",[id,attempt]));return 'SUPPRESSED';
  }
  let result:CardResult;try{signal.throwIfAborted();if(claimed.state==='CREATING')result=await this.transport.create({outTrackId:id,target:{kind:task.target.kind,externalId:claimed.external_target as string},data:{...JSON.parse(this.vault.open(JSON.parse(claimed.initial_data_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:card:${id}`)) as Record<string,string>,[this.binding.template.statusKey]:claimed.desired_content as string}},signal);
   else result=await this.transport.update({outTrackId:id,guid:attempt,key:this.binding.template.statusKey,content:claimed.desired_content as string,finalize:claimed.finalize_requested as boolean},signal);
  }catch{result={state:'UNKNOWN',reason:'CARD_RESPONSE_LOST'};}
  await this.db.scope(ctx,async c=>{
   const creating=claimed.state==='CREATING',deadline=this.clock()+(result.retryAfterMs??750),expires=new Date(task.expires_at as string).getTime(),retryExpired=result.reason==='RATE_LIMITED'&&deadline>=expires;
   const state=retryExpired?'SUPPRESSED':result.state==='APPLIED_UNVERIFIED'?(creating?'ACTIVE':claimed.finalize_requested?'FINALIZED_UNVERIFIED':'ACTIVE'):result.reason==='RATE_LIMITED'?(creating?'NEW':'ACTIVE'):result.state==='UNKNOWN'?'UNKNOWN':'FAILED';
   await c.query("UPDATE card_instances SET state=$3,stream_state='IDLE',applied_version=CASE WHEN $4 THEN sent_version ELSE applied_version END,next_at=$5,last_error=$6,external_request_id=$7,version=version+1,updated_at=now() WHERE id=$1 AND attempt_id=$2",[id,attempt,state,result.state==='APPLIED_UNVERIFIED',new Date(retryExpired?expires:deadline),retryExpired?'CARD_RETRY_AFTER_TASK_EXPIRY':result.reason??null,result.requestId??null]);
  });return result.state;
 }
 async tick(ctx:DbContext,signal:AbortSignal){
  const scopeKey=`${ctx.tenantId}:${ctx.actorId}`,cursor=this.scanCursors.get(scopeKey);const tasks=await this.db.scope(ctx,c=>c.query("SELECT t.id FROM tasks t LEFT JOIN card_instances card ON card.tenant_id=t.tenant_id AND card.task_id=t.id WHERE t.source_event_id IS NOT NULL AND ($1::uuid IS NULL OR t.id>$1) AND (card.id IS NULL OR card.state IN ('NEW','ACTIVE')) ORDER BY t.id LIMIT 100",[cursor??null]));if(tasks.rowCount===100)this.scanCursors.set(scopeKey,tasks.rows[99]!.id as string);else this.scanCursors.delete(scopeKey);
  for(const t of tasks.rows)await this.observe(ctx,t.id as string);for(const id of await this.due(ctx)){signal.throwIfAborted();await this.process(ctx,id,signal);}
 }
}
