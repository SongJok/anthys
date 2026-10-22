import '../support/isolation.js';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import pg from 'pg';
import {analysisJobSchema,signAnalysisJob,type AnalysisJob,type AnalysisJobSubject} from '../../packages/analysis/src/job-contract.js';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {PgSandboxBrokerStore,SandboxBroker,type SandboxArtifactResolver,type SandboxAuthorizer,type SandboxBrokerQuota,type SandboxResultSink} from '../../packages/sandbox/src/broker.js';
import {SandboxError,type SandboxExecutionResult,type SandboxInput} from '../../packages/sandbox/src/executor.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
const keys=generateKeyPairSync('ed25519'),keyId='sandbox-broker-test',imageDigest='sha256:'+'a'.repeat(64);
afterAll(async()=>{await db.close();await root.end();});

type World={tenantId:string;actorId:string;subject:AnalysisJobSubject;store:PgSandboxBrokerStore};
async function addUser(tenantId:string){
 const actorId=randomUUID();
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic sandbox user','ACTIVE')",[tenantId,actorId,'synthetic-sandbox-'+actorId]);
 return {tenantId,actorId,subject:subjectFor(tenantId,actorId)};
}
function subjectFor(tenantId:string,actorId:string):AnalysisJobSubject{return {tenantId,actorId,authEpoch:1,taskId:randomUUID(),runId:randomUUID(),jobId:randomUUID()};}
async function world(quota?:SandboxBrokerQuota):Promise<World>{
 const tenantId=randomUUID(),actorId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic sandbox broker','ACTIVE','UTC')",[tenantId,'synthetic-sandbox-broker-'+tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic sandbox owner','ACTIVE')",[tenantId,actorId,'synthetic-sandbox-'+actorId]);
 return {tenantId,actorId,subject:subjectFor(tenantId,actorId),store:new PgSandboxBrokerStore(db,quota)};
}
function jobFor(subject:AnalysisJobSubject,overrides:Record<string,unknown>={}):AnalysisJob{
 return analysisJobSchema.parse({tenantId:subject.tenantId,taskId:subject.taskId,runId:subject.runId,jobId:subject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:64*1024},allowedOutputTypes:['json','markdown'],...overrides});
}
function signed(subject:AnalysisJobSubject,job:AnalysisJob,nonce=randomUUID()){
 const now=Date.now();
 return signAnalysisJob(job,{subject,imageDigest,keyId,privateKey:keys.privateKey,nonce,issuedAt:now-1000,expiresAt:now+30_000,now});
}
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function artifact(name:string,bytes:Uint8Array){return Object.freeze({name,bytes,sha256:digest(bytes)});}
function success(outputs:readonly ReturnType<typeof artifact>[]=[artifact('result.json',Buffer.from('{"ok":true}')),artifact('note.md',Buffer.from('# ok'))]):SandboxExecutionResult{
 return Object.freeze({state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false,outputs:Object.freeze(outputs),stdout:'',stderr:'',durationMs:5});
}
type PersistInput=Parameters<SandboxResultSink['persist']>[0];
type Overrides={artifacts?:Map<string,Uint8Array>;resolve?:SandboxArtifactResolver['resolve'];authorize?:SandboxAuthorizer['authorize'];execute?:(job:AnalysisJob,code:string,inputs:readonly SandboxInput[],signal:AbortSignal)=>Promise<SandboxExecutionResult>;persist?:SandboxResultSink['persist'];pollMs?:number;recheckMs?:number};
function brokerFor(w:World,overrides:Overrides={}){
 const calls={authorizations:0,resolved:[] as string[],executions:0,persisted:[] as PersistInput[],lastExecution:undefined as {job:AnalysisJob;code:string;inputs:readonly SandboxInput[]}|undefined};
 const broker=new SandboxBroker({
  keyId,publicKey:keys.publicKey,imageDigest,brokerId:'broker-'+w.actorId,store:w.store,cancelPollMs:overrides.pollMs??50,...(overrides.recheckMs===undefined?{}:{authorizationRecheckMs:overrides.recheckMs}),
  authorizer:{authorize:async(payload,signal)=>{calls.authorizations++;return overrides.authorize?overrides.authorize(payload,signal):{authorized:true};}},
  resolver:{resolve:async(id,_subject,signal)=>{calls.resolved.push(id);if(overrides.resolve)return overrides.resolve(id,_subject,signal);const value=overrides.artifacts?.get(id);if(!value)throw Error('ARTIFACT_NOT_FOUND');return value;}},
  executor:{execute:async(job,code,inputs,signal)=>{calls.executions++;calls.lastExecution={job,code,inputs};return overrides.execute?overrides.execute(job,code,inputs,signal):success();}},
  sink:{persist:async(input)=>{calls.persisted.push(input);return overrides.persist?overrides.persist(input):{reference:'artifact:'+input.payload.job.jobId};}},
 });
 return {broker,calls};
}

