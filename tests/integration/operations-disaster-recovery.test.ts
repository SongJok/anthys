import '../support/isolation.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,realpath,chmod,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {Database} from '../../packages/storage/src/database.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {secret} from '../../packages/config/src/index.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {capturePostgresInventory,comparePostgresInventories} from '../../packages/operations/src/postgres-inventory.js';
import {writePrivateArchive,openPrivateArchive,type PlaintextLease} from '../../packages/operations/src/archive.js';
import {snapshotFileStore,restoreFileStoreSnapshot,type RestoredFileStoreLease} from '../../packages/operations/src/filestore-snapshot.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
const signal=()=>new AbortController().signal,sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
it('T124 local joint drill destroys its original database and FileStore then restores protected tasks ACL artifact bytes CLOSED and UNKNOWN without dispatch',async()=>{
 const started=Date.now(),source=await groupReminderDatabase();let directory:string|undefined,plain:PlaintextLease|undefined,files:RestoredFileStoreLease|undefined,runtimeDb:Database|undefined,appDb:Database|undefined;
 const vaultKey=randomBytes(32),backupKey=randomBytes(32),vault=new Vault(new Map([['1',vaultKey]]),'1');
 try{
  await source.install();directory=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-joint-disaster-')));await chmod(directory,0o700);const sourceRoot=join(directory,'source-files'),archiveRoot=join(directory,'encrypted-backups'),restoreParent=join(directory,'verified-restores');for(const path of [sourceRoot,archiveRoot,restoreParent])await mkdir(path,{mode:0o700});
  const store=new RuntimeStore(source.db,vault),gateway=new Gateway(store),sessions=new Sessions(source.appDb,secret('SESSION_SECRET')!),world=await artifactWorld({isolated:source,store,gateway,sessions},'http://127.0.0.1:64702'),fileStore=new EncryptedFileStore(sourceRoot,vault),artifacts=new TaskResultArtifacts(source.db,vault,fileStore,gateway);
  const made=await artifacts.create(world.principal,world.taskId,{format:'txt',runId:world.runId},'SYNTHETIC_RECOVERY_ARTIFACT',signal()),artifact=made.artifact,key=(await source.root.query('SELECT storage_key FROM artifacts WHERE id=$1',[artifact.id])).rows[0].storage_key as string,original=await fileStore.get(key);expect(sha(original)).toBe(artifact.sha256);expect(original.toString()).toContain(world.value);
  // Distinct real local task records demonstrate that recovery does not turn an
  // unresolved action into a fresh attempt or reopen an unrelated CLOSED trial.
  const unresolved=await new TaskStore(source.db).create(world.ctx,'SYNTHETIC unresolved external action','SYNTHETIC_UNKNOWN_'+randomUUID()),actionId=randomUUID();
  await source.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version) VALUES($1,$2,$3,$4,$5,$6,'UNKNOWN','SYNTHETIC_RECOVERY','1.0.0')",[world.ctx.tenantId,actionId,world.ctx.actorId,unresolved.runId,randomUUID(),hash('SYNTHETIC_UNKNOWN')]);
  const closedCtx={tenantId:randomUUID(),actorId:randomUUID()};await source.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_CLOSED','ACTIVE')",[closedCtx.tenantId]);await source.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC_CLOSED','ACTIVE')",[closedCtx.tenantId,closedCtx.actorId]);const closedTask=await new TaskStore(source.db).create(closedCtx,'SYNTHETIC closed trial task','SYNTHETIC_CLOSED_'+randomUUID());
  await source.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,closed_at,close_reason) VALUES($1,$2,$3,$4,$1::uuid::text,$2::uuid::text,'SYNTHETIC_ROBOT','SYNTHETIC_CLOSED_DM',clock_timestamp()-interval '1 hour','CLOSED',clock_timestamp(),'SYNTHETIC_PERMANENT_CLOSURE')",[closedCtx.tenantId,closedCtx.actorId,hash('SYNTHETIC_CLOSED_SOURCE'),hash('SYNTHETIC_CLOSED_BUDGET')]);
  const system=(await source.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value as string,limits={maxTables:512,maxRows:100000,maxBytes:16*1024*1024,timeoutMs:60000},inventory=(connectionString:string,expectedDatabase:string)=>capturePostgresInventory({connectionString,expectedDatabase,expectedSystemIdentifier:system,expectedSchemaFingerprint:requiredSchema.contractHash,limits,signal:signal()}),before=await inventory(source.connectionString,source.name),pgBackupId=randomUUID(),fsBackupId=randomUUID(),pgMetadata={keyId:'SYNTHETIC_BACKUP_KEY',sourceSchemaFingerprint:requiredSchema.contractHash,type:'POSTGRES_DUMP' as const},dump=await source.dumpOwn();
  const pgReceipt=await writePrivateArchive({root:archiveRoot,backupId:pgBackupId,key:backupKey,maxBytes:16*1024*1024,signal:signal(),metadata:pgMetadata,input:Readable.from([dump])});expect(pgReceipt.plaintext.sha256).toBe(sha(dump));dump.fill(0);
  const fsOptions={sourceRoot,archiveRoot,backupId:fsBackupId,keyId:'SYNTHETIC_BACKUP_KEY',key:backupKey,schemaFingerprint:requiredSchema.contractHash,maxFiles:100,maxFileBytes:16*1024*1024,maxTotalBytes:32*1024*1024,signal:signal()},fsReceipt=await snapshotFileStore(fsOptions);expect(fsReceipt.manifest.files).toHaveLength(1);expect(fsReceipt.manifest.files[0]!.key).toBe(key);
  expect((await inventory(source.connectionString,source.name)).contentFingerprint).toBe(before.contentFingerprint);
  const destroyed=await source.destroyOwnSource();expect(destroyed.state).toBe('DESTROYED');await rm(sourceRoot,{recursive:true});await expect(stat(sourceRoot)).rejects.toMatchObject({code:'ENOENT'});await expect(source.dumpOwn()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');await expect(source.install()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');
  plain=await openPrivateArchive({root:archiveRoot,backupId:pgBackupId,key:backupKey,maxBytes:16*1024*1024,signal:signal(),expectedMetadata:pgMetadata});const verifiedDump=await readFile(plain.plaintextPath),restored=await source.restoreOwn(verifiedDump);verifiedDump.fill(0);await plain.cleanup();plain=undefined;
  expect((await restored.root.query('SELECT datname FROM pg_database WHERE datname=$1',[source.name])).rows).toEqual([]);files=await restoreFileStoreSnapshot({...fsOptions,restoreParent,restoreId:randomUUID(),signal:signal()});expect(files.receipt.manifest).toEqual(fsReceipt.manifest);expect(comparePostgresInventories(before,await inventory(restored.connectionString,restored.name))).toMatchObject({status:'MATCH',externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true});
  runtimeDb=new Database(restored.runtimeConnectionString);appDb=new Database(restored.appConnectionString);expect(await runtimeDb.ready()).toBe(true);expect(await appDb.ready()).toBe(true);
  const restoredSessions=new Sessions(appDb,secret('SESSION_SECRET')!),principal=(await restoredSessions.authenticate(world.owner.cookie))!,other=(await restoredSessions.authenticate(world.other.cookie))!,restoredStore=new RuntimeStore(runtimeDb,vault),restoredGateway=new Gateway(restoredStore);restoredGateway.register(world.cap);const restoredArtifacts=new TaskResultArtifacts(runtimeDb,vault,new EncryptedFileStore(files.root,vault),restoredGateway);
  expect((await restoredArtifacts.list(principal,world.taskId)).items.map(a=>a.id)).toEqual([artifact.id]);await expect(restoredArtifacts.list(other,world.taskId)).rejects.toMatchObject({code:'ARTIFACT_ACCESS_DENIED'});
  const ticket=await restoredArtifacts.ticket(principal,artifact.id),download=await restoredArtifacts.download(principal,artifact.id,ticket.ticket,signal());expect(download.bytes).toEqual(original);expect(sha(download.bytes)).toBe(artifact.sha256);await expect(restoredArtifacts.download(principal,artifact.id,ticket.ticket,signal())).rejects.toMatchObject({code:'ARTIFACT_TICKET_INVALID'});expect(world.calls()).toBe(1);
  expect((await restored.root.query('SELECT state FROM tool_actions WHERE id=$1',[actionId])).rows[0].state).toBe('UNKNOWN');expect((await restored.root.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[closedCtx.tenantId])).rows[0].state).toBe('CLOSED');expect((await runtimeDb.scope(closedCtx,c=>c.query('SELECT public.oa_lifecycle_run_allowed($1) allowed',[closedTask.runId]))).rows[0].allowed).toBe(false);expect(await restoredStore.acquire(closedCtx,closedTask.runId,randomUUID())).toBeNull();
  const replayState=async()=>({outbox:(await restored.root.query('SELECT row_to_json(o)::text value FROM outbox o ORDER BY id')).rows,deliveries:(await restored.root.query('SELECT row_to_json(d)::text value FROM deliveries d ORDER BY id')).rows,action:(await restored.root.query('SELECT row_to_json(a)::text value FROM tool_actions a WHERE id=$1',[actionId])).rows});
  const replayBefore=await replayState();expect(await restoredStore.acquire(closedCtx,closedTask.runId,randomUUID())).toBeNull();expect(await replayState()).toEqual(replayBefore);
  // No notifier, scheduler, model, DWS or physical sender is constructed by this
  // drill. Timing is recorded as a local observation, never production RPO/RTO.
  expect(Date.now()-started).toBeLessThan(120000);
 }finally{await plain?.cleanup();await files?.cleanup();await Promise.allSettled([runtimeDb?.close(),appDb?.close()]);await source.close();if(directory)await rm(directory,{recursive:true,force:true});vaultKey.fill(0);backupKey.fill(0);}
},120000);
