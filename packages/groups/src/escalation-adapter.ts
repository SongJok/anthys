import {z} from 'zod';
import {groupEscalationContext,groupEscalationContextHash,groupEscalationIntentHash,groupEscalationPreviewHash,groupEscalationIntentSchema,groupEscalationReferenceSchema,groupEscalationPreparationSchema,groupEscalationReadSchema,groupEscalationEnqueueSchema,groupEscalationCancellationSchema,escalationSnapshot,freezeEscalation,groupEscalationLimits,type GroupEscalationContext,type GroupEscalationHostPort,type GroupEscalationPreview,type GroupEscalationReceipt,type GroupEscalationReference,type GroupEscalationPreparation,type GroupEscalationRead,type GroupEscalationEnqueue,type GroupEscalationCancellation} from './escalation-contracts.js';
const requestSchema=z.uuid().transform(s=>s.toLowerCase());
const denied=(code:'GROUP_ESCALATION_INPUT_INVALID'|'GROUP_ESCALATION_CANCELLED'|'GROUP_ESCALATION_LIMIT'|'GROUP_ESCALATION_SOURCE_CHANGED')=>({kind:'DENIED' as const,code});
const unknown=()=>({kind:'UNKNOWN' as const,code:'GROUP_ESCALATION_RESULT_UNKNOWN' as const});
const reconcile=()=>({kind:'UNKNOWN' as const,code:'GROUP_ESCALATION_RECONCILE_REQUIRED' as const});
/** Own late settlement even when the host ignores cancellation; never issue a second operation. */
function waitForHost<T>(signal:AbortSignal,pending:Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{
 let settled=false;const finish=(fn:()=>void)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);fn();},abort=()=>finish(()=>reject(Error('GROUP_ESCALATION_CANCELLED')));
 signal.addEventListener('abort',abort,{once:true});Promise.resolve(pending).then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));if(signal.aborted)abort();
});}

