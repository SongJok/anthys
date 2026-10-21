import {groupMentionRosterDelegationSchema,groupMentionRosterSignedResultSchema,type GroupMentionRosterDelegation} from './group-mention-roster-protocol.js';
import {nativeCaseRosterDelegationSchema,nativeCaseRosterSignedResultSchema,type NativeCaseRosterDelegation} from './native-case-roster-protocol.js';
import {readRequestSchema as requestSchema} from './read-protocol.js';
import {scheduledGroupDelegationSchema,scheduledGroupSignedResultSchema,type ScheduledGroupDelegation} from './scheduled-group-protocol.js';
import {caseRosterDelegationSchema,caseRosterSignedResultSchema,type CaseRosterDelegation} from './case-roster-protocol.js';
import {request as httpRequest} from 'node:http';
import {randomUUID,type KeyObject} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {DwsError,validateState,type DwsState} from './contracts.js';
import {safeSocketParent} from './signed-service.js';
import {challengeSchema,responseSchema,delegationSchema,groupDelegationSchema,groupTargetSchema,documentDelegationSchema,documentTargetSchema,signedDocumentResultSchema,validateSignedDocumentObservation,signedGroupResultSchema,validateSignedGroupObservation,openEnvelope,signEnvelope,rpcHash,rpcBodyLimit,type DwsReadDelegation,type DwsGroupDelegation,type DwsGroupTarget,type DwsSignedReadResponse,type DwsDocumentDelegation,type DwsDocumentTarget} from './signed-protocol.js';

