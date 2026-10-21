import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {dwsFixture} from '../support/dws-cli.js';
import {groupMembersReply,groupInfoReply,syntheticGroupInfoProfile} from '../support/group-members.js';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {SignedDwsReadClient,postDwsSocket} from '../../packages/dws/src/signed-client.js';
import {SignedGroupAudienceReader} from '../../packages/dws/src/signed-group-reader.js';
import {SignedGroupReadClient,type DwsNativeCaseRosterAuthority} from '../../packages/dws/src/read-client.js';
import {nativeCaseRosterTargetForPolicy,type NativeCaseRosterPolicy,type NativeCaseRosterDelegation,type NativeCaseRosterRequest} from '../../packages/dws/src/native-case-roster-protocol.js';
import {challengeSchema,openEnvelope,responseSchema,rpcHash,signEnvelope} from '../../packages/dws/src/signed-protocol.js';
import type {DwsRunner} from '../../packages/dws/src/runner.js';

const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function world(enabled=true,timeouts={service:3000,client:3000}){
 const cli=await dwsFixture({groups:true});cleanup.push(()=>cli.close());const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const ownerId=randomUUID(),p:NativeCaseRosterPolicy={schemaVersion:1,purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',principal:{tenantId:randomUUID(),ownerId,identityId:randomUUID(),authEpoch:1,authorizationVersion:2,audience:{kind:'PRIVATE_USER',id:ownerId},subject:{corpId:'synthetic-corp',userId:'synthetic-owner'}},contractId:randomUUID(),contractVersion:1,contractHash:'d'.repeat(64),delegationId:randomUUID(),allowedActions:['case.read','case.create','case.update'],allowedPhases:['EXECUTION','RESULT_VERIFICATION'],scopeId:randomUUID(),scopeVersion:1,conversationId:'cidSynthetic==',profile:structuredClone(syntheticGroupInfoProfile),binaryHash:cli.runner.config.binaryHash,membersSchemaHash:cli.runner.config.groupMembersSchemaHash!,infoSchemaHash:cli.runner.config.groupInfoSchemaHash!,validFrom:Date.now()-1000,expiresAt:Date.now()+60_000};
 const d:NativeCaseRosterDelegation={...structuredClone(p.principal),purpose:p.purpose,capabilityBindingId:p.capabilityBindingId,requester:{actorId:randomUUID(),authEpoch:3,taskId:randomUUID(),runId:randomUUID(),workerId:randomUUID(),fence:4,deadline:Date.now()+20_000,phase:'EXECUTION'},contract:{contractId:p.contractId,version:p.contractVersion,revisionHash:p.contractHash,delegationId:p.delegationId},action:'case.read'};
 const caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519'),socketPath=join(root,'runner.sock'),calls:Parameters<DwsRunner['readGroupAudience']>[]=[],read=cli.runner.readGroupAudience.bind(cli.runner);
 let afterRead:(()=>void)|undefined,entered=()=>{},settled=()=>{};const began=new Promise<void>(resolve=>{entered=resolve;}),finished=new Promise<void>(resolve=>{settled=resolve;});
 cli.runner.readGroupAudience=async(...args)=>{calls.push(args);entered();try{const result=await read(...args);afterRead?.();return result;}finally{settled();}};
 const policy={tenantId:p.principal.tenantId,corpId:p.principal.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_NATIVE_ROSTER_ONLY'}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:timeouts.service,maxConcurrent:2,maxReplayEntries:100,...(enabled?{nativeCaseRosterPolicies:[p]}:{})};
 const service=new SignedDwsReadService(cli.runner,policy);cleanup.push(()=>service.close());await service.listen(socketPath);
 await cli.mode('normal',{groups:{[p.conversationId]:{allowedUsers:[p.principal.subject.userId],reply:groupMembersReply(),info:groupInfoReply()}}});
 const config={socketPath,callerKeyId:policy.callerKeyId,callerPrivateKey:caller.privateKey,runnerKeyId:policy.runnerKeyId,runnerPublicKey:signer.publicKey,bindingHash:service.bindingHash,policyHash:policy.policyHash,timeoutMs:timeouts.client},client=new SignedDwsReadClient(config),reader=new SignedGroupReadClient({...cli.runner.config,signedBindingHash:service.bindingHash,signedPolicyHash:policy.policyHash},new SignedGroupAudienceReader(client),[],[],[],[p]);
 const authority:DwsNativeCaseRosterAuthority={conversationId:p.conversationId,delegation:d,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeExpiresAtMs:p.expiresAt+1000,contractExpiresAtMs:p.expiresAt+1000,profileHash:rpcHash(p.profile)},state=cli.state(p.principal.subject),target=nativeCaseRosterTargetForPolicy(p),signal=new AbortController().signal;
 async function request():Promise<NativeCaseRosterRequest>{const nonce=randomUUID(),challenge=openEnvelope(await postDwsSocket(socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce},AbortSignal.timeout(4000)),policy.runnerKeyId,signer.publicKey,challengeSchema),now=Date.now();return {type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:service.bindingHash,policyHash:policy.policyHash,issuedAt:now,expiresAt:Math.min(now+3000,challenge.expiresAt,d.requester.deadline),operation:'READ_NATIVE_GROUP_CASE_ROSTER',delegation:structuredClone(d),group:target,state};}
 const sign=(body:unknown)=>signEnvelope(body,policy.callerKeyId,caller.privateKey),rawRead=async(body:unknown)=>openEnvelope(await postDwsSocket(socketPath,'/v1/read',body,AbortSignal.timeout(4000)),policy.runnerKeyId,signer.publicKey,responseSchema);
 return {cli,p,d,calls,client,reader,authority,state,target,signal,began,finished,service,config,sign,request,rawRead,afterRead:(fn:()=>void)=>{afterRead=fn;},read:(s=signal)=>reader.readNativeCaseRoster!(p.principal.subject,state,{conversationId:p.conversationId,authorizationVersion:p.principal.authorizationVersion,requestNonce:randomUUID()},p.profile,s,authority)};
}

it('real Unix socket native EXECUTION and read-only RESULT_VERIFICATION use fixed reviewed owner with independent complete roster',async()=>{
 const w=await world();w.d.requester.deadline=Date.now()+2500;w.d.action='case.create';const first=await w.read();expect(first.value.internalMembersVerified).toBe(false);expect(first.value.platformCountsVerified).toBe(true);expect(first.value.users).toHaveLength(2);expect(first.state.files).not.toEqual(w.state.files);
 w.d.action='case.read';w.d.requester.phase='RESULT_VERIFICATION';w.d.requester.deadline=Date.now()+2500;const second=await w.read();expect(second.value.membershipHash).toBe(first.value.membershipHash);expect(w.calls).toHaveLength(2);expect(w.d.requester.actorId).not.toBe(w.d.ownerId);
 expect(w.calls.every(([subject,,args,profile])=>subject.userId==='synthetic-owner'&&subject.corpId==='synthetic-corp'&&args.conversationId===w.p.conversationId&&rpcHash(profile)===rpcHash(w.p.profile))).toBe(true);
 const events=(await w.cli.events()).filter(e=>['GROUP_INFO','GROUP_READ'].includes(e.phase));expect(events.map(e=>e.phase)).toEqual(['GROUP_INFO','GROUP_READ','GROUP_INFO','GROUP_INFO','GROUP_READ','GROUP_INFO']);expect(events.every(e=>e.user==='synthetic-owner'&&e.tokenMatches&&e.group===w.p.conversationId)).toBe(true);
});
it('native leaf is disabled without its own policy, even for an otherwise valid signed native request',async()=>{const w=await world(false);await expect(w.client.readNativeCaseRoster(w.d,w.state,w.target,w.signal)).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});expect(w.calls).toHaveLength(0);});
it('signed native contract, scope and credential drift cannot reach the runner',async()=>{
 const w=await world();for(const change of [{...w.d,contract:{...w.d.contract,version:2}},{...w.d,subject:{...w.d.subject,userId:'synthetic-requester'}},{...w.d,authorizationVersion:3}])await expect(w.client.readNativeCaseRoster(change,w.cli.state(change.subject),w.target,w.signal)).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});
 await expect(w.client.readNativeCaseRoster(w.d,w.state,{...w.target,scopeVersion:2},w.signal)).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});expect(w.calls).toHaveLength(0);
});
it('old H5/native-ask/scheduled signatures cannot be relabeled, and malformed native requester claims are rejected before runner',async()=>{
 const w=await world(),request=await w.request(),principal=w.p.principal;
 const old=[{operation:'READ_GROUP_AUDIENCE',delegation:{...principal,taskId:w.d.requester.taskId,runId:w.d.requester.runId,capabilityBindingId:'dws.group.audience.v1'}},{operation:'READ_GROUP_CASE_ROSTER',delegation:{...principal,purpose:'H5_SESSION',capabilityBindingId:'dws.group.case-roster.v1',requester:{actorId:w.d.requester.actorId,sessionId:randomUUID(),authEpoch:3},contract:w.d.contract,action:'case.read'}},{operation:'READ_GROUP_REMINDER_AUDIENCE',delegation:{...principal,purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',contract:w.d.contract,authorization:{id:randomUUID(),version:1,documentHash:'e'.repeat(64)},scheduled:{scheduleId:randomUUID(),revision:1,generation:1,occurrenceId:randomUUID(),fence:1,scheduledAt:'2026-10-19T00:00:00Z',notificationId:randomUUID(),originHash:'f'.repeat(64),phase:'PLAN'}}}];
 for(const leaf of old){const envelope=w.sign({...request,...leaf});await expect(w.rawRead({...envelope,payload:request})).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});await expect(w.rawRead(w.sign({...request,delegation:leaf.delegation}))).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});}
 for(const delegation of [{...w.d,requester:{...w.d.requester,sessionId:randomUUID()}},{...w.d,action:'case.update',requester:{...w.d.requester,phase:'RESULT_VERIFICATION'}}])await expect(w.rawRead(w.sign({...request,delegation}))).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});expect(w.calls).toHaveLength(0);
});
it('concurrent replay accepts exactly one actual runner read and request lifetime cannot exceed its fixed native deadline',async()=>{
 const w=await world(),request=await w.request(),envelope=w.sign(request),results=await Promise.all([w.rawRead(envelope),w.rawRead(envelope)]);expect(results.filter(r=>r.result.ok)).toHaveLength(1);expect(results.find(r=>!r.result.ok)?.result).toEqual({ok:false,code:'DWS_RPC_REPLAY'});expect(w.calls).toHaveLength(1);
 const fresh=await w.request();await expect(w.rawRead(w.sign({...fresh,delegation:{...w.d,requester:{...w.d.requester,deadline:fresh.expiresAt-1}}}))).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});expect(w.calls).toHaveLength(1);
});
it('actual native requester deadline aborts an in-flight read earlier than client timeout and never releases a late observation',async()=>{
 const w=await world();await w.cli.mode('normal',{groups:{[w.p.conversationId]:{allowedUsers:[w.p.principal.subject.userId],reply:groupMembersReply(),info:groupInfoReply(),delayMs:1200}}});w.d.requester.deadline=Date.now()+300;const started=performance.now();await expect(w.read()).rejects.toMatchObject({code:expect.stringMatching(/^DWS_(?:PROCESS_TIMEOUT|RPC_EXPIRED)$/)});expect(performance.now()-started).toBeLessThan(2500);expect(w.calls).toHaveLength(1);await w.finished;expect(w.calls[0]![4].aborted).toBe(true);
});
it.each([{name:'challenge expiry',service:300,client:3000},{name:'client timeout',service:3000,client:300}])('actual $name limits native execution independently of the longer requester deadline',async timeouts=>{
 const w=await world(true,timeouts);await w.cli.mode('normal',{groups:{[w.p.conversationId]:{allowedUsers:[w.p.principal.subject.userId],reply:groupMembersReply(),info:groupInfoReply(),delayMs:1200}}});const started=performance.now();await expect(w.read()).rejects.toMatchObject({code:expect.stringMatching(/^DWS_(?:PROCESS_TIMEOUT|RPC_EXPIRED)$/)});expect(performance.now()-started).toBeLessThan(2500);expect(w.calls).toHaveLength(1);await w.finished;expect(w.calls[0]![4].aborted).toBe(true);
});
it('pre-cancel and in-flight cancel return no observation, without a retry or another runner invocation',async()=>{
 const w=await world(),pre=new AbortController();pre.abort();await expect(w.read(pre.signal)).rejects.toBeDefined();expect(w.calls).toHaveLength(0);
 await w.cli.mode('normal',{groups:{[w.p.conversationId]:{allowedUsers:[w.p.principal.subject.userId],reply:groupMembersReply(),info:groupInfoReply(),delayMs:1000}}});const controller=new AbortController(),pending=w.read(controller.signal);await w.began;controller.abort();await expect(pending).rejects.toMatchObject({code:'DWS_PROCESS_TIMEOUT'});expect(w.calls).toHaveLength(1);
});
it('runner pin change after real CLI response is rejected, and independent roster failure returns no observation',async()=>{
 const w=await world();w.afterRead(()=>{w.cli.runner.config.groupInfoSchemaHash='0'.repeat(64);});await expect(w.read()).rejects.toMatchObject({code:'DWS_RPC_BINDING_CHANGED'});expect(w.calls).toHaveLength(1);
 const next=await world();await next.cli.mode('normal',{groups:{[next.p.conversationId]:{allowedUsers:[next.p.principal.subject.userId],reply:groupMembersReply(),info:groupInfoReply(3,1)}}});await expect(next.read()).rejects.toMatchObject({code:'DWS_RPC_EXECUTION_FAILED'});expect(next.calls).toHaveLength(1);
});
