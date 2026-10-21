import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,chmod,writeFile,readFile,stat,open,rm,type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {boundedMigrationProfile,planBoundedMigrationStep,type BoundedMigrationProfile} from '../../packages/operations/src/bounded-migration.js';
import {boundedMigrationStepCommand} from '../../scripts/bounded-migration-step.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const prefix=(count:number)=>hash(requiredSchema.migrations.slice(0,count).map(m=>m.name+'\0'+m.hash+'\0').join(''));
const repository=resolve(import.meta.dirname,'../..'),contractPath=join(repository,'packages/storage/src/required-migrations.json');
const sqlPaths=requiredSchema.migrations.map(m=>join(repository,'db/migrations',m.name));
// Assignability keeps this test typecheckable against the older one-argument
// implementation without changing it. Runtime tests still require the signal.
const plan:(raw:unknown,signal?:AbortSignal)=>ReturnType<typeof planBoundedMigrationStep>=planBoundedMigrationStep;
let directory:string,profileFile:string,profile:BoundedMigrationProfile,prototype:FileHandle;
let identities:Map<string,string>;
const handles=new Set<FileHandle>();
type ReadEvent={path:string|undefined;file:FileHandle;bytes:Buffer|null};
function gate(){let release!:()=>void;const pending=new Promise<void>(done=>{release=done;});return {pending,release};}
async function reached(entered:ReturnType<typeof gate>,pending:Promise<string|null>){await Promise.race([entered.pending,pending.then(()=>{throw Error('SYNTHETIC_READ_GATE_NOT_REACHED');})]);}
async function failureCode(pending:Promise<unknown>){try{await pending;return null;}catch(error){return error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof Error?error.name:'UNEXPECTED_ERROR';}}
function observe(onRead:(event:ReadEvent)=>Promise<void>|void=()=>{}){
 const records:ReadEvent[]=[];
 const record=async(file:FileHandle,bytes:Buffer|null)=>{const s=await file.stat(),event={path:identities.get(s.dev+':'+s.ino),file,bytes};handles.add(file);records.push(event);await onRead(event);};
 const originalFile=prototype.readFile,originalRead=prototype.read;
 vi.spyOn(prototype,'readFile').mockImplementation((async function(this:FileHandle,...args:unknown[]){
  const result=await Reflect.apply(originalFile,this,args);await record(this,Buffer.isBuffer(result)?result:null);return result;
 }) as typeof prototype.readFile);
 vi.spyOn(prototype,'read').mockImplementation((async function(this:FileHandle,...args:unknown[]){
  const result=await Reflect.apply(originalRead,this,args);if(result.bytesRead>0)await record(this,null);return result;
 }) as typeof prototype.read);
 return records;
}
beforeEach(async()=>{
 directory=await realpath(await mkdtemp(join(tmpdir(),'oa-bounded-lifetime-')));await chmod(directory,0o700);profileFile=join(directory,'profile.json');
 profile={schemaVersion:1,kind:'BOUNDED_PROJECT_MIGRATION_STEP',reviewReference:'SYNTHETIC_LIFETIME_ONLY_NOT_AUTHORIZED',repository:await realpath(repository),connectionFile:join(directory,'deliberately-absent-connection'),connectionFileSha256:hash('SYNTHETIC_UNUSED_CONNECTION_PIN'),target:{host:'127.0.0.1',port:64711,database:'synthetic_no_connection',systemIdentifierSha256:hash('SYNTHETIC_NO_DATABASE')},from:73,to:74,sourceFingerprint:prefix(73),targetFingerprint:prefix(74),repositoryContractFingerprint:requiredSchema.contractHash,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+120000).toISOString(),maxDurationMs:15000,lockTimeoutMs:1000,prerequisites:{maintenanceStopReference:'SYNTHETIC_OPERATOR_ATTESTATION',backupReference:'SYNTHETIC_NOT_BACKUP_PROOF',restoredPostgresContentFingerprint:hash('SYNTHETIC_POSTGRES'),restoredFileStoreManifestSha256:hash('SYNTHETIC_FILESTORE'),keyRecoveryReference:'SYNTHETIC_NOT_KEY_RECOVERY_PROOF',sqlSemanticReviewSha256:hash('SYNTHETIC_NOT_SEMANTIC_REVIEW'),externalStateReconciliationReference:'SYNTHETIC_NOT_RECONCILIATION_PROOF'}};
 await writeFile(profileFile,JSON.stringify(profile),{mode:0o600});
 const probe=await open(profileFile,'r');prototype=Object.getPrototypeOf(probe) as FileHandle;await probe.close();
 identities=new Map();for(const path of [profileFile,contractPath,...sqlPaths]){const s=await stat(path);identities.set(s.dev+':'+s.ino,path);}
 vi.spyOn(pg.Client.prototype,'connect').mockImplementation(()=>{throw Error('UNEXPECTED_DATABASE_CONNECT');});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('UNEXPECTED_NETWORK_FETCH');}));
});
afterEach(async()=>{
 try{expect(pg.Client.prototype.connect).not.toHaveBeenCalled();expect(globalThis.fetch).not.toHaveBeenCalled();}
 finally{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all([...handles].map(file=>file.close().catch(()=>{})));handles.clear();await rm(directory,{recursive:true,force:true});}
});

