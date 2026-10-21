import {snapshotGroupMentionPolicies,groupMentionRosterTargetForPolicy,validateGroupMentionRosterDelegation,type GroupMentionRosterPolicy} from './group-mention-roster-protocol.js';
import {snapshotNativeCaseRosterPolicies,nativeCaseRosterTargetForPolicy,validateNativeCaseRosterDelegation,type NativeCaseRosterPolicy} from './native-case-roster-protocol.js';
import {readRequestSchema as requestSchema} from './read-protocol.js';
import {snapshotScheduledGroupPolicies,scheduledGroupTargetForPolicy,validateScheduledGroupDelegation,type ScheduledGroupPolicy} from './scheduled-group-protocol.js';
import {snapshotCaseRosterPolicies,caseRosterTargetForPolicy,validateCaseRosterDelegation,type CaseRosterPolicy} from './case-roster-protocol.js';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {DwsError,validateState,subjectPart} from './contracts.js';
import type {DwsRunner} from './runner.js';
import {helloSchema,responseSchema,openEnvelope,signEnvelope,rpcHash,rpcBodyLimit,snapshotGroupScopes,groupTargetForScope,validateSignedGroupObservation,snapshotDocumentScopes,snapshotDocumentPolicies,documentScopeForPolicy,documentTargetForScope,validateSignedDocumentObservation,type DwsDocumentScope,type DwsDocumentPolicy,type DwsGroupScope,type DwsReadPolicy,type DwsSignedReadResponse} from './signed-protocol.js';

type SignedReadRunner=Pick<DwsRunner,'config'|'verify'|'readSelf'> & Partial<Pick<DwsRunner,'readGroupAudience'|'readDocument'>>;
export function readBindingHash(runner:Pick<DwsRunner,'config'>,groupScopes?:unknown,documentScopes?:unknown,documentPolicies?:unknown,caseRosterPolicies?:unknown,scheduledGroupPolicies?:unknown,nativeCaseRosterPolicies?:unknown,groupMentionPolicies?:unknown){
 const legacy=rpcHash({protocol:'OA_DWS_READ_V1',binaryHash:runner.config.binaryHash,schemaHash:runner.config.schemaHash,operations:['VERIFY_IDENTITY','READ_SELF']}),scopes=snapshotGroupScopes(groupScopes);
 const current=scopes.length?rpcHash({protocol:'OA_DWS_READ_V1',legacy,operations:['VERIFY_IDENTITY','READ_SELF','READ_GROUP_AUDIENCE'],groups:scopes.map(groupTargetForScope)}):legacy,documents=snapshotDocumentScopes(documentScopes),policies=snapshotDocumentPolicies(documentPolicies);
 if(documents.length&&policies.length)throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
 const roster=snapshotCaseRosterPolicies(caseRosterPolicies);
 const base=policies.length?rpcHash({protocol:'OA_DWS_READ_V1',base:current,operations:['READ_DOCUMENT'],documentPolicies:policies}):documents.length?rpcHash({protocol:'OA_DWS_READ_V1',base:current,operations:['READ_DOCUMENT'],documents:documents.map(documentTargetForScope)}):current;
 const withRoster=roster.length?rpcHash({protocol:'OA_DWS_READ_V1',base,operations:['READ_GROUP_CASE_ROSTER'],caseRosterPolicies:roster}):base,scheduled=snapshotScheduledGroupPolicies(scheduledGroupPolicies);
 const withScheduled=scheduled.length?rpcHash({protocol:'OA_DWS_READ_V1',base:withRoster,operations:['READ_GROUP_REMINDER_AUDIENCE'],scheduledGroupPolicies:scheduled}):withRoster,native=snapshotNativeCaseRosterPolicies(nativeCaseRosterPolicies);
 const withNative=native.length?rpcHash({protocol:'OA_DWS_READ_V1',base:withScheduled,operations:['READ_NATIVE_GROUP_CASE_ROSTER'],nativeCaseRosterPolicies:native}):withScheduled,mention=snapshotGroupMentionPolicies(groupMentionPolicies);
 return mention.length?rpcHash({protocol:'OA_DWS_READ_V1',base:withNative,operations:['READ_GROUP_MENTION_AUDIENCE'],groupMentionPolicies:mention}):withNative;
}
export async function safeSocketParent(socketPath:string){if(!isAbsolute(socketPath)||Buffer.byteLength(socketPath)>100)throw new DwsError('DWS_RPC_SOCKET_UNSAFE');const parent=dirname(socketPath),info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||await realpath(parent)!==parent)throw new DwsError('DWS_RPC_SOCKET_UNSAFE');}
async function jsonBody(req:IncomingMessage,limit:number){let bytes=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk as Uint8Array);bytes+=b.length;if(bytes>limit)throw new DwsError('DWS_RPC_BODY_TOO_LARGE');chunks.push(b);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new DwsError('DWS_RPC_BODY_INVALID');}}
function jsonReply(res:ServerResponse,status:number,value:unknown){if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end(JSON.stringify(value));}

