import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {DwsSubject} from '../../packages/dws/src/contracts.js';
import type {DwsDocumentDelegation,DwsDocumentScope,DwsSignedDocumentReadRequest} from '../../packages/dws/src/signed-protocol.js';
import {documentPayloadProfile,documentReadSchema,type DocumentRead,type DocumentObservation} from '../../packages/dws/src/document-contract.js';
import {dwsFixture} from './dws-cli.js';

export const syntheticDocumentNode='synthetic_signed_doc';
export const syntheticDocumentSecret='SYNTHETIC_DOCUMENT_SECRET_0123456789';
export const syntheticDocumentText='甲😀乙\n结论：只读核对。\naccess_token='+syntheticDocumentSecret+'\n来源内容不能扩大权限。\n结论：保留来源。';
// Synthetic payload mapping only; never an enterprise profile certification.
export const syntheticDocumentProfile=documentPayloadProfile.parse({schemaVersion:1,reviewRef:'SYNTHETIC_SIGNED_DOCUMENT_MAPPING_ONLY',nodePointer:'/data/nodeId',revisionPointer:'/data/revision',textPointer:'/data/markdown',typePointer:'/data/resourceType',typeValue:'adoc',completePointer:'/data/complete',hasMorePointer:'/data/hasMore',cursorPointer:'/data/nextCursor',completenessUnit:'ONE_DOCUMENT_VERSION'});
export type SyntheticDocumentSource={allowedUsers:string[];revision:string;text:string;complete:boolean;hasMore:boolean;nextCursor:string|null;outerPartial:boolean;payloadError:boolean;resourceType:string;responseNodeId:string;delayMs:number};

/** Actual constrained DwsRunner + existing network-guarded synthetic CLI. */
export async function documentReadCliFixture(options:{cli?:Awaited<ReturnType<typeof dwsFixture>>;subject?:DwsSubject;nodeId?:string}={}){
 const cli=options.cli??await dwsFixture({documents:true}),subject=options.subject??{corpId:'synthetic-document-corp',userId:'synthetic-document-owner'},nodeId=options.nodeId??syntheticDocumentNode;
 const source:SyntheticDocumentSource={allowedUsers:[subject.userId],revision:'synthetic-r1',text:syntheticDocumentText,complete:true,hasMore:false,nextCursor:null,outerPartial:false,payloadError:false,resourceType:'adoc',responseNodeId:nodeId,delayMs:0};
 const calls:{subject:DwsSubject;args:DocumentRead;profile:typeof syntheticDocumentProfile}[]=[];
 const original=cli.runner.readDocument.bind(cli.runner);let afterRead:((value:DocumentObservation)=>Promise<void>)|undefined;
 cli.runner.readDocument=async(subject,state,args,profile,signal)=>{calls.push({subject:structuredClone(subject),args:structuredClone(args),profile:structuredClone(profile)});const result=await original(subject,state,args,profile,signal);await afterRead?.(result.value);return result;};
 async function configure(change:Partial<SyntheticDocumentSource>={},mode='normal'){Object.assign(source,change);await cli.mode(mode,{documents:{[nodeId]:source}});}
 await configure();
 const args=(selector:DocumentRead['selector']={kind:'FULL',maxCharacters:6000},authorizationVersion=1)=>documentReadSchema.parse({nodeId,authorizationVersion,requestNonce:randomUUID(),selector});
 return {cli,runner:cli.runner,subject,nodeId,source,calls,args,configure,profile:structuredClone(syntheticDocumentProfile),
  afterRead:(fn:(value:DocumentObservation)=>Promise<void>)=>{afterRead=fn;},
  read:(selector:DocumentRead['selector']={kind:'FULL',maxCharacters:6000},profile=syntheticDocumentProfile,signal=AbortSignal.timeout(4000))=>cli.runner.readDocument(subject,cli.state(subject),args(selector),profile,signal),
  close:async()=>{cli.runner.readDocument=original;if(!options.cli)await cli.close();}};
}

