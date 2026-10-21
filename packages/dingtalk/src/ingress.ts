import {groupCaseCommand} from '../../groups/src/commands.js';
import {reminderCommand} from '../../schedules/src/commands.js';
import {Schedules} from '../../schedules/src/service.js';
import {scheduleAndReceipt} from '../../schedules/src/receipts.js';
import {isDmCaptureMarker} from './dm-metadata.js';
import {PrivatePreferences} from '../../memory/src/service.js';
import {memoryCommand} from '../../memory/src/commands.js';
import {memoryAndReceipt} from './memories.js';
import {Personas} from '../../personas/src/service.js';
import {personaCommand} from '../../personas/src/commands.js';
import {personaAndReceipt} from './personas.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import type {Database,DbContext} from '../../storage/src/database.js';
import {Vault,hash} from '../../storage/src/crypto.js';
import {insertTask,cancelTask} from '../../tasks/src/store.js';
import {messageInput} from './message-input.js';
import {stopCommand,stopAndReceipt} from './stop.js';
import {RuntimeStore} from '../../runtime/src/store.js';
import {clarificationCommand,acceptClarification} from './clarification.js';
import type {Audience} from '../../tasks/src/store.js';
import {assertTrial,type TrialState} from '../../storage/src/trial.js';
import {appendAudit} from '../../storage/src/audit.js';
import {requestTaskReceipt} from './task-receipt.js';
const messageSchema=z.object({msgId:z.string().min(1),chatbotCorpId:z.string().min(1),senderCorpId:z.string().min(1),senderStaffId:z.string().min(1),conversationId:z.string().min(1),conversationType:z.enum(['1','2']),robotCode:z.string(),createAt:z.number(),senderId:z.string(),chatbotUserId:z.string(),sessionWebhook:z.url().optional(),sessionWebhookExpiredTime:z.number().optional()});
export class DingTalkIngress {
 constructor(private db:Database,private vault:Vault,private binding:{tenantId:string;corpId:string;robotCode:string},private continuations=new RuntimeStore(db,vault),private readonly personaSettings=new Personas(db,vault),private readonly memories=new PrivatePreferences(db,vault),private readonly schedules=new Schedules(db,vault)) {}
 async acceptTrustedCallback(message:DWClientDownStream):Promise<{taskId:string;duplicate:boolean}|null> {
  if(message.type!=='CALLBACK'||message.headers.topic!==TOPIC_ROBOT) throw Error('UNSUPPORTED_CALLBACK');
  const raw=JSON.parse(message.data) as unknown,m=messageSchema.parse(raw),input=messageInput(raw);
  if(m.chatbotCorpId!==this.binding.corpId||m.senderCorpId!==this.binding.corpId||m.robotCode!==this.binding.robotCode) throw Error('IDENTITY_MISMATCH');
  if(m.senderId===m.chatbotUserId) return null;
  const directoryContext={tenantId:this.binding.tenantId,actorId:'00000000-0000-4000-8000-000000000000'};
  const user=await this.db.scope(directoryContext,c=>c.query("SELECT u.id,t.timezone FROM users u JOIN tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.external_user_id=$2 AND u.status='ACTIVE'",[this.binding.tenantId,m.senderStaffId]));
  if(!user.rowCount) throw Error('UNMAPPED_IDENTITY');
  const ctx:DbContext={tenantId:this.binding.tenantId,actorId:user.rows[0].id as string};
  // This reserved setup control stays inert on every later redelivery.
  // Keep trusted corp/robot and ACTIVE directory verification above it.
  if((raw as {msgtype?:unknown}).msgtype==='text'&&isDmCaptureMarker(input.goal))return null;
  let finiteStopTask:string|null=null;
  const result=await this.db.scope(ctx,async c=>{
   const reminder=m.conversationType==='1'&&!input.attachments.length?reminderCommand(input.goal,{now:new Date().toISOString(),tz:user.rows[0].timezone as string}):null;
   const bound={taskId:randomUUID(),runId:randomUUID()},plain=(raw as {msgtype?:unknown}).msgtype==='text',
    eligible=plain&&m.conversationType==='1'&&!input.attachments.length&&!stopCommand(input.goal)&&!clarificationCommand(input.goal)&&!memoryCommand(input.goal)&&!personaCommand(input.goal)&&!reminder;
   const caseControl=plain&&m.conversationType==='2'&&!input.attachments.length?groupCaseCommand(input.goal):null;
   const isControl=!!(caseControl||stopCommand(input.goal)||clarificationCommand(input.goal)||memoryCommand(input.goal)||personaCommand(input.goal)||reminder);
   if(isControl&&m.conversationType==='1'&&(await c.query('SELECT public.oa_finite_private_pilot_active() active')).rows[0].active){
    const stop=stopCommand(input.goal);if(stop){const state=(await c.query('SELECT public.oa_finite_private_pilot_stop($1,$2,$3,$4,$5,$6) value',[m.senderCorpId,m.senderStaffId,m.robotCode,m.conversationId,stop.targetId,stop.invalidTarget])).rows[0].value as {taskId?:string|null};if(state.taskId)finiteStopTask=state.taskId;}
    return null;
   }
   const trial=(await c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) state',[m.senderCorpId,m.senderStaffId,m.robotCode,m.conversationId,m.msgId,eligible,bound.taskId,bound.runId,Number.isSafeInteger(m.createAt)?m.createAt:null,m.conversationType==='1'?'DM':'GROUP',input.attachments.length>0,isControl,hash(input.goal),stopCommand(input.goal)?'STOP':isControl?'OTHER':'NONE'])).rows[0].state as TrialState;
   if(trial.restricted){if(trial.duplicate&&trial.taskId)return {taskId:trial.taskId,duplicate:true};if(!trial.allowed)return null;}
   const id=randomUUID(),key=`${m.robotCode}:${m.conversationId}:${m.msgId}`;
   const inbox=await c.query("INSERT INTO event_inbox(tenant_id,id,owner_id,source,event_key,payload_cipher_ref,state) VALUES($1,$2,$3,'DINGTALK',$4,$5,'RECEIVED') ON CONFLICT(tenant_id,source,event_key) DO NOTHING RETURNING id",[ctx.tenantId,id,ctx.actorId,key,JSON.stringify(this.vault.seal(message.data,`${ctx.tenantId}:${ctx.actorId}:inbox:${id}`))]);
   if(!inbox.rowCount) {const routedFirst=await c.query('SELECT p.task_id FROM dingtalk_clarification_replies p JOIN event_inbox e ON e.tenant_id=p.tenant_id AND e.id=p.event_id WHERE e.event_key=$1',[key]);if(routedFirst.rowCount)return routedFirst.rows[0].task_id?{taskId:routedFirst.rows[0].task_id as string,duplicate:true}:null;const old=await c.query('SELECT t.id FROM tasks t JOIN event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id WHERE e.event_key=$1',[key]);if(!old.rowCount){const routed=await c.query('SELECT task_id FROM dingtalk_clarification_replies p JOIN event_inbox e ON e.tenant_id=p.tenant_id AND e.id=p.event_id WHERE e.event_key=$1',[key]);if(routed.rowCount)return routed.rows[0].task_id?{taskId:routed.rows[0].task_id as string,duplicate:true}:null;throw Error('DUPLICATE_IDENTITY_CONFLICT');}return {taskId:old.rows[0].id as string,duplicate:true};}
   const conv=await c.query('SELECT public.oa_join_verified_conversation($1,$2) id',[m.conversationId,m.conversationType==='1'?'DM':'GROUP']);
   // The standard robot transport delivers group mentions only; do not invent non-mention coverage.
   const audience:Audience={kind:m.conversationType==='1'?'PRIVATE_USER':'GROUP',targetId:m.conversationType==='1'?ctx.actorId:m.conversationId,classificationCeiling:m.conversationType==='1'?'RESTRICTED':'INTERNAL'},control=(raw as {msgtype?:unknown}).msgtype==='text'?stopCommand(input.goal):null;
   if(control)return {taskId:await stopAndReceipt(c,ctx,{command:control,goal:input.goal,eventId:id,conversationId:conv.rows[0].id as string,audience,...(trial.mode==='FORMAL'?{bound}:{})},this.vault),duplicate:false};
   const clarification=(raw as {msgtype?:unknown}).msgtype==='text'?clarificationCommand(input.goal):null;if(clarification){const taskId=await acceptClarification(c,ctx,this.continuations,{command:clarification,eventId:id,conversationId:conv.rows[0].id as string,isPrivate:m.conversationType==='1',audience,...(trial.mode==='FORMAL'?{bound}:{})},this.vault);return taskId?{taskId,duplicate:false}:null;}
   if((raw as {msgtype?:unknown}).msgtype==='text'&&memoryCommand(input.goal))return {taskId:await memoryAndReceipt(c,ctx,this.memories,this.vault,this.binding,{eventId:id,conversationId:conv.rows[0].id as string,audience,...(trial.mode==='FORMAL'?{bound}:{})}),duplicate:false};
   if((raw as {msgtype?:unknown}).msgtype==='text'&&personaCommand(input.goal))return {taskId:await personaAndReceipt(c,ctx,this.personaSettings,this.vault,this.binding,{eventId:id,conversationId:conv.rows[0].id as string,audience,...(trial.mode==='FORMAL'?{bound}:{})}),duplicate:false};
   if(plain&&m.conversationType==='1'&&reminder)return {taskId:await scheduleAndReceipt(c,ctx,this.schedules,this.vault,this.binding,{eventId:id,conversationId:conv.rows[0].id as string,...(trial.mode==='FORMAL'?{bound}:{})}),duplicate:false};
   const result=await insertTask(c,ctx,input.goal,audience,id,conv.rows[0].id as string,trial.restricted?bound:undefined);
   if((await c.query('SELECT public.oa_finite_private_pilot_active($1,NULL) active',[result.runId])).rows[0].active)await c.query("UPDATE runs SET budget=jsonb_set(budget,'{maxTurns}','4') WHERE id=$1",[result.runId]);
   if(trial.mode==='FORMAL'&&trial.channel==='GROUP')await c.query("UPDATE runs SET budget=jsonb_set(budget,'{maxTurns}','4') WHERE id=$1",[result.runId]);
   if(caseControl){await c.query("UPDATE tasks SET control_kind='GROUP_CASE' WHERE id=$1",[result.taskId]);await c.query("UPDATE runs SET budget=$2,persona_context_state='BUILTIN_ONLY' WHERE id=$1",[result.runId,JSON.stringify({schemaVersion:1,maxTurns:0,maxTools:0,maxActiveMs:240000})]);}
   const task=await c.query('SELECT auth_epoch FROM tasks WHERE id=$1',[result.taskId]);for(const [index,attachment] of input.attachments.entries())await c.query('INSERT INTO attachments(tenant_id,id,owner_id,task_id,source_event_id,source_index,file_name,input_kind,auth_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,randomUUID(),ctx.actorId,result.taskId,id,index,attachment.fileName,attachment.kind,task.rows[0].auth_epoch]);
   if(plain&&m.conversationType==='1'&&!input.attachments.length&&(!trial.restricted||trial.mode==='FORMAL'))await requestTaskReceipt(c,ctx,{...result,sourceEventId:id});
   await appendAudit(c,ctx,{action:'message.accepted',resource:result.taskId,result:'ENQUEUED',traceId:result.runId});
   await c.query("UPDATE event_inbox SET state='ENQUEUED' WHERE id=$1",[id]);if(trial.restricted)await assertTrial(c,result.runId);return {taskId:result.taskId,duplicate:false};
  });
  // The durable finite stop commits before task cancellation. No pilot lock is
  // held while the existing task/run cancellation takes its own locks. If it
  // fails, the finite tombstone still vetoes egress and callback ACK is withheld.
  if(finiteStopTask)await this.db.scope(ctx,c=>cancelTask(c,finiteStopTask!));
  return result;
 }
}
export function attachDurableRobotCallback(client:Pick<DWClient,'registerCallbackListener'|'socketCallBackResponse'>,ingress:DingTalkIngress,onError:(code:string)=>void,maxPending=20):void {
 let pending=0;
 client.registerCallbackListener(TOPIC_ROBOT,(message)=>{
  if(pending>=maxPending){onError('BACKPRESSURE_NOT_ACKNOWLEDGED');return;}pending++;
  void ingress.acceptTrustedCallback(message).then(()=>client.socketCallBackResponse(message.headers.messageId,{status:'SUCCESS'})).catch(()=>onError('INGRESS_NOT_ACKNOWLEDGED')).finally(()=>{pending--;});
 });
}
