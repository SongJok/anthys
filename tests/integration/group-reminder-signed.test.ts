import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dwsFixture,dwsCredentialCanary} from '../support/dws-cli.js';
import {groupMembersReply,groupInfoReply,syntheticGroupInfoProfile} from '../support/group-members.js';
import {SignedDwsReadService,readBindingHash} from '../../packages/dws/src/signed-service.js';
import {SignedDwsReadClient,postDwsSocket} from '../../packages/dws/src/signed-client.js';
import {SignedGroupAudienceReader} from '../../packages/dws/src/signed-group-reader.js';
import {scheduledGroupDelegationSchema,scheduledGroupTargetForPolicy,validateScheduledGroupResult,type ScheduledGroupPolicy} from '../../packages/dws/src/scheduled-group-protocol.js';
import {challengeSchema,responseSchema,openEnvelope,signEnvelope,rpcHash,groupDelegationSchema} from '../../packages/dws/src/signed-protocol.js';
import {caseRosterDelegationSchema} from '../../packages/dws/src/case-roster-protocol.js';

/** Real local socket, Ed25519 envelopes and subprocess CLI; no database or real provider. */
async function fixture(options:{installed?:boolean;expired?:boolean}={}){
 const cli=await dwsFixture({groups:true}),root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);
 const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519'),ownerId=randomUUID(),now=Date.now();
 const policy:ScheduledGroupPolicy={schemaVersion:1,purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',principal:{tenantId:randomUUID(),ownerId,identityId:randomUUID(),authEpoch:1,authorizationVersion:1,audience:{kind:'PRIVATE_USER',id:ownerId},subject:{corpId:'synthetic-corp',userId:'synthetic-owner'}},contractId:randomUUID(),delegationId:randomUUID(),scheduleId:randomUUID(),proactiveAuthorizationId:randomUUID(),proactiveAuthorizationHash:'a'.repeat(64),scopeId:randomUUID(),scopeVersion:1,conversationId:'cidSynthetic==',profile:structuredClone(syntheticGroupInfoProfile),binaryHash:cli.runner.config.binaryHash,membersSchemaHash:cli.runner.config.groupMembersSchemaHash!,infoSchemaHash:cli.runner.config.groupInfoSchemaHash!,validFrom:now-10000,expiresAt:now+60000};
 if(options.expired)policy.expiresAt=now-1;
 const delegation=scheduledGroupDelegationSchema.parse({...policy.principal,purpose:policy.purpose,capabilityBindingId:policy.capabilityBindingId,contract:{contractId:policy.contractId,version:2,revisionHash:'b'.repeat(64),delegationId:policy.delegationId},authorization:{id:policy.proactiveAuthorizationId,version:3,documentHash:policy.proactiveAuthorizationHash},scheduled:{scheduleId:policy.scheduleId,revision:4,generation:5,occurrenceId:randomUUID(),fence:6,scheduledAt:new Date(now).toISOString(),notificationId:randomUUID(),originHash:'c'.repeat(64),phase:'PLAN'}});
 const keys={tenantId:policy.principal.tenantId,corpId:policy.principal.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_SCHEDULED_ONLY'}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:100};
 const configure=async(extra:Record<string,unknown>={})=>cli.mode('normal',{groups:{[policy.conversationId]:{allowedUsers:[delegation.subject.userId],reply:groupMembersReply(),info:groupInfoReply(),...extra}}});await configure();
 const service=new SignedDwsReadService(cli.runner,{...keys,scheduledGroupPolicies:options.installed===false?[]:[policy]});
 try{await service.listen(socketPath);}catch(e){await service.close();await cli.close();await rm(root,{recursive:true,force:true});throw e;}
 const client=new SignedDwsReadClient({socketPath,callerKeyId:keys.callerKeyId,callerPrivateKey:caller.privateKey,runnerKeyId:keys.runnerKeyId,runnerPublicKey:signer.publicKey,bindingHash:service.bindingHash,policyHash:keys.policyHash,timeoutMs:3000}),reader=new SignedGroupAudienceReader(client);
 const request=async()=>{const challenge=openEnvelope(await postDwsSocket(socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce:randomUUID()},AbortSignal.timeout(4000)),keys.runnerKeyId,signer.publicKey,challengeSchema),issuedAt=Date.now();return {type:'READ_REQUEST' as const,protocol:'OA_DWS_READ_V1' as const,instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:service.bindingHash,policyHash:keys.policyHash,issuedAt,expiresAt:Math.min(issuedAt+3000,challenge.expiresAt),operation:'READ_GROUP_REMINDER_AUDIENCE' as const,delegation:structuredClone(delegation),group:scheduledGroupTargetForPolicy(policy),state:cli.state(delegation.subject)};};
 const sign=(value:unknown)=>signEnvelope(value,keys.callerKeyId,caller.privateKey),rawRead=async(value:unknown)=>openEnvelope(await postDwsSocket(socketPath,'/v1/read',value,AbortSignal.timeout(4000)),keys.runnerKeyId,signer.publicKey,responseSchema);
 return {cli,policy,delegation,service,request,sign,rawRead,configure,read:(signal=AbortSignal.timeout(4000))=>reader.readScheduled(delegation,cli.state(delegation.subject),policy,signal),close:async()=>{await service.close();await cli.close();await rm(root,{recursive:true,force:true});}};
}