it('T097/T098 admits one signed job, resolves only bound artifacts, executes once and persists bounded evidence',async()=>{
 const w=await world();const codeId=randomUUID(),inputId=randomUUID(),artifacts=new Map<string,Uint8Array>([[codeId,Buffer.from("require('node:fs')")],[inputId,Buffer.from('bound-input')]]);
 const job=jobFor(w.subject,{codeArtifactId:codeId,inputArtifactIds:[inputId],allowedOutputTypes:['json','markdown']});
 const envelope=signed(w.subject,job),wire=JSON.stringify(envelope),{broker,calls}=brokerFor(w,{artifacts});
 const outcome=await broker.submit(wire,w.subject);
 expect(outcome).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',failureCode:null,artifactReference:'artifact:'+job.jobId});
 expect(outcome.outputs.map(output=>output.name)).toEqual(['result.json','note.md']);
 expect(outcome.outputs.every(output=>/^[a-f0-9]{64}$/.test(output.sha256))).toBe(true);
 expect(calls.authorizations).toBe(1);expect(calls.executions).toBe(1);expect(calls.resolved).toEqual([codeId,inputId]);
 expect(calls.lastExecution).toMatchObject({code:"require('node:fs')",inputs:[{artifactId:inputId}]});
 expect(calls.persisted).toHaveLength(1);
 expect(calls.persisted[0]).toMatchObject({state:'SUCCEEDED',failureCode:null,codeSha256:digest(artifacts.get(codeId)!),inputHashes:[{artifactId:inputId,sha256:digest(artifacts.get(inputId)!),byteSize:11}]});
 const stored=await w.store.get(w.subject,job.jobId);
 expect(stored).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',failureCode:null,cancelRequested:false});
 expect(stored?.result).toMatchObject({state:'SUCCEEDED',artifactReference:'artifact:'+job.jobId,outputs:[{name:'result.json',mime:'application/json',byteSize:11},{name:'note.md',mime:'text/markdown',byteSize:4}],codeSha256:digest(artifacts.get(codeId)!),inputHashes:[{artifactId:inputId,sha256:digest(artifacts.get(inputId)!),byteSize:11}]});
 await expect(broker.submit(wire,w.subject)).rejects.toMatchObject({code:'SANDBOX_BROKER_REPLAYED'});
 await expect(broker.submit(JSON.stringify(signed(w.subject,job)),w.subject)).rejects.toMatchObject({code:'SANDBOX_BROKER_REPLAYED'});
 expect(calls.executions).toBe(1);
 expect(Number((await root.query('SELECT count(*) n FROM sandbox_broker_jobs WHERE tenant_id=$1',[w.tenantId])).rows[0].n)).toBe(1);
 const other=await addUser(w.tenantId);
 expect(await w.store.get(other.subject,job.jobId)).toBeNull();
 expect(await w.store.requestCancel(other.subject,job.jobId)).toBe(false);
 expect(await w.store.get(w.subject,job.jobId)).toMatchObject({cancelRequested:false,state:'SUCCEEDED'});
});

