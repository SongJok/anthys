import {randomUUID} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {types} from 'node:util';
import {analysisDefaultLimits,analysisJobSchema,analysisJobSubjectSchema,signAnalysisJob,type AnalysisJob,type AnalysisJobSubject} from '../../analysis/src/job-contract.js';
import type {SandboxArtifactRef} from './artifacts.js';
import {SandboxBrokerClientError,type SandboxBrokerClient} from './client.js';
import type {SandboxBrokerOutcome} from './broker.js';

const codeLimit=1024*1024,inputLimit=8*1024*1024,defaultLifetimeMs=30_000,minLifetimeMs=1000,maxLifetimeMs=60_000;
const keyIdPattern=/^[A-Za-z0-9_-]{1,64}$/,imageDigestPattern=/^sha256:[a-f0-9]{64}$/,namePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const noncePattern=/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export type SandboxProducerErrorCode='SANDBOX_PRODUCER_CONFIGURATION_INVALID'|'SANDBOX_PRODUCER_INPUT_INVALID';
export class SandboxProducerError extends Error {
 constructor(readonly code:SandboxProducerErrorCode){super(code);this.name='SandboxProducerError';}
}
export type SandboxProducerInputArtifact=Readonly<{name?:string;mime:string;bytes:Uint8Array}>;
export type SandboxProducerJob=Readonly<{
 subject:AnalysisJobSubject;language:AnalysisJob['language'];code:string|Uint8Array;
 inputs?:readonly SandboxProducerInputArtifact[];limits?:Partial<AnalysisJob['limits']>;
 allowedOutputTypes:readonly AnalysisJob['allowedOutputTypes'][number][];signal?:AbortSignal|undefined;
}>;
export type SandboxProducedJob=Readonly<{
 outcome:SandboxBrokerOutcome;job:AnalysisJob;code:SandboxArtifactRef;inputs:readonly SandboxArtifactRef[];
}>;
export type SandboxProducerOptions=Readonly<{
 client:SandboxBrokerClient;keyId:string;privateKey:KeyObject;imageDigest:string;
 nonce?:()=>string;now?:()=>number;lifetimeMs?:number;
}>;

