import '../support/isolation.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {historicalMigrationDatabase} from '../support/historical-migration-database.js';
import {independentPostgresCluster} from '../support/independent-postgres-cluster.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {createPostgresFileBackup} from '../../packages/operations/src/project-backup-driver.js';
import {planProjectRestore,type ProjectRestoreProfile} from '../../packages/operations/src/project-restore.js';
import {projectBackupSchemaPrefix} from '../../packages/operations/src/project-backup-profile.js';
import {comparePostgresInventories} from '../../packages/operations/src/postgres-inventory.js';
import type {PostgresBackupConnection} from '../../packages/operations/src/postgres-backup-snapshot.js';

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
it('T124 independent PG system: original source destruction, actual production CLI restoration and separate synthetic application-key recovery preserve contents and safety states',async()=>{
 const own=await historicalMigrationDatabase(73),archiveKey=randomBytes(32),applicationKey=randomBytes(32),vault=new Vault(new Map([['synthetic-v1',applicationKey]]),'synthetic-v1');
 let directory:string|undefined,target:Awaited<ReturnType<typeof independentPostgresCluster>>|undefined;
 try{
  directory=await realpath(await mkdtemp(join(await realpath('/tmp'),'oa-independent-restore-')));
  for(const name of ['postgres','filestore','source'])await mkdir(join(directory,name),{mode:0o700});
  const body=Buffer.from('SYNTHETIC_INDEPENDENT_RESTORED_CONTENT_'+randomUUID()),fileKey=`${randomUUID()}/${randomUUID()}/${randomUUID()}/${randomUUID()}.sealed`;
  await new EncryptedFileStore(join(directory,'source'),vault).put(fileKey,body);
  const tenant=randomUUID(),owner=randomUUID(),task=randomUUID(),run=randomUUID(),action=randomUUID(),identity=randomUUID(),credential=randomUUID(),credentialAad='SYNTHETIC_AAD_'+randomUUID(),credentialBody='SYNTHETIC_CREDENTIAL_'+randomUUID();
  await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_INDEPENDENT_RESTORE','ACTIVE')",[tenant]);
  await own.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC_INDEPENDENT_RESTORE','ACTIVE')",[tenant,owner]);
  await own.root.query("INSERT INTO identities(tenant_id,id,owner_id,kind,provider,external_subject,status) VALUES($1,$2,$3,'HUMAN','SYNTHETIC_RESTORE',$2::uuid::text,'ACTIVE')",[tenant,identity,owner]);
  await own.root.query("INSERT INTO credentials(tenant_id,id,owner_id,identity_id,ciphertext,key_version) VALUES($1,$2,$3,$4,$5,'synthetic-v1')",[tenant,credential,owner,identity,JSON.stringify(vault.seal(credentialBody,credentialAad))]);
  await own.root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'SYNTHETIC_CLOSED_RESTORE','CANCELLED','{}',1,clock_timestamp()+interval '1 day')",[tenant,task,owner]);
  await own.root.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'CANCELLED','{}')",[tenant,run,task,owner]);
  await own.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version) VALUES($1,$2,$3,$4,$2::uuid::text,$5,'UNKNOWN','SYNTHETIC_RESTORE','1.0.0')",[tenant,action,owner,run,hash('SYNTHETIC_UNKNOWN')]);
  await own.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,closed_at,close_reason) VALUES($1,$2,$3,$4,$1::uuid::text,$2::uuid::text,'SYNTHETIC_ROBOT','SYNTHETIC_CONVERSATION',clock_timestamp()+interval '1 day','CLOSED',clock_timestamp(),'SYNTHETIC_PRE_BACKUP_CLOSED')",[tenant,owner,hash('SYNTHETIC_RESTORE_TRIAL'),hash('SYNTHETIC_RESTORE_BUDGET')]);
  const system=(await own.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value as string,url=new URL(own.connectionString);
  const connection:PostgresBackupConnection={host:'127.0.0.1',port:53331,database:own.name,user:'oa_migrator',password:decodeURIComponent(url.password),ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off'};
  const limits={maxTables:512,maxRows:100000,maxBytes:32*1024*1024,timeoutMs:30000},pins=JSON.parse(await readFile('.data/test-environment/pg17-client.json','utf8')).pins,backupSetId=randomUUID(),backupProfileHash=hash('SYNTHETIC_INDEPENDENT_BACKUP');
  const backup=await createPostgresFileBackup({connection,expectedDatabase:own.name,expectedSystemIdentifierSha256:hash(system),expectedMigrationCount:73,expectedSchemaFingerprint:projectBackupSchemaPrefix(73),expiresAt:new Date(Date.now()+60000).toISOString(),maxDurationMs:60000,signal:new AbortController().signal,backupSetId,profileHash:backupProfileHash,keyId:'synthetic-separate-key',key:archiveKey,pgDump:pins.pg_dump,pgRestore:pins.pg_restore,postgresArchiveRoot:join(directory,'postgres'),maxPostgresArchiveBytes:16*1024*1024,inventoryLimits:limits,fileStore:{sourceRoot:join(directory,'source'),archiveRoot:join(directory,'filestore'),maxFiles:10,maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024},expectedFileStoreRootHash:hash(join(directory,'source'))});
  expect((await own.destroyOwnSource()).state).toBe('DESTROYED');await rm(join(directory,'source'),{recursive:true});await expect(stat(join(directory,'source'))).rejects.toMatchObject({code:'ENOENT'});
  target=await independentPostgresCluster(directory);expect(target.system).not.toBe(system);
  await target.stage('private/archive-key',archiveKey);await target.stage('private/application-key',applicationKey);await target.stage('private/connection',Buffer.from(target.connectionString));
  for(const [root,type] of [['postgres','postgres'],['filestore','filestore']] as const){const file=backupSetId+'.oa-archive';await target.stage(type+'/'+file,await readFile(join(directory,root,file)));}
  const receipt=await readFile(backup.receiptPath);await target.stage('postgres/'+backupSetId+'.backup-set.json',receipt);
  const restoreId=randomUUID(),profile:ProjectRestoreProfile={schemaVersion:1,kind:'BOUNDED_PROJECT_RESTORE',reviewReference:'SYNTHETIC_INDEPENDENT_RESTORE_REVIEW',repositoryContractFingerprint:requiredSchema.contractHash,backup:{backupSetId,receiptFile:'/oa/postgres/'+backupSetId+'.backup-set.json',receiptSha256:backup.receiptSha256,profileHash:backupProfileHash,sourceDatabase:own.name,sourceSystemIdentifierSha256:hash(system),migrationCount:73,schemaFingerprint:projectBackupSchemaPrefix(73),postgresArchiveRoot:'/oa/postgres',fileStoreArchiveRoot:'/oa/filestore',maxPostgresArchiveBytes:16*1024*1024,fileStore:{sourceRoot:join(directory,'source'),maxFiles:10,maxFileBytes:1024*1024,maxTotalBytes:4*1024*1024}},key:{id:'synthetic-separate-key',file:'/oa/private/archive-key',fileSha256:hash(archiveKey)},target:{host:'127.0.0.1',port:53331,database:target.database,role:'oa_migrator',databaseOid:target.databaseOid,systemIdentifierSha256:hash(target.system),connectionFile:'/oa/private/connection',connectionFileSha256:hash(target.connectionString)},pgRestore:target.pgRestore,fileRestore:{parent:'/oa/restored',restoreId},inventoryLimits:limits,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+600000).toISOString(),maxDurationMs:60000,maintenance:{targetExclusiveControlReference:'SYNTHETIC_NETWORK_NONE_TARGET',sourceStopReference:'SYNTHETIC_SOURCE_ACTUALLY_DESTROYED',keyRecoveryReference:'SYNTHETIC_SEPARATE_APPLICATION_KEY',externalStateReconciliationReference:'SYNTHETIC_NOT_RECONCILED'}};
  await target.stage('private/profile.json',Buffer.from(JSON.stringify(profile)));
  const result=target.runNode('restore.mjs',['restore','--profile','/oa/private/profile.json','--expect-profile-hash',planProjectRestore(profile).profileHash,'--review-reference',profile.reviewReference]);
  expect(result.code).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toMatchObject({status:'RESTORED_SET_RECONCILIATION_REQUIRED',sourceAndTargetClustersDiffer:true,postgresContentFingerprint:backup.receipt.inventory.contentFingerprint,applicationKeyRecoveryVerified:false,externalDispatchResumeAuthorized:false,servicesStarted:false});
  for(const privateText of [body.toString(),credentialBody,own.connectionString,target.connectionString,tenant,owner])expect(result.stdout).not.toContain(privateText);
  expect(JSON.parse(target.sql("SELECT json_build_object('trials',(SELECT json_agg(state) FROM one_shot_trials),'actions',(SELECT json_agg(state) FROM tool_actions),'runs',(SELECT json_agg(status) FROM runs),'count',(SELECT count(*) FROM tenants));"))).toEqual({trials:['CLOSED'],actions:['UNKNOWN'],runs:['CANCELLED'],count:1});
  await target.stage('private/inventory-profile.json',Buffer.from(JSON.stringify({schemaVersion:1,kind:'POSTGRES_READ_ONLY_RESTORE_VERIFICATION',connectionFile:'/oa/private/connection',expectedDatabase:target.database,expectedSystemIdentifier:target.system,expectedSchemaFingerprint:projectBackupSchemaPrefix(73),limits})));
  const captured=target.runNode('verification.mjs',['capture','--profile','/oa/private/inventory-profile.json','--output','/oa/private/inventory.json']);expect(captured.code).toBe(0);
  const after=JSON.parse(target.read('private/inventory.json').toString('utf8'));expect(after.systemIdentifier).not.toBe(backup.receipt.inventory.systemIdentifier);expect(comparePostgresInventories(backup.receipt.inventory,after)).toMatchObject({status:'MATCH',schemaMatches:true,metadataMatches:true,dataMatches:true,sequencesMatch:true,externalDispatchResumeAuthorized:false});
  const probeProfile={keyFile:'/oa/private/application-key',keyVersion:'synthetic-v1',root:'/oa/restored/'+restoreId,fileKey,expectedSha256:hash(body),connectionFile:'/oa/private/connection',credentialId:credential,credentialAad,credentialSha256:hash(credentialBody)};
  await target.stage('private/probe-profile.json',Buffer.from(JSON.stringify(probeProfile)));
  const probe=target.runNode('probe.mjs',['/oa/private/probe-profile.json']);expect(probe.code).toBe(0);expect(JSON.parse(probe.stdout)).toMatchObject({status:'SYNTHETIC_APPLICATION_KEY_RECOVERY_VERIFIED',contentSha256:hash(body),credentialSha256:hash(credentialBody),servicesStarted:false,externalDispatchResumeAuthorized:false});
  await target.stage('private/wrong-key',randomBytes(32));await target.stage('private/wrong-key-probe.json',Buffer.from(JSON.stringify({...probeProfile,keyFile:'/oa/private/wrong-key'})));
  const rejectedKey=target.runNode('probe.mjs',['/oa/private/wrong-key-probe.json']);expect(rejectedKey.code).toBe(1);expect(rejectedKey.stderr).toBe('');expect(JSON.parse(rejectedKey.stdout).status).toBe('SYNTHETIC_APPLICATION_KEY_REJECTED');
  const repeated=target.runNode('restore.mjs',['restore','--profile','/oa/private/profile.json','--expect-profile-hash',planProjectRestore(profile).profileHash,'--review-reference',profile.reviewReference]);expect(repeated.code).toBe(1);expect(JSON.parse(repeated.stdout)).toMatchObject({status:'REJECTED_OR_QUARANTINED_RECONCILIATION_REQUIRED',code:'RESTORE_FAILED_FILESTORE_RECONCILIATION_REQUIRED',automaticRetry:false,servicesStarted:false});
  const recaptured=target.runNode('verification.mjs',['capture','--profile','/oa/private/inventory-profile.json','--output','/oa/private/after-repeat.json']);expect(recaptured.code).toBe(0);expect(comparePostgresInventories(after,JSON.parse(target.read('private/after-repeat.json').toString('utf8'))).status).toBe('MATCH');
  const confirmedCleanup=await target.close();expect(confirmedCleanup).toEqual({state:'DESTROYED',confirmedAbsent:true});
  await mkdir('reports/independent-cluster-restore-20261020',{recursive:true});await writeFile('reports/independent-cluster-restore-20261020/actual-path.json',JSON.stringify({sourceAndTargetSystemIdentifiersDiffer:true,originalSourceDatabaseDestroyed:true,originalFileRootDestroyed:true,productionRestoreCommand:JSON.parse(result.stdout),comparison:comparePostgresInventories(backup.receipt.inventory,after),syntheticApplicationKeyRecovery:JSON.parse(probe.stdout),wrongKeyRejected:true,repeatRestoreRejected:true,fixture:target.evidence,cleanup:confirmedCleanup,realOperationsPerformed:false,phaseOneComplete:false},null,2)+'\n');
 }finally{
  const cleanup=await Promise.allSettled([target?.close(),own.close()]);
  try{if(directory)await rm(directory,{recursive:true,force:true});}finally{archiveKey.fill(0);applicationKey.fill(0);}
  if(cleanup.some(result=>result.status==='rejected'))throw Error('INDEPENDENT_FIXTURE_CLEANUP_UNCONFIRMED');
 }
},120000);
