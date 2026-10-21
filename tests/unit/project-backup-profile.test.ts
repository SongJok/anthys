import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,writeFile,rm,chmod,open,type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {planProjectBackup,projectBackupSchemaPrefix} from '../../packages/operations/src/project-backup-profile.js';
import {readProjectBackupSource} from '../../packages/operations/src/project-backup-source.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {backupProject} from '../../packages/operations/src/project-backup-driver.js';

const sha='a'.repeat(64);
function profile(){return {schemaVersion:1,kind:'BOUNDED_PROJECT_BACKUP',backupSetId:randomUUID(),reviewReference:'SYNTHETIC_BACKUP_REVIEW',source:{host:'127.0.0.1',port:64710,database:'anthys',role:'oa_migrator',systemIdentifierSha256:sha,migrationCount:73,schemaFingerprint:projectBackupSchemaPrefix(73),connectionFile:'/private/tmp/source-private/connection',connectionFileSha256:sha},repositoryContractFingerprint:requiredSchema.contractHash,pgDump:{path:'/private/tmp/tools/pg_dump',sha256:sha,version:'pg_dump (PostgreSQL) 17.6'},pgRestore:{path:'/private/tmp/tools/pg_restore',sha256:sha,version:'pg_restore (PostgreSQL) 17.6'},postgresArchiveRoot:'/private/tmp/pg-archives',fileStoreArchiveRoot:'/private/tmp/fs-archives',key:{id:'SYNTHETIC_BACKUP_KEY',file:'/private/tmp/key-private/key',fileSha256:sha},fileStore:{sourceRoot:'/private/tmp/source-filestore',sourceRootFingerprint:sha,maxFiles:100,maxFileBytes:4096,maxTotalBytes:65536},maxPostgresArchiveBytes:1024*1024,inventoryLimits:{maxTables:100,maxRows:10000,maxBytes:1024*1024,timeoutMs:5000},validFrom:'2026-10-20T09:00:00.000Z',validUntil:'2026-10-20T09:10:00.000Z',maxDurationMs:60000,maintenance:{stopReference:'SYNTHETIC_STOP_REVIEW',independentWriteFenceReference:'SYNTHETIC_WRITE_FENCE',externalStateReconciliationReference:'SYNTHETIC_RECONCILIATION'}};}
it('produces a stable offline-only plan with explicit unverified attestations and no implicit authorization',()=>{
 const raw=profile(),a=planProjectBackup(raw),b=planProjectBackup({...raw});expect(a.profileHash).toBe(b.profileHash);expect(a.summary).toMatchObject({status:'OFFLINE_PLAN_ONLY_NOT_AUTHORIZED',credentialsRead:false,keyRead:false,databaseAccess:false,processesStarted:false,backupCreated:false,restoreVerified:false,maintenanceIndependentlyVerified:false,operatorReferencesAreAttestations:true,servicesStarted:false,externalDispatchResumeAuthorized:false});expect(JSON.stringify(a.summary)).not.toContain(raw.source.connectionFile);expect(JSON.stringify(a.summary)).not.toContain(raw.key.file);expect(a.summary.sourceMigrationCount).toBe(73);
});
it.each([
 ['host','localhost'],['port',64711],['database','anthys_test'],['role','oa_runtime'],['systemIdentifierSha256','x'],['migrationCount',72],['schemaFingerprint','b'.repeat(64)],['connectionFile','relative'],['connectionFileSha256','x'],
] as const)('rejects source %s drift before any executable operation', (key,value)=>{const p=profile();expect(()=>planProjectBackup({...p,source:{...p.source,[key]:value}})).toThrow();});
it.each(['source','pgDump','pgRestore','key','fileStore','inventoryLimits','maintenance'] as const)('rejects unknown nested %s controls',key=>{const p=profile();expect(()=>planProjectBackup({...p,[key]:{...p[key],unapprovedOverride:true}})).toThrow();});
it.each([
 {approved:true},{repositoryContractFingerprint:'b'.repeat(64)},{postgresArchiveRoot:'/private/tmp/source-filestore/backup'},
 {fileStoreArchiveRoot:'/private/tmp/pg-archives'},{postgresArchiveRoot:'/private/tmp'},
 {maxDurationMs:600001},{maxDurationMs:1},{maxPostgresArchiveBytes:8*1024*1024*1024+1},
 {validUntil:'2026-10-20T09:00:00.000Z'},{validUntil:'2026-10-20T10:00:00.001Z'},
 {validUntil:'2026-10-20T09:00:30.000Z'},{postgresArchiveRoot:'/private/tmp/a/../b'},
 {postgresArchiveRoot:'/private/tmp/unsafe\npath'},
 {postgresArchiveRoot:'/private/tmp/pg-archives/'},{backupSetId:'AB12AB12-AB12-4B12-AB12-AB12AB12AB12'},
])('rejects a changed schema, path topology, duration or unapproved field %#',patch=>{expect(()=>planProjectBackup({...profile(),...patch})).toThrow();});
it('separates keys, connection material, executable pins and archive roots',()=>{
 const p=profile();for(const patch of [{key:{...p.key,file:p.source.connectionFile}},{key:{...p.key,file:p.postgresArchiveRoot+'/key'}},{pgRestore:{...p.pgRestore,path:p.pgDump.path}},{pgDump:{...p.pgDump,version:'pg_dump (PostgreSQL) 18.0'}},{pgDump:{...p.pgDump,version:p.pgDump.version+'\n'}}])expect(()=>planProjectBackup({...p,...patch})).toThrow();
});
it('bounds inventory and file storage before production source inspection',()=>{
 const p=profile();for(const patch of [{inventoryLimits:{...p.inventoryLimits,timeoutMs:60001}},{fileStore:{...p.fileStore,maxFileBytes:65537}},{fileStore:{...p.fileStore,maxFiles:10001}},{fileStore:{...p.fileStore,maxTotalBytes:0}},{fileStore:{...p.fileStore,maxTotalBytes:8*1024*1024*1024}},{key:{...p.key,id:'invalid/archive/key'}},{key:{...p.key,id:'a'.repeat(65)}}])expect(()=>planProjectBackup({...p,...patch})).toThrow();
});
it('binds every reviewed byte, including limits and maintenance references, without treating refs as verified',()=>{
 const p=profile(),before=planProjectBackup(p);for(const patch of [{maxPostgresArchiveBytes:p.maxPostgresArchiveBytes+1},{maintenance:{...p.maintenance,stopReference:'SYNTHETIC_DIFFERENT_STOP'}},{pgDump:{...p.pgDump,sha256:'b'.repeat(64)}}])expect(planProjectBackup({...p,...patch}).profileHash).not.toBe(before.profileHash);
});
it.each([0,72,requiredSchema.migrations.length+1,73.5,NaN,Infinity])('rejects unsupported prefix %s',value=>{expect(()=>projectBackupSchemaPrefix(value)).toThrow('BACKUP_SCHEMA_PREFIX_REJECTED');});

