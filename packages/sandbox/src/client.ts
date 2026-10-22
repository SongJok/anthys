import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {analysisJobWireLimit,type AnalysisJobSubject} from '../../analysis/src/job-contract.js';
import type {SandboxArtifactPut,SandboxArtifactRef} from './artifacts.js';
import type {SandboxBrokerOutcome,SandboxStoredJob,SandboxTerminalState} from './broker.js';
import {signSandboxBrokerRequest} from './service-auth.js';

const submitPath='/v1/sandbox/jobs',artifactPath='/v1/sandbox/artifacts';
const codeLimit=1024*1024,inputLimit=8*1024*1024,responseLimit=1024*1024,defaultTimeoutMs=30_000,defaultSubmitTimeoutMs=130_000;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,digestPattern=/^[a-f0-9]{64}$/,codePattern=/^[A-Z][A-Z0-9_]{0,127}$/,statePattern=/^[A-Z][A-Z0-9_]{0,31}$/,instantPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const terminalStates:readonly SandboxTerminalState[]=['SUCCEEDED','FAILED','TIMEOUT','CANCELLED','LIMIT_EXCEEDED','REJECTED'];

export type SandboxBrokerClientErrorCode='SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID'|'SANDBOX_BROKER_CLIENT_REQUEST_INVALID'|'SANDBOX_BROKER_CLIENT_ABORTED'|'SANDBOX_BROKER_CLIENT_TIMEOUT'|'SANDBOX_BROKER_CLIENT_UNAVAILABLE'|'SANDBOX_BROKER_CLIENT_RESPONSE_INVALID';
export class SandboxBrokerClientError extends Error {
 constructor(readonly code:string,readonly status:number|null=null){super(code);this.name='SandboxBrokerClientError';}
}
export type SandboxBrokerClientOptions=Readonly<{baseUrl:string;authKey:Buffer;timeoutMs?:number;submitTimeoutMs?:number;fetch?:typeof fetch}>;

function clientError(code:SandboxBrokerClientErrorCode,status:number|null=null){return new SandboxBrokerClientError(code,status);}
function origin(value:unknown):string{
 if(typeof value!=='string'||value.length===0||value.length>2048||value.includes('\0'))throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
 let url:URL;
 try{url=new URL(value);}catch{throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');}
 if((url.protocol!=='http:'&&url.protocol!=='https:')||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname)throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
 return url.origin;
}
function timeout(value:unknown,fallback:number):number{
 const selected=value??fallback;
 if(typeof selected!=='number'||!Number.isSafeInteger(selected)||selected<1000||selected>600_000)throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
 return selected;
}
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return value as Record<string,unknown>;
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||value.length===0||value.length>max)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return value;
}
function instant(value:unknown):string{
 const result=text(value,40);
 if(!instantPattern.test(result)||new Date(result).toISOString()!==result)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return result;
}
function nullable<T>(value:unknown,check:(item:unknown)=>T):T|null{return value===null?null:check(value);}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number{
 if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return value as number;
}
function jobId(value:unknown):string{
 if(typeof value!=='string'||!uuidPattern.test(value))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return value;
}
function bytes(value:unknown,max:number):Buffer{
 if(!(value instanceof Uint8Array)||types.isProxy(value))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
 const result=Buffer.from(value);
 if(result.length===0||result.length>max)throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
 return result;
}
function artifactRef(value:unknown):SandboxArtifactRef{
 const raw=record(value),kind=raw['kind'],name=raw['name'],mime=text(raw['mime'],128),sha256=text(raw['sha256'],64);
 if(kind!=='CODE'&&kind!=='INPUT'&&kind!=='OUTPUT')throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 if(name!==null&&(typeof name!=='string'||name.length===0||name.length>128))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 if(!digestPattern.test(sha256))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return Object.freeze({id:jobId(raw['id']),kind,name,mime,sha256,byteSize:integer(raw['byteSize'],0),expiresAt:instant(raw['expiresAt'])});
}
function outcome(value:unknown):SandboxBrokerOutcome{
 const raw=record(value),state=raw['state'],failureCode=raw['failureCode'],reference=raw['artifactReference'],outputs=raw['outputs'];
 if(typeof state!=='string'||!terminalStates.includes(state as SandboxTerminalState))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 if(failureCode!==null&&(typeof failureCode!=='string'||!codePattern.test(failureCode)))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 if(reference!==null&&(typeof reference!=='string'||reference.length===0||reference.length>512))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 if(!Array.isArray(outputs)||outputs.length>64)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 const verified=outputs.map(item=>{
  const output=record(item),name=text(output['name'],128),sha256=text(output['sha256'],64);
  if(!digestPattern.test(sha256))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
  return Object.freeze({name,mime:text(output['mime'],128),sha256,byteSize:integer(output['byteSize'],0)});
 });
 return Object.freeze({jobId:jobId(raw['jobId']),state:state as SandboxTerminalState,failureCode,artifactReference:reference,outputs:Object.freeze(verified),durationMs:integer(raw['durationMs'],0)});
}
function storedJob(value:unknown):SandboxStoredJob{
 const raw=record(value),state=raw['state'],failureCode=raw['failureCode'];
 if(typeof state!=='string'||!statePattern.test(state)||typeof raw['cancelRequested']!=='boolean'||failureCode!==null&&(typeof failureCode!=='string'||!codePattern.test(failureCode)))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
 return Object.freeze({jobId:jobId(raw['jobId']),state,failureCode,cancelRequested:raw['cancelRequested'],createdAt:instant(raw['createdAt']),startedAt:nullable(raw['startedAt'],instant),completedAt:nullable(raw['completedAt'],instant),result:raw['result'],version:integer(raw['version'],1)});
}
function errorCode(body:Record<string,unknown>):string|null{
 const code=body['code'];
 return typeof code==='string'&&codePattern.test(code)?code:null;
}