export class SignedDwsReadService{
 readonly instanceId=randomUUID();readonly bindingHash:string;
 private readonly seen=new Map<string,{monotonicUntil:number;wallUntil:number}>();private readonly active=new Set<AbortController>();
 private wallFloor=Date.now();
 private readonly requests=new Set<Promise<void>>();
 private closed=false;private server:ReturnType<typeof createServer>|undefined;
 private readonly groupMentionPolicies:readonly GroupMentionRosterPolicy[];
 private readonly nativeCaseRosterPolicies:readonly NativeCaseRosterPolicy[];
 private readonly scheduledGroupPolicies:readonly ScheduledGroupPolicy[];
 private readonly caseRosterPolicies:readonly CaseRosterPolicy[];private readonly policy:DwsReadPolicy;private readonly groupScopes:readonly DwsGroupScope[];private readonly runnerBaseHash:string;private readonly documentScopes:readonly DwsDocumentScope[];private readonly documentPolicies:readonly DwsDocumentPolicy[];
 constructor(private readonly runner:SignedReadRunner,policy:DwsReadPolicy){
  const scalars=z.object({tenantId:z.uuid(),corpId:subjectPart,policyHash:z.string().regex(/^[a-f0-9]{64}$/),callerKeyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),runnerKeyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),maxRequestMs:z.number().int().min(100).max(10000),maxConcurrent:z.number().int().min(1).max(8),maxReplayEntries:z.number().int().min(1).max(100000)}).parse(policy);
  if(policy.callerPublicKey.type!=='public'||policy.runnerPrivateKey.type!=='private'||policy.callerPublicKey.asymmetricKeyType!=='ed25519'||policy.runnerPrivateKey.asymmetricKeyType!=='ed25519')throw new DwsError('DWS_RPC_KEY_INVALID');
  this.policy=Object.freeze({...scalars,callerPublicKey:policy.callerPublicKey,runnerPrivateKey:policy.runnerPrivateKey});
  this.groupMentionPolicies=snapshotGroupMentionPolicies(policy.groupMentionPolicies);this.nativeCaseRosterPolicies=snapshotNativeCaseRosterPolicies(policy.nativeCaseRosterPolicies);this.scheduledGroupPolicies=snapshotScheduledGroupPolicies(policy.scheduledGroupPolicies);this.caseRosterPolicies=snapshotCaseRosterPolicies(policy.caseRosterPolicies);this.groupScopes=snapshotGroupScopes(policy.groupScopes);this.documentScopes=snapshotDocumentScopes(policy.documentScopes);this.documentPolicies=snapshotDocumentPolicies(policy.documentPolicies);this.runnerBaseHash=readBindingHash(runner);
  if(this.groupScopes.some(s=>s.delegation.tenantId!==scalars.tenantId||s.delegation.subject.corpId!==scalars.corpId||!this.scopeRunnerCurrent(s))||this.groupScopes.length&&typeof runner.readGroupAudience!=='function')throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  if(this.documentScopes.some(s=>s.delegation.tenantId!==scalars.tenantId||s.delegation.subject.corpId!==scalars.corpId||!this.documentScopeRunnerCurrent(s))||this.documentScopes.length&&typeof runner.readDocument!=='function')throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
  if(this.documentPolicies.some(p=>p.principal.tenantId!==scalars.tenantId||p.principal.subject.corpId!==scalars.corpId||runner.config.binaryHash!==p.binaryHash||runner.config.documentSchemaHash!==p.documentSchemaHash)||this.documentPolicies.length&&typeof runner.readDocument!=='function'||this.documentScopes.length&&runner.config.mode==='PRODUCTION')throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
  if(this.caseRosterPolicies.some(p=>p.principal.tenantId!==scalars.tenantId||p.principal.subject.corpId!==scalars.corpId||!this.scopeRunnerCurrent(p))||this.caseRosterPolicies.length&&typeof runner.readGroupAudience!=='function')throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  if(this.scheduledGroupPolicies.some(p=>p.principal.tenantId!==scalars.tenantId||p.principal.subject.corpId!==scalars.corpId||!this.scopeRunnerCurrent(p))||this.scheduledGroupPolicies.length&&typeof runner.readGroupAudience!=='function')throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  if(this.nativeCaseRosterPolicies.some(p=>p.principal.tenantId!==scalars.tenantId||p.principal.subject.corpId!==scalars.corpId||!this.scopeRunnerCurrent(p))||this.nativeCaseRosterPolicies.length&&typeof runner.readGroupAudience!=='function')throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  if(this.groupMentionPolicies.some(p=>p.principal.tenantId!==scalars.tenantId||p.principal.subject.corpId!==scalars.corpId||!this.scopeRunnerCurrent(p))||this.groupMentionPolicies.length&&typeof runner.readGroupAudience!=='function')throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  this.bindingHash=readBindingHash(runner,this.groupScopes,this.documentScopes,this.documentPolicies,this.caseRosterPolicies,this.scheduledGroupPolicies,this.nativeCaseRosterPolicies,this.groupMentionPolicies);
 }
 private scopeRunnerCurrent(s:Pick<DwsGroupScope,'binaryHash'|'membersSchemaHash'|'infoSchemaHash'>){return readBindingHash(this.runner)===this.runnerBaseHash&&this.runner.config.binaryHash===s.binaryHash&&this.runner.config.groupMembersSchemaHash===s.membersSchemaHash&&this.runner.config.groupInfoSchemaHash===s.infoSchemaHash;}
 private documentScopeRunnerCurrent(s:DwsDocumentScope){return readBindingHash(this.runner)===this.runnerBaseHash&&this.runner.config.binaryHash===s.binaryHash&&this.runner.config.documentSchemaHash===s.documentSchemaHash;}
 async listen(socketPath:string){if(this.server||this.closed)throw new DwsError('DWS_RPC_ALREADY_STARTED');await safeSocketParent(socketPath);if(await lstat(socketPath).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}))throw new DwsError('DWS_RPC_SOCKET_EXISTS');
  const server=createServer((req,res)=>{const task=this.handle(req,res).catch(()=>jsonReply(res,400,{error:'DWS_RPC_REQUEST_REJECTED'}));this.requests.add(task);void task.finally(()=>this.requests.delete(task));});server.requestTimeout=11000;server.headersTimeout=11000;server.timeout=11000;server.maxConnections=16;server.maxRequestsPerSocket=1;this.server=server;
  // The 0700 parent prevents access before chmod and must be a dedicated mount.
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});await chmod(socketPath,0o600);}catch(error){await this.close();throw error;}
 }
 private async handle(req:IncomingMessage,res:ServerResponse){
  if(this.closed||req.method!=='POST'||req.headers['content-type']!=='application/json'||!['/v1/challenge','/v1/read'].includes(req.url??'')){jsonReply(res,404,{error:'DWS_RPC_REQUEST_REJECTED'});return;}
  const raw=await jsonBody(req,req.url==='/v1/challenge'?1024:rpcBodyLimit);
  if(req.url==='/v1/challenge'){const hello=helloSchema.parse(raw),now=Math.max(this.wallFloor,Date.now());this.wallFloor=now;jsonReply(res,200,signEnvelope({type:'CHALLENGE',protocol:'OA_DWS_READ_V1',nonce:hello.nonce,instanceId:this.instanceId,bindingHash:this.bindingHash,policyHash:this.policy.policyHash,issuedAt:now,expiresAt:now+this.policy.maxRequestMs},this.policy.runnerKeyId,this.policy.runnerPrivateKey));return;}
  const request=openEnvelope(raw,this.policy.callerKeyId,this.policy.callerPublicKey,requestSchema),requestHash=rpcHash(request),started=performance.now(),now=Date.now();
  const reply=(result:DwsSignedReadResponse['result'])=>jsonReply(res,200,signEnvelope({type:'READ_RESPONSE',protocol:'OA_DWS_READ_V1',instanceId:this.instanceId,requestId:request.requestId,requestHash,result},this.policy.runnerKeyId,this.policy.runnerPrivateKey));
  if(request.instanceId!==this.instanceId||request.bindingHash!==this.bindingHash||request.policyHash!==this.policy.policyHash){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  if(now<this.wallFloor||request.issuedAt>now||request.expiresAt<=now||request.expiresAt<=request.issuedAt||request.expiresAt-request.issuedAt>this.policy.maxRequestMs){reply({ok:false,code:'DWS_RPC_EXPIRED'});return;}this.wallFloor=now;
  const d=request.delegation,capability=request.operation==='READ_GROUP_MENTION_AUDIENCE'?'dws.group.mention-audience.v1':request.operation==='READ_NATIVE_GROUP_CASE_ROSTER'?'dws.group.native-case-roster.v1':request.operation==='READ_GROUP_REMINDER_AUDIENCE'?'dws.group.reminder-audience.v1':request.operation==='READ_GROUP_CASE_ROSTER'?'dws.group.case-roster.v1':request.operation==='READ_DOCUMENT'?'dws.doc.read.v1':request.operation==='READ_GROUP_AUDIENCE'?'dws.group.audience.v1':request.operation==='READ_SELF'?'dws.contact.me.v1':'dws.identity.verify.v1';
  if(d.tenantId!==this.policy.tenantId||d.subject.corpId!==this.policy.corpId||d.audience.id!==d.ownerId||d.capabilityBindingId!==capability){reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
  let mentionPolicy:GroupMentionRosterPolicy|undefined;
  if(request.operation==='READ_GROUP_MENTION_AUDIENCE'){
   mentionPolicy=this.groupMentionPolicies.find(p=>p.scopeId===request.group.scopeId);
   try{if(!mentionPolicy)throw Error();validateGroupMentionRosterDelegation(d,mentionPolicy,{now});if(rpcHash(request.group)!==rpcHash(groupMentionRosterTargetForPolicy(mentionPolicy)))throw Error();}catch(error){reply({ok:false,code:error instanceof DwsError&&error.code==='DWS_RPC_EXPIRED'?'DWS_RPC_EXPIRED':'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(!this.scopeRunnerCurrent(mentionPolicy)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  let nativePolicy:NativeCaseRosterPolicy|undefined;
  if(request.operation==='READ_NATIVE_GROUP_CASE_ROSTER'){
   nativePolicy=this.nativeCaseRosterPolicies.find(p=>p.scopeId===request.group.scopeId);
   try{if(!nativePolicy)throw Error();validateNativeCaseRosterDelegation(d,nativePolicy,{now});if(rpcHash(request.group)!==rpcHash(nativeCaseRosterTargetForPolicy(nativePolicy)))throw Error();}catch(error){reply({ok:false,code:error instanceof DwsError&&error.code==='DWS_RPC_EXPIRED'?'DWS_RPC_EXPIRED':'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(!this.scopeRunnerCurrent(nativePolicy)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  let scheduledPolicy:ScheduledGroupPolicy|undefined;
  if(request.operation==='READ_GROUP_REMINDER_AUDIENCE'){
   const origin=request.delegation.scheduled;scheduledPolicy=this.scheduledGroupPolicies.find(p=>p.scopeId===request.group.scopeId&&p.scheduleId===origin.scheduleId);
   try{if(!scheduledPolicy)throw Error();validateScheduledGroupDelegation(d,scheduledPolicy,{now});if(rpcHash(request.group)!==rpcHash(scheduledGroupTargetForPolicy(scheduledPolicy)))throw Error();}catch{reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(!this.scopeRunnerCurrent(scheduledPolicy)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  let caseRosterPolicy:CaseRosterPolicy|undefined;
  if(request.operation==='READ_GROUP_CASE_ROSTER'){
   caseRosterPolicy=this.caseRosterPolicies.find(p=>p.scopeId===request.group.scopeId);
   try{if(!caseRosterPolicy)throw Error();validateCaseRosterDelegation(d,caseRosterPolicy,{now});if(rpcHash(request.group)!==rpcHash(caseRosterTargetForPolicy(caseRosterPolicy)))throw Error();}catch{reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(!this.scopeRunnerCurrent(caseRosterPolicy)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  let groupScope:DwsGroupScope|undefined;
  if(request.operation==='READ_GROUP_AUDIENCE'){
   groupScope=this.groupScopes.find(s=>s.scopeId===request.group.scopeId);
   if(!groupScope||rpcHash(d)!==rpcHash(groupScope.delegation)||rpcHash(request.group)!==rpcHash(groupTargetForScope(groupScope))){reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(now<groupScope.validFrom||now>=groupScope.expiresAt){reply({ok:false,code:'DWS_RPC_EXPIRED'});return;}
   if(!this.scopeRunnerCurrent(groupScope)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  let documentScope:DwsDocumentScope|undefined;
  if(request.operation==='READ_DOCUMENT'){
   const policy=this.documentPolicies.find(p=>p.scopeId===request.document.scopeId);
   try{documentScope=policy?documentScopeForPolicy(policy,request.delegation):this.documentScopes.find(s=>s.scopeId===request.document.scopeId);}catch{reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(!documentScope||rpcHash(d)!==rpcHash(documentScope.delegation)||rpcHash(request.document)!==rpcHash(documentTargetForScope(documentScope))){reply({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});return;}
   if(now<documentScope.validFrom||now>=documentScope.expiresAt){reply({ok:false,code:'DWS_RPC_EXPIRED'});return;}
   if(!this.documentScopeRunnerCurrent(documentScope)){reply({ok:false,code:'DWS_RPC_BINDING_CHANGED'});return;}
  }
  for(const [id,until] of this.seen)if(until.monotonicUntil<=started&&until.wallUntil<=now)this.seen.delete(id);
  if(this.seen.has(request.requestId)){reply({ok:false,code:'DWS_RPC_REPLAY'});return;}
  if(this.seen.size>=this.policy.maxReplayEntries||this.active.size>=this.policy.maxConcurrent){reply({ok:false,code:'DWS_RPC_BUSY'});return;}
  // No eviction of live nonces; monotonic retention survives wall-clock rollback.
  // A new random process instance invalidates all previous-process requests.
  this.seen.set(request.requestId,{monotonicUntil:started+this.policy.maxRequestMs,wallUntil:request.expiresAt});
  try{validateState(request.state,d.subject);}catch{reply({ok:false,code:'DWS_RPC_STATE_INVALID'});return;}
  const controller=new AbortController(),executionExpiry=Math.min(request.expiresAt,groupScope?.expiresAt??request.expiresAt,caseRosterPolicy?.expiresAt??request.expiresAt,scheduledPolicy?.expiresAt??request.expiresAt,nativePolicy?.expiresAt??request.expiresAt,mentionPolicy?.expiresAt??request.expiresAt,documentScope?.expiresAt??request.expiresAt),remaining=executionExpiry-now,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)]),disconnected=()=>controller.abort();this.active.add(controller);res.once('close',disconnected);
  try{
   signal.throwIfAborted();
   const result=request.operation==='READ_DOCUMENT'
    ?await this.runner.readDocument!(d.subject,request.state,{nodeId:request.document.nodeId,selector:request.document.selector,authorizationVersion:d.authorizationVersion,requestNonce:request.requestId},documentScope!.profile,signal)
    :request.operation==='READ_GROUP_AUDIENCE'||request.operation==='READ_GROUP_CASE_ROSTER'||request.operation==='READ_GROUP_REMINDER_AUDIENCE'||request.operation==='READ_NATIVE_GROUP_CASE_ROSTER'||request.operation==='READ_GROUP_MENTION_AUDIENCE'
    ?await this.runner.readGroupAudience!(d.subject,request.state,{conversationId:request.group.conversationId,authorizationVersion:d.authorizationVersion,requestNonce:request.requestId},(groupScope??caseRosterPolicy??scheduledPolicy??nativePolicy??mentionPolicy)!.profile,signal)
    :request.operation==='READ_SELF'?await this.runner.readSelf(d.subject,request.state,signal):await this.runner.verify(d.subject,request.state,signal);
   const finished=Date.now();if(signal.aborted||finished<now||finished>=executionExpiry||performance.now()-started>=remaining)throw new DwsError('DWS_RPC_EXPIRED');this.wallFloor=Math.max(this.wallFloor,finished);
   let value:unknown=result.value;
   if(request.operation==='READ_GROUP_AUDIENCE'||request.operation==='READ_GROUP_CASE_ROSTER'||request.operation==='READ_GROUP_REMINDER_AUDIENCE'||request.operation==='READ_NATIVE_GROUP_CASE_ROSTER'||request.operation==='READ_GROUP_MENTION_AUDIENCE'){
    if(!this.scopeRunnerCurrent((groupScope??caseRosterPolicy??scheduledPolicy??nativePolicy??mentionPolicy)!))throw new DwsError('DWS_RPC_BINDING_CHANGED');
    value={operation:request.operation,grantsAuthority:false,delegationHash:rpcHash(d),group:request.group,observation:validateSignedGroupObservation(result.value,request.group,(groupScope??caseRosterPolicy??scheduledPolicy??nativePolicy??mentionPolicy)!.profile)};
   }
   if(request.operation==='READ_DOCUMENT'){
    if(!this.documentScopeRunnerCurrent(documentScope!))throw new DwsError('DWS_RPC_BINDING_CHANGED');
    value={operation:'READ_DOCUMENT',grantsAuthority:false,delegationHash:rpcHash(d),document:request.document,observation:validateSignedDocumentObservation(result.value,request.document,documentScope!.profile)};
   }
   validateState(result.state,d.subject);
   if(groupScope||caseRosterPolicy||scheduledPolicy||nativePolicy||mentionPolicy||documentScope){
    const validatedAt=Date.now();
    if(signal.aborted||validatedAt<finished||validatedAt>=executionExpiry||performance.now()-started>=remaining)throw new DwsError('DWS_RPC_EXPIRED');
    if(groupScope&&!this.scopeRunnerCurrent(groupScope)||caseRosterPolicy&&!this.scopeRunnerCurrent(caseRosterPolicy)||scheduledPolicy&&!this.scopeRunnerCurrent(scheduledPolicy)||documentScope&&!this.documentScopeRunnerCurrent(documentScope))throw new DwsError('DWS_RPC_BINDING_CHANGED');
    if(nativePolicy){validateNativeCaseRosterDelegation(d,nativePolicy,{now:validatedAt});if(!this.scopeRunnerCurrent(nativePolicy))throw new DwsError('DWS_RPC_BINDING_CHANGED');}
    if(mentionPolicy){validateGroupMentionRosterDelegation(d,mentionPolicy,{now:validatedAt});if(!this.scopeRunnerCurrent(mentionPolicy))throw new DwsError('DWS_RPC_BINDING_CHANGED');}
    this.wallFloor=Math.max(this.wallFloor,validatedAt);
   }
   reply({ok:true,value,state:result.state});
  }catch(error){
   // Never return vendor stderr, raw exception messages, credentials or paths.
   const candidate=error instanceof DwsError?error.code:signal.aborted?'DWS_PROCESS_TIMEOUT':'DWS_RPC_EXECUTION_FAILED';
   const parsed=responseSchema.shape.result.safeParse({ok:false,code:candidate});reply(parsed.success?parsed.data:{ok:false,code:'DWS_RPC_EXECUTION_FAILED'});
  }finally{res.removeListener('close',disconnected);this.active.delete(controller);}
 }
 async close(){this.closed=true;for(const controller of this.active)controller.abort();const server=this.server;if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await Promise.allSettled([...this.requests]);}
}