it('T097 rejects tampered or oversized wire, a foreign subject and unavailable authorization before executing',async()=>{
 const w=await world(),job=jobFor(w.subject),envelope=signed(w.subject,job),{broker,calls}=brokerFor(w,{artifacts:new Map([[job.codeArtifactId,Buffer.from('void 0')]])});
 const tampered=JSON.parse(JSON.stringify(envelope)) as {signature:string};tampered.signature=tampered.signature.slice(0,-1)+(tampered.signature.endsWith('A')?'B':'A');
 await expect(broker.submit(JSON.stringify(tampered),w.subject)).rejects.toMatchObject({code:'SANDBOX_BROKER_WIRE_INVALID'});
 await expect(broker.submit('x'.repeat(32*1024+1),w.subject)).rejects.toMatchObject({code:'SANDBOX_BROKER_WIRE_INVALID'});
 const foreign=subjectFor(w.tenantId,w.actorId);
 await expect(broker.submit(JSON.stringify(envelope),foreign)).rejects.toMatchObject({code:'SANDBOX_BROKER_WIRE_INVALID'});
 expect(calls.authorizations).toBe(0);expect(calls.executions).toBe(0);
 expect(Number((await root.query('SELECT count(*) n FROM sandbox_broker_jobs WHERE tenant_id=$1',[w.tenantId])).rows[0].n)).toBe(0);
 const denied=await world(),deniedJob=jobFor(denied.subject),deniedWire=JSON.stringify(signed(denied.subject,deniedJob));
 const deniedBroker=brokerFor(denied,{authorize:async()=>({authorized:false,reason:'RUN_ENDED'})});
 await expect(deniedBroker.broker.submit(deniedWire,denied.subject)).resolves.toMatchObject({state:'REJECTED',failureCode:'RUN_ENDED',outputs:[],artifactReference:null});
 expect(deniedBroker.calls.executions).toBe(0);
 expect(await denied.store.get(denied.subject,deniedJob.jobId)).toMatchObject({state:'REJECTED',failureCode:'RUN_ENDED'});
 const unavailable=await world(),unavailableJob=jobFor(unavailable.subject),unavailableBroker=brokerFor(unavailable,{authorize:async()=>{throw Error('ACL_DATABASE_DOWN');}});
 await expect(unavailableBroker.broker.submit(JSON.stringify(signed(unavailable.subject,unavailableJob)),unavailable.subject)).resolves.toMatchObject({state:'FAILED',failureCode:'AUTHORIZATION_UNAVAILABLE'});
 expect(unavailableBroker.calls.executions).toBe(0);
 expect(unavailableBroker.calls.persisted).toHaveLength(0);
});

