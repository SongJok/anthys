import '../support/isolation.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,readFile,readdir,rm,stat,open,lstat,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {historicalMigrationDatabase} from '../support/historical-migration-database.js';
import {Database} from '../../packages/storage/src/database.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {createPostgresFileBackup,type CreatePostgresFileBackupInput} from '../../packages/operations/src/project-backup-driver.js';
import {restoreAuthenticatedPostgres} from '../../packages/operations/src/postgres-authenticated-restore.js';
import {restoreFileStoreSnapshot} from '../../packages/operations/src/filestore-snapshot.js';
import {projectBackupSchemaPrefix} from '../../packages/operations/src/project-backup-profile.js';
import {capturePostgresInventory} from '../../packages/operations/src/postgres-inventory.js';
import type {PostgresBackupConnection} from '../../packages/operations/src/postgres-backup-snapshot.js';

const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),signal=()=>new AbortController().signal;
const limits={maxTables:512,maxRows:100000,maxBytes:32*1024*1024,timeoutMs:30000},key=randomBytes(32),vault=new Vault(new Map([['synthetic-v1',randomBytes(32)]]),'synthetic-v1'),body=Buffer.from('SYNTHETIC_PRIVATE_BACKUP_CONTENT 不得输出');
let own:Awaited<ReturnType<typeof historicalMigrationDatabase>>,directory:string,system:string,pins:{pg_dump:CreatePostgresFileBackupInput['pgDump'];pg_restore:CreatePostgresFileBackupInput['pgRestore']},first:Awaited<ReturnType<typeof createPostgresFileBackup>>,initial:CreatePostgresFileBackupInput,action:string,trial:unknown;
const fileKey=`${randomUUID()}/${randomUUID()}/${randomUUID()}/${randomUUID()}.sealed`;
function connection(url:string):PostgresBackupConnection{const u=new URL(url);expect(u.hostname).toBe('127.0.0.1');expect(u.port).toBe('53331');expect(u.pathname).toMatch(/^\/open_aider_test_group_reminder_[a-f0-9]{32}$/);return {host:'127.0.0.1',port:53331,database:u.pathname.slice(1),user:'oa_migrator',password:decodeURIComponent(u.password),ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off'};}
function options(patch:Partial<CreatePostgresFileBackupInput>={}):CreatePostgresFileBackupInput{return {...initial,backupSetId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),signal:signal(),...patch};}
const capture=()=>capturePostgresInventory({connection:initial.connection,expectedDatabase:own.name,expectedSystemIdentifierSha256:hash(system),expectedSchemaFingerprint:projectBackupSchemaPrefix(73),limits,signal:signal()});
beforeAll(async()=>{
 pins=JSON.parse(await readFile('.data/test-environment/pg17-client.json','utf8')).pins;for(const name of ['pg_dump','pg_restore'] as const){expect(pins[name].version).toBe(name+' (PostgreSQL) 17.11');expect(hash(await readFile(pins[name].path))).toBe(pins[name].sha256);}
 own=await historicalMigrationDatabase(73);system=(await own.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value;
 directory=await realpath(await mkdtemp(join(await realpath('/tmp'),'oa-native-backup-test-')));for(const name of ['postgres','filestore','source','restored'])await mkdir(join(directory,name),{mode:0o700});await new EncryptedFileStore(join(directory,'source'),vault).put(fileKey,body);
 const tenant=randomUUID(),actor=randomUUID();await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC','ACTIVE')",[tenant]);await own.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC','ACTIVE')",[tenant,actor]);
 const u=new URL(process.env['RUNTIME_DATABASE_URL']!);u.pathname='/'+own.name;const runtime=new Database(u.href);let task:Awaited<ReturnType<TaskStore['create']>>;try{task=await new TaskStore(runtime).create({tenantId:tenant,actorId:actor},'SYNTHETIC unknown backup task',randomUUID());}finally{await runtime.close();}
 action=randomUUID();await own.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version) VALUES($1,$2,$3,$4,$5,$6,'UNKNOWN','SYNTHETIC','1.0.0')",[tenant,action,actor,task.runId,randomUUID(),hash('SYNTHETIC_UNKNOWN')]);
 await own.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,closed_at,close_reason) VALUES($1,$2,$3,$4,$1::uuid::text,$2::uuid::text,'SYNTHETIC','SYNTHETIC',clock_timestamp()-interval '1 hour','CLOSED',clock_timestamp(),'SYNTHETIC PERMANENT CLOSED')",[tenant,actor,hash('SYNTHETIC_CLOSED'),hash('SYNTHETIC_BUDGET')]);trial=(await own.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t')).rows;
 await own.root.query('CREATE TABLE public.backup_native_probe(id int,body bytea); ALTER TABLE public.backup_native_probe ENABLE ROW LEVEL SECURITY; ALTER TABLE public.backup_native_probe FORCE ROW LEVEL SECURITY; CREATE POLICY probe_deny ON public.backup_native_probe USING(false); REVOKE ALL ON public.backup_native_probe FROM PUBLIC; CREATE SEQUENCE public.backup_native_seq');await own.root.query('INSERT INTO public.backup_native_probe VALUES(1,$1)',[body]);await own.root.query("SELECT setval('public.backup_native_seq',345,true)");
 initial={connection:connection(own.connectionString),expectedDatabase:own.name,expectedSystemIdentifierSha256:hash(system),expectedMigrationCount:73,expectedSchemaFingerprint:projectBackupSchemaPrefix(73),expiresAt:new Date(Date.now()+60000).toISOString(),maxDurationMs:60000,signal:signal(),backupSetId:randomUUID(),profileHash:hash('SYNTHETIC_REVIEW'),keyId:'synthetic-separate-backup-key',key,pgDump:pins.pg_dump,pgRestore:pins.pg_restore,postgresArchiveRoot:join(directory,'postgres'),maxPostgresArchiveBytes:16*1024*1024,inventoryLimits:limits,fileStore:{sourceRoot:join(directory,'source'),archiveRoot:join(directory,'filestore'),maxFiles:10,maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024},expectedFileStoreRootHash:hash(join(directory,'source'))};
 first=await createPostgresFileBackup(initial);
},60000);
afterAll(async()=>{await own?.close();if(directory)await rm(directory,{recursive:true,force:true});key.fill(0);},60000);
function restoreOptions(target:Awaited<ReturnType<typeof own.createOwnEmptyRestoreTarget>>){return {archive:{root:initial.postgresArchiveRoot,backupId:initial.backupSetId,key,maxBytes:initial.maxPostgresArchiveBytes,signal:signal(),expectedMetadata:first.receipt.postgres.metadata},expectedArchiveReceipt:first.receipt.postgres,connection:connection(target.connectionString),expectedDatabaseOid:target.databaseOid,expectedSystemIdentifierSha256:hash(system),before:first.receipt.inventory,pgRestore:pins.pg_restore,limits,expiresAt:new Date(Date.now()+60000).toISOString(),maxDurationMs:60000,signal:signal()};}
it('actual native child + held snapshot + two encrypted archives + fsynced set receipt preserve the historical source without disclosure or dispatch',async()=>{
 expect(first.receipt).toMatchObject({kind:'POSTGRES_FILESTORE_BACKUP_SET',sourceStable:{status:'MATCH'},maintenanceIndependentlyVerified:false,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true});expect(hash(await readFile(first.receiptPath))).toBe(first.receiptSha256);expect((await stat(first.receiptPath)).mode&0o777).toBe(0o600);expect(JSON.stringify(first)).not.toContain(body.toString());expect(JSON.stringify(first)).not.toContain(initial.connection.password);expect(first.receipt.postgres.plaintext.byteSize).toBeGreaterThan(5);expect(first.receipt.fileStore.manifest.files).toHaveLength(1);expect((await capture()).contentFingerprint).toBe(first.receipt.inventory.contentFingerprint);expect((await own.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t')).rows).toEqual(trial);expect((await own.root.query('SELECT state FROM tool_actions WHERE id=$1',[action])).rows[0].state).toBe('UNKNOWN');
});
it('full archive authentication then actual native restore into a new empty nonce yields complete schema/ACL/RLS/data/sequence and sealed FileStore matches',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),result=await restoreAuthenticatedPostgres(restoreOptions(target));
 expect(result).toMatchObject({status:'RESTORED_INVENTORY_MATCH',comparison:{status:'MATCH',schemaMatches:true,metadataMatches:true,dataMatches:true,sequencesMatch:true},externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true,independentClusterRecoveryVerified:false});expect(result.inventory.database).toBe(target.name);expect(result.inventory.database).not.toBe(own.name);expect((await target.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t')).rows).toEqual(trial);expect((await target.root.query('SELECT state FROM tool_actions WHERE id=$1',[action])).rows[0].state).toBe('UNKNOWN');
 const lease=await restoreFileStoreSnapshot({...initial.fileStore,backupId:initial.backupSetId,keyId:initial.keyId,key,schemaFingerprint:initial.expectedSchemaFingerprint,signal:signal(),restoreParent:join(directory,'restored'),restoreId:randomUUID()});try{expect(await new EncryptedFileStore(lease.root,vault).get(fileKey)).toEqual(body);expect(lease.receipt).toEqual(first.receipt.fileStore);}finally{await lease.cleanup();}
 await expect(restoreAuthenticatedPostgres(restoreOptions(target))).rejects.toThrow('RESTORE_TARGET_NOT_EMPTY_OR_EXCLUSIVE');expect((await target.root.query('SELECT state FROM tool_actions WHERE id=$1',[action])).rows[0].state).toBe('UNKNOWN');
},60000);
it('a wrong archive key authenticates nothing and performs zero target connections',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),o=restoreOptions(target),original=pg.Client.prototype.connect;let targetConnections=0;const spy=vi.spyOn(pg.Client.prototype,'connect').mockImplementation((function(this:pg.Client,...args:unknown[]){if((this as unknown as {connectionParameters:{database:string}}).connectionParameters.database===target.name)targetConnections++;return Reflect.apply(original,this,args);}) as typeof pg.Client.prototype.connect);try{await expect(restoreAuthenticatedPostgres({...o,archive:{...o.archive,key:randomBytes(32)}})).rejects.toThrow('RESTORE_FAILED');expect(targetConnections).toBe(0);}finally{spy.mockRestore();}expect((await target.root.query("SELECT to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();expect((await readdir(initial.postgresArchiveRoot)).some(name=>name.startsWith('.oa-plaintext-'))).toBe(false);
});
it('wrong target OID preserves the independently created empty database with no restore or automatic drop',async()=>{
 const target=await own.createOwnEmptyRestoreTarget();await expect(restoreAuthenticatedPostgres({...restoreOptions(target),expectedDatabaseOid:'0'})).rejects.toThrow('RESTORE_TARGET_IDENTITY_REJECTED');expect((await target.root.query("SELECT to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
});
it('duplicate backup ID cannot replace either archive or the successful set receipt',async()=>{
 const archive=await readFile(join(initial.postgresArchiveRoot,initial.backupSetId+'.oa-archive'));await expect(createPostgresFileBackup({...initial,expiresAt:new Date(Date.now()+60000).toISOString()})).rejects.toThrow('BACKUP_FAILED');expect(await readFile(join(initial.postgresArchiveRoot,initial.backupSetId+'.oa-archive'))).toEqual(archive);expect(hash(await readFile(first.receiptPath))).toBe(first.receiptSha256);
},60000);
it('actual dump output limit kills/reaps the direct producer and publishes no complete set',async()=>{
 const o=options({maxPostgresArchiveBytes:1});await expect(createPostgresFileBackup(o)).rejects.toThrow('BACKUP_FAILED');expect(await readdir(initial.postgresArchiveRoot)).not.toContain(o.backupSetId+'.backup-set.json');expect(await readdir(initial.postgresArchiveRoot)).not.toContain(o.backupSetId+'.oa-archive');expect((await own.root.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name IN ('open_aider_backup_snapshot','open_aider_bounded_backup_child')",[own.name])).rows[0].n).toBe('0');
},60000);
it('pre-cancel and expired review window write no archive or set receipt',async()=>{
 const a=new AbortController();a.abort();for(const change of [{signal:a.signal},{expiresAt:'2000-01-01T00:00:00.000Z'}]){const o=options(change);await expect(createPostgresFileBackup(o)).rejects.toThrow(/BACKUP_CANCELLED|BACKUP_WINDOW_CLOSED/);expect(await readdir(initial.postgresArchiveRoot)).not.toContain(o.backupSetId+'.backup-set.json');}
});
it('explicit inventory connection and hashed cluster pin ignore hostile inherited PG options and preserve generic URL compatibility',async()=>{
 const keys=['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLNEGOTIATION','PGOPTIONS','PGCLIENTENCODING','PGREPLICATION'] as const;
 for(const key of keys)vi.stubEnv(key,key==='PGSSLNEGOTIATION'?'direct':key==='PGSSLMODE'?'verify-full':'SYNTHETIC_INVALID');try{expect((await capture()).contentFingerprint).toBe(first.receipt.inventory.contentFingerprint);}finally{vi.unstubAllEnvs();}
 expect((await capturePostgresInventory({connectionString:own.connectionString,expectedDatabase:own.name,expectedSystemIdentifier:system,expectedSchemaFingerprint:initial.expectedSchemaFingerprint,limits,signal:signal()})).contentFingerprint).toBe(first.receipt.inventory.contentFingerprint);
});

it('database names that libpq could interpret as conninfo are refused before archive authentication or any target connection',async()=>{
 const target=await own.createOwnEmptyRestoreTarget(),o=restoreOptions(target),connect=pg.Client.prototype.connect;let calls=0;const spy=vi.spyOn(pg.Client.prototype,'connect').mockImplementation((function(this:pg.Client,...args:unknown[]){calls++;return Reflect.apply(connect,this,args);}) as typeof pg.Client.prototype.connect);
 try{for(const database of ['dbname=other host=synthetic.invalid','postgresql://synthetic.invalid/other','bad/name','other\n','a'.repeat(64)])await expect(restoreAuthenticatedPostgres({...o,connection:{...o.connection,database}})).rejects.toThrow('RESTORE_OPTIONS_REJECTED');expect(calls).toBe(0);}
 finally{spy.mockRestore();}
});

it('cancellation after the actual set-marker directory fsync removes only its uncommitted marker and waits for all archive work',async()=>{
 const controller=new AbortController(),o=options({signal:controller.signal}),path=join(o.postgresArchiveRoot,o.backupSetId+'.backup-set.json'),probe=await open(o.postgresArchiveRoot,'r'),stamp=await probe.stat(),prototype=Object.getPrototypeOf(probe) as FileHandle,original=prototype.sync;await probe.close();let observed=0;
 const spy=vi.spyOn(prototype,'sync').mockImplementation(async function(this:FileHandle){await Reflect.apply(original,this,[]);const actual=await this.stat();if(actual.isDirectory()&&actual.ino===stamp.ino&&actual.dev===stamp.dev&&await lstat(path).then(()=>true,()=>false)){observed++;controller.abort();}});
 try{await expect(createPostgresFileBackup(o)).rejects.toThrow('BACKUP_CANCELLED_OR_TIMEOUT');expect(observed).toBe(1);expect(await readdir(o.postgresArchiveRoot)).not.toContain(o.backupSetId+'.backup-set.json');
  // Completed encrypted artifacts are quarantined, not auto-deleted/reused.
  expect(await readdir(o.postgresArchiveRoot)).toContain(o.backupSetId+'.oa-archive');expect(await readdir(o.fileStore.archiveRoot)).toContain(o.backupSetId+'.oa-archive');
 }finally{spy.mockRestore();}
},60000);