it('a genuine plan reads every pinned repository SQL and leaves SQL, contract and profile unchanged without reading connection credentials',async()=>{
 const paths=[contractPath,...sqlPaths],before=new Map<string,string>();for(const path of paths)before.set(path,hash(await readFile(path)));const rawBefore=JSON.stringify(profile),records=observe(),result=await plan(profile,new AbortController().signal);
 expect(result.summary).toMatchObject({status:'PLAN_ONLY_NOT_AUTHORIZED',from:73,to:74,databaseAccess:false,credentialsRead:false,prerequisitesIndependentlyVerified:false,servicesStarted:false,externalDispatchResumeAuthorized:false});
 expect(result.migration).toEqual(requiredSchema.migrations[73]);expect(hash(result.sql)).toBe(requiredSchema.migrations[73]!.hash);expect(result.profileHash).toBe(hash(JSON.stringify(boundedMigrationProfile.parse(profile))));
 const touched=new Set(records.map(r=>r.path));expect(touched).toEqual(new Set(paths));expect(touched.has(profile.connectionFile)).toBe(false);
 // Source bytes are read again; no implementation/content is substituted.
 for(const path of paths)expect(hash(await readFile(path))).toBe(before.get(path));expect(JSON.stringify(profile)).toBe(rawBefore);
});

it.each(['past','future'] as const)('planning a %s execution window remains inspection-only and does not require the absent connection file',async when=>{
 const start=when==='past'?'2000-01-01T00:00:00.000Z':'2099-01-01T00:00:00.000Z',end=when==='past'?'2000-01-01T00:02:00.000Z':'2099-01-01T00:02:00.000Z',records=observe();
 const result=await plan({...profile,validFrom:start,validUntil:end},new AbortController().signal);expect(result.summary.status).toBe('PLAN_ONLY_NOT_AUTHORIZED');expect(new Set(records.map(r=>r.path))).toEqual(new Set([contractPath,...sqlPaths]));expect(result.summary.credentialsRead).toBe(false);
});

it('pre-cancelled planning rejects with the fixed cancellation code before any file content is read',async()=>{
 const records=observe(),controller=new AbortController();controller.abort();
 expect.soft(await failureCode(plan(profile,controller.signal))).toBe('CANCELLED_OR_TIMEOUT');expect(records.length).toBe(0);
});

