import '../support/isolation.js';
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {analysisJobSchema,signAnalysisJob,type AnalysisJob,type AnalysisJobSubject} from '../../packages/analysis/src/job-contract.js';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Database} from '../../packages/storage/src/database.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {PgSandboxArtifactConnector,type SandboxArtifactRef} from '../../packages/sandbox/src/artifacts.js';
import {PgSandboxBrokerStore,SandboxBroker} from '../../packages/sandbox/src/broker.js';
import {PgSandboxAuthorizer} from '../../packages/sandbox/src/authorizer.js';
import type {SandboxExecutionResult,SandboxInput} from '../../packages/sandbox/src/executor.js';
import {signSandboxBrokerRequest,sandboxBrokerAuthHeaders} from '../../packages/sandbox/src/service-auth.js';
import {SandboxBrokerClient} from '../../packages/sandbox/src/client.js';
import {SandboxProducer} from '../../packages/sandbox/src/producer.js';
import {createSandboxBrokerHttpService,type SandboxBrokerHttpService} from '../../apps/sandbox-broker/src/service.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,8);
const keys=generateKeyPairSync('ed25519'),keyId='sandbox-broker-service-test',imageDigest='sha256:'+'e'.repeat(64),brokerId='broker-service-test',port=64712;
const authKey=Buffer.from(randomBytes(32).toString('hex'),'utf8');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let directory:string,files:EncryptedFileStore,connector:PgSandboxArtifactConnector,store:PgSandboxBrokerStore,service:SandboxBrokerHttpService,client:SandboxBrokerClient;
let executions=0,lastExecution:{code:string;inputs:readonly SandboxInput[]}|null=null,executeHook:((job:AnalysisJob,code:string,inputs:readonly SandboxInput[],signal:AbortSignal)=>Promise<SandboxExecutionResult>)|null=null;

type World={tenantId:string;actorId:string;subject:AnalysisJobSubject};
async function world():Promise<World>{
 const tenantId=randomUUID(),actorId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic sandbox service','ACTIVE','UTC')",[tenantId,'synthetic-sandbox-service-'+tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic sandbox service owner','ACTIVE')",[tenantId,actorId,'synthetic-sandbox-service-'+actorId]);
 await root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'synthetic broker service task','ACTIVE',$4,1,clock_timestamp()+interval '1 hour')",[tenantId,taskId,actorId,JSON.stringify({})]);
 await root.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'RUNNING',$5)",[tenantId,runId,taskId,actorId,JSON.stringify({})]);
 return {tenantId,actorId,subject:{tenantId,actorId,authEpoch:1,taskId,runId,jobId:randomUUID()}};
}
function jobFor(subject:AnalysisJobSubject,overrides:Record<string,unknown>={}):AnalysisJob{return analysisJobSchema.parse({tenantId:subject.tenantId,taskId:subject.taskId,runId:subject.runId,jobId:subject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:64*1024},allowedOutputTypes:['json'],...overrides});}
function signedEnvelope(subject:AnalysisJobSubject,job:AnalysisJob){const now=Date.now();return signAnalysisJob(job,{subject,imageDigest,keyId,privateKey:keys.privateKey,nonce:randomUUID(),issuedAt:now-1000,expiresAt:now+30_000,now});}
function success(job:AnalysisJob):SandboxExecutionResult{
 const bytes=Buffer.from(JSON.stringify({jobId:job.jobId})),artifact=Object.freeze({name:'result.json',bytes,sha256:hash(bytes)});
 return Object.freeze({state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false,outputs:Object.freeze([artifact]),stdout:'',stderr:'',durationMs:3});
}

