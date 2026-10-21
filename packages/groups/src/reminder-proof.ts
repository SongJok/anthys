import {z} from 'zod';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {messageInput} from '../../dingtalk/src/message-input.js';
import {payloadSchema} from './case-contracts.js';
import {caseState} from './case-model.js';
import {evaluateGroupContract,type GroupContract} from './contract-model.js';
import {groupReminderDefinition,openGroupReminderDefinition} from './reminders.js';
import {GroupReminderError} from './reminder-model.js';
import {planGroupReminder,type ReminderCase} from './reminder-policy.js';
import type {GroupReminderObserver,GroupReminderOrigin} from './reminder-audience.js';
const uuid=z.uuid(),positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const source=z.object({id:uuid,kind:z.enum(['MENTION','CARD']),key:sha,eventId:uuid.nullable(),authorId:uuid,createdAt:instant,authorActive:z.boolean(),externalId:z.string().min(1).max(256),corpId:z.string().min(1).max(256),cipher:z.string().max(65536).nullable(),eventState:z.string().nullable(),eventSource:z.string().nullable(),eventOwner:uuid.nullable(),goal:z.string().max(10000).nullable()}).strict();
const row=z.object({id:uuid,version:positive,state:caseState,ownerId:uuid.nullable(),createdBy:uuid,resourceHash:sha,payloadRef:z.unknown(),payloadHash:sha,sources:z.array(source).min(1).max(2000)}).strict();
export const reminderProofItem=payloadSchema.extend({id:uuid,version:positive,sourceHash:sha}).strict();
export type ReminderProofItem=z.infer<typeof reminderProofItem>;
export const groupReminderProof=z.object({schemaVersion:z.literal(1),originHash:sha,authorityHash:sha,membershipHash:sha,caseSourceHash:sha,selectionAt:instant,items:z.array(reminderProofItem).min(1).max(20),omitted:z.number().int().nonnegative().max(10000),definitionHash:sha,contentHash:sha}).strict();
export type GroupReminderProof=z.infer<typeof groupReminderProof>;
export const groupReminderTarget=(group:string)=>({kind:'GROUP',targetId:group,classificationCeiling:'INTERNAL'});
export const observerAuthorityHash=(o:GroupReminderObserver)=>hash(canonical({...o,occurrence:{...o.occurrence,phase:'PLAN'}}));
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
export async function reminderDefinition(c:pg.PoolClient,ctx:DbContext,vault:Vault,o:GroupReminderObserver){
 const row=(await c.query('SELECT s.*,g.contract_version,g.reminders_per_case_day,g.summaries_per_group_hour FROM group_reminder_schedules s JOIN group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id WHERE s.id=$1',[o.schedule.id])).rows[0];
 if(!row||row.definition_hash!==o.schedule.definitionHash)throw new GroupReminderError('GROUP_REMINDER_INTEGRITY');return openGroupReminderDefinition(vault,ctx,row);
}
export async function reminderContract(c:pg.PoolClient,ctx:DbContext,vault:Vault,o:GroupReminderObserver,d:z.infer<typeof groupReminderDefinition>,now:number){
 const r=(await c.query('SELECT r.document_ref,r.document_hash FROM group_contracts c JOIN group_contract_revisions r ON r.tenant_id=c.tenant_id AND r.id=c.current_revision_id AND r.contract_id=c.id WHERE c.id=$1 AND c.group_id=$2',[o.contractId,o.groupId])).rows[0];
 if(!r||r.document_hash!==o.contractHash||d.contractHash!==o.contractHash)throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');
 const text=vault.open(r.document_ref as Sealed,`${ctx.tenantId}:group-contract:${o.contractId}:${o.revisionId}`),contract=JSON.parse(text) as GroupContract;
 if(hash(text)!==o.contractHash||evaluateGroupContract(contract,{tenantId:ctx.tenantId,groupId:o.groupId,contractId:o.contractId,serviceIdentityId:o.identityId,currentVersion:o.contractVersion,now}).status!=='ELIGIBLE'||(contract.sources.mode??'MENTION_ONLY')!=='MENTION_ONLY'||canonical(contract.workHours)!==canonical(d.workHours))throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');
 return {...contract,limits:{remindersPerCasePerDay:Math.min(contract.limits?.remindersPerCasePerDay??2,d.limits.remindersPerCasePerDay,o.authorization.limits.remindersPerCasePerDay),summariesPerGroupPerHour:Math.min(contract.limits?.summariesPerGroupPerHour??6,d.limits.summariesPerGroupPerHour,o.authorization.limits.summariesPerGroupPerHour)}} satisfies GroupContract;
}
/** Current immutable submitted sources, never a user assertion or a guessed resource merge. */
export async function registeredReminderCases(c:pg.PoolClient,ctx:DbContext,vault:Vault,o:GroupReminderObserver,origin:GroupReminderOrigin,contract:GroupContract,robotCode:string){
 return openRegisteredCases((await c.query('SELECT public.oa_group_reminder_cases($1,$2,$3) value',[origin.occurrenceId,origin.fence,origin.phase])).rows[0].value,ctx,vault,o.groupId,contract,robotCode);
}
/** Shared immutable submitted-source validation; callers still obtain raw rows
 * through the authority oracle for their exact reminder or escalation origin. */
