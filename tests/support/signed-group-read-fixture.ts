import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dwsFixture} from './dws-cli.js';
import {groupMembersReply,groupInfoReply,syntheticGroupInfoProfile} from './group-members.js';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {SignedDwsReadClient,postDwsSocket} from '../../packages/dws/src/signed-client.js';
import {SignedGroupAudienceReader} from '../../packages/dws/src/signed-group-reader.js';
import {challengeSchema,groupTargetForScope,openEnvelope,responseSchema,rpcHash,signEnvelope,type DwsGroupDelegation,type DwsGroupScope,type DwsSignedGroupReadRequest} from '../../packages/dws/src/signed-protocol.js';
import type {DwsRunner} from '../../packages/dws/src/runner.js';

export async function signedGroupReadFixture(options:{delegation?:DwsGroupDelegation;scopeId?:string;scopeVersion?:number;expiresAt?:number;enabled?:boolean;cli?:Awaited<ReturnType<typeof dwsFixture>>;configureSource?:boolean;onSocket?:(path:string,active:boolean)=>void}={}){
 const cli=options.cli??await dwsFixture({groups:true});
 const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));
 await chmod(root,0o700);
 const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519'),ownerId=randomUUID();
 const delegation:DwsGroupDelegation=structuredClone(options.delegation??{tenantId:randomUUID(),ownerId,identityId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),authEpoch:1,authorizationVersion:1,capabilityBindingId:'dws.group.audience.v1',audience:{kind:'PRIVATE_USER',id:ownerId},subject:{corpId:'synthetic-corp',userId:'synthetic-user'}});
 const scope:DwsGroupScope={scopeId:options.scopeId??randomUUID(),scopeVersion:options.scopeVersion??1,conversationId:'cidSynthetic==',delegation:structuredClone(delegation),profile:structuredClone(syntheticGroupInfoProfile),binaryHash:cli.runner.config.binaryHash,membersSchemaHash:cli.runner.config.groupMembersSchemaHash!,infoSchemaHash:cli.runner.config.groupInfoSchemaHash!,validFrom:Date.now()-10000,expiresAt:options.expiresAt??Date.now()+60000};
 const groupCalls:Parameters<DwsRunner['readGroupAudience']>[]=[],legacyCalls:string[]=[];
 const groupRead=cli.runner.readGroupAudience.bind(cli.runner),verify=cli.runner.verify.bind(cli.runner),readSelf=cli.runner.readSelf.bind(cli.runner);
 let afterRead:(()=>Promise<void>)|undefined;
 cli.runner.readGroupAudience=async(...args)=>{groupCalls.push(args);const result=await groupRead(...args);await afterRead?.();return result;};
 cli.runner.verify=async(...args)=>{legacyCalls.push('VERIFY');return verify(...args);};
 cli.runner.readSelf=async(...args)=>{legacyCalls.push('SELF');return readSelf(...args);};
 const policy={tenantId:delegation.tenantId,corpId:delegation.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_SIGNED_GROUP_POLICY'}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:100,...(options.enabled===false?{}:{groupScopes:[scope]})};
 let service:SignedDwsReadService|undefined;
 try{
  if(options.configureSource!==false)await cli.mode('normal',{groups:{[scope.conversationId]:{allowedUsers:[delegation.subject.userId],reply:groupMembersReply(),info:groupInfoReply()}}});
  options.onSocket?.(socketPath,true);
  service=new SignedDwsReadService(cli.runner,policy);await service.listen(socketPath);
 }catch(error){try{await service?.close();}finally{options.onSocket?.(socketPath,false);if(!options.cli)await cli.close();await rm(root,{recursive:true,force:true});}throw error;}
 const clientConfig={socketPath,callerKeyId:policy.callerKeyId,callerPrivateKey:caller.privateKey,runnerKeyId:policy.runnerKeyId,runnerPublicKey:signer.publicKey,bindingHash:service.bindingHash,policyHash:policy.policyHash,timeoutMs:policy.maxRequestMs};
 const client=new SignedDwsReadClient(clientConfig),reader=new SignedGroupAudienceReader(client);
 async function request():Promise<DwsSignedGroupReadRequest>{
  const nonce=randomUUID(),raw=await postDwsSocket(socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce},AbortSignal.timeout(4000)),challenge=openEnvelope(raw,policy.runnerKeyId,signer.publicKey,challengeSchema),now=Date.now();
  return {type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:service!.bindingHash,policyHash:policy.policyHash,issuedAt:now,expiresAt:Math.min(now+3000,challenge.expiresAt),operation:'READ_GROUP_AUDIENCE',delegation:structuredClone(delegation),group:groupTargetForScope(scope),state:cli.state(delegation.subject)};
 }
 async function rawRead(envelope:unknown){return openEnvelope(await postDwsSocket(socketPath,'/v1/read',envelope,AbortSignal.timeout(4000)),policy.runnerKeyId,signer.publicKey,responseSchema);}
 return {cli,root,socketPath,caller,signer,delegation,scope,policy,service,clientConfig,client,reader,groupCalls,legacyCalls,request,rawRead,
  sign:(value:unknown)=>signEnvelope(value,policy.callerKeyId,caller.privateKey),
  afterRead:(fn:()=>Promise<void>)=>{afterRead=fn;},
  read:(signal=AbortSignal.timeout(4000))=>reader.read(delegation,cli.state(delegation.subject),scope,signal),
  close:async()=>{try{await service!.close();}finally{options.onSocket?.(socketPath,false);if(!options.cli)await cli.close();await rm(root,{recursive:true,force:true});}}};
}