/** One bounded local operation flow. Host persistence is required across instances/restarts. */
export class GroupEscalationAdapter {
 private readonly attempts=new Set<string>();
 private readonly host:GroupEscalationHostPort;
 constructor(host:GroupEscalationHostPort,private readonly now:()=>number=Date.now){
  if(!host||['prepare','read','enqueue','cancel'].some(k=>typeof host[k as keyof GroupEscalationHostPort]!=='function')||typeof now!=='function')throw Error('GROUP_ESCALATION_CONFIGURATION_INVALID');
  this.host={prepare:host.prepare.bind(host),read:host.read.bind(host),enqueue:host.enqueue.bind(host),cancel:host.cancel.bind(host)};
 }
 private time(){const now=this.now();if(!Number.isSafeInteger(now)||now<0)throw Error('GROUP_ESCALATION_CLOCK_INVALID');return now;}
 private preview(c:GroupEscalationContext,p:GroupEscalationPreview,hash:string){
  const now=this.time();if(p.groupId!==c.groupId||p.contextHash!==groupEscalationContextHash(c)||p.intentHash!==groupEscalationIntentHash(p.intent)||hash!==groupEscalationPreviewHash(p)||Date.parse(p.asOf)>now+5000||Date.parse(p.asOf)<now-groupEscalationLimits.maxPreviewLifetimeMs||Date.parse(p.expiresAt)<=now)throw Error('GROUP_ESCALATION_HOST_INVALID');
 }
 private receipt(c:GroupEscalationContext,r:GroupEscalationReceipt,ref:GroupEscalationReference,p?:GroupEscalationPreview){
  const now=this.time();if(r.proposalId!==ref.proposalId||r.previewHash!==ref.previewHash||r.contextHash!==groupEscalationContextHash(c)||r.groupId!==c.groupId||Date.parse(r.asOf)>now+5000||Date.parse(r.asOf)<now-groupEscalationLimits.maxPreviewLifetimeMs||p&&(r.caseId!==p.case.id||r.caseVersion!==p.case.version||r.contractVersion!==p.contract.version))throw Error('GROUP_ESCALATION_HOST_INVALID');
 }
 private reserve(c:GroupEscalationContext,ref:GroupEscalationReference,operation:'enqueue'|'cancel'){
  const key=groupEscalationContextHash(c)+':'+operation+':'+ref.proposalId;
  if(this.attempts.has(key))return reconcile();if(this.attempts.size>=groupEscalationLimits.maxLocalAttempts)return denied('GROUP_ESCALATION_LIMIT');this.attempts.add(key);return null;
 }
 async prepare(rawContext:GroupEscalationContext,rawIntent:unknown,rawRequestId:unknown):Promise<GroupEscalationPreparation>{
  let c:GroupEscalationContext,intent:z.infer<typeof groupEscalationIntentSchema>,requestId:string;
  try{c=groupEscalationContext(rawContext);intent=freezeEscalation(groupEscalationIntentSchema.parse(escalationSnapshot(rawIntent)));requestId=requestSchema.parse(escalationSnapshot(rawRequestId));if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');}catch{return denied('GROUP_ESCALATION_INPUT_INVALID');}
  try{const result=groupEscalationPreparationSchema.parse(escalationSnapshot(await waitForHost(c.signal,this.host.prepare(c,intent,requestId))));if(c.signal.aborted)return unknown();if(result.kind==='PREPARED'){this.preview(c,result.preview,result.previewHash);if(groupEscalationIntentHash(intent)!==result.preview.intentHash)throw Error('GROUP_ESCALATION_HOST_INVALID');}return freezeEscalation(result);}catch{return unknown();}
 }
 async read(rawContext:GroupEscalationContext,rawProposalId:unknown):Promise<GroupEscalationRead>{
  let c:GroupEscalationContext,id:string;try{c=groupEscalationContext(rawContext);id=requestSchema.parse(escalationSnapshot(rawProposalId));if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');}catch{return denied('GROUP_ESCALATION_INPUT_INVALID');}
  try{const r=groupEscalationReadSchema.parse(escalationSnapshot(await waitForHost(c.signal,this.host.read(c,id))));if(c.signal.aborted)return unknown();if(r.kind==='PREPARED'){this.preview(c,r.preview,r.previewHash);if(r.preview.proposalId!==id)throw Error('GROUP_ESCALATION_HOST_INVALID');}else if('receipt'in r)this.receipt(c,r.receipt,{proposalId:id,previewHash:r.receipt.previewHash});return freezeEscalation(r);}catch{return unknown();}
 }
 async enqueue(rawContext:GroupEscalationContext,rawReference:unknown,rawRequestId:unknown):Promise<GroupEscalationEnqueue>{
  let c:GroupEscalationContext,ref:GroupEscalationReference,id:string;
  try{c=groupEscalationContext(rawContext);ref=freezeEscalation(groupEscalationReferenceSchema.parse(escalationSnapshot(rawReference)));id=requestSchema.parse(escalationSnapshot(rawRequestId));if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');const held=this.reserve(c,ref,'enqueue');if(held)return held;}catch{return denied('GROUP_ESCALATION_INPUT_INVALID');}
  try{
   const current=await this.read(c,ref.proposalId);if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');
   if(current.kind==='QUEUED'){this.receipt(c,current.receipt,ref);return current;}
   if(current.kind==='DENIED'||current.kind==='UNKNOWN')return current;
   if(current.kind!=='PREPARED')return denied('GROUP_ESCALATION_SOURCE_CHANGED');
   if(current.previewHash!==ref.previewHash)return denied('GROUP_ESCALATION_SOURCE_CHANGED');this.preview(c,current.preview,current.previewHash);
   if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');
   // Once entered, any exception/abort/malformed response is uncertain. No retry or automatic cancellation follows.
   try{const result=groupEscalationEnqueueSchema.parse(escalationSnapshot(await waitForHost(c.signal,this.host.enqueue(c,ref,id))));if(c.signal.aborted||Date.parse(current.preview.expiresAt)<=this.time())return unknown();if(result.kind==='QUEUED')this.receipt(c,result.receipt,ref,current.preview);return freezeEscalation(result);}catch{return unknown();}
  }catch{return unknown();}
 }
 async cancel(rawContext:GroupEscalationContext,rawReference:unknown,rawRequestId:unknown):Promise<GroupEscalationCancellation>{
  let c:GroupEscalationContext,ref:GroupEscalationReference,id:string;
  try{c=groupEscalationContext(rawContext);ref=freezeEscalation(groupEscalationReferenceSchema.parse(escalationSnapshot(rawReference)));id=requestSchema.parse(escalationSnapshot(rawRequestId));if(c.signal.aborted)return denied('GROUP_ESCALATION_CANCELLED');const held=this.reserve(c,ref,'cancel');if(held)return held;}catch{return denied('GROUP_ESCALATION_INPUT_INVALID');}
  try{const result=groupEscalationCancellationSchema.parse(escalationSnapshot(await waitForHost(c.signal,this.host.cancel(c,ref,id))));if(c.signal.aborted)return unknown();if('receipt'in result)this.receipt(c,result.receipt,ref);return freezeEscalation(result);}catch{return unknown();}
 }
}
export const createGroupEscalationAdapter=(host:GroupEscalationHostPort,options:{now?:()=>number}={})=>new GroupEscalationAdapter(host,options.now);
