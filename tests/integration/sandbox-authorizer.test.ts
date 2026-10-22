import '../support/isolation.js';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import pg from 'pg';
import {analysisJobSchema,signAnalysisJob,type AnalysisJobPayload,type AnalysisJobSubject} from '../../packages/analysis/src/job-contract.js';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {PgSandboxAuthorizer} from '../../packages/sandbox/src/authorizer.js';
import {PgSandboxBrokerStore,SandboxBroker} from '../../packages/sandbox/src/broker.js';
import type {SandboxExecutionResult} from '../../packages/sandbox/src/executor.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
const keys=generateKeyPairSync('ed25519'),keyId='sandbox-authorizer-test',imageDigest='sha256:'+'b'.repeat(64);
afterAll(async()=>{await db.close();await root.end();});

type World={tenantId:string;actorId:string;taskId:string;runId:string;subject:AnalysisJobSubject;payload:AnalysisJobPayload;envelope:string;authorizer:PgSandboxAuthorizer};
async function world(options:{tenantStatus?:string;userStatus?:string;userEpoch?:number;taskStatus?:string;taskEpoch?:number;taskExpired?:boolean;taskCancelled?:boolean;runStatus?:string}={}):Promise<World>{
 const tenantId=randomUUID(),actorId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic sandbox acl','ACTIVE','UTC')",[tenantId,'synthetic-sandbox-acl-'+tenantId]);
 await root.query('INSERT INTO users(tenant_id,id,external_user_id,display_name,status,auth_epoch) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,actorId,'synthetic-sandbox-acl-'+actorId,'synthetic sandbox requester',options.userStatus??'ACTIVE',options.userEpoch??1]);
 await root.query('INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at,cancel_requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::int)*interval \'1 minute\',$9)',[tenantId,taskId,actorId,'synthetic sandbox authorization',options.taskStatus??'ACTIVE',JSON.stringify({}),options.taskEpoch??1,options.taskExpired?-1:60,options.taskCancelled?new Date().toISOString():null]);
 await root.query('INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,runId,taskId,actorId,options.runStatus??'RUNNING',JSON.stringify({})]);
 if(options.tenantStatus&&options.tenantStatus!=='ACTIVE')await root.query('UPDATE tenants SET status=$2 WHERE tenant_id=$1',[tenantId,options.tenantStatus]);
 const subject:AnalysisJobSubject={tenantId,actorId,authEpoch:options.userEpoch??1,taskId,runId,jobId:randomUUID()};
 const signed=signAnalysisJob(analysisJobSchema.parse({tenantId,taskId,runId,jobId:subject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:64*1024},allowedOutputTypes:['json']}),{subject,imageDigest,keyId,privateKey:keys.privateKey,nonce:randomUUID(),issuedAt:Date.now()-1000,expiresAt:Date.now()+30_000});
 return {tenantId,actorId,taskId,runId,subject,payload:signed.payload,envelope:JSON.stringify(signed),authorizer:new PgSandboxAuthorizer(db)};
}
const signal=()=>new AbortController().signal;

it('T097 admits a live owner session and denies suspended tenants, inactive identities and stale epochs',async()=>{
 const w=await world();
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:true});
 await root.query("UPDATE tenants SET status='SUSPENDED' WHERE tenant_id=$1",[w.tenantId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TENANT_INACTIVE'});
 await root.query("UPDATE tenants SET status='ACTIVE' WHERE tenant_id=$1",[w.tenantId]);
 await root.query("UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'IDENTITY_INACTIVE'});
 await root.query("UPDATE users SET status='ACTIVE',auth_epoch=2 WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.actorId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'IDENTITY_EPOCH_STALE'});
 await root.query('UPDATE users SET auth_epoch=1 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.actorId]);
 await root.query('UPDATE tasks SET auth_epoch=2 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_EPOCH_STALE'});
 await root.query('UPDATE tasks SET auth_epoch=1 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:true});
});

it('T097 denies paused, completed, cancelled and expired tasks and every non-active run state',async()=>{
 const w=await world();
 await root.query("UPDATE tasks SET status='PAUSED' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_NOT_ACTIVE'});
 await root.query("UPDATE tasks SET status='COMPLETED' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_NOT_ACTIVE'});
 await root.query("UPDATE tasks SET status='ACTIVE',cancel_requested_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_CANCELLED'});
 await root.query("UPDATE tasks SET cancel_requested_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.taskId]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_EXPIRED'});
 await root.query("UPDATE tasks SET expires_at=clock_timestamp()+interval '1 hour' WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.taskId]);
 for(const state of ['CANCELLED','EXPIRED','FAILED','SUCCEEDED','PARTIAL']){
  await root.query('UPDATE runs SET status=$3 WHERE tenant_id=$1 AND id=$2',[w.tenantId,w.runId,state]);
  await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'RUN_NOT_ACTIVE'});
 }
 const otherTask=randomUUID();
 await root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'other task','ACTIVE',$4,1,clock_timestamp()+interval '1 hour')",[w.tenantId,otherTask,w.actorId,JSON.stringify({})]);
 await root.query("UPDATE runs SET status='RUNNING',task_id=$3 WHERE tenant_id=$1 AND id=$2",[w.tenantId,w.runId,otherTask]);
 await expect(w.authorizer.authorize(w.payload,signal())).resolves.toEqual({authorized:false,reason:'RUN_BINDING_MISMATCH'});
});

it('T097 hides foreign owners and tenants behind RLS and never authorizes an ended run',async()=>{
 const w=await world(),otherActor=randomUUID(),otherTask=randomUUID(),otherRun=randomUUID();
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,$4,'ACTIVE')",[w.tenantId,otherActor,'synthetic-other-'+otherActor,'synthetic other owner']);
 await root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'foreign task','ACTIVE',$4,1,clock_timestamp()+interval '1 hour')",[w.tenantId,otherTask,otherActor,JSON.stringify({})]);
 await root.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'RUNNING',$5)",[w.tenantId,otherRun,otherTask,otherActor,JSON.stringify({})]);
 const foreignSubject:AnalysisJobSubject={tenantId:w.tenantId,actorId:w.actorId,authEpoch:1,taskId:otherTask,runId:otherRun,jobId:randomUUID()};
 const foreignRun=signAnalysisJob(analysisJobSchema.parse({tenantId:w.tenantId,taskId:otherTask,runId:otherRun,jobId:foreignSubject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:65_536},allowedOutputTypes:['json']}),{subject:foreignSubject,imageDigest,keyId,privateKey:keys.privateKey,nonce:randomUUID(),issuedAt:Date.now()-1000,expiresAt:Date.now()+30_000});
 await expect(w.authorizer.authorize(foreignRun.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_NOT_FOUND'});
 const foreignTenant=await world(),crossSubject:AnalysisJobSubject={...w.subject,taskId:foreignTenant.taskId,runId:foreignTenant.runId,jobId:randomUUID()};
 const crossTenant=signAnalysisJob(analysisJobSchema.parse({tenantId:crossSubject.tenantId,taskId:crossSubject.taskId,runId:crossSubject.runId,jobId:crossSubject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:65_536},allowedOutputTypes:['json']}),{subject:crossSubject,imageDigest,keyId,privateKey:keys.privateKey,nonce:randomUUID(),issuedAt:Date.now()-1000,expiresAt:Date.now()+30_000});
 await expect(w.authorizer.authorize(crossTenant.payload,signal())).resolves.toEqual({authorized:false,reason:'TASK_NOT_FOUND'});
 const aborted=new AbortController();aborted.abort();
 await expect(w.authorizer.authorize(w.payload,aborted.signal)).rejects.toMatchObject({code:'SANDBOX_BROKER_CANCELLED'});
 const closed=new Database(secret('RUNTIME_DATABASE_URL')!,1);await closed.close();
 await expect(new PgSandboxAuthorizer(closed).authorize(w.payload,signal())).rejects.toMatchObject({code:'SANDBOX_BROKER_UNAVAILABLE'});
});

it('T097/T098 lets the broker execute only after this authorizer confirms the live run and rejects before any resolution once it ends',async()=>{
 const active=await world(),store=new PgSandboxBrokerStore(db,{maxActivePerOwner:2,maxJobsPerDay:10}),calls={resolved:0,executed:0,persisted:0};
 const artifacts=new Map([[active.payload.job.codeArtifactId,Buffer.from('void 0')]]);
 const codeHash=createHash('sha256').update(artifacts.get(active.payload.job.codeArtifactId)!).digest('hex');
 const brokerFor=(w:World)=>new SandboxBroker({keyId,publicKey:keys.publicKey,imageDigest,brokerId:'broker-'+w.actorId,store,authorizer:w.authorizer,cancelPollMs:50,
  resolver:{resolve:async(artifactId)=>{calls.resolved++;return artifacts.get(artifactId)!;}},
  executor:{execute:async():Promise<SandboxExecutionResult>=>{calls.executed++;return Object.freeze({state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false,outputs:Object.freeze([Object.freeze({name:'result.json',bytes:Buffer.from('{"ok":true}'),sha256:createHash('sha256').update('{"ok":true}').digest('hex')})]),stdout:'',stderr:'',durationMs:3});}},
  sink:{persist:async(input)=>{calls.persisted++;expect(input.codeSha256).toBe(codeHash);return {reference:'sink:'+input.payload.job.jobId};}},
 });
 await expect(brokerFor(active).submit(active.envelope,active.subject)).resolves.toMatchObject({state:'SUCCEEDED',failureCode:null,artifactReference:'sink:'+active.payload.job.jobId,outputs:[{name:'result.json',mime:'application/json'}]});
 expect(calls).toEqual({resolved:1,executed:1,persisted:1});
 const ended=await world({runStatus:'CANCELLED'}),endedBroker=brokerFor(ended);
 await expect(endedBroker.submit(ended.envelope,ended.subject)).resolves.toMatchObject({state:'REJECTED',failureCode:'RUN_NOT_ACTIVE',artifactReference:null,outputs:[]});
 expect(calls).toEqual({resolved:1,executed:1,persisted:1});
 expect(await store.get(ended.subject,ended.payload.job.jobId)).toMatchObject({state:'REJECTED',failureCode:'RUN_NOT_ACTIVE'});
});
