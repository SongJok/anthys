import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {AnalysisJobSubject} from '../../../packages/analysis/src/job-contract.js';
import type {DbContext} from '../../../packages/storage/src/database.js';
import {SandboxBrokerError,type SandboxBrokerOutcome} from '../../../packages/sandbox/src/broker.js';
import {SandboxArtifactError,type SandboxArtifactPut,type SandboxArtifactRef} from '../../../packages/sandbox/src/artifacts.js';
import {SandboxBrokerAuthError,verifySandboxBrokerRequest} from '../../../packages/sandbox/src/service-auth.js';

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,jobPathPattern=/^\/v1\/sandbox\/jobs\/([0-9a-f-]{36})$/,cancelPathPattern=/^\/v1\/sandbox\/jobs\/([0-9a-f-]{36})\/cancel$/,artifactPath='/v1/sandbox/artifacts',jobSubmitPath='/v1/sandbox/jobs';
const jobBodyLimit=40*1024,artifactBodyLimit=12*1024*1024,controlBodyLimit=1024,maxConcurrentLimit=32;

type HttpErrorCode='SANDBOX_BROKER_BODY_TOO_LARGE'|'SANDBOX_BROKER_CONTENT_TYPE_INVALID'|'SANDBOX_BROKER_ROUTE_NOT_FOUND'|'SANDBOX_BROKER_METHOD_NOT_ALLOWED'|'SANDBOX_BROKER_BUSY'|'SANDBOX_BROKER_JOB_NOT_FOUND'|'SANDBOX_BROKER_JOB_TERMINAL'|'SANDBOX_BROKER_INTERNAL_ERROR'|'SANDBOX_BROKER_REQUEST_INVALID';
class HttpError extends Error {
 constructor(readonly status:number,readonly code:HttpErrorCode,readonly allow?:string){super(code);this.name='HttpError';}
}

export type SandboxBrokerHttpOptions=Readonly<{
 submit(wire:string|Uint8Array,subject:AnalysisJobSubject,signal?:AbortSignal):Promise<SandboxBrokerOutcome>;
 get(subject:AnalysisJobSubject,jobId:string):Promise<unknown|null>;
 requestCancel(subject:AnalysisJobSubject,jobId:string):Promise<boolean>;
 putArtifact(subject:DbContext,raw:SandboxArtifactPut):Promise<SandboxArtifactRef>;
 authKey:Buffer;
 host?:string;
 port?:number;
 ready?:()=>Promise<boolean>;
 now?:()=>number;
 maxConcurrent?:number;
 log?:(event:Record<string,unknown>)=>void;
}>;
export type SandboxBrokerHttpService=Readonly<{listen():Promise<{host:string;port:number}>;close():Promise<void>;address():{host:string;port:number}}>;

