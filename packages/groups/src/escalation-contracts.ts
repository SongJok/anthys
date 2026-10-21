import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import type {Principal} from '../../identity/src/sessions.js';

export const groupEscalationNotice='仅为已登记事项的同群升级申请；事实仍未核验，入队不表示送达或问题解决，不改变负责人和完成状态。';
export const groupEscalationDeliveryNotice='记录仅描述本地投递和提供方回执，不证明接收方已收到或阅读；UNKNOWN 不重发。';
/** Component safety bounds, not product quota, permission or a production SLA. */
export const groupEscalationLimits=Object.freeze({maxJsonBytes:131072,maxNodes:4096,maxPreviewLifetimeMs:60000,maxTargets:20,maxLocalAttempts:256,maxDisplayBytes:16384});
export interface GroupEscalationContext {principal:Principal;groupId:string;signal:AbortSignal}
const uuid=z.uuid().transform(s=>s.toLowerCase()),positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const text=(max:number)=>z.string().min(1).max(max).refine(v=>v.trim()===v&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(v));
export const groupEscalationIntentSchema=z.object({caseId:uuid,expectedCaseVersion:positive,expectedContractVersion:positive,reason:text(1000)}).strict();
export const groupEscalationReferenceSchema=z.object({proposalId:uuid,previewHash:sha}).strict();
const principalSchema=z.object({tenantId:uuid,actorId:uuid,sessionId:uuid,authEpoch:positive,roles:z.array(text(128)).max(128),auditAccess:z.literal(false).optional()}).strict();
const groupSchema=text(512);
export const groupEscalationPreviewSchema=z.object({
 proposalId:uuid,contextHash:sha,intent:groupEscalationIntentSchema,intentHash:sha,groupId:groupSchema,
 case:z.object({id:uuid,version:positive,title:text(300),resourceRef:text(512),state:z.enum(['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED']),ownerId:uuid.nullable(),dueAt:instant.nullable()}).strict(),
 contract:z.object({id:uuid,version:positive,hash:sha}).strict(),
 targets:z.array(z.object({id:uuid,name:text(100)}).strict()).min(1).max(groupEscalationLimits.maxTargets),
 coverage:z.object({mode:z.literal('MENTION_ONLY'),completeChat:z.literal(false)}).strict(),
 verification:z.literal('UNVERIFIED'),asOf:instant,expiresAt:instant,notice:z.literal(groupEscalationNotice),
}).strict().superRefine((v,c)=>{
 if(v.case.id!==v.intent.caseId||v.case.version!==v.intent.expectedCaseVersion||v.contract.version!==v.intent.expectedContractVersion||new Set(v.targets.map(t=>t.id)).size!==v.targets.length||Date.parse(v.expiresAt)<=Date.parse(v.asOf)||Date.parse(v.expiresAt)-Date.parse(v.asOf)>groupEscalationLimits.maxPreviewLifetimeMs||v.case.state!=='BLOCKED'&&(v.case.dueAt===null||Date.parse(v.case.dueAt)>Date.parse(v.asOf)))c.addIssue({code:'custom',message:'GROUP_ESCALATION_PREVIEW_INVALID'});
});
export const groupEscalationReceiptSchema=z.object({proposalId:uuid,previewHash:sha,contextHash:sha,groupId:groupSchema,caseId:uuid,caseVersion:positive,contractVersion:positive,verification:z.literal('UNVERIFIED'),asOf:instant,replayed:z.boolean()}).strict();
const denied=z.object({kind:z.literal('DENIED'),code:z.enum(['GROUP_ESCALATION_DENIED','GROUP_ESCALATION_SOURCE_CHANGED','GROUP_ESCALATION_NOT_FOUND','GROUP_ESCALATION_EXPIRED','GROUP_ESCALATION_LIMIT','GROUP_ESCALATION_CANCELLED','GROUP_ESCALATION_INPUT_INVALID'])}).strict();
const unknown=z.object({kind:z.literal('UNKNOWN'),code:z.enum(['GROUP_ESCALATION_RESULT_UNKNOWN','GROUP_ESCALATION_RECONCILE_REQUIRED'])}).strict();
const prepared=z.object({kind:z.literal('PREPARED'),preview:groupEscalationPreviewSchema,previewHash:sha}).strict();
const queued=z.object({kind:z.literal('QUEUED'),receipt:groupEscalationReceiptSchema}).strict();
const cancelled=z.object({kind:z.literal('CANCELLED_LOCAL'),receipt:groupEscalationReceiptSchema}).strict();
const reconcile=z.object({kind:z.literal('RECONCILE_REQUIRED'),receipt:groupEscalationReceiptSchema}).strict();
const deliveryStatus=z.object({kind:z.literal('DELIVERY_STATUS'),receipt:groupEscalationReceiptSchema,delivery:z.object({state:z.enum(['PENDING','SENDING','APPLIED_UNVERIFIED','FAILED','UNKNOWN','SUPPRESSED']),verification:z.literal('UNVERIFIED'),method:z.enum(['PROVIDER_ACCEPTANCE_ONLY','NO_PROVIDER_RECEIPT']),physicalDeliveryVerified:z.literal(false),asOf:instant,notice:z.literal(groupEscalationDeliveryNotice)}).strict()}).strict();
export const groupEscalationPreparationSchema=z.discriminatedUnion('kind',[prepared,denied,unknown]);
export const groupEscalationEnqueueSchema=z.discriminatedUnion('kind',[queued,denied,unknown]);
export const groupEscalationCancellationSchema=z.discriminatedUnion('kind',[cancelled,reconcile,denied,unknown]);
export const groupEscalationReadSchema=z.discriminatedUnion('kind',[prepared,queued,cancelled,reconcile,deliveryStatus,denied,unknown]);
export type GroupEscalationIntent=z.infer<typeof groupEscalationIntentSchema>;
export type GroupEscalationReference=z.infer<typeof groupEscalationReferenceSchema>;
export type GroupEscalationPreview=z.infer<typeof groupEscalationPreviewSchema>;
export type GroupEscalationReceipt=z.infer<typeof groupEscalationReceiptSchema>;
export type GroupEscalationPreparation=z.infer<typeof groupEscalationPreparationSchema>;
export type GroupEscalationEnqueue=z.infer<typeof groupEscalationEnqueueSchema>;
export type GroupEscalationCancellation=z.infer<typeof groupEscalationCancellationSchema>;
export type GroupEscalationRead=z.infer<typeof groupEscalationReadSchema>;
/** Real authorization, durable confirmation/quota and final send proof belong to the host. */
export interface GroupEscalationHostPort {
 prepare(context:GroupEscalationContext,intent:GroupEscalationIntent,requestId:string):Promise<GroupEscalationPreparation>;
 read(context:GroupEscalationContext,proposalId:string):Promise<GroupEscalationRead>;
 enqueue(context:GroupEscalationContext,reference:GroupEscalationReference,requestId:string):Promise<GroupEscalationEnqueue>;
 cancel(context:GroupEscalationContext,reference:GroupEscalationReference,requestId:string):Promise<GroupEscalationCancellation>;
}
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
/** Only inert bounded JSON. No getters/toJSON/proxies or class instances are evaluated. */
export function escalationSnapshot(raw:unknown):Json {
 let nodes=0,bytes=0;const active=new Set<object>();
 const visit=(v:unknown,depth:number):Json=>{
  if(++nodes>groupEscalationLimits.maxNodes||depth>16)throw Error('GROUP_ESCALATION_INPUT_INVALID');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>groupEscalationLimits.maxJsonBytes)throw Error('GROUP_ESCALATION_INPUT_INVALID');return v;}
  if(typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0))return v;
  if(typeof v!=='object'||types.isProxy(v)||active.has(v))throw Error('GROUP_ESCALATION_INPUT_INVALID');
  const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw Error('GROUP_ESCALATION_INPUT_INVALID');
  active.add(v);try{
   const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);if(keys.some(k=>typeof k!=='string'))throw Error('GROUP_ESCALATION_INPUT_INVALID');
   if(array){const length=ds['length']?.value as unknown;if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>256||keys.length!==length+1)throw Error('GROUP_ESCALATION_INPUT_INVALID');const out:Json[]=[];for(let i=0;i<length;i++){const d=ds[String(i)];if(!d||!('value'in d)||!d.enumerable)throw Error('GROUP_ESCALATION_INPUT_INVALID');out.push(visit(d.value,depth+1));}return out;}
   if(keys.length>32)throw Error('GROUP_ESCALATION_INPUT_INVALID');const out:Record<string,Json>=Object.create(null);
   for(const k of keys){const key=k as string,d=ds[key]!;bytes+=Buffer.byteLength(key);if(bytes>groupEscalationLimits.maxJsonBytes||!('value'in d)||!d.enumerable)throw Error('GROUP_ESCALATION_INPUT_INVALID');out[key]=visit(d.value,depth+1);}return out;
  }finally{active.delete(v);}
 };const result=visit(raw,0);if(Buffer.byteLength(JSON.stringify(result))>groupEscalationLimits.maxJsonBytes)throw Error('GROUP_ESCALATION_INPUT_INVALID');return result;
}
export function freezeEscalation<T>(v:T):T {if(v&&typeof v==='object'){for(const child of Object.values(v))freezeEscalation(child);Object.freeze(v);}return v;}
function digest(value:unknown){const visit=(v:Json):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(visit).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+visit(v[k]!)).join(',')+'}';return createHash('sha256').update(visit(escalationSnapshot(value))).digest('hex');}
export const groupEscalationIntentHash=(raw:unknown)=>digest(groupEscalationIntentSchema.parse(escalationSnapshot(raw)));
export const groupEscalationPreviewHash=(raw:unknown)=>digest(groupEscalationPreviewSchema.parse(escalationSnapshot(raw)));
/** A local content binding only, never proof that the supplied session is authentic. */
export function groupEscalationContext(context:GroupEscalationContext):GroupEscalationContext {
 if(!context||types.isProxy(context)||Object.getPrototypeOf(context)!==Object.prototype)throw Error('GROUP_ESCALATION_INPUT_INVALID');
 const ds=Object.getOwnPropertyDescriptors(context);if(Reflect.ownKeys(ds).length!==3||!['principal','groupId','signal'].every(k=>ds[k]&&'value'in ds[k]!))throw Error('GROUP_ESCALATION_INPUT_INVALID');
 const principal=principalSchema.parse(escalationSnapshot(ds['principal']!.value)),groupId=groupSchema.parse(escalationSnapshot(ds['groupId']!.value)),signal:unknown=ds['signal']!.value;
 if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw Error('GROUP_ESCALATION_INPUT_INVALID');
 const identity:Principal={tenantId:principal.tenantId,actorId:principal.actorId,sessionId:principal.sessionId,authEpoch:principal.authEpoch,roles:principal.roles,...(principal.auditAccess===false?{auditAccess:false}:{})};
 return Object.freeze({principal:freezeEscalation(identity),groupId,signal});
}
export function groupEscalationContextHash(context:GroupEscalationContext){const c=groupEscalationContext(context),p=c.principal;return digest({tenantId:p.tenantId,actorId:p.actorId,sessionId:p.sessionId,authEpoch:p.authEpoch,groupId:c.groupId});}
/** Plain review text only: never HTML, a send payload or permission to send. */
export function renderGroupEscalationPreview(raw:unknown){
 const p=groupEscalationPreviewSchema.parse(escalationSnapshot(raw));
 const text=`同群升级申请（待明确确认，尚未发送）\n事项 ${p.case.id} · v${p.case.version}\n标题：${p.case.title}\n资源：${p.case.resourceRef}\n现负责人：${p.case.ownerId??'未设置'}；状态：${p.case.state}\n升级理由（申请人输入）：${p.intent.reason}\n当前合同升级对象：${p.targets.map(t=>t.name+' · '+t.id).join('；')}\n合同版本 ${p.contract.version}；预览到期 ${p.expiresAt}\n仅覆盖已登记@／共享卡片事项，不覆盖全部群聊。\n${groupEscalationNotice}`;
 if(Buffer.byteLength(text)>groupEscalationLimits.maxDisplayBytes)throw Error('GROUP_ESCALATION_INPUT_INVALID');return text;
}
