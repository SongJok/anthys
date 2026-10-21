import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dwsFixture} from './dws-cli.js';
import {groupMembersReply,groupInfoReply,syntheticGroupInfoProfile} from './group-members.js';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {SignedDwsReadClient,postDwsSocket} from '../../packages/dws/src/signed-client.js';
import {SignedGroupAudienceReader} from '../../packages/dws/src/signed-group-reader.js';
import {caseRosterTargetForPolicy,caseRosterDelegationSchema,type CaseRosterPolicy} from '../../packages/dws/src/case-roster-protocol.js';
import {openEnvelope,challengeSchema,responseSchema,rpcHash,signEnvelope} from '../../packages/dws/src/signed-protocol.js';
export async function caseRosterSignedFixture(options:{cli?:Awaited<ReturnType<typeof dwsFixture>>;policy?:CaseRosterPolicy;configureSource?:boolean}={}){
 const cli=options.cli??await dwsFixture({groups:true}),root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);
 const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519'),ownerId=randomUUID(),now=Date.now();
 const policy:CaseRosterPolicy=structuredClone(options.policy??{schemaVersion:1,purpose:'H5_SESSION',capabilityBindingId:'dws.group.case-roster.v1',principal:{tenantId:randomUUID(),ownerId,identityId:randomUUID(),authEpoch:1,authorizationVersion:1,audience:{kind:'PRIVATE_USER',id:ownerId},subject:{corpId:'synthetic-corp',userId:'synthetic-owner'}},contractId:randomUUID(),delegationId:randomUUID(),allowedActions:['case.read'],scopeId:randomUUID(),scopeVersion:1,conversationId:'cidSynthetic==',profile:structuredClone(syntheticGroupInfoProfile),binaryHash:cli.runner.config.binaryHash,membersSchemaHash:cli.runner.config.groupMembersSchemaHash!,infoSchemaHash:cli.runner.config.groupInfoSchemaHash!,validFrom:now-10000,expiresAt:now+60000});
 const delegation=caseRosterDelegationSchema.parse({...policy.principal,purpose:policy.purpose,capabilityBindingId:policy.capabilityBindingId,requester:{actorId:randomUUID(),sessionId:randomUUID(),authEpoch:1},contract:{contractId:policy.contractId,delegationId:policy.delegationId,version:1,revisionHash:'a'.repeat(64)},action:'case.read'}),keys={tenantId:policy.principal.tenantId,corpId:policy.principal.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_CASE_ROSTER_ONLY'}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:100};
 if(options.configureSource!==false)await cli.mode('normal',{groups:{[policy.conversationId]:{allowedUsers:[delegation.subject.userId],reply:groupMembersReply(),info:groupInfoReply()}}});
 const service=new SignedDwsReadService(cli.runner,{...keys,caseRosterPolicies:[policy]});try{await service.listen(socketPath);}catch(e){await service.close();if(!options.cli)await cli.close();await rm(root,{recursive:true,force:true});throw e;}
 const clientConfig={socketPath,callerKeyId:keys.callerKeyId,callerPrivateKey:caller.privateKey,runnerKeyId:keys.runnerKeyId,runnerPublicKey:signer.publicKey,bindingHash:service.bindingHash,policyHash:keys.policyHash,timeoutMs:keys.maxRequestMs},client=new SignedDwsReadClient(clientConfig),reader=new SignedGroupAudienceReader(client);
 const request=async()=>{const nonce=randomUUID(),challenge=openEnvelope(await postDwsSocket(socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce},AbortSignal.timeout(4000)),keys.runnerKeyId,signer.publicKey,challengeSchema),issuedAt=Date.now();return {type:'READ_REQUEST' as const,protocol:'OA_DWS_READ_V1' as const,instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:service.bindingHash,policyHash:keys.policyHash,issuedAt,expiresAt:Math.min(issuedAt+3000,challenge.expiresAt),operation:'READ_GROUP_CASE_ROSTER' as const,delegation:structuredClone(delegation),group:caseRosterTargetForPolicy(policy),state:cli.state(delegation.subject)};};
 return {cli,root,socketPath,policy,delegation,service,client,clientConfig,reader,caller,signer,request,
  sign:(x:unknown)=>signEnvelope(x,keys.callerKeyId,caller.privateKey),
  rawRead:async(x:unknown)=>openEnvelope(await postDwsSocket(socketPath,'/v1/read',x,AbortSignal.timeout(4000)),keys.runnerKeyId,signer.publicKey,responseSchema),
  read:(signal=AbortSignal.timeout(4000))=>reader.readCaseRoster(delegation,cli.state(delegation.subject),policy,signal),
  close:async()=>{await service.close();if(!options.cli)await cli.close();await rm(root,{recursive:true,force:true});}};
}