function contentLength(req:IncomingMessage):number|null{
 const raw=req.headers['content-length'];
 if(raw===undefined)return null;
 if(typeof raw!=='string'||!/^[0-9]{1,12}$/.test(raw))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 return Number(raw);
}
function readBody(req:IncomingMessage,limit:number):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const declared=contentLength(req);
  if(declared!==null&&declared>limit)throw new HttpError(413,'SANDBOX_BROKER_BODY_TOO_LARGE');
  const chunks:Buffer[]=[];let total=0,settled=false;
  const finish=(error?:Error)=>{
   if(settled)return;settled=true;
   req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onAbort);
   if(error)reject(error);else resolve(Buffer.concat(chunks));
  };
  const onData=(chunk:Buffer)=>{total+=chunk.length;if(total>limit){finish(new HttpError(413,'SANDBOX_BROKER_BODY_TOO_LARGE'));return;}chunks.push(chunk);};
  const onEnd=()=>finish(),onError=()=>finish(new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID')),onAbort=()=>finish(new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID'));
  req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onAbort);
 });
}
function isJson(req:IncomingMessage){const raw=req.headers['content-type'];return typeof raw==='string'&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(raw);}
function send(res:ServerResponse,status:number,value:unknown,extra:Record<string,string>={}){
 if(res.headersSent){res.end();return;}
 const payload=Buffer.from(JSON.stringify(value),'utf8');
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':String(payload.length),'cache-control':'no-store','x-content-type-options':'nosniff',...extra});
 res.end(payload);
}
function failureStatus(error:unknown):{status:number;code:string;allow?:string}{
 if(error instanceof SandboxBrokerAuthError)return {status:401,code:error.code};
 if(error instanceof HttpError)return {status:error.status,code:error.code,...(error.allow?{allow:error.allow}:{})};
 if(error instanceof SandboxArtifactError)return {
  status:error.code==='SANDBOX_ARTIFACT_NOT_FOUND'?404:error.code==='SANDBOX_ARTIFACT_UNAVAILABLE'?503:error.code==='SANDBOX_ARTIFACT_INTEGRITY_FAILED'?409:error.code==='SANDBOX_ARTIFACT_CANCELLED'?409:400,
  code:error.code,
 };
 if(error instanceof SandboxBrokerError)return {
  status:error.code==='SANDBOX_BROKER_QUOTA_EXCEEDED'?429:error.code==='SANDBOX_BROKER_UNAVAILABLE'?503:error.code==='SANDBOX_BROKER_CONFIGURATION_INVALID'?500:error.code==='SANDBOX_BROKER_NOT_AUTHORIZED'?403:error.code==='SANDBOX_BROKER_WIRE_INVALID'?400:409,
  code:error.code,
 };
 return {status:500,code:'SANDBOX_BROKER_INTERNAL_ERROR'};
}
function strictObject(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 return value as Record<string,unknown>;
}
function artifactInput(value:unknown):SandboxArtifactPut{
 const raw=strictObject(value),allowed=new Set(['kind','name','mime','bytes','expiresAt']);
 if(Object.keys(raw).some(key=>!allowed.has(key)))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 const kind=raw['kind'],mime=raw['mime'],name=raw['name'],expiresAt=raw['expiresAt'],encoded=raw['bytes'];
 if(kind!=='CODE'&&kind!=='INPUT')throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 if(typeof mime!=='string'||mime.length>128)throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 if(name!==undefined&&(typeof name!=='string'||name.length>128))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 if(expiresAt!==undefined&&(typeof expiresAt!=='string'||expiresAt.length>40))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 if(typeof encoded!=='string'||encoded.length===0||encoded.length>artifactBodyLimit||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length===0||bytes.toString('base64')!==encoded)throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
 return Object.freeze({kind,mime,bytes,...(name===undefined?{}:{name}),...(expiresAt===undefined?{}:{expiresAt})});
}
const storeUnavailable=async<T>(fn:()=>Promise<T>):Promise<T>=>{
 try{return await fn();}catch(error){if(error instanceof SandboxBrokerError)throw error;throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
};

export function createSandboxBrokerHttpService(options:SandboxBrokerHttpOptions):SandboxBrokerHttpService {
 const host=options.host??'127.0.0.1',port=options.port??8092,maxConcurrent=options.maxConcurrent??4,now=options.now??Date.now,log=options.log??(event=>console.error(JSON.stringify(event)));
 if(!Number.isSafeInteger(port)||port<0||port>65535||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>maxConcurrentLimit)throw new HttpError(500,'SANDBOX_BROKER_INTERNAL_ERROR');
 if(!Buffer.isBuffer(options.authKey)||options.authKey.length<32)throw new HttpError(500,'SANDBOX_BROKER_INTERNAL_ERROR');
 let closing=false,bound:{host:string;port:number}|null=null;
 const activeControllers=new Set<AbortController>(),activeSubmissions=new Set<Promise<unknown>>();
 const server=createServer((req,res)=>{void handle(req,res).catch(error=>{
  const mapped=failureStatus(error);if(mapped.status>=500)log({kind:'SANDBOX_BROKER_REQUEST_FAILED',code:mapped.code});
  if(mapped.status===413)req.resume();
  send(res,mapped.status,{code:mapped.code},mapped.allow?{allow:mapped.allow}:{});
 });});
 server.requestTimeout=120_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;server.maxHeadersCount=64;

 async function authenticate(req:IncomingMessage,method:string,path:string,body:Uint8Array){
  return verifySandboxBrokerRequest({method,path,headers:req.headers,body,key:options.authKey,now:now()});
 }
 async function handle(req:IncomingMessage,res:ServerResponse){
  const started=now(),method=(req.method??'').toUpperCase();
  let pathname:string;
  try{const url=new URL(req.url??'','http://sandbox-broker');if(url.search||url.hash)throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');pathname=url.pathname;}
  catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');}
  if(closing)throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');
  if(pathname==='/health/live'){
   if(method!=='GET')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','GET');
   return send(res,200,{status:'ALIVE'},{allow:'GET'});
  }
  if(pathname==='/health/ready'){
   if(method!=='GET')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','GET');
   try{const ready=await options.ready?.()??true;return send(res,ready?200:503,{status:ready?'READY':'NOT_READY'},{allow:'GET'});}
   catch{return send(res,503,{status:'NOT_READY'},{allow:'GET'});}
  }
  if(pathname===jobSubmitPath){
   if(method!=='POST')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','POST');
   if(!isJson(req))throw new HttpError(415,'SANDBOX_BROKER_CONTENT_TYPE_INVALID');
   const body=await readBody(req,jobBodyLimit),subject=await authenticate(req,method,pathname,body);
   if(activeSubmissions.size>=maxConcurrent)throw new HttpError(429,'SANDBOX_BROKER_BUSY');
   const controller=new AbortController(),pending=options.submit(body,subject,controller.signal);
   activeControllers.add(controller);activeSubmissions.add(pending);
   const disconnected=()=>{if(!res.writableEnded)controller.abort();};
   req.once('aborted',disconnected);res.once('close',disconnected);
   try{
    const outcome=await pending;
    send(res,200,outcome);
    log({kind:'SANDBOX_BROKER_JOB_FINISHED',state:outcome.state,failureCode:outcome.failureCode,durationMs:now()-started});
   }finally{
    req.removeListener('aborted',disconnected);res.removeListener('close',disconnected);
    activeControllers.delete(controller);activeSubmissions.delete(pending);
   }
   return;
  }
  if(pathname===artifactPath){
   if(method!=='POST')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','POST');
   if(!isJson(req))throw new HttpError(415,'SANDBOX_BROKER_CONTENT_TYPE_INVALID');
   const body=await readBody(req,artifactBodyLimit),subject=await authenticate(req,method,pathname,body);
   let parsed:unknown;
   try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');}
   const artifact=await options.putArtifact({tenantId:subject.tenantId,actorId:subject.actorId},artifactInput(parsed));
   return send(res,201,artifact);
  }
  const cancel=cancelPathPattern.exec(pathname);
  if(cancel){
   if(method!=='POST')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','POST');
   const body=await readBody(req,controlBodyLimit),jobId=cancel[1]!;
   if(body.length!==0||!uuidPattern.test(jobId))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
   const subject=await authenticate(req,method,pathname,body);
   const requested=await storeUnavailable(()=>options.requestCancel(subject,jobId));
   if(requested)return send(res,200,{jobId,cancelRequested:true});
   const job=await storeUnavailable(()=>options.get(subject,jobId));
   if(job===null)throw new HttpError(404,'SANDBOX_BROKER_JOB_NOT_FOUND');
   throw new HttpError(409,'SANDBOX_BROKER_JOB_TERMINAL');
  }
  const status=jobPathPattern.exec(pathname);
  if(status){
   if(method!=='GET')throw new HttpError(405,'SANDBOX_BROKER_METHOD_NOT_ALLOWED','GET');
   const body=await readBody(req,controlBodyLimit),jobId=status[1]!;
   if(body.length!==0||!uuidPattern.test(jobId))throw new HttpError(400,'SANDBOX_BROKER_REQUEST_INVALID');
   const subject=await authenticate(req,method,pathname,body);
   const job=await storeUnavailable(()=>options.get(subject,jobId));
   if(job===null)throw new HttpError(404,'SANDBOX_BROKER_JOB_NOT_FOUND');
   return send(res,200,job);
  }
  throw new HttpError(404,'SANDBOX_BROKER_ROUTE_NOT_FOUND');
 }

 return Object.freeze({
  listen:async()=>{
   if(bound)return bound;
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
   const address=server.address() as AddressInfo;bound=Object.freeze({host:address.address,port:address.port});return bound;
  },
  close:async()=>{
   if(closing)return;closing=true;
   for(const controller of activeControllers)controller.abort();
   const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
   server.closeIdleConnections?.();
   const force=setTimeout(()=>server.closeAllConnections?.(),5000);force.unref();
   const settle=new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);timer.unref();void Promise.allSettled([...activeSubmissions]).finally(()=>{clearTimeout(timer);resolve();});});
   await Promise.allSettled([closed,settle]);clearTimeout(force);server.closeAllConnections?.();bound=null;
  },
  address:()=>bound??{host,port},
 });
}
