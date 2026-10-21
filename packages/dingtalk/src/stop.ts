import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {Vault,hash} from '../../storage/src/crypto.js';
import type {DbContext} from '../../storage/src/database.js';
import {cancelTask,type Audience} from '../../tasks/src/store.js';
export type StopCommand={targetId:string|null;invalidTarget:boolean};
export function stopCommand(text:string):StopCommand|null {
 const match=/^(?:停止(?:任务)?|\/stop)(?:\s+([^\s]+))?[。!！]?$/i.exec(text.trim());if(!match)return null;
 const target=match[1]?.replace(/[。!！]$/,'');if(!target)return {targetId:null,invalidTarget:false};const id=z.uuid().safeParse(target);return id.success?{targetId:id.data.toLowerCase(),invalidTarget:false}:{targetId:null,invalidTarget:true};
}
export async function stopAndReceipt(c:pg.PoolClient,ctx:DbContext,input:{command:StopCommand;goal:string;eventId:string;conversationId:string;audience:Audience;bound?:{taskId:string;runId:string}},vault:Vault):Promise<string>{
 const identity=await c.query("SELECT u.auth_epoch FROM users u JOIN tenants org ON org.tenant_id=u.tenant_id WHERE u.id=$1 AND u.status='ACTIVE' AND org.status='ACTIVE' FOR UPDATE OF u",[ctx.actorId]);if(!identity.rowCount)throw Error('IDENTITY_INACTIVE');
 // Only the requester's tasks in this verified conversation are candidates. Never guess across channels.
 const candidates=input.command.invalidTarget?[]:(await c.query("SELECT t.id,t.cancel_requested_at FROM tasks t WHERE t.conversation_id=$1 AND EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND public.oa_lifecycle_run_allowed(r.id)) AND t.control_kind IS NULL AND t.expires_at>now() AND ($2::uuid IS NULL OR t.id=$2) AND ($2::uuid IS NOT NULL OR t.cancel_requested_at IS NULL AND (t.status IN ('OPEN','ACTIVE','PAUSED') OR t.status='COMPLETED' AND EXISTS(SELECT 1 FROM deliveries d WHERE d.task_id=t.id AND d.state IN ('PENDING','SENDING')))) ORDER BY t.created_at,t.id LIMIT 21 FOR UPDATE OF t",[input.conversationId,input.command.targetId])).rows;
 let outcome:string,content:string,targetId:string|null=null;
 if(input.command.invalidTarget){outcome='INVALID_TARGET';content='任务编号格式不正确。请使用“停止 <完整任务编号>”。';}
 else if(candidates.length===1){targetId=candidates[0].id as string;const stopped=await cancelTask(c,targetId);outcome=stopped?'STOP_REQUESTED':'NOT_FOUND';content=stopped?`已记录任务 ${targetId} 的停止请求，后续工具执行和投递将被阻止。在途外部动作可能已发生，仍须核对；本回执不表示副作用已撤回。`:'未找到可停止的任务。';}
 else if(candidates.length>1){outcome='CHOOSE_TASK';content='当前会话有多个可停止任务，请回复“停止 <完整任务编号>”：\n'+candidates.slice(0,20).map(t=>t.id as string).join('\n')+(candidates.length>20?'\n候选超过20个，请在个人工作台查看完整列表。':'');}
 else{outcome='NOT_FOUND';content='未找到当前会话中属于你的可停止任务。请核对任务编号，或在个人工作台停止任务。';}
 // A deterministic control receipt is final on commit and has no model queue entry.
 const taskId=input.bound?.taskId??randomUUID(),runId=input.bound?.runId??randomUUID(),deliveryId=randomUUID(),epoch=identity.rows[0].auth_epoch;
 await c.query("INSERT INTO tasks(tenant_id,id,requester_id,conversation_id,source_event_id,goal,status,audience,auth_epoch,expires_at,control_kind) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8,now()+interval '1 day','STOP')",[ctx.tenantId,taskId,ctx.actorId,input.conversationId,input.eventId,input.goal,JSON.stringify(input.audience),epoch]);
 await c.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget,result,result_classification) VALUES($1,$2,$3,$4,'SUCCEEDED',$5,$6,'INTERNAL')",[ctx.tenantId,runId,taskId,ctx.actorId,JSON.stringify({schemaVersion:1,maxTurns:0,maxTools:0,maxActiveMs:1}),content]);
 await c.query("INSERT INTO run_steps(tenant_id,id,run_id,owner_id,seq,kind,state,safe_payload) VALUES($1,$2,$3,$4,1,'control.stop','SUCCEEDED',$5)",[ctx.tenantId,randomUUID(),runId,ctx.actorId,JSON.stringify({outcome,targetId,candidateIds:candidates.slice(0,20).map(t=>t.id as string),truncated:candidates.length>20})]);
 await c.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,'INTERNAL',$8,1)",[ctx.tenantId,deliveryId,ctx.actorId,taskId,JSON.stringify(input.audience),hash(JSON.stringify({taskId,outcome,targetId,audience:input.audience})),JSON.stringify(vault.seal(content,`${ctx.tenantId}:${ctx.actorId}:delivery:${deliveryId}`)),runId]);
 await c.query("UPDATE event_inbox SET state='PROCESSED' WHERE id=$1",[input.eventId]);return taskId;
}
