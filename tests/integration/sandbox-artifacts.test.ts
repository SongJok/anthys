import '../support/isolation.js';
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {analysisJobSchema,signAnalysisJob,type AnalysisJob,type AnalysisJobSubject} from '../../packages/analysis/src/job-contract.js';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Database} from '../../packages/storage/src/database.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {PgSandboxArtifactConnector} from '../../packages/sandbox/src/artifacts.js';
import {PgSandboxBrokerStore,SandboxBroker} from '../../packages/sandbox/src/broker.js';
import type {SandboxExecutionResult,SandboxInput} from '../../packages/sandbox/src/executor.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
const keys=generateKeyPairSync('ed25519'),keyId='sandbox-artifact-test',imageDigest='sha256:'+'c'.repeat(64);
let directory:string,files:EncryptedFileStore,connector:PgSandboxArtifactConnector;
beforeAll(async()=>{directory=await realpath(await mkdtemp(join(tmpdir(),'anthys-sandbox-artifacts-')));files=new EncryptedFileStore(directory,new Vault(new Map([['1',randomBytes(32)]]),'1'));connector=new PgSandboxArtifactConnector(db,files);});
afterAll(async()=>{await db.close();await root.end();await rm(directory,{recursive:true,force:true});});

type World={tenantId:string;actorId:string;taskId:string;runId:string;subject:AnalysisJobSubject};
async function world():Promise<World>{
 const tenantId=randomUUID(),actorId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic sandbox artifacts','ACTIVE','UTC')",[tenantId,'synthetic-sandbox-artifacts-'+tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic sandbox artifacts owner','ACTIVE')",[tenantId,actorId,'synthetic-sandbox-artifacts-'+actorId]);
 await root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'synthetic artifact task','ACTIVE',$4,1,clock_timestamp()+interval '1 hour')",[tenantId,taskId,actorId,JSON.stringify({})]);
 await root.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'RUNNING',$5)",[tenantId,runId,taskId,actorId,JSON.stringify({})]);
 return {tenantId,actorId,taskId,runId,subject:{tenantId,actorId,authEpoch:1,taskId,runId,jobId:randomUUID()}};
}
function jobFor(subject:AnalysisJobSubject,overrides:Record<string,unknown>={}):AnalysisJob{return analysisJobSchema.parse({tenantId:subject.tenantId,taskId:subject.taskId,runId:subject.runId,jobId:subject.jobId,language:'javascript',codeArtifactId:randomUUID(),inputArtifactIds:[],network:'NONE',limits:{cpuMillis:1000,memoryMb:64,wallMs:2000,outputBytes:128*1024},allowedOutputTypes:['json','markdown'],...overrides});}
function signed(subject:AnalysisJobSubject,job:AnalysisJob){const now=Date.now();return signAnalysisJob(job,{subject,imageDigest,keyId,privateKey:keys.privateKey,nonce:randomUUID(),issuedAt:now-1000,expiresAt:now+30_000,now});}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const signal=()=>new AbortController().signal;