it('scheduled transport uses reviewed owner profile and full independent platform roster without granting publication authority',async()=>{
 const f=await fixture();try{const r=await f.read(),events=await f.cli.events();expect(r.grantsAuthority).toBe(false);expect(r.value.platformCountsVerified).toBe(true);expect(r.value.users).toHaveLength(2);expect(r.value.bots).toHaveLength(1);expect(JSON.stringify(r.value)).not.toContain(dwsCredentialCanary);expect(events.filter(e=>e.phase==='GROUP_INFO')).toHaveLength(2);expect(events.filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);expect(events.some(e=>e.phase==='READ'||e.phase==='DOC_READ')).toBe(false);expect(events.every(e=>e.user===f.delegation.subject.userId&&e.corp===f.delegation.subject.corpId&&e.tokenMatches)).toBe(true);expect(await readdir(f.cli.workspace)).toEqual([]);expect(f.service.bindingHash).toBe(readBindingHash(f.cli.runner,undefined,undefined,undefined,undefined,[f.policy]));expect(groupDelegationSchema.safeParse(f.delegation).success).toBe(false);expect(caseRosterDelegationSchema.safeParse(f.delegation).success).toBe(false);}finally{await f.close();}
});

it.each(['tenant','owner','identity','authEpoch','authorizationVersion','subject','contract','delegation','schedule','authorization','authorizationHash','scope','scopeVersion','profile','binary','membersSchema','infoSchema','instance','binding','policy','expired'])('signed scheduled request rejects changed fixed binding %s before CLI execution',async kind=>{
 const f=await fixture();try{const req=await f.request(),d=req.delegation;let expected='DWS_RPC_SCOPE_MISMATCH';
 if(kind==='tenant')d.tenantId=randomUUID();if(kind==='owner'){d.ownerId=randomUUID();d.audience.id=d.ownerId;}if(kind==='identity')d.identityId=randomUUID();if(kind==='authEpoch')d.authEpoch++;if(kind==='authorizationVersion')d.authorizationVersion++;if(kind==='subject')d.subject.userId='other-owner';if(kind==='contract')d.contract.contractId=randomUUID();if(kind==='delegation')d.contract.delegationId=randomUUID();if(kind==='schedule')d.scheduled.scheduleId=randomUUID();if(kind==='authorization')d.authorization.id=randomUUID();if(kind==='authorizationHash')d.authorization.documentHash='d'.repeat(64);if(kind==='scope')req.group.scopeId=randomUUID();if(kind==='scopeVersion')req.group.scopeVersion++;if(kind==='profile')req.group.profileHash='0'.repeat(64);if(kind==='binary')req.group.binaryHash='0'.repeat(64);if(kind==='membersSchema')req.group.membersSchemaHash='0'.repeat(64);if(kind==='infoSchema')req.group.infoSchemaHash='0'.repeat(64);if(kind==='instance'){req.instanceId=randomUUID();expected='DWS_RPC_BINDING_CHANGED';}if(kind==='binding'){req.bindingHash='0'.repeat(64);expected='DWS_RPC_BINDING_CHANGED';}if(kind==='policy'){req.policyHash='0'.repeat(64);expected='DWS_RPC_BINDING_CHANGED';}if(kind==='expired'){req.issuedAt=Date.now()-10000;req.expiresAt=Date.now()-1;expected='DWS_RPC_EXPIRED';}
 expect((await f.rawRead(f.sign(req))).result).toEqual({ok:false,code:expected});expect(await f.cli.events()).toEqual([]);
 }finally{await f.close();}
});