const syntheticUrl='postgresql://oa_migrator:SYNTHETIC_ONLY_NOT_A_REAL_PASSWORD@127.0.0.1:64710/anthys';
async function privateSource(text:string|Buffer=syntheticUrl){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'oa-backup-source-unit-'))),file=join(dir,'connection'),p=profile();
 await writeFile(file,text,{mode:0o600});p.source.connectionFile=file;p.source.connectionFileSha256=createHash('sha256').update(text).digest('hex');p.validFrom=new Date(Date.now()-1000).toISOString();p.validUntil=new Date(Date.now()+600000).toISOString();
 return {p,file,review:()=>({expectedProfileHash:planProjectBackup(p).profileHash,reviewReference:p.reviewReference}),close:()=>rm(dir,{recursive:true,force:true})};
}
it('reads only the pinned private local connection and ignores inherited PG redirection, without opening a DB connection',async()=>{
 const f=await privateSource();try{vi.stubEnv('PGHOST','synthetic.invalid');vi.stubEnv('PGOPTIONS','-c search_path=unapproved');vi.stubEnv('PGSSLMODE','require');vi.stubEnv('PGSSLNEGOTIATION','direct');vi.stubEnv('PGCLIENT_ENCODING','SYNTHETIC_INVALID_ENCODING');vi.stubEnv('PGREPLICATION','database');const value=await readProjectBackupSource(f.p,f.review(),new AbortController().signal);expect(value).toMatchObject({host:'127.0.0.1',port:64710,database:'anthys',user:'oa_migrator',ssl:false,options:'-c row_security=off'});expect(value.password).toBe('SYNTHETIC_ONLY_NOT_A_REAL_PASSWORD');expect('connectionString' in value).toBe(false);const client=new pg.Client(value),params=Reflect.get(client,'connectionParameters');expect({host:client.host,port:client.port,database:client.database,user:client.user,ssl:client.ssl,sslnegotiation:Reflect.get(client,'sslNegotiation'),client_encoding:params.client_encoding,replication:Reflect.get(client,'replication')}).toEqual({host:'127.0.0.1',port:64710,database:'anthys',user:'oa_migrator',ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false'});}finally{vi.unstubAllEnvs();await f.close();}
});
it.each([
 syntheticUrl.replace('127.0.0.1','localhost'),syntheticUrl.replace(':64710/',':64711/'),syntheticUrl.replace('/anthys','/anthys_test'),syntheticUrl.replace('oa_migrator:','oa_runtime:'),syntheticUrl+'?host=synthetic.invalid',syntheticUrl+'?',syntheticUrl+'#',syntheticUrl.replace('127.0.0.1','2130706433'),syntheticUrl.replace('postgresql:','postgres:'),syntheticUrl.replace('SYNTHETIC_ONLY_NOT_A_REAL_PASSWORD',''),syntheticUrl.replace('SYNTHETIC_ONLY_NOT_A_REAL_PASSWORD','encoded%00password'),syntheticUrl.replace('127.0.0.1','127.000.000.001'),
])('rejects pinned but non-approved connection syntax %# without secret output',async text=>{
 const f=await privateSource(text);try{await expect(readProjectBackupSource(f.p,f.review(),new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_TARGET_REJECTED');}finally{await f.close();}
});
it('rejects changed bytes, unsafe private mode and invalid UTF-8 using fixed errors',async()=>{
 const f=await privateSource();try{const review=f.review();await writeFile(f.file,syntheticUrl+'\n');await expect(readProjectBackupSource(f.p,review,new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_CONNECTION_CHANGED');await chmod(f.file,0o644);await expect(readProjectBackupSource(f.p,review,new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_PRIVATE_INPUT_REJECTED');}finally{await f.close();}
 const invalid=await privateSource(Buffer.from([0xff]));try{await expect(readProjectBackupSource(invalid.p,invalid.review(),new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_PRIVATE_INPUT_REJECTED');}finally{await invalid.close();}
});
it('checks cancellation, exact review and the finite window before reading the connection file',async()=>{
 const f=await privateSource();try{const review=f.review();await rm(f.file);await expect(readProjectBackupSource(f.p,{...review,expectedProfileHash:'b'.repeat(64)},new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_REVIEW_MISMATCH');const a=new AbortController();a.abort();await expect(readProjectBackupSource(f.p,review,a.signal)).rejects.toThrow('BACKUP_SOURCE_CANCELLED');f.p.validFrom='2000-01-01T00:00:00.000Z';f.p.validUntil='2000-01-01T00:10:00.000Z';await expect(readProjectBackupSource(f.p,f.review(),new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_WINDOW_CLOSED');}finally{await f.close();}
});
it('the total backup deadline includes a slow private source read and never proceeds to key or DB access',async()=>{
 const f=await privateSource(),probe=await open(f.file,'r'),prototype=Object.getPrototypeOf(probe) as FileHandle,original=prototype.read;await probe.close();f.p.maxDurationMs=1000;f.p.inventoryLimits.timeoutMs=1000;let reads=0;
 const spy=vi.spyOn(prototype,'read').mockImplementation((async function(this:FileHandle,...args:unknown[]){
  const result=await Reflect.apply(original,this,args);if(reads++===0)await new Promise(resolve=>setTimeout(resolve,1100));return result;
 }) as typeof prototype.read);
 try{await expect(backupProject(f.p,f.review(),new AbortController().signal)).rejects.toThrow('BACKUP_SOURCE_CANCELLED');expect(reads).toBeGreaterThan(0);}
 finally{spy.mockRestore();await f.close();}
});
async function backupCli(args:string[]){
 return new Promise<{code:number|null;stdout:string;stderr:string;value:Record<string,unknown>}>((done,reject)=>{
  const cwd=resolve(import.meta.dirname,'../..'),child=spawn(process.execPath,['--import',join(cwd,'scripts/test-network-guard.mjs'),'--import',join(cwd,'node_modules/tsx/dist/loader.mjs'),join(cwd,'scripts/project-backup.ts'),...args],{cwd,env:{PATH:process.env['PATH']??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);try{done({code,stdout,stderr,value:JSON.parse(stdout)});}catch{reject(Error('CLI_JSON_REQUIRED'));}});
 });
}
it('actual offline plan CLI reads only its private profile, with missing connection/key/tools and no service startup',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'oa-backup-cli-'))),file=join(dir,'profile'),p=profile();p.source.connectionFile=join(dir,'absent-connection');p.key.file=join(dir,'absent-key');p.pgDump.path=join(dir,'absent-dump');p.pgRestore.path=join(dir,'absent-restore');
 try{await writeFile(file,JSON.stringify(p),{mode:0o600});const result=await backupCli(['plan','--profile',file]);expect(result.code).toBe(0);expect(result.stderr).toBe('');expect(result.value).toEqual(planProjectBackup(p).summary);expect(result.stdout).not.toContain(dir);}
 finally{await rm(dir,{recursive:true,force:true});}
});
it('actual backup CLI rejects wrong review before absent credentials, and rejects duplicate/unknown flags without input reads',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'oa-backup-cli-'))),file=join(dir,'profile'),p=profile();p.source.connectionFile=join(dir,'absent-connection');
 try{await writeFile(file,JSON.stringify(p),{mode:0o600});const result=await backupCli(['backup','--profile',file,'--expect-profile-hash','b'.repeat(64),'--review-reference',p.reviewReference]);expect(result.code).toBe(1);expect(result.stderr).toBe('');expect(result.value).toMatchObject({code:'BACKUP_SOURCE_REVIEW_MISMATCH',automaticRetry:false,servicesStarted:false,externalDispatchResumeAuthorized:false});expect(result.stdout).not.toContain(dir);
  for(const args of [['plan','--profile','missing','--profile','missing'],['backup','--unsafe','true'],['restore','--profile','missing']])expect((await backupCli(args)).value.code).toBe('BACKUP_CLI_USAGE');
 }finally{await rm(dir,{recursive:true,force:true});}
});