/**
 * Trusted application-side producer for the broker HTTP service. It signs every
 * authenticated request with the shared service key, never follows redirects or
 * retries, and rejects malformed responses instead of trusting JSON shapes.
 * Uploading an artifact and submitting its envelope are separate calls: a retry
 * after an ambiguous submit failure must reuse the same signed envelope so the
 * broker's nonce/job replay guard, not the client, decides duplication.
 */
export class SandboxBrokerClient {
 private readonly baseUrl:string;
 private readonly authKey:Buffer;
 private readonly fetchImpl:typeof fetch;
 private readonly timeoutMs:number;
 private readonly submitTimeoutMs:number;
 constructor(options:SandboxBrokerClientOptions){
  if(!options||typeof options!=='object')throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
  this.baseUrl=origin(options.baseUrl);
  if(!Buffer.isBuffer(options.authKey)||options.authKey.length<32||options.authKey.length>512)throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
  this.authKey=Buffer.from(options.authKey);
  this.fetchImpl=options.fetch??fetch;
  if(typeof this.fetchImpl!=='function')throw clientError('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
  this.timeoutMs=timeout(options.timeoutMs,defaultTimeoutMs);
  this.submitTimeoutMs=timeout(options.submitTimeoutMs,defaultSubmitTimeoutMs);
 }
 private async request(input:{method:'GET'|'POST';path:string;subject?:AnalysisJobSubject;body?:Uint8Array;signal?:AbortSignal|undefined;timeoutMs:number;expected:number}):Promise<unknown>{
  const body=input.body??new Uint8Array(),headers:Record<string,string>={accept:'application/json'};
  if(body.length)headers['content-type']='application/json';
  if(input.subject){Object.assign(headers,signSandboxBrokerRequest({method:input.method,path:input.path,subject:input.subject,body,key:this.authKey}).headers);}
  const deadline=AbortSignal.timeout(input.timeoutMs),signal=input.signal?AbortSignal.any([input.signal,deadline]):deadline,payload=body.length===0?undefined:Uint8Array.from(body).buffer;
  let response:Response;
  try{
   response=await this.fetchImpl(this.baseUrl+input.path,{method:input.method,headers,...(payload?{body:payload}:{}),cache:'no-store',redirect:'manual',signal});
  }catch{
   if(input.signal?.aborted)throw clientError('SANDBOX_BROKER_CLIENT_ABORTED');
   if(deadline.aborted)throw clientError('SANDBOX_BROKER_CLIENT_TIMEOUT');
   throw clientError('SANDBOX_BROKER_CLIENT_UNAVAILABLE');
  }
  if(response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',response.status);}
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^[0-9]{1,12}$/.test(declared)||Number(declared)>responseLimit)){await response.body?.cancel().catch(()=>{});throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',response.status);}
  let raw:string;
  try{raw=await response.text();}catch{
   if(input.signal?.aborted)throw clientError('SANDBOX_BROKER_CLIENT_ABORTED');
   if(deadline.aborted)throw clientError('SANDBOX_BROKER_CLIENT_TIMEOUT');
   throw clientError('SANDBOX_BROKER_CLIENT_UNAVAILABLE');
  }
  if(Buffer.byteLength(raw,'utf8')>responseLimit)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',response.status);
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',response.status);}
  if(response.status!==input.expected){
   const code=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?errorCode(parsed as Record<string,unknown>):null;
   throw new SandboxBrokerClientError(code??(response.status>=500?'SANDBOX_BROKER_CLIENT_UNAVAILABLE':'SANDBOX_BROKER_CLIENT_RESPONSE_INVALID'),response.status);
  }
  return parsed;
 }
 async healthLive(signal?:AbortSignal):Promise<{status:'ALIVE'}>{
  const raw=record(await this.request({method:'GET',path:'/health/live',signal,timeoutMs:this.timeoutMs,expected:200}));
  if(raw['status']!=='ALIVE')throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
  return Object.freeze({status:'ALIVE'});
 }
 async healthReady(signal?:AbortSignal):Promise<{status:'READY'}>{
  const raw=record(await this.request({method:'GET',path:'/health/ready',signal,timeoutMs:this.timeoutMs,expected:200}));
  if(raw['status']!=='READY')throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
  return Object.freeze({status:'READY'});
 }
 async putArtifact(subject:AnalysisJobSubject,artifact:SandboxArtifactPut,signal?:AbortSignal):Promise<SandboxArtifactRef>{
  if(!artifact||typeof artifact!=='object'||(artifact.kind!=='CODE'&&artifact.kind!=='INPUT'))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  const bytesValue=bytes(artifact.bytes,artifact.kind==='CODE'?codeLimit:inputLimit);
  if(typeof artifact.mime!=='string'||artifact.mime.length===0||artifact.mime.length>128)throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  if(artifact.name!==undefined&&(typeof artifact.name!=='string'||artifact.name.length===0||artifact.name.length>128))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  if(artifact.expiresAt!==undefined&&(typeof artifact.expiresAt!=='string'||artifact.expiresAt.length===0||artifact.expiresAt.length>40))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  const payload=Buffer.from(JSON.stringify({kind:artifact.kind,mime:artifact.mime,bytes:bytesValue.toString('base64'),...(artifact.name===undefined?{}:{name:artifact.name}),...(artifact.expiresAt===undefined?{}:{expiresAt:artifact.expiresAt})}),'utf8');
  const reference=artifactRef(await this.request({method:'POST',path:artifactPath,subject,body:payload,signal,timeoutMs:this.timeoutMs,expected:201}));
  if(reference.kind!==artifact.kind||reference.byteSize!==bytesValue.length||reference.sha256!==createHash('sha256').update(bytesValue).digest('hex'))throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',201);
  return reference;
 }
 async submit(subject:AnalysisJobSubject,wire:string|Uint8Array,signal?:AbortSignal):Promise<SandboxBrokerOutcome>{
  let body:Buffer;
  if(typeof wire==='string'){
   if(wire.length===0||Buffer.byteLength(wire,'utf8')>analysisJobWireLimit)throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
   body=Buffer.from(wire,'utf8');
  }else{
   body=bytes(wire,analysisJobWireLimit);
  }
  return outcome(await this.request({method:'POST',path:submitPath,subject,body,signal,timeoutMs:this.submitTimeoutMs,expected:200}));
 }
 async getJob(subject:AnalysisJobSubject,id:string,signal?:AbortSignal):Promise<SandboxStoredJob>{
  if(typeof id!=='string'||!uuidPattern.test(id))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  return storedJob(await this.request({method:'GET',path:`${submitPath}/${id}`,subject,signal,timeoutMs:this.timeoutMs,expected:200}));
 }
 async cancel(subject:AnalysisJobSubject,id:string,signal?:AbortSignal):Promise<{jobId:string;cancelRequested:true}>{
  if(typeof id!=='string'||!uuidPattern.test(id))throw clientError('SANDBOX_BROKER_CLIENT_REQUEST_INVALID');
  const raw=record(await this.request({method:'POST',path:`${submitPath}/${id}/cancel`,subject,signal,timeoutMs:this.timeoutMs,expected:200}));
  if(raw['cancelRequested']!==true||jobId(raw['jobId'])!==id)throw clientError('SANDBOX_BROKER_CLIENT_RESPONSE_INVALID');
  return Object.freeze({jobId:id,cancelRequested:true});
 }
}