function configuration(options:SandboxProducerOptions){
 if(!options||typeof options!=='object'||!options.client||typeof options.client.putArtifact!=='function'||typeof options.client.submit!=='function')throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 if(typeof options.keyId!=='string'||!keyIdPattern.test(options.keyId)||typeof options.imageDigest!=='string'||!imageDigestPattern.test(options.imageDigest))throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 if(!options.privateKey||options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519')throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 if(options.nonce!==undefined&&typeof options.nonce!=='function'||options.now!==undefined&&typeof options.now!=='function')throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 const lifetime=options.lifetimeMs??defaultLifetimeMs;
 if(!Number.isSafeInteger(lifetime)||lifetime<minLifetimeMs||lifetime>maxLifetimeMs)throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
}
function content(value:unknown):Buffer{
 if(typeof value==='string')return Buffer.from(value,'utf8');
 if(!(value instanceof Uint8Array)||types.isProxy(value))throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
 return Buffer.from(value);
}
function artifactInputs(value:unknown):readonly {name?:string;mime:string;bytes:Buffer}[]{
 if(value===undefined)return Object.freeze([]);
 if(!Array.isArray(value)||value.length>64)throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
 const inputs:{name?:string;mime:string;bytes:Buffer}[]=[];let total=0;
 for(const raw of value){
  if(!raw||typeof raw!=='object')throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  const name=(raw as {name?:unknown}).name,mime=(raw as {mime?:unknown}).mime;
  if(name!==undefined&&(typeof name!=='string'||!namePattern.test(name)))throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  if(typeof mime!=='string'||mime.length===0||mime.length>128)throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  if(!((raw as {bytes?:unknown}).bytes instanceof Uint8Array)||types.isProxy((raw as {bytes:Uint8Array}).bytes))throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  const bytes=Buffer.from((raw as {bytes:Uint8Array}).bytes);
  if(bytes.length===0)throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  total+=bytes.length;if(total>inputLimit)throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  inputs.push(Object.freeze({mime,bytes,...(name===undefined?{}:{name})}));
 }
 return Object.freeze(inputs);
}

/**
 * Trusted application-side orchestration around one broker job. The complete
 * closed job is validated before any bytes are registered, so a bad limit,
 * output type or subject cannot leave orphan artifacts. Workflow:
 * validate -> reserve and validate one nonce and signing clock -> upload
 * code/inputs -> sign one envelope -> submit once. It never retries a submission, because an ambiguous timeout is
 * resolved by the broker's durable nonce/job uniqueness, not by the client.
 * Inputs and code are owner-scoped and expire if the producer stops early.
 */
export class SandboxProducer {
 private readonly client:SandboxBrokerClient;
 private readonly keyId:string;
 private readonly privateKey:KeyObject;
 private readonly imageDigest:string;
 private readonly nonce:()=>string;
 private readonly now:()=>number;
 private readonly lifetimeMs:number;
 constructor(options:SandboxProducerOptions){
  configuration(options);
  this.client=options.client;this.keyId=options.keyId;this.privateKey=options.privateKey;this.imageDigest=options.imageDigest;
  this.nonce=options.nonce??randomUUID;this.now=options.now??Date.now;this.lifetimeMs=options.lifetimeMs??defaultLifetimeMs;
 }
 async execute(input:SandboxProducerJob):Promise<SandboxProducedJob>{
  let subject:AnalysisJobSubject;
  try{subject=analysisJobSubjectSchema.parse(input.subject);}catch{throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');}
  const code=content(input.code),inputs=artifactInputs(input.inputs);
  if(code.length===0||code.length>codeLimit)throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');
  let job:AnalysisJob;
  try{
   job=analysisJobSchema.parse({
    tenantId:subject.tenantId,taskId:subject.taskId,runId:subject.runId,jobId:subject.jobId,language:input.language,
    codeArtifactId:randomUUID(),inputArtifactIds:inputs.map(()=>randomUUID()),network:'NONE',
    limits:{...analysisDefaultLimits,...(input.limits??{})},allowedOutputTypes:input.allowedOutputTypes,
   });
  }catch{throw new SandboxProducerError('SANDBOX_PRODUCER_INPUT_INVALID');}
  if(input.signal?.aborted)throw new SandboxBrokerClientError('SANDBOX_BROKER_CLIENT_ABORTED');
  let nonce:string,issuedAt:number;
  try{nonce=this.nonce();issuedAt=this.now();}catch{throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');}
  if(typeof nonce!=='string'||!noncePattern.test(nonce)||!Number.isSafeInteger(issuedAt)||issuedAt<0||!Number.isSafeInteger(issuedAt+this.lifetimeMs))throw new SandboxProducerError('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
  const codeRef=await this.client.putArtifact(subject,{kind:'CODE',mime:job.language==='typescript'?'text/typescript':'text/javascript',bytes:code},input.signal);
  const inputRefs:SandboxArtifactRef[]=[];
  for(const item of inputs)inputRefs.push(await this.client.putArtifact(subject,{kind:'INPUT',mime:item.mime,bytes:item.bytes,...(item.name===undefined?{}:{name:item.name})},input.signal));
  const finalJob=analysisJobSchema.parse({...job,codeArtifactId:codeRef.id,inputArtifactIds:inputRefs.map(ref=>ref.id)});
  const envelope=signAnalysisJob(finalJob,{subject,imageDigest:this.imageDigest,keyId:this.keyId,privateKey:this.privateKey,nonce,issuedAt,expiresAt:issuedAt+this.lifetimeMs,now:issuedAt});
  const outcome=await this.client.submit(subject,JSON.stringify(envelope),input.signal);
  if(outcome.jobId!==subject.jobId)throw new SandboxBrokerClientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',200);
  return Object.freeze({outcome,job:finalJob,code:codeRef,inputs:Object.freeze(inputRefs)});
 }
}