it.each(['extra','native','h5','signature','phase','occurrenceId','fence','generation','revision','notificationId','originHash','scheduledAt','contractVersion','contractHash','authorizationVersion'])('wire rejects unsigned dynamic mutation or foreign shape %s',async kind=>{
 const f=await fixture();try{const req=await f.request();let envelope=f.sign(req);
 if(kind==='extra')envelope=f.sign({...req,endpoint:'https://undeclared.invalid'});
 else if(kind==='native')envelope=f.sign({...req,delegation:{...req.delegation,taskId:randomUUID(),runId:randomUUID()}});
 else if(kind==='h5')envelope=f.sign({...req,delegation:{...req.delegation,purpose:'H5_SESSION',requester:{actorId:randomUUID(),sessionId:randomUUID(),authEpoch:1}}});
 else if(kind==='signature')envelope={...envelope,signature:'A'.repeat(86)};
 else{const changed=structuredClone(req);if(kind==='phase')changed.delegation.scheduled.phase='SEND';if(kind==='occurrenceId')changed.delegation.scheduled.occurrenceId=randomUUID();if(kind==='fence')changed.delegation.scheduled.fence++;if(kind==='generation')changed.delegation.scheduled.generation++;if(kind==='revision')changed.delegation.scheduled.revision++;if(kind==='notificationId')changed.delegation.scheduled.notificationId=randomUUID();if(kind==='originHash')changed.delegation.scheduled.originHash='d'.repeat(64);if(kind==='scheduledAt')changed.delegation.scheduled.scheduledAt=new Date(Date.now()+60000).toISOString();if(kind==='contractVersion')changed.delegation.contract.version++;if(kind==='contractHash')changed.delegation.contract.revisionHash='d'.repeat(64);if(kind==='authorizationVersion')changed.delegation.authorization.version++;envelope={...f.sign(changed),signature:envelope.signature};}
 await expect(f.rawRead(envelope)).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});expect(await f.cli.events()).toEqual([]);
 }finally{await f.close();}
});

it('PLAN and SEND preserve all trusted occurrence assertions in signed responses and cannot reuse the old response',async()=>{
 const f=await fixture();try{const plan=await f.request(),first=await f.rawRead(f.sign(plan));expect(first.requestHash).toBe(rpcHash(plan));expect(first.result.ok).toBe(true);if(!first.result.ok)throw Error('Expected PLAN observation');expect(first.result.value).toMatchObject({operation:plan.operation,grantsAuthority:false,delegationHash:rpcHash(plan.delegation),group:plan.group});
 const oldValue=first.result.value,send=await f.request();send.delegation.scheduled={...send.delegation.scheduled,phase:'SEND',fence:7,generation:6,revision:5,occurrenceId:randomUUID(),notificationId:randomUUID(),originHash:'d'.repeat(64)};send.delegation.contract.version++;send.delegation.contract.revisionHash='e'.repeat(64);send.delegation.authorization.version++;
 const second=await f.rawRead(f.sign(send));expect(second.result.ok).toBe(true);expect(second.requestHash).toBe(rpcHash(send));expect(second.requestHash).not.toBe(first.requestHash);if(!second.result.ok)throw Error('Expected SEND observation');expect(second.result.value).toMatchObject({delegationHash:rpcHash(send.delegation)});expect(()=>validateScheduledGroupResult(oldValue,{delegation:send.delegation,policy:f.policy,now:Date.now()})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(2);
 }finally{await f.close();}
});

it('concurrent exact signed envelope is physically read once and replayed once',async()=>{
 const f=await fixture();try{const request=await f.request(),signed=f.sign(request),replies=await Promise.all([f.rawRead(signed),f.rawRead(signed)]);expect(replies.filter(r=>r.result.ok)).toHaveLength(1);expect(replies.filter(r=>!r.result.ok).map(r=>r.result)).toEqual([{ok:false,code:'DWS_RPC_REPLAY'}]);expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);}finally{await f.close();}
});

