import {z} from 'zod';
import {capabilityDescriptorSchema} from '../../contracts/src/capability.js';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical,type Gateway} from './index.js';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const readBackRequestSchema=z.object({
 version:z.literal(1),tenantId:z.uuid(),ownerId:z.uuid(),actionId:z.uuid(),actionKey:z.string().min(1).max(512),
 argsHash:digest,resourceId:z.string().min(1).max(2048),capabilityId:z.string().min(1).max(256),
 capabilityVersion:z.string().min(1).max(128),bindingHash:digest,descriptorHash:digest,readerBindingHash:digest
}).strict();
export const readBackProofSchema=readBackRequestSchema.extend({
 outcome:z.enum(['APPLIED','NOT_APPLIED']),terminal:z.literal(true),observedAt:z.iso.datetime(),evidenceHash:digest
}).strict();
export type ReadBackRequest=z.infer<typeof readBackRequestSchema>;
const reviewSchema=z.object({
 protocol:z.literal('TERMINAL_OPERATION_JOURNAL_V1'),
 capabilityId:z.string().min(1).max(256),capabilityVersion:z.string().min(1).max(128),bindingHash:digest,descriptorHash:digest,
 reader:capabilityDescriptorSchema,readerBindingHash:digest,connectorId:z.string().min(1).max(256)
}).strict().superRefine((v,c)=>{
 if(v.reader.risk!=='READ'||v.reader.state!=='READY'||v.reader.provider==='CORE'||v.reader.supportsDryRun||
    canonical(v.reader.inputSchema)!==canonical(z.toJSONSchema(readBackRequestSchema))||
    canonical(v.reader.outputSchema)!==canonical(z.toJSONSchema(readBackProofSchema)))c.addIssue({code:'custom',message:'REVIEWED_READ_BACK_CONTRACT_REQUIRED'});
});
export type ReadBackReview=z.infer<typeof reviewSchema>;
type Reader=(request:ReadBackRequest,context:{principal:DbContext;signal:AbortSignal})=>Promise<unknown>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export type ReadBackRegistration=Readonly<{review:ReadBackReview;reviewHash:string;inputSchemaHash:string;read:Reader}>;

// Internal, reviewed adapter registration only. There is no HTTP/config route
// that turns an arbitrary tool, EMPTY result, or human claim into a verifier.
// The journal protocol must authenticate the *reviewer's* read independently,
// bind a terminal record to the complete original operation, and guarantee a
// terminal NOT_APPLIED record cannot later be accepted. No real adapter is
// enabled by default; provider guarantees need their own reviewed integration.
export class CertifiedReadBacks {
 private entries=new Map<string,ReadBackRegistration>();
 constructor(private gateway:Gateway){}
 register(input:ReadBackReview,read:Reader){
  const review=structuredClone(reviewSchema.parse(input)),key=canonical([review.capabilityId,review.capabilityVersion]);
  if(this.entries.has(key))throw Error('DUPLICATE_READ_BACK');
  const current=this.gateway.describeCapability(review.capabilityId,review.capabilityVersion);
  if(!current||current.state!=='READY'||current.risk==='READ'||current.risk==='FORBIDDEN'||current.bindingHash!==review.bindingHash||current.descriptorHash!==review.descriptorHash)throw Error('READ_BACK_WRITE_CONTRACT_REQUIRED');
  const entry=Object.freeze({review:freeze(review),reviewHash:hash(canonical(review)),inputSchemaHash:current.inputSchemaHash,read});this.entries.set(key,entry);
 }
 resolve(action:{capability_id:string;tool_version:unknown;binding_hash:unknown;scope_descriptor:Record<string,unknown>}):ReadBackRegistration|null{
  const entry=this.entries.get(canonical([action.capability_id,action.tool_version]));if(!entry)return null;
  try{const current=this.gateway.describeCapability(action.capability_id,String(action.tool_version)),r=entry.review;
   return current&&current.state==='READY'&&current.risk!=='READ'&&current.risk!=='FORBIDDEN'&&current.bindingHash===r.bindingHash&&current.descriptorHash===r.descriptorHash&&action.binding_hash===r.bindingHash&&action.scope_descriptor['descriptorHash']===r.descriptorHash?entry:null;
  }catch{return null;}
 }
 async observe(entry:ReadBackRegistration,request:ReadBackRequest,principal:DbContext){
  const start=Date.now(),signal=AbortSignal.timeout(10000);let listener:(()=>void)|undefined;
  try{
   const value=await Promise.race([entry.read(freeze(readBackRequestSchema.parse(request)),{principal:Object.freeze({...principal}),signal}),new Promise<never>((_,reject)=>{listener=()=>reject(Error('READ_BACK_TIMEOUT'));signal.addEventListener('abort',listener,{once:true});})]);
   signal.throwIfAborted();const proof=readBackProofSchema.safeParse(value);if(!proof.success)return null;
   const {outcome,terminal,observedAt,evidenceHash,...scope}=proof.data,time=new Date(observedAt).getTime();
   if(canonical(scope)!==canonical(request)||time<start-30000||time>Date.now()+30000)return null;
   return {outcome,terminal,observedAt,evidenceHash,reviewHash:entry.reviewHash};
  }catch{return null;}finally{if(listener)signal.removeEventListener('abort',listener);}
 }
}
