import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {appendAudit} from '../../storage/src/audit.js';

const requestSchema=z.object({taskId:z.uuid(),runId:z.uuid(),sourceEventId:z.uuid(),authEpoch:z.string(),policyVersion:z.string()}).strict();
const receiptText=(taskId:string)=>`任务 ${taskId} 已接收。可在工作台查看处理进度；这条回执不代表任务已经完成。`;

// This marker commits with the inbox and RUN outbox, before protocol ACK.
export async function requestTaskReceipt(c:pg.PoolClient,ctx:DbContext,input:{taskId:string;runId:string;sourceEventId:string}):Promise<void>{
 if((await c.query('SELECT public.oa_finite_private_pilot_active($1,NULL) active',[input.runId])).rows[0].active)return;
 const row=(await c.query('SELECT t.auth_epoch,org.policy_version FROM tasks t JOIN tenants org ON org.tenant_id=t.tenant_id WHERE t.id=$1',[input.taskId])).rows[0];
 if(!row)throw Error('RECEIPT_TASK_MISSING');
 const payload={...input,authEpoch:String(row.auth_epoch),policyVersion:String(row.policy_version)};
 await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'TASK_RECEIPT',$4,$5,$6)",[ctx.tenantId,randomUUID(),ctx.actorId,input.taskId,JSON.stringify(payload),`task-receipt:${input.taskId}`]);
}

export async function stageTaskReceipts(c:pg.PoolClient,ctx:DbContext,vault:Vault):Promise<void>{
 const rows=await c.query("SELECT o.id,o.payload_ref,t.status,t.cancel_requested_at,t.auth_epoch,t.audience,t.source_event_id,r.id run_id,r.provider_session_no,r.status run_status,u.auth_epoch current_epoch,u.status user_status,org.status tenant_status,org.policy_version,conv.kind FROM outbox o JOIN tasks t ON t.tenant_id=o.tenant_id AND t.id=o.aggregate_id JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id AND r.id=(o.payload_ref->>'runId')::uuid JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id JOIN conversations conv ON conv.tenant_id=t.tenant_id AND conv.id=t.conversation_id WHERE o.kind='TASK_RECEIPT' AND o.published_at IS NULL ORDER BY o.created_at,o.id LIMIT 50 FOR UPDATE OF o,r");
 for(const row of rows.rows){
  const input=requestSchema.parse(row.payload_ref),ready=(await c.query('SELECT id FROM deliveries WHERE task_id=$1 AND finalization_id IS NOT NULL LIMIT 1',[input.taskId])).rowCount;
  const current=!ready&&row.kind==='DM'&&['OPEN','ACTIVE'].includes(row.status as string)&&['QUEUED','RUNNING'].includes(row.run_status as string)&&!row.cancel_requested_at&&row.user_status==='ACTIVE'&&row.tenant_status==='ACTIVE'&&String(row.current_epoch)===input.authEpoch&&String(row.auth_epoch)===input.authEpoch&&String(row.policy_version)===input.policyVersion&&row.source_event_id===input.sourceEventId&&row.run_id===input.runId;
  if(current){
   const id=randomUUID(),content=receiptText(input.taskId),contentHash=hash(content);
   await c.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,'INTERNAL',$8,$9)",[ctx.tenantId,id,ctx.actorId,input.taskId,JSON.stringify(row.audience),hash(JSON.stringify({kind:'TASK_RECEIPT',taskId:input.taskId,runId:input.runId})),JSON.stringify(vault.seal(content,`${ctx.tenantId}:${ctx.actorId}:delivery:${id}`)),input.runId,Number(row.provider_session_no)]);
   await c.query("INSERT INTO run_steps(tenant_id,id,owner_id,run_id,seq,kind,state,safe_payload) VALUES($1,$2,$3,$4,(SELECT coalesce(max(seq),0)+1 FROM run_steps WHERE run_id=$4),'message.received','SUCCEEDED',$5)",[ctx.tenantId,randomUUID(),ctx.actorId,input.runId,JSON.stringify({...input,deliveryId:id,contentHash})]);
  }
  await c.query('UPDATE outbox SET published_at=now() WHERE id=$1',[row.id]);
  await appendAudit(c,ctx,{action:'message.receipt',resource:input.taskId,result:current?'PENDING':'SUPPRESSED',traceId:input.runId});
 }
}

// An early receipt authorizes no model claims, tool output or task completion.
export async function taskReceiptAllowed(c:pg.PoolClient,ctx:DbContext,vault:Vault,delivery:Record<string,unknown>):Promise<boolean>{
 if(delivery.control_kind||delivery.finalization_id||delivery.target&&((delivery.target as {kind?:unknown}).kind!=='PRIVATE_USER'))return false;
 const proof=(await c.query("SELECT safe_payload FROM run_steps WHERE run_id=$1 AND kind='message.received' AND state='SUCCEEDED' AND safe_payload->>'deliveryId'=$2",[delivery.source_run_id,delivery.id])).rows[0]?.safe_payload;
 if(!proof||proof.taskId!==delivery.task_id||proof.runId!==delivery.source_run_id||proof.sourceEventId!==delivery.source_event_id||proof.authEpoch!==String(delivery.current_auth_epoch)||proof.policyVersion!==String(delivery.current_policy_version))return false;
 const text=vault.open(JSON.parse(delivery.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${delivery.id}`);
 if(text!==receiptText(delivery.task_id as string)||hash(text)!==proof.contentHash)return false;
 return !(await c.query('SELECT id FROM deliveries WHERE task_id=$1 AND finalization_id IS NOT NULL LIMIT 1',[delivery.task_id])).rowCount;
}