export async function postDwsSocket(socketPath:string,path:'/v1/challenge'|'/v1/read',body:unknown,signal:AbortSignal):Promise<unknown>{
 signal.throwIfAborted();await safeSocketParent(socketPath);const socket=await lstat(socketPath);if(!socket.isSocket()||(socket.mode&0o077)!==0)throw new DwsError('DWS_RPC_SOCKET_UNSAFE');const data=Buffer.from(JSON.stringify(body));if(data.length>rpcBodyLimit)throw new DwsError('DWS_RPC_BODY_TOO_LARGE');
 return new Promise((resolve,reject)=>{const req=httpRequest({socketPath,path,method:'POST',agent:false,signal,headers:{'content-type':'application/json','content-length':data.length,'connection':'close'}},res=>{let bytes=0;const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>rpcBodyLimit){req.destroy(new DwsError('DWS_RPC_BODY_TOO_LARGE'));return;}chunks.push(b);});res.on('error',()=>reject(new DwsError('DWS_RPC_TRANSPORT_FAILED')));res.on('end',()=>{if(res.statusCode!==200||res.headers['content-type']!=='application/json'){reject(new DwsError('DWS_RPC_TRANSPORT_FAILED'));return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new DwsError('DWS_RPC_BODY_INVALID'));}});});req.on('error',error=>reject(error instanceof DwsError?error:new DwsError(signal.aborted?'DWS_PROCESS_TIMEOUT':'DWS_RPC_TRANSPORT_FAILED')));req.end(data);});
}
export type SignedDwsClientConfig={socketPath:string;callerKeyId:string;callerPrivateKey:KeyObject;runnerKeyId:string;runnerPublicKey:KeyObject;bindingHash:string;policyHash:string;timeoutMs:number};
export class SignedDwsReadClient{
 constructor(private readonly config:SignedDwsClientConfig){z.object({bindingHash:z.string().regex(/^[a-f0-9]{64}$/),policyHash:z.string().regex(/^[a-f0-9]{64}$/),timeoutMs:z.number().int().min(100).max(10000),callerKeyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),runnerKeyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)}).parse(config);if(config.callerPrivateKey.type!=='private'||config.runnerPublicKey.type!=='public'||config.callerPrivateKey.asymmetricKeyType!=='ed25519'||config.runnerPublicKey.asymmetricKeyType!=='ed25519')throw new DwsError('DWS_RPC_KEY_INVALID');this.config=Object.freeze({...config});}
 async verify(delegation:DwsReadDelegation,state:DwsState,signal:AbortSignal){const r=await this.invoke('VERIFY_IDENTITY',delegation,state,signal);return {value:z.object({verified:z.literal(true)}).strict().parse(r.value),state:r.state};}
 async readSelf(delegation:DwsReadDelegation,state:DwsState,signal:AbortSignal){const r=await this.invoke('READ_SELF',delegation,state,signal);const value=z.object({userId:z.string(),name:z.string().max(1024).optional(),dept:z.string().max(1024).optional(),org:z.string().max(1024).optional()}).strict().safeParse(r.value);if(!value.success||value.data.userId!==delegation.subject.userId)throw new DwsError('DWS_RPC_RESULT_INVALID');return {value:value.data,state:r.state};}
 /** Metadata read only; the owner-private delegation never grants group publishing. */
 async readGroupAudience(delegation:DwsGroupDelegation,state:DwsState,group:DwsGroupTarget,signal:AbortSignal){
  const d=groupDelegationSchema.parse(delegation),target=groupTargetSchema.parse(group),r=await this.invoke('READ_GROUP_AUDIENCE',d,state,signal,target);
  try{
   const result=signedGroupResultSchema.parse(r.value);
   if(result.delegationHash!==rpcHash(d)||rpcHash(result.group)!==rpcHash(target))throw Error();
   return {value:validateSignedGroupObservation(result.observation,target),state:r.state,grantsAuthority:false as const};
  }catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
 }
 async readGroupMentionAudience(delegation:GroupMentionRosterDelegation,state:DwsState,group:DwsGroupTarget,signal:AbortSignal){
  const d=groupMentionRosterDelegationSchema.parse(delegation),target=groupTargetSchema.parse(group),r=await this.invoke('READ_GROUP_MENTION_AUDIENCE',d,state,signal,target);
  try{const result=groupMentionRosterSignedResultSchema.parse(r.value);if(result.delegationHash!==rpcHash(d)||rpcHash(result.group)!==rpcHash(target))throw Error();return {value:validateSignedGroupObservation(result.observation,target),state:r.state,grantsAuthority:false as const};}catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
 }
 async readNativeCaseRoster(delegation:NativeCaseRosterDelegation,state:DwsState,group:DwsGroupTarget,signal:AbortSignal){
  const d=nativeCaseRosterDelegationSchema.parse(delegation),target=groupTargetSchema.parse(group),r=await this.invoke('READ_NATIVE_GROUP_CASE_ROSTER',d,state,signal,target);
  try{const result=nativeCaseRosterSignedResultSchema.parse(r.value);if(result.delegationHash!==rpcHash(d)||rpcHash(result.group)!==rpcHash(target))throw Error();return {value:validateSignedGroupObservation(result.observation,target),state:r.state,grantsAuthority:false as const};}catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
 }
 async readGroupCaseRoster(delegation:CaseRosterDelegation,state:DwsState,group:DwsGroupTarget,signal:AbortSignal){
  const d=caseRosterDelegationSchema.parse(delegation),target=groupTargetSchema.parse(group),r=await this.invoke('READ_GROUP_CASE_ROSTER',d,state,signal,target);
  try{const result=caseRosterSignedResultSchema.parse(r.value);if(result.delegationHash!==rpcHash(d)||rpcHash(result.group)!==rpcHash(target))throw Error();return {value:validateSignedGroupObservation(result.observation,target),state:r.state,grantsAuthority:false as const};}catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
 }
 async readGroupReminderAudience(delegation:ScheduledGroupDelegation,state:DwsState,group:DwsGroupTarget,signal:AbortSignal){
  const d=scheduledGroupDelegationSchema.parse(delegation),target=groupTargetSchema.parse(group),r=await this.invoke('READ_GROUP_REMINDER_AUDIENCE',d,state,signal,target);
  try{const result=scheduledGroupSignedResultSchema.parse(r.value);if(result.delegationHash!==rpcHash(d)||rpcHash(result.group)!==rpcHash(target))throw Error();return {value:validateSignedGroupObservation(result.observation,target),state:r.state,grantsAuthority:false as const};}catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
 }
 async readDocument(delegation:DwsDocumentDelegation,state:DwsState,document:DwsDocumentTarget,signal:AbortSignal){
  const d=documentDelegationSchema.parse(delegation),target=documentTargetSchema.parse(document),r=await this.invoke('READ_DOCUMENT',d,state,signal,undefined,target);
  try{const result=signedDocumentResultSchema.parse(r.value);if(result.delegationHash!==rpcHash(d)||rpcHash(result.document)!==rpcHash(target))throw Error();return {value:validateSignedDocumentObservation(result.observation,target),state:r.state,grantsAuthority:false as const};}catch{throw new DwsError('DWS_RPC_DOCUMENT_RESULT_INVALID');}
 }
 private async invoke(operation:'VERIFY_IDENTITY'|'READ_SELF'|'READ_GROUP_AUDIENCE'|'READ_DOCUMENT'|'READ_GROUP_CASE_ROSTER'|'READ_GROUP_REMINDER_AUDIENCE'|'READ_NATIVE_GROUP_CASE_ROSTER'|'READ_GROUP_MENTION_AUDIENCE',rawDelegation:DwsReadDelegation|DwsGroupDelegation|DwsDocumentDelegation|CaseRosterDelegation|ScheduledGroupDelegation|NativeCaseRosterDelegation|GroupMentionRosterDelegation,state:DwsState,parentSignal:AbortSignal,group?:DwsGroupTarget,document?:DwsDocumentTarget){
  const started=performance.now(),initialNow=Date.now(),delegation=(operation==='READ_GROUP_MENTION_AUDIENCE'?groupMentionRosterDelegationSchema:operation==='READ_NATIVE_GROUP_CASE_ROSTER'?nativeCaseRosterDelegationSchema:operation==='READ_GROUP_REMINDER_AUDIENCE'?scheduledGroupDelegationSchema:operation==='READ_GROUP_CASE_ROSTER'?caseRosterDelegationSchema:operation==='READ_GROUP_AUDIENCE'?groupDelegationSchema:operation==='READ_DOCUMENT'?documentDelegationSchema:delegationSchema).parse(rawDelegation);
  const deadline=Math.min(initialNow+this.config.timeoutMs,'requester' in delegation&&'deadline' in delegation.requester?delegation.requester.deadline:Infinity),remaining=deadline-Date.now();if(remaining<=0)throw new DwsError('DWS_RPC_EXPIRED');const signal=AbortSignal.any([parentSignal,AbortSignal.timeout(remaining)]);validateState(state,delegation.subject);
  const nonce=randomUUID(),rawChallenge=await postDwsSocket(this.config.socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce},signal),challenge=openEnvelope(rawChallenge,this.config.runnerKeyId,this.config.runnerPublicKey,challengeSchema),now=Date.now();
  if(challenge.nonce!==nonce||challenge.bindingHash!==this.config.bindingHash||challenge.policyHash!==this.config.policyHash||challenge.issuedAt>now||challenge.expiresAt<=now||challenge.expiresAt-challenge.issuedAt>10000)throw new DwsError('DWS_RPC_CHALLENGE_INVALID');
  if(now>=deadline)throw new DwsError('DWS_RPC_EXPIRED');
  const request=requestSchema.parse({type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:this.config.bindingHash,policyHash:this.config.policyHash,issuedAt:now,expiresAt:Math.min(deadline,challenge.expiresAt),operation,delegation,state,...(operation==='READ_GROUP_AUDIENCE'||operation==='READ_GROUP_CASE_ROSTER'||operation==='READ_GROUP_REMINDER_AUDIENCE'||operation==='READ_NATIVE_GROUP_CASE_ROSTER'||operation==='READ_GROUP_MENTION_AUDIENCE'?{group}:operation==='READ_DOCUMENT'?{document}:{})}),raw=await postDwsSocket(this.config.socketPath,'/v1/read',signEnvelope(request,this.config.callerKeyId,this.config.callerPrivateKey),signal),reply=openEnvelope(raw,this.config.runnerKeyId,this.config.runnerPublicKey,responseSchema);
  if(reply.requestId!==request.requestId||reply.instanceId!==request.instanceId||reply.requestHash!==rpcHash(request))throw new DwsError('DWS_RPC_RESPONSE_MISMATCH');if(signal.aborted||Date.now()>=deadline||performance.now()-started>=this.config.timeoutMs)throw new DwsError('DWS_RPC_EXPIRED');
  return this.result(reply,delegation);
 }
 private result(reply:DwsSignedReadResponse,delegation:DwsReadDelegation|DwsGroupDelegation|DwsDocumentDelegation|CaseRosterDelegation|ScheduledGroupDelegation|NativeCaseRosterDelegation|GroupMentionRosterDelegation){if(!reply.result.ok)throw new DwsError(reply.result.code);validateState(reply.result.state,delegation.subject);return reply.result;}
}