beforeAll(async()=>{
 directory=await realpath(await mkdtemp(join(tmpdir(),'anthys-sandbox-service-')));
 files=new EncryptedFileStore(directory,new Vault(new Map([['1',randomBytes(32)]]),'1'));
 connector=new PgSandboxArtifactConnector(db,files);
 store=new PgSandboxBrokerStore(db,{maxActivePerOwner:8,maxJobsPerDay:100});
 const broker=new SandboxBroker({
  keyId,publicKey:keys.publicKey,imageDigest,brokerId,store,cancelPollMs:50,
  authorizer:new PgSandboxAuthorizer(db),resolver:connector,sink:connector,
  executor:{execute:async(job,code,inputs,signal)=>{executions++;lastExecution={code,inputs};return executeHook?executeHook(job,code,inputs,signal):success(job);}},
 });
 service=createSandboxBrokerHttpService({
  submit:(wire,subject,signal)=>broker.submit(wire,subject,signal),
  get:(subject,jobId)=>store.get(subject,jobId),
  requestCancel:(subject,jobId)=>store.requestCancel(subject,jobId),
  putArtifact:(subject,raw)=>connector.put(subject,raw),
  authKey,host:'127.0.0.1',port,maxConcurrent:1,ready:()=>db.ready(),
 });
 await service.listen();
 client=new SandboxBrokerClient({baseUrl:`http://127.0.0.1:${port}`,authKey});
});
afterAll(async()=>{await service.close();await db.close();await root.end();await rm(directory,{recursive:true,force:true});});

type CallOptions={subject?:AnalysisJobSubject;body?:unknown;raw?:string|Uint8Array;timestamp?:number;key?:Buffer;headers?:Record<string,string>};
async function call(method:string,path:string,options:CallOptions={}){
 const body=options.raw!==undefined?Buffer.from(options.raw):options.body===undefined?undefined:Buffer.from(JSON.stringify(options.body));
 const headers:Record<string,string>={...(options.headers??{})};
 if(body!==undefined&&headers['content-type']===undefined)headers['content-type']='application/json';
 if(options.subject!==undefined){
  const signed=signSandboxBrokerRequest({method,path,subject:options.subject,body:body??new Uint8Array(),key:options.key??authKey,...(options.timestamp===undefined?{}:{timestamp:options.timestamp})});
  Object.assign(headers,{...signed.headers,...(options.headers??{})});
 }
 const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers,...(body===undefined?{}:{body})});
 const text=await response.text();
 return {status:response.status,body:text?JSON.parse(text) as Record<string,unknown>:null,allow:response.headers.get('allow')};
}
async function upload(subject:AnalysisJobSubject,kind:'CODE'|'INPUT',bytes:Buffer,name?:string){
 const response=await call('POST','/v1/sandbox/artifacts',{subject,body:{kind,mime:kind==='CODE'?'text/javascript':'text/plain',bytes:bytes.toString('base64'),...(name===undefined?{}:{name})}});
 expect(response.status).toBe(201);
 return response.body as unknown as SandboxArtifactRef;
}

it('authenticates the producer, rejects unsigned, tampered, stale and foreign requests, and enforces route limits',async()=>{
 const w=await world(),other=await world();executions=0;
 expect(await call('GET','/health/live')).toMatchObject({status:200,body:{status:'ALIVE'}});
 expect(await call('GET','/health/ready')).toMatchObject({status:200,body:{status:'READY'}});

 const unsigned=await call('POST','/v1/sandbox/jobs',{body:{}});
 expect(unsigned).toMatchObject({status:401,body:{code:'SANDBOX_BROKER_AUTH_INVALID'}});
 const valid=signSandboxBrokerRequest({method:'POST',path:'/v1/sandbox/jobs',subject:w.subject,body:'{}',key:authKey});
 const signature=valid.headers[sandboxBrokerAuthHeaders.signature]!,tamperedSignature=(signature.startsWith('A')?'B':'A')+signature.slice(1);
 const tampered=await call('POST','/v1/sandbox/jobs',{body:{},headers:{...valid.headers,[sandboxBrokerAuthHeaders.signature]:tamperedSignature}});
 expect(tampered).toMatchObject({status:401,body:{code:'SANDBOX_BROKER_AUTH_INVALID'}});
 const stale=await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:{},timestamp:Date.now()-120_000});
 expect(stale).toMatchObject({status:401,body:{code:'SANDBOX_BROKER_AUTH_STALE'}});
 const foreignJob=jobFor(other.subject),foreign=await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:signedEnvelope(other.subject,foreignJob)});
 expect(foreign).toMatchObject({status:400,body:{code:'SANDBOX_BROKER_WIRE_INVALID'}});
 expect(executions).toBe(0);
 expect(Number((await root.query('SELECT count(*) n FROM sandbox_broker_jobs WHERE tenant_id=$1',[w.tenantId])).rows[0].n)).toBe(0);

 expect((await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:{},headers:{'content-type':'text/plain'}})).status).toBe(415);
 const wrongMethod=await call('PUT','/v1/sandbox/jobs',{subject:w.subject});
 expect(wrongMethod).toMatchObject({status:405,allow:'POST'});
 expect((await call('GET','/v1/sandbox/jobs?unexpected=1')).status).toBe(400);
 expect((await call('GET','/v1/sandbox/jobs/not-a-uuid',{subject:w.subject})).status).toBe(404);
 const oversized=await call('POST','/v1/sandbox/jobs',{raw:'x'.repeat(40*1024+1)});
 expect(oversized).toMatchObject({status:413,body:{code:'SANDBOX_BROKER_BODY_TOO_LARGE'}});
 expect(executions).toBe(0);
});