it('T097/T098 rechecks live authorization while running and refuses to persist after revocation',async()=>{
 const run=async(decide:SandboxAuthorizer['authorize'])=>{
  const w=await world(),job=jobFor(w.subject),started={resolve:()=>{}} as {resolve:()=>void},startedPromise=new Promise<void>(resolve=>{started.resolve=resolve;});let aborted=false,attempts=0;
  const authorize:SandboxAuthorizer['authorize']=async(payload,signal)=>++attempts===1?{authorized:true}:decide(payload,signal);
  const {broker,calls}=brokerFor(w,{artifacts:new Map([[job.codeArtifactId,Buffer.from('void 0')]]),authorize,recheckMs:250,execute:async(_job,_code,_inputs,signal)=>{
   started.resolve();
   return new Promise(resolve=>{const done=()=>{aborted=true;resolve(Object.freeze({state:'CANCELLED',reason:'CANCELLED',exitCode:null,oomKilled:false,outputs:Object.freeze([]),stdout:'ignored',stderr:'',durationMs:1}));};if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
  }});
  const pending=broker.submit(JSON.stringify(signed(w.subject,job)),w.subject);
  await startedPromise;
  const outcome=await pending;
  return {w,job,outcome,calls,aborted};
 };
 const revoked=await run(async()=>({authorized:false,reason:'TASK_CANCELLED'}));
 expect(revoked.outcome).toMatchObject({state:'REJECTED',failureCode:'AUTHORIZATION_REVOKED',outputs:[],artifactReference:null});
 expect(revoked.aborted).toBe(true);expect(revoked.calls.authorizations).toBeGreaterThanOrEqual(2);expect(revoked.calls.persisted).toHaveLength(0);
 expect(await revoked.w.store.get(revoked.w.subject,revoked.job.jobId)).toMatchObject({state:'REJECTED',failureCode:'AUTHORIZATION_REVOKED'});
 const unavailable=await run(async()=>{throw Error('ACL_DATABASE_DOWN');});
 expect(unavailable.outcome).toMatchObject({state:'FAILED',failureCode:'AUTHORIZATION_RECHECK_FAILED',outputs:[],artifactReference:null});
 expect(unavailable.aborted).toBe(true);expect(unavailable.calls.persisted).toHaveLength(0);
 expect(()=>brokerFor(revoked.w,{recheckMs:1})).toThrow('SANDBOX_BROKER_CONFIGURATION_INVALID');
});

it('T098 refuses a cancelled reservation and aborts a running executor after a durable cancel request',async()=>{
 const w=await world(),first=jobFor(w.subject),artifacts=new Map([[first.codeArtifactId,Buffer.from('void 0')]]);
 const before=brokerFor(w,{artifacts,authorize:async(payload)=>{expect(await w.store.requestCancel(w.subject,payload.job.jobId)).toBe(true);return {authorized:true};}});
 await expect(before.broker.submit(JSON.stringify(signed(w.subject,first)),w.subject)).resolves.toMatchObject({state:'CANCELLED',failureCode:null,artifactReference:null});
 expect(before.calls.executions).toBe(0);expect(before.calls.persisted).toHaveLength(0);
 expect(await w.store.get(w.subject,first.jobId)).toMatchObject({state:'CANCELLED',cancelRequested:true});

 const secondSubject=subjectFor(w.tenantId,w.actorId),second=jobFor(secondSubject),started={resolve:()=>{}} as {resolve:()=>void};
 const startedPromise=new Promise<void>(resolve=>{started.resolve=resolve;});
 const running=brokerFor(w,{artifacts:new Map([[second.codeArtifactId,Buffer.from('void 0')]]),execute:async(_job,_code,_inputs,signal)=>{
  started.resolve();
  return new Promise(resolve=>{const done=()=>resolve(Object.freeze({state:'CANCELLED',reason:'CANCELLED',exitCode:null,oomKilled:false,outputs:Object.freeze([]),stdout:'',stderr:'',durationMs:1}));if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
 }});
 const pending=running.broker.submit(JSON.stringify(signed(secondSubject,second)),secondSubject);
 await startedPromise;
 expect(await w.store.get(w.subject,second.jobId)).toMatchObject({state:'RUNNING',startedAt:expect.any(String)});
 expect(await w.store.requestCancel(w.subject,second.jobId)).toBe(true);
 await expect(pending).resolves.toMatchObject({state:'CANCELLED',failureCode:null});
 expect(await w.store.get(w.subject,second.jobId)).toMatchObject({state:'CANCELLED',cancelRequested:true,completedAt:expect.any(String)});
 expect(running.calls.persisted).toHaveLength(1);
 expect(running.calls.persisted[0]).toMatchObject({state:'CANCELLED',failureCode:null});
 expect(await w.store.requestCancel(w.subject,second.jobId)).toBe(false);
});

it('T098 enforces an owner-scoped active and daily quota without consuming a rejected nonce',async()=>{
 const w=await world({maxActivePerOwner:1,maxJobsPerDay:10}),firstSubject=subjectFor(w.tenantId,w.actorId),first=jobFor(firstSubject),release={resolve:()=>{}} as {resolve:()=>void};
 const releasePromise=new Promise<void>(resolve=>{release.resolve=resolve;});
 const firstBroker=brokerFor(w,{artifacts:new Map([[first.codeArtifactId,Buffer.from('void 0')]]),execute:async()=>{
  await releasePromise;return success([artifact('result.json',Buffer.from('{"ok":true}'))]);
 }});
 const firstPending=firstBroker.broker.submit(JSON.stringify(signed(firstSubject,first)),firstSubject);
 await new Promise(resolve=>setTimeout(resolve,100));
 const secondSubject=subjectFor(w.tenantId,w.actorId),second=jobFor(secondSubject),artifacts=new Map([[second.codeArtifactId,Buffer.from('void 0')]]),secondWire=JSON.stringify(signed(secondSubject,second));
 const secondBroker=brokerFor(w,{artifacts});
 await expect(secondBroker.broker.submit(secondWire,secondSubject)).rejects.toMatchObject({code:'SANDBOX_BROKER_QUOTA_EXCEEDED'});
 expect(Number((await root.query('SELECT count(*) n FROM sandbox_broker_jobs WHERE tenant_id=$1',[w.tenantId])).rows[0].n)).toBe(1);
 release.resolve();
 await expect(firstPending).resolves.toMatchObject({state:'SUCCEEDED'});
 await expect(secondBroker.broker.submit(secondWire,secondSubject)).resolves.toMatchObject({state:'SUCCEEDED'});

 const daily=await world({maxActivePerOwner:2,maxJobsPerDay:1}),dailyFirst=jobFor(daily.subject),dailyBroker=brokerFor(daily,{artifacts:new Map([[dailyFirst.codeArtifactId,Buffer.from('void 0')]])});
 await expect(dailyBroker.broker.submit(JSON.stringify(signed(daily.subject,dailyFirst)),daily.subject)).resolves.toMatchObject({state:'SUCCEEDED'});
 const dailySecondSubject=subjectFor(daily.tenantId,daily.actorId),dailySecond=jobFor(dailySecondSubject),dailySecondBroker=brokerFor(daily,{artifacts:new Map([[dailySecond.codeArtifactId,Buffer.from('void 0')]])});
 await expect(dailySecondBroker.broker.submit(JSON.stringify(signed(dailySecondSubject,dailySecond)),dailySecondSubject)).rejects.toMatchObject({code:'SANDBOX_BROKER_QUOTA_EXCEEDED'});
});

it('T098 re-verifies output hashes, extensions and container MIME before persisting',async()=>{
 const w=await world();
 const run=async(outputs:readonly ReturnType<typeof artifact>[],allowedOutputTypes:string[])=>{
  const subject=subjectFor(w.tenantId,w.actorId),job=jobFor(subject,{allowedOutputTypes}),{broker,calls}=brokerFor(w,{artifacts:new Map([[job.codeArtifactId,Buffer.from('void 0')]]),execute:async()=>success(outputs)});
  const outcome=await broker.submit(JSON.stringify(signed(subject,job)),subject);
  return {outcome,calls,stored:await w.store.get(w.subject,job.jobId)};
 };
 const pdf=await run([artifact('result.pdf',Buffer.from('not a pdf'))],['pdf']);
 expect(pdf.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID',outputs:[],artifactReference:null});
 expect(pdf.calls.persisted).toHaveLength(0);expect(pdf.stored).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID'});
 const mismatched={name:'result.json',bytes:Buffer.from('{"ok":true}'),sha256:'0'.repeat(64)};
 const hash=await run([mismatched],['json']);
 expect(hash.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID'});
 const extension=await run([artifact('result.exe',Buffer.from('MZ'))],['json']);
 expect(extension.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID'});
 const invalidJson=await run([artifact('result.json',Buffer.from('{not json'))],['json']);
 expect(invalidJson.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID'});
 const empty=await run([artifact('result.md',Buffer.alloc(0))],['markdown']);
 expect(empty.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID'});
 const validPdf=await run([artifact('report.pdf',Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n'))],['pdf']);
 expect(validPdf.outcome).toMatchObject({state:'SUCCEEDED',outputs:[{name:'report.pdf',mime:'application/pdf'}]});
 expect(validPdf.calls.persisted).toHaveLength(1);
 const workbook=new ExcelJS.Workbook();workbook.addWorksheet('S').addRow(['value']);
 const validXlsx=await run([artifact('report.xlsx',Buffer.from(await workbook.xlsx.writeBuffer()))],['xlsx']);
 expect(validXlsx.outcome).toMatchObject({state:'SUCCEEDED',outputs:[{name:'report.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}]});
 const spoofed=Buffer.concat([Buffer.from('504b0304','hex'),Buffer.from('xl/workbook.xml'),Buffer.from('504b0506','hex'),Buffer.alloc(18)]);
 const fakeXlsx=await run([artifact('spoof.xlsx',spoofed)],['xlsx']);
 expect(fakeXlsx.outcome).toMatchObject({state:'FAILED',failureCode:'OUTPUT_INVALID',artifactReference:null});
 expect(fakeXlsx.calls.persisted).toHaveLength(0);
});

it('T097/T098 records resolver, code and executor failures as terminal without unverified output',async()=>{
 const w=await world(),missing=subjectFor(w.tenantId,w.actorId),missingJob=jobFor(missing);
 const missingBroker=brokerFor(w,{artifacts:new Map()});
 await expect(missingBroker.broker.submit(JSON.stringify(signed(missing,missingJob)),missing)).resolves.toMatchObject({state:'FAILED',failureCode:'ARTIFACT_RESOLUTION_FAILED',outputs:[]});
 expect(missingBroker.calls.executions).toBe(0);expect(missingBroker.calls.persisted).toHaveLength(0);
 expect(await w.store.get(w.subject,missingJob.jobId)).toMatchObject({state:'FAILED',failureCode:'ARTIFACT_RESOLUTION_FAILED'});

 const badSubject=subjectFor(w.tenantId,w.actorId),badJob=jobFor(badSubject);
 const badBroker=brokerFor(w,{artifacts:new Map([[badJob.codeArtifactId,Buffer.from([0xff,0xfe])]])});
 await expect(badBroker.broker.submit(JSON.stringify(signed(badSubject,badJob)),badSubject)).resolves.toMatchObject({state:'FAILED',failureCode:'CODE_INVALID'});
 expect(badBroker.calls.executions).toBe(0);

 const runtimeSubject=subjectFor(w.tenantId,w.actorId),runtimeJob=jobFor(runtimeSubject);
 const runtimeBroker=brokerFor(w,{artifacts:new Map([[runtimeJob.codeArtifactId,Buffer.from('void 0')]]),execute:async()=>{throw new SandboxError('SANDBOX_RUNTIME_UNAVAILABLE');}});
 await expect(runtimeBroker.broker.submit(JSON.stringify(signed(runtimeSubject,runtimeJob)),runtimeSubject)).resolves.toMatchObject({state:'FAILED',failureCode:'SANDBOX_RUNTIME_UNAVAILABLE'});
 expect(runtimeBroker.calls.persisted).toHaveLength(0);
 expect(await w.store.get(w.subject,runtimeJob.jobId)).toMatchObject({state:'FAILED',failureCode:'SANDBOX_RUNTIME_UNAVAILABLE'});
});

it('T097/T098 settles only the restarting broker\'s interrupted jobs and leaves other brokers and terminals untouched',async()=>{
 const w=await world({maxActivePerOwner:8,maxJobsPerDay:100}),store=new PgSandboxBrokerStore(db,{maxActivePerOwner:8,maxJobsPerDay:100});
 const claim=()=>{const subject=subjectFor(w.tenantId,w.actorId),job=jobFor(subject);return {job,payload:signed(subject,job).payload};};
 const reservedA=claim(),runningA=claim(),reservedB=claim(),finishedA=claim();
 await store.claim(reservedA.payload,'broker-a');await store.claim(runningA.payload,'broker-a');
 expect(await store.begin(runningA.payload)).toBe('RUNNING');
 await store.claim(reservedB.payload,'broker-b');
 await store.claim(finishedA.payload,'broker-a');await store.finish(finishedA.payload,'SUCCEEDED',null,null);
 await expect(store.recoverInterrupted('broker-a')).resolves.toBe(2);
 expect(await store.get(w.subject,reservedA.job.jobId)).toMatchObject({state:'FAILED',failureCode:'SANDBOX_JOB_INTERRUPTED',cancelRequested:false});
 expect(await store.get(w.subject,runningA.job.jobId)).toMatchObject({state:'FAILED',failureCode:'SANDBOX_JOB_INTERRUPTED'});
 expect(await store.get(w.subject,reservedB.job.jobId)).toMatchObject({state:'RESERVED',failureCode:null,completedAt:null});
 expect(await store.get(w.subject,finishedA.job.jobId)).toMatchObject({state:'SUCCEEDED',failureCode:null});
 await expect(store.recoverInterrupted('broker-a')).resolves.toBe(0);
 await expect(store.recoverInterrupted('bad owner!')).rejects.toMatchObject({code:'SANDBOX_BROKER_CONFIGURATION_INVALID'});
 await expect(store.claim(claim().payload,'bad owner!')).rejects.toMatchObject({code:'SANDBOX_BROKER_CONFIGURATION_INVALID'});
 expect((await store.get(w.subject,reservedB.job.jobId))?.result).toBeNull();
});
