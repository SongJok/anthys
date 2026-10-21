import pg from 'pg';
import {createHash} from 'node:crypto';
import {requiredSchema} from '../../storage/src/schema.js';
import {projectBackupSchemaPrefix} from './project-backup-profile.js';

export type PostgresBackupConnection=pg.ClientConfig&{host:'127.0.0.1';port:number;database:string;user:'oa_migrator';ssl:false;sslnegotiation:'postgres';client_encoding:'UTF8';replication:'false';binary:false;options:'-c row_security=off'};
export type PostgresBackupSnapshotOptions={connection:PostgresBackupConnection;expectedDatabase:string;expectedSystemIdentifierSha256:string;expectedMigrationCount:number;expectedSchemaFingerprint:string;expiresAt:string;maxDurationMs:number;signal:AbortSignal};
class SnapshotError extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new SnapshotError(code);};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Internal readonly snapshot primitive, not an authorization boundary. The
 * production driver must first enforce the fixed project profile and review.
 * Explicit connection parameters also allow owned isolated fixture databases;
 * this module never creates, restores, migrates, or drops a database. */
export async function openPostgresBackupSnapshot(input:PostgresBackupSnapshotOptions){
 const p=input.connection;
 if(!p||p.host!=='127.0.0.1'||!Number.isSafeInteger(p.port)||p.port<1||p.port>65535||p.user!=='oa_migrator'||p.database!==input.expectedDatabase||!/^[a-z][a-z0-9_]{0,62}$/.test(p.database??'')||typeof p.password!=='string'||!p.password||p.connectionString!==undefined||p.ssl!==false||p.sslnegotiation!=='postgres'||p.client_encoding!=='UTF8'||p.replication!=='false'||p.binary!==false||p.options!=='-c row_security=off'||!Number.isSafeInteger(input.maxDurationMs)||input.maxDurationMs<1000||input.maxDurationMs>600000||!/^[a-f0-9]{64}$/.test(input.expectedSystemIdentifierSha256)||input.expectedSchemaFingerprint!==projectBackupSchemaPrefix(input.expectedMigrationCount)||!Number.isFinite(Date.parse(input.expiresAt)))fail('BACKUP_SNAPSHOT_OPTIONS_REJECTED');
 const left=Math.min(input.maxDurationMs,Date.parse(input.expiresAt)-Date.now());
 if(input.signal.aborted)fail('BACKUP_SNAPSHOT_CANCELLED');if(left<=0)fail('BACKUP_SNAPSHOT_WINDOW_CLOSED');
 const deadline=performance.now()+left,controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]);
 const connection={host:p.host,port:p.port,database:p.database,user:p.user,password:p.password,ssl:false,sslnegotiation:'postgres' as const,client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off',application_name:'anthys_backup_snapshot',query_timeout:left,connectionTimeoutMillis:Math.min(3000,left),statement_timeout:left,lock_timeout:1000,idle_in_transaction_session_timeout:left},client=new pg.Client(connection);
 let connected=false,transaction=false,closed=false,closing:Promise<void>|undefined;
 client.on('error',()=>controller.abort());
 const checkpoint=()=>{if(signal.aborted)fail('BACKUP_SNAPSHOT_CANCELLED_OR_TIMEOUT');if(performance.now()>=deadline||Date.now()>=Date.parse(input.expiresAt))fail('BACKUP_SNAPSHOT_WINDOW_CLOSED');};
 const timer=setTimeout(()=>controller.abort(),left);timer.unref();
 const abort=()=>{void client.end().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 const close=()=>closing??=(async()=>{
  try{if(connected&&transaction&&!signal.aborted){await client.query('ROLLBACK');transaction=false;}}
  finally{closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort);await client.end().catch(()=>{});}
 })();
 const identityAndLedger=async()=>{
  checkpoint();const r=(await client.query("SELECT current_database() database,current_user role,current_setting('server_version_num')::integer version,(SELECT system_identifier::text FROM pg_control_system()) system,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) global_visibility")).rows[0];
  if(r?.database!==input.expectedDatabase||r.role!=='oa_migrator'||!Number.isInteger(r.version)||r.version<170000||r.version>=180000||r.global_visibility!==true||hash(r.system)!==input.expectedSystemIdentifierSha256)fail('BACKUP_SNAPSHOT_IDENTITY_REJECTED');
  const rows=(await client.query<{name:string;hash:string}>('SELECT name,hash FROM public.schema_migrations ORDER BY name')).rows;
  if(rows.length!==input.expectedMigrationCount||rows.some((r,i)=>r.name!==requiredSchema.migrations[i]?.name||r.hash!==requiredSchema.migrations[i]?.hash))fail('BACKUP_SNAPSHOT_LEDGER_CHANGED');checkpoint();
 };
 const stopped=async()=>{
  // Statistics may otherwise be cached within the long readonly transaction.
  // This clears this session's observation cache, not application state.
  await client.query('SELECT pg_stat_clear_snapshot()');
  const r=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename IN ('oa_app','oa_runtime','oa_queue')) OR EXISTS(SELECT 1 FROM public.runs WHERE status IN ('RUNNING','WAITING_EXTERNAL')) OR EXISTS(SELECT 1 FROM public.tool_actions WHERE state='EXECUTING') OR EXISTS(SELECT 1 FROM public.deliveries WHERE state='SENDING') busy")).rows[0];
  if(r?.busy!==false)fail('BACKUP_SNAPSHOT_DISPATCHERS_OR_IN_FLIGHT');checkpoint();
 };
 try{
  checkpoint();await client.connect();connected=true;checkpoint();
  // Acquire the session lock before assigning the repeatable-read snapshot.
  // Waiting for a migration inside that transaction could freeze its old ledger.
  await client.query("SELECT pg_advisory_lock_shared(hashtext('anthys_migrations'))");checkpoint();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;await identityAndLedger();await stopped();
  const snapshot=(await client.query('SELECT pg_export_snapshot() snapshot')).rows[0]?.snapshot;
  if(typeof snapshot!=='string'||! /^[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]{1,10}$/.test(snapshot))fail('BACKUP_SNAPSHOT_ID_REJECTED');checkpoint();
  return {snapshotId:snapshot,sourceSchemaFingerprint:input.expectedSchemaFingerprint,expiresAt:input.expiresAt,maintenanceIndependentlyVerified:false as const,externalDispatchResumeAuthorized:false as const,
   // Data/ledger reads remain at the held snapshot. The coordinator MUST also
   // take independent pre/post inventories; this is not a current-state proof.
   checkHeldSnapshot:async()=>{if(closed||closing)fail('BACKUP_SNAPSHOT_CLOSED');try{await identityAndLedger();await stopped();}catch(error){await close().catch(()=>{});throw error instanceof SnapshotError?error:new SnapshotError('BACKUP_SNAPSHOT_CHECK_FAILED');}},close};
 }catch(error){await close().catch(()=>{});throw error instanceof SnapshotError?error:new SnapshotError(signal.aborted?'BACKUP_SNAPSHOT_CANCELLED_OR_TIMEOUT':'BACKUP_SNAPSHOT_OPEN_FAILED');}
}