it('uploads artifacts, executes a signed job and exposes only the authenticated owner status',async()=>{
 const w=await world(),other=await world();executions=0;lastExecution=null;
 const code=Buffer.from('void 0'),input=Buffer.from('bound-input');
 const codeRef=await upload(w.subject,'CODE',code),inputRef=await upload(w.subject,'INPUT',input,'input.txt');
 expect(codeRef).toMatchObject({kind:'CODE',sha256:hash(code),byteSize:code.length});
 expect(inputRef).toMatchObject({kind:'INPUT',name:'input.txt',sha256:hash(input)});
 const job=jobFor(w.subject,{codeArtifactId:codeRef.id,inputArtifactIds:[inputRef.id]}),envelope=signedEnvelope(w.subject,job);
 const submitted=await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:envelope});
 expect(submitted.status).toBe(200);
 expect(submitted.body).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',failureCode:null,artifactReference:'sandbox-job:'+job.jobId});
 expect(submitted.body?.['outputs']).toEqual([{name:'result.json',mime:'application/json',sha256:hash(Buffer.from(JSON.stringify({jobId:job.jobId}))),byteSize:Buffer.byteLength(JSON.stringify({jobId:job.jobId}))}]);
 expect(executions).toBe(1);
 expect(lastExecution).toMatchObject({code:'void 0',inputs:[{artifactId:inputRef.id}]});
 expect(Buffer.from(lastExecution!.inputs[0]!.bytes).toString()).toBe('bound-input');
 const outputRows=await root.query("SELECT name,state FROM sandbox_artifacts WHERE tenant_id=$1 AND job_id=$2 AND kind='OUTPUT'",[w.tenantId,job.jobId]);
 expect(outputRows.rows).toEqual([{name:'result.json',state:'READY'}]);

 const status=await call('GET',`/v1/sandbox/jobs/${job.jobId}`,{subject:w.subject});
 expect(status).toMatchObject({status:200,body:{jobId:job.jobId,state:'SUCCEEDED',cancelRequested:false}});
 expect(await call('GET',`/v1/sandbox/jobs/${job.jobId}`,{subject:other.subject})).toMatchObject({status:404,body:{code:'SANDBOX_BROKER_JOB_NOT_FOUND'}});
 expect(await call('POST',`/v1/sandbox/jobs/${job.jobId}/cancel`,{subject:w.subject})).toMatchObject({status:409,body:{code:'SANDBOX_BROKER_JOB_TERMINAL'}});
 expect(await call('POST',`/v1/sandbox/jobs/${randomUUID()}/cancel`,{subject:w.subject})).toMatchObject({status:404,body:{code:'SANDBOX_BROKER_JOB_NOT_FOUND'}});
 expect(await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:envelope})).toMatchObject({status:409,body:{code:'SANDBOX_BROKER_REPLAYED'}});
 expect(executions).toBe(1);

 expect(await call('POST','/v1/sandbox/artifacts',{subject:w.subject,body:{kind:'CODE',mime:'text/javascript',bytes:'!!!'}})).toMatchObject({status:400,body:{code:'SANDBOX_BROKER_REQUEST_INVALID'}});
 expect(await call('POST','/v1/sandbox/artifacts',{subject:w.subject,body:{kind:'CODE',mime:'text/javascript',bytes:code.toString('base64'),path:'/etc/passwd'}})).toMatchObject({status:400,body:{code:'SANDBOX_BROKER_REQUEST_INVALID'}});
});