export function openRegisteredCases(value:unknown,ctx:DbContext,vault:Vault,groupId:string,contract:GroupContract,robotCode:string){
 const raw=z.array(row).max(10000).parse(value),items:ReminderProofItem[]=[];
 for(const r of raw){
  const text=vault.open(r.payloadRef as Sealed,`${ctx.tenantId}:group-case:${r.id}`),p=payloadSchema.parse(JSON.parse(text));
  if(hash(text)!==r.payloadHash||p.state!==r.state||p.ownerId!==r.ownerId||p.createdBy!==r.createdBy||hash(p.resourceRef)!==r.resourceHash)throw new GroupReminderError('GROUP_REMINDER_CASE_INTEGRITY');
  for(const s of r.sources){
   if(!s.authorActive||!contract.sources.entries.some(e=>e.kind===s.kind))throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');
   if(s.kind==='CARD'){if(s.eventId!==null||s.cipher!==null)throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');}
   else{
    if(!robotCode||!s.cipher||s.eventId===null||s.eventOwner!==s.authorId||s.eventSource!=='DINGTALK'||!['ENQUEUED','PROCESSED'].includes(s.eventState??'')||s.goal===null)throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');
    const event=JSON.parse(vault.open(JSON.parse(s.cipher) as Sealed,`${ctx.tenantId}:${s.authorId}:inbox:${s.eventId}`));
    if(event.conversationType!=='2'||event.conversationId!==groupId||event.robotCode!==robotCode||event.senderStaffId!==s.externalId||event.senderCorpId!==s.corpId||event.chatbotCorpId!==s.corpId||event.msgtype!=='text'||messageInput(event).goal!==s.goal)throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED');
   }
  }
  items.push({...p,id:r.id,version:r.version,sourceHash:hash(canonical(r))});
 }
 return {items,hash:hash(canonical(items))};
}
export function reminderUsage(raw:unknown){const value=z.object({tenantId:z.string(),groupId:z.string(),from:z.string(),until:z.string(),complete:z.literal(true),includesAllUnresolved:z.literal(true),notifications:z.array(z.object({notificationId:uuid,at:z.string(),caseIds:z.array(uuid).min(1).max(10000),state:z.enum(['PENDING','APPLIED_UNVERIFIED','UNKNOWN','FAILED','SUPPRESSED'])}).strict()).max(10000)}).strict().parse(raw);return {...value,from:iso(value.from),until:iso(value.until),notifications:value.notifications.map(n=>({...n,at:iso(n.at)}))};}
export function reminderCandidate(items:ReminderProofItem[],contract:GroupContract,o:GroupReminderObserver,usage:ReturnType<typeof reminderUsage>,members:{id:string;name:string}[]){
 const current=new Set(members.map(m=>m.id));return planGroupReminder({contract,context:{tenantId:usage.tenantId,groupId:o.groupId,contractId:o.contractId,serviceIdentityId:o.identityId,currentVersion:o.contractVersion,now:Date.parse(usage.until)},cases:items.filter(i=>!i.ownerId||current.has(i.ownerId)).map(i=>({id:i.id,version:i.version,resourceRef:i.resourceRef,ownerId:i.ownerId,state:i.state,dueAt:i.dueAt} satisfies ReminderCase)),usage,maxItems:20});
}
/** Plain sampleText only: no @all parameters, link fetching, instruction execution or automatic escalation. */
export function renderGroupReminder(items:ReminderProofItem[],o:GroupReminderObserver,scheduledAt:string,omitted:number){
 return `群催办摘要 ${o.occurrence.notificationId}\n计划时间 ${scheduledAt}（UTC）；合同版本 ${o.contractVersion}\n${items.map(i=>`事项 ${i.id} · v${i.version}\n${i.title}\n资源：${i.resourceRef}\n负责人：${i.ownerId}；状态：${i.state}；截止：${i.dueAt}\n提醒不代表负责人已完成或资源已修复。`).join('\n\n')}\n本次 ${items.length} 项；${omitted?`另有 ${omitted} 项未在本条展示，不代表全部事项。`:'仅为本次符合条件的已登记事项。'}\n仅包含已登记的 @／共享卡片事项，不覆盖全部群聊；未使用@全员、跨通道私信或升级。`;
}