it('missing installed scheduled policy is rejected even with otherwise matching signed request',async()=>{
 const f=await fixture({installed:false});try{expect((await f.rawRead(f.sign(await f.request()))).result).toEqual({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});expect(await f.cli.events()).toEqual([]);}finally{await f.close();}
});
it('expired installed scheduled policy is rejected by both owner adapter and actual signed service before provider execution',async()=>{
 const f=await fixture({expired:true});try{await expect(f.read()).rejects.toMatchObject({code:'DWS_RPC_EXPIRED'});expect((await f.rawRead(f.sign(await f.request()))).result).toEqual({ok:false,code:'DWS_RPC_SCOPE_MISMATCH'});expect(await f.cli.events()).toEqual([]);}finally{await f.close();}
});
it('runner binary drift after installation rejects a previously correct target before provider execution',async()=>{
 const f=await fixture();try{const req=await f.request();f.cli.runner.config.binaryHash='0'.repeat(64);expect((await f.rawRead(f.sign(req))).result).toEqual({ok:false,code:'DWS_RPC_BINDING_CHANGED'});expect(await f.cli.events()).toEqual([]);}finally{await f.close();}
});

it.each(['partial','countMismatch','rosterChanged'])('incomplete platform observation %s never becomes a successful signed roster',async kind=>{
 const f=await fixture();try{const reply=groupMembersReply();if(kind==='partial'){reply.data.hasMore=true;reply.data.complete=false;reply.data.partial=true;reply.data.buckets.users.hasMore=true;reply.data.buckets.users.complete=false;}await f.configure({reply,info:groupInfoReply(kind==='countMismatch'?3:2),...(kind==='rosterChanged'?{infoAfter:groupInfoReply(2,1,'r2')}:{})});await expect(f.read()).rejects.toThrow();expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);}finally{await f.close();}
});

it('prior cancellation does not execute the CLI or retry',async()=>{const f=await fixture();try{const a=new AbortController();a.abort();await expect(f.read(a.signal)).rejects.toThrow();expect(await f.cli.events()).toEqual([]);}finally{await f.close();}});
it('in-flight cancellation terminates the current CLI observation without a retry or returned roster',async()=>{
 const f=await fixture();try{await f.configure({delayMs:5000});const a=new AbortController(),result=f.read(a.signal).then(()=>({ok:true}),()=>({ok:false})),until=Date.now()+2500;while(!(await f.cli.events()).some(e=>e.phase==='GROUP_READ')){if(Date.now()>=until)throw Error('CLI did not reach GROUP_READ within original deadline');await new Promise(r=>setTimeout(r,10));}a.abort();expect(await result).toEqual({ok:false});await f.service.close();expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);expect(await readdir(f.cli.workspace)).toEqual([]);}finally{await f.close();}
});
it('original 3000ms RPC deadline rejects delayed provider and never retries or exposes credentials',async()=>{
 const f=await fixture();try{await f.configure({delayMs:5000});const error=await f.read().then(()=>null,e=>e as Error);expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(dwsCredentialCanary);await f.service.close();expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);expect(await readdir(f.cli.workspace)).toEqual([]);}finally{await f.close();}
});