it('producer client signs uploads, submission, status and cancellation, and maps broker errors',async()=>{
 const w=await world(),other=await world();executions=0;
 await expect(client.healthLive()).resolves.toEqual({status:'ALIVE'});
 await expect(client.healthReady()).resolves.toEqual({status:'READY'});
 const code=Buffer.from('void 0'),input=Buffer.from('client-bound-input');
 const codeRef=await client.putArtifact(w.subject,{kind:'CODE',mime:'text/javascript',bytes:code});
 const inputRef=await client.putArtifact(w.subject,{kind:'INPUT',mime:'text/plain',bytes:input,name:'input.txt'});
 expect(codeRef).toMatchObject({kind:'CODE',sha256:hash(code),byteSize:code.length});
 expect(inputRef).toMatchObject({kind:'INPUT',name:'input.txt',sha256:hash(input)});
 const job=jobFor(w.subject,{codeArtifactId:codeRef.id,inputArtifactIds:[inputRef.id]});
 const submitted=await client.submit(w.subject,JSON.stringify(signedEnvelope(w.subject,job)));
 expect(submitted).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',failureCode:null,artifactReference:'sandbox-job:'+job.jobId});
 expect(submitted.outputs).toEqual([{name:'result.json',mime:'application/json',sha256:hash(Buffer.from(JSON.stringify({jobId:job.jobId}))),byteSize:Buffer.byteLength(JSON.stringify({jobId:job.jobId}))}]);
 const status=await client.getJob(w.subject,job.jobId);
 expect(status).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',cancelRequested:false,version:3});
 await expect(client.cancel(w.subject,job.jobId)).rejects.toMatchObject({code:'SANDBOX_BROKER_JOB_TERMINAL',status:409});
 await expect(client.getJob(other.subject,job.jobId)).rejects.toMatchObject({code:'SANDBOX_BROKER_JOB_NOT_FOUND',status:404});
 const wrongKey=new SandboxBrokerClient({baseUrl:`http://127.0.0.1:${port}`,authKey:Buffer.from(randomBytes(32).toString('hex'),'utf8')});
 await expect(wrongKey.getJob(w.subject,job.jobId)).rejects.toMatchObject({code:'SANDBOX_BROKER_AUTH_INVALID',status:401});
 await expect(client.putArtifact(w.subject,{kind:'CODE',mime:'text/javascript',bytes:Buffer.alloc(0)})).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_REQUEST_INVALID',status:null});
 expect(()=>new SandboxBrokerClient({baseUrl:'ftp://sandbox-broker',authKey})).toThrow('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
 expect(()=>new SandboxBrokerClient({baseUrl:'http://sandbox-broker:8092/prefix',authKey})).toThrow('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
 expect(()=>new SandboxBrokerClient({baseUrl:'http://sandbox-broker:8092',authKey,timeoutMs:1})).toThrow('SANDBOX_BROKER_CLIENT_CONFIGURATION_INVALID');
});

it('producer rejects a closed-invalid job before upload, registers artifacts, signs once and submits',async()=>{
 const w=await world(),other=await world();executions=0;lastExecution=null;
 const producer=new SandboxProducer({client,keyId,privateKey:keys.privateKey,imageDigest});
 const count=async(tenantId:string)=>Number((await root.query('SELECT count(*) n FROM sandbox_artifacts WHERE tenant_id=$1',[tenantId])).rows[0].n);
 expect(await count(w.tenantId)).toBe(0);
 await expect(producer.execute({subject:{...w.subject,jobId:'not-a-job'} as unknown as AnalysisJobSubject,language:'javascript',code:'void 0',allowedOutputTypes:['json']})).rejects.toMatchObject({code:'SANDBOX_PRODUCER_INPUT_INVALID'});
 await expect(producer.execute({subject:w.subject,language:'javascript',code:'void 0',allowedOutputTypes:[] as unknown as ['json']})).rejects.toMatchObject({code:'SANDBOX_PRODUCER_INPUT_INVALID'});
 await expect(producer.execute({subject:w.subject,language:'javascript',code:Buffer.alloc(1024*1024+1),allowedOutputTypes:['json']})).rejects.toMatchObject({code:'SANDBOX_PRODUCER_INPUT_INVALID'});
 expect(await count(w.tenantId)).toBe(0);
 const produced=await producer.execute({
  subject:w.subject,language:'javascript',code:'void 0',inputs:[{name:'input.txt',mime:'text/plain',bytes:Buffer.from('producer-input')}],
  limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:64*1024},allowedOutputTypes:['json'],
 });
 expect(produced.outcome).toMatchObject({jobId:w.subject.jobId,state:'SUCCEEDED',failureCode:null});
 expect(produced.job).toMatchObject({tenantId:w.subject.tenantId,taskId:w.subject.taskId,runId:w.subject.runId,jobId:w.subject.jobId,codeArtifactId:produced.code.id,inputArtifactIds:[produced.inputs[0]!.id],limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:64*1024}});
 expect(produced.code).toMatchObject({kind:'CODE',sha256:hash(Buffer.from('void 0'))});
 expect(produced.inputs[0]).toMatchObject({kind:'INPUT',name:'input.txt',sha256:hash(Buffer.from('producer-input'))});
 expect(executions).toBe(1);
 expect(lastExecution).toMatchObject({code:'void 0',inputs:[{artifactId:produced.inputs[0]!.id}]});
 expect(Buffer.from(lastExecution!.inputs[0]!.bytes).toString()).toBe('producer-input');
 const controller=new AbortController();controller.abort();
 await expect(producer.execute({subject:other.subject,language:'javascript',code:'void 0',allowedOutputTypes:['json'],signal:controller.signal})).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_ABORTED'});
 expect(await count(other.tenantId)).toBe(0);
 expect(()=>new SandboxProducer({client,keyId:'bad key',privateKey:keys.privateKey,imageDigest})).toThrow('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 expect(()=>new SandboxProducer({client,keyId,privateKey:keys.publicKey,imageDigest})).toThrow('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
 expect(()=>new SandboxProducer({client,keyId,privateKey:keys.privateKey,imageDigest,lifetimeMs:60_001})).toThrow('SANDBOX_PRODUCER_CONFIGURATION_INVALID');
});

it('producer rejects unusable nonce or clock before uploading any artifact',async()=>{
 const w=await world();executions=0;
 const count=async()=>Number((await root.query('SELECT count(*) n FROM sandbox_artifacts WHERE tenant_id=$1',[w.tenantId])).rows[0].n);
 const cases=[
  {nonce:()=>{throw new Error('PRIVATE_NONCE_GENERATOR');}},
  {nonce:()=> 'not-a-nonce'},
  {nonce:()=> '123e4567-e89b-02d3-a456-426614174000'},
  {now:()=> -1},
  {now:()=> Number.MAX_SAFE_INTEGER},
 ];
 for(const overrides of cases){
  const producer=new SandboxProducer({client,keyId,privateKey:keys.privateKey,imageDigest,...overrides});
  await expect(producer.execute({subject:w.subject,language:'javascript',code:'void 0',allowedOutputTypes:['json']})).rejects.toMatchObject({code:'SANDBOX_PRODUCER_CONFIGURATION_INVALID'});
 }
 expect(executions).toBe(0);
 expect(await count()).toBe(0);
});

it('client rejects redirects, oversized or malformed responses and aborted requests',async()=>{
 const never=async()=>{throw new Error('fetch must not run');};
 const invalid=new SandboxBrokerClient({baseUrl:'http://sandbox-broker.invalid',authKey,fetch:never as typeof fetch});
 await expect(invalid.putArtifact({tenantId:randomUUID(),actorId:randomUUID(),authEpoch:1,taskId:randomUUID(),runId:randomUUID(),jobId:randomUUID()},{kind:'CODE',mime:'text/javascript',bytes:new Uint8Array(0)})).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_REQUEST_INVALID'});
 const redirecting=new SandboxBrokerClient({baseUrl:'http://sandbox-broker.invalid',authKey,fetch:async()=>new Response('moved',{status:302,headers:{location:'http://attacker.invalid'}}) as Response});
 await expect(redirecting.healthLive()).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',status:302});
 const oversized=new SandboxBrokerClient({baseUrl:'http://sandbox-broker.invalid',authKey,fetch:async()=>new Response('{}',{status:200,headers:{'content-length':'2000000'}}) as Response});
 await expect(oversized.healthLive()).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',status:200});
 const malformed=new SandboxBrokerClient({baseUrl:'http://sandbox-broker.invalid',authKey,fetch:async()=>new Response(JSON.stringify({jobId:'not-a-uuid'}),{status:200,headers:{'content-type':'application/json'}}) as Response});
 await expect(malformed.getJob({tenantId:randomUUID(),actorId:randomUUID(),authEpoch:1,taskId:randomUUID(),runId:randomUUID(),jobId:randomUUID()},randomUUID())).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_RESPONSE_INVALID',status:null});
 const controller=new AbortController();controller.abort();
 const abortedFetch:typeof fetch=async(_input,init)=>{init?.signal?.throwIfAborted();throw new Error('aborted');};
 const aborted=new SandboxBrokerClient({baseUrl:'http://sandbox-broker.invalid',authKey,fetch:abortedFetch});
 await expect(aborted.healthLive(controller.signal)).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_ABORTED',status:null});
});

it('cancels a running job over HTTP and refuses a concurrent submission',async()=>{
 const w=await world();executions=0;
 const codeRef=await upload(w.subject,'CODE',Buffer.from('void 0'));
 const first=jobFor(w.subject,{codeArtifactId:codeRef.id}),second=jobFor(w.subject,{codeArtifactId:codeRef.id});
 const started={resolve:()=>{}} as {resolve:()=>void};
 const startedPromise=new Promise<void>(resolve=>{started.resolve=resolve;});
 let aborted=false;
 executeHook=async(_job,_code,_inputs,signal)=>{
  started.resolve();
  return new Promise(resolve=>{
   const done=()=>{aborted=true;resolve(Object.freeze({state:'CANCELLED',reason:'CANCELLED',exitCode:null,oomKilled:false,outputs:Object.freeze([]),stdout:'',stderr:'',durationMs:1}));};
   if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});
  });
 };
 const running=call('POST','/v1/sandbox/jobs',{subject:w.subject,body:signedEnvelope(w.subject,first)});
 await startedPromise;
 expect(await call('POST','/v1/sandbox/jobs',{subject:w.subject,body:signedEnvelope(w.subject,second)})).toMatchObject({status:429,body:{code:'SANDBOX_BROKER_BUSY'}});
 const cancellation=await call('POST',`/v1/sandbox/jobs/${first.jobId}/cancel`,{subject:w.subject});
 expect(cancellation).toMatchObject({status:200,body:{jobId:first.jobId,cancelRequested:true}});
 expect(await running).toMatchObject({status:200,body:{jobId:first.jobId,state:'CANCELLED',failureCode:null}});
 expect(aborted).toBe(true);
 expect(await call('GET',`/v1/sandbox/jobs/${first.jobId}`,{subject:w.subject})).toMatchObject({status:200,body:{state:'CANCELLED',cancelRequested:true}});
 executeHook=null;
});

it('closes the listener, aborts the active execution and rejects later requests',async()=>{
 const w=await world();executions=0;
 const codeRef=await upload(w.subject,'CODE',Buffer.from('void 0')),job=jobFor(w.subject,{codeArtifactId:codeRef.id});
 const started={resolve:()=>{}} as {resolve:()=>void};
 const startedPromise=new Promise<void>(resolve=>{started.resolve=resolve;});
 let aborted=false;
 executeHook=async(_job,_code,_inputs,signal)=>{
  started.resolve();
  return new Promise(resolve=>{
   const done=()=>{aborted=true;resolve(Object.freeze({state:'CANCELLED',reason:'CANCELLED',exitCode:null,oomKilled:false,outputs:Object.freeze([]),stdout:'',stderr:'',durationMs:1}));};
   if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});
  });
 };
 const pending=call('POST','/v1/sandbox/jobs',{subject:w.subject,body:signedEnvelope(w.subject,job)});
 await startedPromise;
 const closing=service.close();
 await expect(closing).resolves.toBeUndefined();
 await expect(pending).resolves.toMatchObject({status:200,body:{state:'CANCELLED'}});
 expect(aborted).toBe(true);
 await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
 await expect(service.close()).resolves.toBeUndefined();
});