it('T097 registers code and inputs in the owner-scoped encrypted store and hides, expires or rejects unverified bytes',async()=>{
 const w=await world(),code=Buffer.from("console.log('bound')"),input=Buffer.from('bound-input');
 const codeRef=await connector.put(w,{kind:'CODE',mime:'text/javascript',bytes:code}),inputRef=await connector.put(w,{kind:'INPUT',name:'input.txt',mime:'text/plain; charset=utf-8',bytes:input});
 expect(codeRef).toMatchObject({kind:'CODE',mime:'text/javascript',sha256:hash(code),byteSize:code.length,name:null});
 expect(inputRef).toMatchObject({kind:'INPUT',mime:'text/plain',name:'input.txt',sha256:hash(input)});
 await expect(connector.resolve(codeRef.id,w.subject,signal())).resolves.toEqual(code);
 await expect(connector.resolve(inputRef.id,w.subject,signal())).resolves.toEqual(input);
 const other=await world();
 await expect(connector.resolve(codeRef.id,other.subject,signal())).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_NOT_FOUND'});
 await expect(connector.resolve(randomUUID(),w.subject,signal())).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_NOT_FOUND'});
 const aborted=new AbortController();aborted.abort();
 await expect(connector.resolve(codeRef.id,w.subject,aborted.signal)).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_CANCELLED'});
 await expect(connector.put(w,{kind:'CODE',mime:'text/javascript',bytes:Buffer.alloc(1024*1024+1)})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 await expect(connector.put(w,{kind:'INPUT',mime:'text/plain',bytes:Buffer.alloc(0)})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 await expect(connector.put(w,{kind:'INPUT',mime:'not a mime',bytes:Buffer.from('x')})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 await expect(connector.put(w,{kind:'INPUT',name:'../escape.txt',mime:'text/plain',bytes:Buffer.from('x')})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 await expect(connector.put(w,{kind:'INPUT',mime:'text/plain',bytes:Buffer.from('x'),expiresAt:new Date(Date.now()-1000).toISOString()})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 const key=(await root.query('SELECT storage_key FROM sandbox_artifacts WHERE tenant_id=$1 AND id=$2',[w.tenantId,codeRef.id])).rows[0] as {storage_key:string};
 await writeFile(join(directory,key.storage_key),'tampered');
 await expect(connector.resolve(codeRef.id,w.subject,signal())).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INTEGRITY_FAILED'});
 await connector.put(w,{kind:'INPUT',name:'expired.txt',mime:'text/plain',bytes:Buffer.from('soon')});
 await root.query("UPDATE sandbox_artifacts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND owner_id=$2 AND name='expired.txt'",[w.tenantId,w.actorId]);
 const expired=(await root.query("SELECT id FROM sandbox_artifacts WHERE tenant_id=$1 AND owner_id=$2 AND name='expired.txt'",[w.tenantId,w.actorId])).rows[0] as {id:string};
 await expect(connector.resolve(expired.id,w.subject,signal())).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_NOT_FOUND'});
});

it('T098 executes a signed job through the concrete connector and stores only verified owner-scoped outputs',async()=>{
 const w=await world(),code=Buffer.from('void 0'),input=Buffer.from('bound-input');
 const codeRef=await connector.put(w,{kind:'CODE',mime:'text/javascript',bytes:code}),inputRef=await connector.put(w,{kind:'INPUT',name:'input.txt',mime:'text/plain',bytes:input});
 const job=jobFor(w.subject,{codeArtifactId:codeRef.id,inputArtifactIds:[inputRef.id]}),envelope=signed(w.subject,job);
 const outputJson=Buffer.from('{"ok":true}'),outputNote=Buffer.from('# verified');
 const seen={code:'',inputs:[] as string[]};
 const broker=new SandboxBroker({keyId,publicKey:keys.publicKey,imageDigest,brokerId:'broker-'+w.actorId,store:new PgSandboxBrokerStore(db,{maxActivePerOwner:2,maxJobsPerDay:10}),authorizer:{authorize:async()=>({authorized:true})},resolver:connector,sink:connector,cancelPollMs:50,
  executor:{execute:async(_job,text,inputs:readonly SandboxInput[]):Promise<SandboxExecutionResult>=>{seen.code=text;seen.inputs=inputs.map(item=>Buffer.from(item.bytes).toString());return Object.freeze({state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false,outputs:Object.freeze([Object.freeze({name:'result.json',mime:'application/json',bytes:outputJson,sha256:hash(outputJson)}),Object.freeze({name:'note.md',mime:'text/markdown',bytes:outputNote,sha256:hash(outputNote)})]),stdout:'',stderr:'',durationMs:4});}},
 });
 const outcome=await broker.submit(JSON.stringify(envelope),w.subject);
 expect(outcome).toMatchObject({jobId:job.jobId,state:'SUCCEEDED',failureCode:null,artifactReference:'sandbox-job:'+job.jobId});
 expect(outcome.outputs.map(item=>item.name)).toEqual(['result.json','note.md']);
 expect(seen).toEqual({code:'void 0',inputs:['bound-input']});
 const rows=(await root.query("SELECT id,name,state,sha256,byte_size FROM sandbox_artifacts WHERE tenant_id=$1 AND job_id=$2 AND kind='OUTPUT' ORDER BY name",[w.tenantId,job.jobId])).rows as {id:string;name:string;state:string;sha256:string;byte_size:number}[];
 expect(rows).toHaveLength(2);expect(rows.every(row=>row.state==='READY')).toBe(true);
 expect(rows.map(row=>[row.name,row.sha256,row.byte_size])).toEqual([['note.md',hash(outputNote),outputNote.length],['result.json',hash(outputJson),outputJson.length]]);
 const storedJson=rows.find(row=>row.name==='result.json')!;
 await expect(connector.resolve(storedJson.id,w.subject,signal())).resolves.toEqual(outputJson);
 const other=await world();
 await expect(connector.resolve(storedJson.id,other.subject,signal())).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_NOT_FOUND'});
 await expect(broker.submit(JSON.stringify(envelope),w.subject)).rejects.toMatchObject({code:'SANDBOX_BROKER_REPLAYED'});
 expect(Number((await root.query("SELECT count(*) n FROM sandbox_artifacts WHERE tenant_id=$1 AND job_id=$2 AND kind='OUTPUT'",[w.tenantId,job.jobId])).rows[0].n)).toBe(2);
});

it('T098 refuses to persist mismatched or oversized sink bytes and leaves no READY output',async()=>{
 const w=await world(),job=jobFor(w.subject,{allowedOutputTypes:['json']}),bytes=Buffer.from('{"ok":true}');
 const base={payload:signed(w.subject,job).payload,state:'SUCCEEDED' as const,failureCode:null,durationMs:1,stdout:'',stderr:'',codeSha256:'0'.repeat(64),inputHashes:[]};
 await expect(connector.persist({...base,outputs:[{name:'result.json',mime:'application/json',sha256:'0'.repeat(64),byteSize:bytes.length,bytes}]})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INTEGRITY_FAILED'});
 const oversized=Buffer.alloc(129*1024,0x78);
 await expect(connector.persist({...base,outputs:[{name:'result.json',mime:'application/json',sha256:hash(oversized),byteSize:oversized.length,bytes:oversized}]})).rejects.toMatchObject({code:'SANDBOX_ARTIFACT_INVALID'});
 expect(Number((await root.query("SELECT count(*) n FROM sandbox_artifacts WHERE tenant_id=$1 AND job_id=$2",[w.tenantId,job.jobId])).rows[0].n)).toBe(0);
 await expect(connector.persist({...base,outputs:[]})).resolves.toEqual({reference:'sandbox-job:'+job.jobId});
});
