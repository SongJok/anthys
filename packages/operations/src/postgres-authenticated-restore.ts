import pg from 'pg';
import {createHash} from 'node:crypto';
import {openPrivateArchive,type OpenPrivateArchiveInput,type ArchiveReceipt} from './archive.js';
import {createProcessReadable} from './process-stream.js';
import {verifyBackupExecutable,type BackupExecutablePin} from './project-backup-toolchain.js';
import {postgresBackupEnvironment} from './project-backup-driver.js';
import {capturePostgresInventory,comparePostgresInventories,validatePostgresInventory,type PostgresInventory,type InventoryLimits} from './postgres-inventory.js';
import type {PostgresBackupConnection} from './postgres-backup-snapshot.js';

class RestoreError extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new RestoreError(code);};
/** Internal operation for an independently provisioned empty target. It never
 * creates or cleans a database, changes global roles, resumes services, or
 * retries pg_restore. A failed/in-flight target must remain quarantined.
 * Complete archive authentication precedes every target database connection.
 * OID/system/database pins and no live sessions are checks, not a write fence;
 * target exclusive administrative control must be maintained independently. */
export async function restoreAuthenticatedPostgres(input:{archive:OpenPrivateArchiveInput;expectedArchiveReceipt:ArchiveReceipt;connection:PostgresBackupConnection;expectedDatabaseOid:string;expectedSystemIdentifierSha256:string;before:PostgresInventory;pgRestore:BackupExecutablePin;limits:InventoryLimits;expiresAt:string;maxDurationMs:number;signal:AbortSignal}){
 const before=validatePostgresInventory(input.before),p=input.connection,left=Math.min(input.maxDurationMs,Date.parse(input.expiresAt)-Date.now());
 if(input.signal.aborted)fail('RESTORE_CANCELLED');
 if(!Number.isFinite(left)||left<1000||left>600000||!p||p.host!=='127.0.0.1'||!Number.isSafeInteger(p.port)||p.port<1||p.port>65535||!/^[a-z][a-z0-9_]{0,62}$/.test(p.database??'')||p.database===before.database||p.database==='anthys'||p.database==='anthys_test'||p.database==='postgres'||!/^\d{1,10}$/.test(input.expectedDatabaseOid)||!/^[a-f0-9]{64}$/.test(input.expectedSystemIdentifierSha256)||p.user!=='oa_migrator'||typeof p.password!=='string'||!p.password||p.connectionString!==undefined||p.ssl!==false||p.sslnegotiation!=='postgres'||p.client_encoding!=='UTF8'||p.replication!=='false'||p.binary!==false||p.options!=='-c row_security=off'||input.archive.expectedMetadata.type!=='POSTGRES_DUMP'||input.archive.expectedMetadata.sourceSchemaFingerprint!==before.schemaFingerprint)fail('RESTORE_OPTIONS_REJECTED');
 const controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]),deadline=performance.now()+left,timer=setTimeout(()=>controller.abort(),left);timer.unref();
 const remaining=()=>{if(signal.aborted)fail('RESTORE_CANCELLED_OR_TIMEOUT');const n=Math.floor(Math.min(deadline-performance.now(),Date.parse(input.expiresAt)-Date.now()));if(n<1)fail('RESTORE_WINDOW_CLOSED');return n;};
 let plaintext:Awaited<ReturnType<typeof openPrivateArchive>>|undefined,child:ReturnType<typeof createProcessReadable>|undefined;
 try{
  plaintext=await openPrivateArchive({...input.archive,signal});remaining();if(JSON.stringify(plaintext.receipt)!==JSON.stringify(input.expectedArchiveReceipt))fail('RESTORE_ARCHIVE_RECEIPT_MISMATCH');
  await verifyBackupExecutable(input.pgRestore,signal,Math.min(10000,remaining()));remaining();
  const config={host:p.host,port:p.port,database:p.database,user:p.user,password:p.password,ssl:false,sslnegotiation:'postgres' as const,client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off',connectionTimeoutMillis:Math.min(3000,remaining()),query_timeout:remaining(),application_name:'anthys_empty_restore_check'},c=new pg.Client(config);
  const abort=()=>{void c.end().catch(()=>{});};c.on('error',()=>controller.abort());signal.addEventListener('abort',abort,{once:true});
  try{
   remaining();await c.connect();await c.query('BEGIN READ ONLY');
   const identity=(await c.query("SELECT current_database() database,current_user role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) oid,(SELECT system_identifier::text FROM pg_control_system()) system,current_setting('server_version_num')::int version,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) bypass")).rows[0];
   if(identity.database!==p.database||identity.role!=='oa_migrator'||identity.oid!==input.expectedDatabaseOid||createHash('sha256').update(identity.system).digest('hex')!==input.expectedSystemIdentifierSha256||identity.version<170000||identity.version>=180000||identity.bypass!==true)fail('RESTORE_TARGET_IDENTITY_REJECTED');
   const empty=(await c.query("SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) empty")).rows[0];if(empty.empty!==true)fail('RESTORE_TARGET_NOT_EMPTY_OR_EXCLUSIVE');remaining();await c.query('ROLLBACK');
  }finally{signal.removeEventListener('abort',abort);await c.end().catch(()=>{});}
  child=createProcessReadable({file:input.pgRestore.path,args:['--no-password','--exit-on-error','--single-transaction','--dbname='+p.database,plaintext.plaintextPath],cwd:'/',env:postgresBackupEnvironment(p,remaining()),signal,timeoutMs:remaining(),maxStdoutBytes:4096,maxStderrBytes:65536});
  for await(const _chunk of child.stream){remaining();}await child.completion;remaining();
  const after=await capturePostgresInventory({connection:p,expectedDatabase:p.database,expectedSystemIdentifierSha256:input.expectedSystemIdentifierSha256,expectedSchemaFingerprint:before.schemaFingerprint,limits:{...input.limits,timeoutMs:Math.max(1000,Math.min(input.limits.timeoutMs,remaining()))},signal});
  const comparison=comparePostgresInventories(before,after);if(comparison.status!=='MATCH')fail('RESTORE_INVENTORY_DIFFERENT_'+(comparison.schemaMatches?'S1':'S0')+(comparison.metadataMatches?'M1':'M0')+(comparison.dataMatches?'D1':'D0')+(comparison.sequencesMatch?'Q1':'Q0'));remaining();
  return {status:'RESTORED_INVENTORY_MATCH' as const,archive:plaintext.receipt,inventory:after,comparison,externalDispatchResumeAuthorized:false as const,revocationAndExternalStateReconciliationRequired:true as const,independentClusterRecoveryVerified:false as const};
 }catch(error){const cancelled=signal.aborted;controller.abort();throw error instanceof RestoreError?error:new RestoreError(cancelled?'RESTORE_CANCELLED_OR_TIMEOUT':'RESTORE_FAILED');}
 finally{clearTimeout(timer);await child?.close().catch(()=>{});await plaintext?.cleanup();}
}
