import '../support/isolation.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,readFile,writeFile,readdir,rm,open,stat,type FileHandle} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {historicalMigrationDatabase} from '../support/historical-migration-database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {createPostgresFileBackup,type CreatePostgresFileBackupInput} from '../../packages/operations/src/project-backup-driver.js';
import {projectBackupSchemaPrefix} from '../../packages/operations/src/project-backup-profile.js';
import {planProjectRestore,restoreProject,type ProjectRestoreProfile} from '../../packages/operations/src/project-restore.js';
import {projectRestoreCommand} from '../../scripts/project-restore.js';
import type {PostgresBackupConnection} from '../../packages/operations/src/postgres-backup-snapshot.js';

const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),signal=()=>new AbortController().signal;
const key=randomBytes(32),vault=new Vault(new Map([['synthetic-v1',randomBytes(32)]]),'synthetic-v1'),body=Buffer.from('SYNTHETIC_RESTORE_COMMAND_CONTENT 不回显');
const fileKey=`${randomUUID()}/${randomUUID()}/${randomUUID()}/${randomUUID()}.sealed`;
const limits={maxTables:512,maxRows:100000,maxBytes:32*1024*1024,timeoutMs:30000};
let own:Awaited<ReturnType<typeof historicalMigrationDatabase>>,directory:string,system:string,initial:CreatePostgresFileBackupInput,backup:Awaited<ReturnType<typeof createPostgresFileBackup>>,firstTarget:Awaited<ReturnType<typeof own.createOwnEmptyRestoreTarget>>,firstProfile:ProjectRestoreProfile;
function connection(text:string):PostgresBackupConnection{
 const u=new URL(text);expect(u.hostname).toBe('127.0.0.1');expect(u.port).toBe('53331');expect(u.pathname).toMatch(/^\/open_aider_test_group_reminder_[a-f0-9]{32}$/);
 return {host:'127.0.0.1',port:53331,database:u.pathname.slice(1),user:'oa_migrator',password:decodeURIComponent(u.password),ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off'};
}
beforeAll(async()=>{
 const pins=JSON.parse(await readFile('.data/test-environment/pg17-client.json','utf8')).pins;
 own=await historicalMigrationDatabase(73);system=(await own.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value;
 directory=await realpath(await mkdtemp(join(await realpath('/tmp'),'oa-restore-command-')));for(const name of ['postgres','filestore','source','restored','private'])await mkdir(join(directory,name),{mode:0o700});
 await new EncryptedFileStore(join(directory,'source'),vault).put(fileKey,body);await writeFile(join(directory,'private','key'),key,{mode:0o600});
 const tenant=randomUUID();await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_RESTORE','ACTIVE')",[tenant]);
 initial={connection:connection(own.connectionString),expectedDatabase:own.name,expectedSystemIdentifierSha256:hash(system),expectedMigrationCount:73,expectedSchemaFingerprint:projectBackupSchemaPrefix(73),expiresAt:new Date(Date.now()+60000).toISOString(),maxDurationMs:60000,signal:signal(),backupSetId:randomUUID(),profileHash:hash('SYNTHETIC_BACKUP_REVIEW'),keyId:'synthetic-separate-key',key,pgDump:pins.pg_dump,pgRestore:pins.pg_restore,postgresArchiveRoot:join(directory,'postgres'),maxPostgresArchiveBytes:16*1024*1024,inventoryLimits:limits,fileStore:{sourceRoot:join(directory,'source'),archiveRoot:join(directory,'filestore'),maxFiles:10,maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024},expectedFileStoreRootHash:hash(join(directory,'source'))};
 backup=await createPostgresFileBackup(initial);
 // Only this fixture's confirmed nonce and private temporary source tree.
 // Recovery must not depend on the original database or FileStore still existing.
 expect((await own.destroyOwnSource()).state).toBe('DESTROYED');await rm(initial.fileStore.sourceRoot,{recursive:true});
 firstTarget=await own.createOwnEmptyRestoreTarget();firstProfile=await profile(firstTarget);
},60000);
afterAll(async()=>{await own?.close();if(directory)await rm(directory,{recursive:true,force:true});key.fill(0);},60000);
async function profile(target:Awaited<ReturnType<typeof own.createOwnEmptyRestoreTarget>>):Promise<ProjectRestoreProfile>{
 const credential=join(directory,'private',target.name);await writeFile(credential,target.connectionString,{mode:0o600});
 return {schemaVersion:1,kind:'BOUNDED_PROJECT_RESTORE',reviewReference:'SYNTHETIC_RESTORE_REVIEW',repositoryContractFingerprint:requiredSchema.contractHash,backup:{backupSetId:initial.backupSetId,receiptFile:backup.receiptPath,receiptSha256:backup.receiptSha256,profileHash:initial.profileHash,sourceDatabase:own.name,sourceSystemIdentifierSha256:hash(system),migrationCount:73,schemaFingerprint:initial.expectedSchemaFingerprint,postgresArchiveRoot:initial.postgresArchiveRoot,fileStoreArchiveRoot:initial.fileStore.archiveRoot,maxPostgresArchiveBytes:initial.maxPostgresArchiveBytes,fileStore:{sourceRoot:initial.fileStore.sourceRoot,maxFiles:10,maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024}},key:{id:initial.keyId,file:join(directory,'private','key'),fileSha256:hash(key)},target:{host:'127.0.0.1',port:53331,database:target.name,role:'oa_migrator',databaseOid:target.databaseOid,systemIdentifierSha256:hash(system),connectionFile:credential,connectionFileSha256:hash(target.connectionString)},pgRestore:initial.pgRestore,fileRestore:{parent:join(directory,'restored'),restoreId:randomUUID()},inventoryLimits:limits,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+600000).toISOString(),maxDurationMs:60000,maintenance:{targetExclusiveControlReference:'SYNTHETIC_TARGET_CONTROL',sourceStopReference:'SYNTHETIC_SOURCE_STOP',keyRecoveryReference:'SYNTHETIC_KEY_REFERENCE',externalStateReconciliationReference:'SYNTHETIC_NOT_YET_RECONCILED'}};
}
const review=(p:ProjectRestoreProfile)=>({expectedProfileHash:planProjectRestore(p).profileHash,reviewReference:p.reviewReference});
async function cli(action:string,p:ProjectRestoreProfile,extra:string[]=[]){
 const file=join(directory,'private','profile-'+randomUUID());await writeFile(file,JSON.stringify(p),{mode:0o600});
 return new Promise<{code:number|null;stdout:string;stderr:string;value:Record<string,unknown>}>((done,reject)=>{
  const cwd=resolve(import.meta.dirname,'../..'),args=action==='restore'?['--expect-profile-hash',review(p).expectedProfileHash,'--review-reference',p.reviewReference]:[];
  const child=spawn(process.execPath,['--import',join(cwd,'scripts/test-network-guard.mjs'),'--import',join(cwd,'node_modules/tsx/dist/loader.mjs'),join(cwd,'scripts/project-restore.ts'),action,'--profile',file,...args,...extra],{cwd,env:{PATH:process.env['PATH']??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),65000);
  child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{done({code,stdout,stderr,value:JSON.parse(stdout)});}catch{reject(Error('CLI_JSON_REQUIRED'));}});
 });
}
it('actual plan command with absent inputs prints hashes without reading credentials, archives or target',async()=>{
 const p=structuredClone(firstProfile);p.backup.postgresArchiveRoot=join(directory,'absent-archives');p.backup.receiptFile=join(p.backup.postgresArchiveRoot,p.backup.backupSetId+'.backup-set.json');p.target.connectionFile=join(directory,'private','absent-credential');p.key.file=join(directory,'private','absent-key');
 const result=await cli('plan',p);expect(result.code).toBe(0);expect(result.stderr).toBe('');expect(result.value).toEqual(planProjectRestore(p).summary);expect(result.stdout).not.toContain(directory);
});
it('after actual destruction of the owned source DB and files, the restore CLI recovers PG and sealed bytes while keeping reconciliation and restart blocked',async()=>{
 const result=await cli('restore',firstProfile);expect(result.code).toBe(0);expect(result.stderr).toBe('');expect(result.value).toMatchObject({status:'RESTORED_SET_RECONCILIATION_REQUIRED',postgresContentFingerprint:backup.receipt.inventory.contentFingerprint,sourceAndTargetClustersDiffer:false,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true,applicationKeyRecoveryVerified:false,servicesStarted:false});
 expect(result.stdout).not.toContain(body.toString());expect(result.stdout).not.toContain(directory);expect(result.stdout).not.toContain(initial.connection.password);
 expect(await new EncryptedFileStore(join(firstProfile.fileRestore.parent,firstProfile.fileRestore.restoreId),vault).get(fileKey)).toEqual(body);
 expect((await firstTarget.root.query('SELECT count(*) n FROM tenants')).rows[0].n).toBe('1');
 expect((await firstTarget.root.query('SELECT datname FROM pg_database WHERE datname=$1',[own.name])).rows).toEqual([]);await expect(stat(initial.fileStore.sourceRoot)).rejects.toMatchObject({code:'ENOENT'});
},60000);
it('repeating the same actual command cannot replace restored files or replay PostgreSQL restoration',async()=>{
 const result=await cli('restore',firstProfile);expect(result.code).toBe(1);expect(result.value).toMatchObject({status:'REJECTED_OR_QUARANTINED_RECONCILIATION_REQUIRED',code:'RESTORE_FAILED_FILESTORE_RECONCILIATION_REQUIRED',automaticRetry:false});expect(await new EncryptedFileStore(join(firstProfile.fileRestore.parent,firstProfile.fileRestore.restoreId),vault).get(fileKey)).toEqual(body);expect((await firstTarget.root.query('SELECT count(*) n FROM tenants')).rows[0].n).toBe('1');
},60000);
it.each(['live-project','shared-test','source','template','conninfo','wrong-port','overlap','wrong-schema','unknown-control'] as const)('refuses %s plan before any input read or target call',kind=>{
 const p=structuredClone(firstProfile);
 if(kind==='live-project')p.target.database='open_aider';if(kind==='shared-test')p.target.database='open_aider_test';if(kind==='source')p.target.database=own.name;if(kind==='template')p.target.database='template1';if(kind==='conninfo')p.target.database='dbname=other';if(kind==='wrong-port')p.target.port=53330;if(kind==='overlap')p.fileRestore.parent=p.backup.postgresArchiveRoot;if(kind==='wrong-schema')p.backup.schemaFingerprint='b'.repeat(64);
 expect(()=>planProjectRestore(kind==='unknown-control'?{...p,unsafeResume:true}:p)).toThrow();
});
it('review, cancellation and expiry reject before missing input files and never start restoration',async()=>{
 const p=structuredClone(firstProfile);p.backup.postgresArchiveRoot=join(directory,'absent');p.backup.receiptFile=join(p.backup.postgresArchiveRoot,p.backup.backupSetId+'.backup-set.json');
 await expect(restoreProject(p,{...review(p),expectedProfileHash:'b'.repeat(64)},signal())).rejects.toThrow('RESTORE_REVIEW_MISMATCH');const a=new AbortController();a.abort();await expect(restoreProject(p,review(p),a.signal)).rejects.toThrow('RESTORE_CANCELLED_OR_TIMEOUT');
 p.validFrom='2000-01-01T00:00:00Z';p.validUntil='2000-01-01T00:10:00Z';await expect(restoreProject(p,review(p),signal())).rejects.toThrow('RESTORE_WINDOW_CLOSED');
 await expect(projectRestoreCommand(['restore','--unsafe','true'],signal())).rejects.toThrow('RESTORE_CLI_USAGE');
});
it('a pinned receipt with a different archive identity is rejected before credentials or target connections',async()=>{
 const p=structuredClone(firstProfile),original=await readFile(backup.receiptPath),receipt=JSON.parse(original.toString());receipt.postgres.backupId=randomUUID();const bytes=Buffer.from(JSON.stringify(receipt));await writeFile(backup.receiptPath,bytes);p.backup.receiptSha256=hash(bytes);p.target.connectionFile=join(directory,'private','absent-credential');
 try{await expect(restoreProject(p,review(p),signal())).rejects.toThrow('RESTORE_BACKUP_SET_BINDING_REJECTED');}finally{await writeFile(backup.receiptPath,original);}
});
it('an authenticated FileStore mismatch is detected with zero target connections and leaves the new sealed tree quarantined',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),p=await profile(target),original=await readFile(backup.receiptPath),receipt=JSON.parse(original.toString());receipt.fileStore.manifest.files[0].sha256='b'.repeat(64);const bytes=Buffer.from(JSON.stringify(receipt));await writeFile(backup.receiptPath,bytes);p.backup.receiptSha256=hash(bytes);
 const connect=pg.Client.prototype.connect;let calls=0;const spy=vi.spyOn(pg.Client.prototype,'connect').mockImplementation((function(this:pg.Client,...args:unknown[]){calls++;return Reflect.apply(connect,this,args);}) as typeof pg.Client.prototype.connect);
 try{await expect(restoreProject(p,review(p),signal())).rejects.toThrow('RESTORE_FILESTORE_RECEIPT_MISMATCH');expect(calls).toBe(0);expect(await new EncryptedFileStore(join(p.fileRestore.parent,p.fileRestore.restoreId),vault).get(fileKey)).toEqual(body);}
 finally{spy.mockRestore();await writeFile(backup.receiptPath,original);}
 expect((await target.root.query("SELECT to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
});
it('wrong target OID after FileStore recovery keeps the new sealed tree and empty DB for explicit reconciliation',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),p=await profile(target);p.target.databaseOid=String(Number(target.databaseOid)+1);
 await expect(restoreProject(p,review(p),signal())).rejects.toThrow('RESTORE_FAILED_POSTGRES_RECONCILIATION_REQUIRED');
 expect(await new EncryptedFileStore(join(p.fileRestore.parent,p.fileRestore.restoreId),vault).get(fileKey)).toEqual(body);
 expect((await target.root.query("SELECT to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
 expect((await readdir(initial.postgresArchiveRoot)).some(name=>name.startsWith('.restore-'))).toBe(false);
},60000);
it.each(['duration','absolute-window'] as const)('%s timeout during actual FileStore reads performs zero target connections and cleans uncommitted staging',async kind=>{
 const p=structuredClone(firstProfile);p.fileRestore.restoreId=randomUUID();p.inventoryLimits.timeoutMs=1000;
 if(kind==='duration')p.maxDurationMs=3000;
 else{p.validFrom=new Date(Date.now()-60000).toISOString();p.validUntil=new Date(Date.now()+3000).toISOString();}
 const archive=join(p.backup.fileStoreArchiveRoot,p.backup.backupSetId+'.oa-archive'),stamp=await stat(archive),probe=await open(archive,'r'),prototype=Object.getPrototypeOf(probe) as FileHandle,read=prototype.read;await probe.close();let delayed=false,calls=0;
 const spy=vi.spyOn(prototype,'read').mockImplementation((async function(this:FileHandle,...args:unknown[]){
  const result=await Reflect.apply(read,this,args),s=await this.stat();if(!delayed&&s.dev===stamp.dev&&s.ino===stamp.ino){delayed=true;await new Promise(done=>setTimeout(done,3300));}return result;
 }) as typeof prototype.read);
 const connect=pg.Client.prototype.connect,dbSpy=vi.spyOn(pg.Client.prototype,'connect').mockImplementation((function(this:pg.Client,...args:unknown[]){calls++;return Reflect.apply(connect,this,args);}) as typeof pg.Client.prototype.connect);
 try{await expect(restoreProject(p,review(p),signal())).rejects.toThrow('RESTORE_CANCELLED_OR_TIMEOUT_RECONCILIATION_REQUIRED');expect(delayed).toBe(true);expect(calls).toBe(0);expect(await readdir(p.fileRestore.parent)).not.toContain(p.fileRestore.restoreId);expect((await readdir(p.backup.fileStoreArchiveRoot)).some(name=>name.startsWith('.restore-'))).toBe(false);}
 finally{spy.mockRestore();dbSpy.mockRestore();}
});
it('cancel after a real target connection but before pg_restore leaves an empty quarantined target and keeps sealed recovery files',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),p=await profile(target),controller=new AbortController(),connect=pg.Client.prototype.connect;let calls=0;
 const spy=vi.spyOn(pg.Client.prototype,'connect').mockImplementation((async function(this:pg.Client,...args:unknown[]){const result=await Reflect.apply(connect,this,args);calls++;controller.abort();return result;}) as typeof pg.Client.prototype.connect);
 try{await expect(restoreProject(p,review(p),controller.signal)).rejects.toThrow('RESTORE_CANCELLED_OR_TIMEOUT_RECONCILIATION_REQUIRED');expect(calls).toBe(1);}
 finally{spy.mockRestore();}
 expect((await target.root.query("SELECT to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
 expect(await new EncryptedFileStore(join(p.fileRestore.parent,p.fileRestore.restoreId),vault).get(fileKey)).toEqual(body);
 expect((await readdir(p.backup.postgresArchiveRoot)).some(name=>name.startsWith('.restore-'))).toBe(false);
},60000);