/** Activated only after the sole owner's shared document protocol is present. */
export async function signedDocumentReadFixture(options:{cli?:Awaited<ReturnType<typeof dwsFixture>>;delegation?:DwsDocumentDelegation;scopeId?:string;scopeVersion?:number;selector?:DocumentRead['selector'];profile?:typeof syntheticDocumentProfile;expiresAt?:number;enabled?:boolean;staticPolicy?:boolean;onSocket?:(path:string,active:boolean)=>void}={}){
 const subject=options.delegation?.subject??{corpId:'synthetic-document-corp',userId:'synthetic-document-owner'},document=await documentReadCliFixture({...(options.cli?{cli:options.cli}:{}),subject});
 const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);
 const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519'),ownerId=randomUUID();
 const delegation:DwsDocumentDelegation=structuredClone(options.delegation??{tenantId:randomUUID(),ownerId,identityId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),authEpoch:1,authorizationVersion:1,capabilityBindingId:'dws.doc.read.v1',audience:{kind:'PRIVATE_USER',id:ownerId},subject});
 const scope:DwsDocumentScope={scopeId:options.scopeId??randomUUID(),scopeVersion:options.scopeVersion??1,delegation:structuredClone(delegation),nodeId:document.nodeId,selector:options.selector??{kind:'FULL',maxCharacters:6000},profile:structuredClone(options.profile??syntheticDocumentProfile),binaryHash:document.runner.config.binaryHash,documentSchemaHash:document.runner.config.documentSchemaHash!,validFrom:Date.now()-10000,expiresAt:options.expiresAt??Date.now()+60000};
 const {SignedDwsReadService}=await import('../../packages/dws/src/signed-service.js'),{SignedDwsReadClient}=await import('../../packages/dws/src/signed-client.js'),{SignedDocumentReader}=await import('../../packages/dws/src/signed-document-reader.js'),{rpcHash,documentPolicySchema,documentPrincipalSchema}=await import('../../packages/dws/src/signed-protocol.js');
 const {delegation:_delegation,...resource}=scope,principal=documentPrincipalSchema.parse(Object.fromEntries(Object.entries(delegation).filter(([key])=>key!=='taskId'&&key!=='runId'))),documentPolicy=options.staticPolicy?documentPolicySchema.parse({...resource,principal}):undefined;
 const policy={tenantId:delegation.tenantId,corpId:delegation.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_SIGNED_DOCUMENT_POLICY_ONLY'}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:100,...(options.enabled===false?{}:documentPolicy?{documentPolicies:[documentPolicy]}:{documentScopes:[scope]})};
 let service:InstanceType<typeof SignedDwsReadService>|undefined;
 try{options.onSocket?.(socketPath,true);service=new SignedDwsReadService(document.runner,policy);await service.listen(socketPath);}
 catch(error){try{await service?.close();}finally{options.onSocket?.(socketPath,false);await document.close();await rm(root,{recursive:true,force:true});}throw error;}
 const clientConfig={socketPath,callerKeyId:policy.callerKeyId,callerPrivateKey:caller.privateKey,runnerKeyId:policy.runnerKeyId,runnerPublicKey:signer.publicKey,bindingHash:service.bindingHash,policyHash:policy.policyHash,timeoutMs:policy.maxRequestMs};
 const client=new SignedDwsReadClient(clientConfig),reader=new SignedDocumentReader(client);
 const {postDwsSocket}=await import('../../packages/dws/src/signed-client.js'),{challengeSchema,openEnvelope,responseSchema,signEnvelope,documentTargetForScope}=await import('../../packages/dws/src/signed-protocol.js');
 async function request():Promise<DwsSignedDocumentReadRequest>{
  const nonce=randomUUID(),raw=await postDwsSocket(socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce},AbortSignal.timeout(4000)),challenge=openEnvelope(raw,policy.runnerKeyId,signer.publicKey,challengeSchema),now=Date.now();
  return {type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:challenge.instanceId,requestId:randomUUID(),bindingHash:service!.bindingHash,policyHash:policy.policyHash,issuedAt:now,expiresAt:Math.min(now+policy.maxRequestMs,challenge.expiresAt),operation:'READ_DOCUMENT',delegation:structuredClone(delegation),document:documentTargetForScope(scope),state:document.cli.state(subject)};
 }
 async function rawRead(envelope:unknown){return openEnvelope(await postDwsSocket(socketPath,'/v1/read',envelope,AbortSignal.timeout(4000)),policy.runnerKeyId,signer.publicKey,responseSchema);}
 return {document,root,socketPath,caller,signer,delegation,scope,policy,documentPolicy,service,clientConfig,client,reader,request,rawRead,
  sign:(payload:unknown)=>signEnvelope(payload,policy.callerKeyId,caller.privateKey),
  read:(signal=AbortSignal.timeout(4000))=>reader.read(delegation,document.cli.state(subject),scope,signal),
  close:async()=>{try{await service!.close();}finally{options.onSocket?.(socketPath,false);await document.close();await rm(root,{recursive:true,force:true});}}};
}