it('cancellation while an actual contract read is gated stops later SQL reads and still closes the opened descriptor',async()=>{
 const entered=gate(),release=gate();let first:ReadEvent|undefined;const records=observe(async event=>{if(!first){first=event;entered.release();await release.pending;}}),controller=new AbortController(),pending=failureCode(plan(profile,controller.signal));
 try{await reached(entered,pending);controller.abort();release.release();expect.soft(await pending).toBe('CANCELLED_OR_TIMEOUT');expect(new Set(records.map(r=>r.path)).size).toBe(1);expect(records[0]?.path).toBe(contractPath);expect(first).toBeDefined();await expect(first!.file.stat()).rejects.toMatchObject({code:'EBADF'});}
 finally{release.release();await pending;}
});

it('cancellation after the final real SQL read cannot return a successful plan',async()=>{
 const controller=new AbortController(),last=sqlPaths.at(-1)!;let finalRead=false;observe(event=>{if(event.path===last){finalRead=true;controller.abort();}});
 const code=await failureCode(plan(profile,controller.signal));expect(finalRead).toBe(true);expect(code).toBe('CANCELLED_OR_TIMEOUT');
});

it('the preparation budget includes a gated actual read even when its timer callback has not run',async()=>{
 const entered=gate(),release=gate(),clock=performance.now.bind(performance);let advance=0,first=false;
 vi.spyOn(performance,'now').mockImplementation(()=>clock()+advance);
 const records=observe(async()=>{if(!first){first=true;entered.release();await release.pending;}});
 const pending=failureCode(plan({...profile,maxDurationMs:1000},new AbortController().signal));
 try{await reached(entered,pending);advance=1001;release.release();expect.soft(await pending).toBe('STEP_DEADLINE_EXCEEDED');expect(new Set(records.map(r=>r.path)).size).toBe(1);expect(records[0]?.path).toBe(contractPath);}
 finally{release.release();await pending;}
});

it('the monotonic preparation budget is cumulative across distinct real files rather than restarted for each SQL',async()=>{
 const clock=performance.now.bind(performance);let advance=0;const touched=new Set<string>();
 vi.spyOn(performance,'now').mockImplementation(()=>clock()+advance);
 const records=observe(event=>{if(event.path&&!touched.has(event.path)){touched.add(event.path);advance+=600;}});
 expect.soft(await failureCode(plan({...profile,maxDurationMs:1000},new AbortController().signal))).toBe('STEP_DEADLINE_EXCEEDED');
 expect(touched.has(contractPath)).toBe(true);expect(touched.size).toBeLessThan(requiredSchema.migrations.length+1);expect(records.every(r=>r.path!==undefined)).toBe(true);
});

it('the CLI propagates its signal into planning after the actual private profile read',async()=>{
 const controller=new AbortController(),entered=gate(),release=gate();let firstRepositoryRead=false;
 const records=observe(async event=>{if(event.path!==profileFile&&!firstRepositoryRead){firstRepositoryRead=true;entered.release();await release.pending;}});
 const pending=failureCode(boundedMigrationStepCommand(['plan','--profile',profileFile],controller.signal));
 try{await reached(entered,pending);controller.abort();release.release();expect.soft(await pending).toBe('CANCELLED_OR_TIMEOUT');expect(records.some(r=>r.path===profileFile)).toBe(true);const repositoryReads=records.filter(r=>r.path!==profileFile);expect(new Set(repositoryReads.map(r=>r.path)).size).toBe(1);expect(repositoryReads[0]?.path).toBe(contractPath);}
 finally{release.release();await pending;}
});

it('cancellation during the actual private profile read cannot fall through to SQL planning',async()=>{
 const controller=new AbortController(),entered=gate(),release=gate();let firstProfileRead=false;
 const records=observe(async event=>{if(event.path===profileFile&&!firstProfileRead){firstProfileRead=true;entered.release();await release.pending;}});
 const pending=failureCode(boundedMigrationStepCommand(['plan','--profile',profileFile],controller.signal));
 try{await reached(entered,pending);controller.abort();release.release();expect.soft(['CANCELLED_OR_TIMEOUT','AbortError']).toContain(await pending);expect(records.every(r=>r.path===profileFile)).toBe(true);}
 finally{release.release();await pending;}
});
