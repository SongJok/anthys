import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {open,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {planProjectBackup} from './project-backup-profile.js';
import {readProjectBackupSource} from './project-backup-source.js';
import {readOperationsPrivateFile,writeOperationsPrivateFile,PrivateFileCommitUncertain} from './private-file.js';
import {verifyBackupExecutable,type BackupExecutablePin} from './project-backup-toolchain.js';
import {openPostgresBackupSnapshot,type PostgresBackupSnapshotOptions,type PostgresBackupConnection} from './postgres-backup-snapshot.js';
import {capturePostgresInventory,comparePostgresInventories,type InventoryLimits} from './postgres-inventory.js';
import {writePrivateArchive} from './archive.js';
import {snapshotFileStore,type FileStoreSnapshotOptions} from './filestore-snapshot.js';
import {createProcessReadable} from './process-stream.js';

class BackupError extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new BackupError(code);};
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
export function postgresBackupEnvironment(p:PostgresBackupConnection,timeoutMs:number){
 return {LC_ALL:'C',LANG:'C',PGHOST:p.host,PGPORT:String(p.port),PGDATABASE:p.database,PGUSER:p.user,PGPASSWORD:p.password as string,PGSSLMODE:'disable',PGCONNECT_TIMEOUT:String(Math.max(1,Math.ceil(Math.min(timeoutMs,3000)/1000))),PGCLIENTENCODING:'UTF8',PGOPTIONS:'-c row_security=off -c statement_timeout='+Math.floor(timeoutMs)+' -c lock_timeout=3000',PGAPPNAME:'anthys_bounded_backup_child',PGSERVICEFILE:'/dev/null',PGPASSFILE:'/dev/null'};
}
export type CreatePostgresFileBackupInput=PostgresBackupSnapshotOptions&{backupSetId:string;profileHash:string;keyId:string;key:Buffer;pgDump:BackupExecutablePin;pgRestore:BackupExecutablePin;postgresArchiveRoot:string;maxPostgresArchiveBytes:number;inventoryLimits:InventoryLimits;fileStore:Omit<FileStoreSnapshotOptions,'backupId'|'keyId'|'key'|'schemaFingerprint'|'signal'>;expectedFileStoreRootHash:string};
/** Internal coordinator shared with owned-nonce acceptance. Production callers
 * must use backupProject(), which pins the real source and reviewed profile.
 * No service/dispatcher is started, no migrations or external calls are made.
 * A returned set is consistent with the observed inventory, not permission to
 * resume: independent maintenance and revocation reconciliation remain required. */
export async function createPostgresFileBackup(input:CreatePostgresFileBackupInput){
 const left=Math.min(input.maxDurationMs,Date.parse(input.expiresAt)-Date.now());
 if(input.signal.aborted)fail('BACKUP_CANCELLED');if(!Number.isFinite(left)||left<1000||left>600000)fail('BACKUP_WINDOW_CLOSED');
 if(!/^[a-f0-9]{64}$/.test(input.profileHash)||hash(input.fileStore.sourceRoot)!==input.expectedFileStoreRootHash||!Buffer.isBuffer(input.key)||input.key.length!==32)fail('BACKUP_OPTIONS_REJECTED');
 const archiveKey=Buffer.from(input.key);
 const controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]),deadline=performance.now()+left,timer=setTimeout(()=>controller.abort(),left);timer.unref();
 const remaining=()=>{if(signal.aborted)fail('BACKUP_CANCELLED_OR_TIMEOUT');const value=Math.floor(Math.min(deadline-performance.now(),Date.parse(input.expiresAt)-Date.now()));if(value<1)fail('BACKUP_WINDOW_CLOSED');return value;};
 let stage='EXECUTABLE',receiptWritten=false,receiptStamp:{ino:number;dev:number}|undefined,receiptPath:string|undefined;const jobs:Promise<unknown>[]=[];
 let snapshot:Awaited<ReturnType<typeof openPostgresBackupSnapshot>>|undefined,producer:ReturnType<typeof createProcessReadable>|undefined;
 const inventory=()=>capturePostgresInventory({connection:input.connection,expectedDatabase:input.expectedDatabase,expectedSystemIdentifierSha256:input.expectedSystemIdentifierSha256,expectedSchemaFingerprint:input.expectedSchemaFingerprint,limits:{...input.inventoryLimits,timeoutMs:Math.max(1000,Math.min(input.inventoryLimits.timeoutMs,remaining()))},signal});
 try{
  for(const pin of [input.pgDump,input.pgRestore]){await verifyBackupExecutable(pin,signal,Math.min(10000,remaining()));remaining();}
  stage='PRE_INVENTORY';const before=await inventory();remaining();stage='SNAPSHOT';snapshot=await openPostgresBackupSnapshot({...input,signal,maxDurationMs:Math.min(input.maxDurationMs,remaining())});
  stage='DUMP';producer=createProcessReadable({file:input.pgDump.path,args:['--no-password','--format=custom','--snapshot='+snapshot.snapshotId],cwd:'/',env:postgresBackupEnvironment(input.connection,remaining()),signal,timeoutMs:remaining(),maxStdoutBytes:input.maxPostgresArchiveBytes,maxStderrBytes:65536});
  let prefix=Buffer.alloc(0);const magic=new Transform({transform(chunk:Buffer,_encoding,done){if(prefix.length<5){prefix=Buffer.concat([prefix,chunk.subarray(0,5-prefix.length)]);if(prefix.length===5&&prefix.toString('ascii')!=='PGDMP'){done(new BackupError('BACKUP_DUMP_FORMAT_REJECTED'));return;}}done(null,chunk);},flush(done){done(prefix.toString('ascii')==='PGDMP'?null:new BackupError('BACKUP_DUMP_FORMAT_REJECTED'));}});
  const pipe=pipeline(producer.stream,magic);void pipe.catch(()=>{});
  const writing=writePrivateArchive({root:input.postgresArchiveRoot,backupId:input.backupSetId,key:archiveKey,maxBytes:input.maxPostgresArchiveBytes,signal,metadata:{keyId:input.keyId,sourceSchemaFingerprint:input.expectedSchemaFingerprint,type:'POSTGRES_DUMP'},input:magic});
  jobs.push(writing,pipe,producer.completion);const [postgres]=await Promise.all([writing,pipe,producer.completion]);remaining();await snapshot.checkHeldSnapshot();
  stage='FILESTORE';const fileStore=await snapshotFileStore({...input.fileStore,backupId:input.backupSetId,keyId:input.keyId,key:archiveKey,schemaFingerprint:input.expectedSchemaFingerprint,signal});remaining();await snapshot.checkHeldSnapshot();
  stage='POST_INVENTORY';const after=await inventory();remaining();const stable=comparePostgresInventories(before,after);if(stable.status!=='MATCH')fail('BACKUP_SOURCE_CHANGED');
  // An exclusive set receipt is committed last. Earlier individual encrypted
  // archives may remain quarantined after failure; they are never a usable set.
  const receipt={schemaVersion:1,kind:'POSTGRES_FILESTORE_BACKUP_SET',backupSetId:input.backupSetId,profileHash:input.profileHash,sourceSystemIdentifierSha256:input.expectedSystemIdentifierSha256,sourceSchemaFingerprint:input.expectedSchemaFingerprint,createdAt:new Date().toISOString(),postgres,fileStore,inventory:before,sourceStable:stable,maintenanceIndependentlyVerified:false,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true};
  stage='RECEIPT';const bytes=Buffer.from(JSON.stringify(receipt)),path=join(input.postgresArchiveRoot,input.backupSetId+'.backup-set.json');receiptPath=path;receiptStamp=await writeOperationsPrivateFile(path,bytes,signal);receiptWritten=true;
  const directory=await open(input.postgresArchiveRoot,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}remaining();
  return {receipt,receiptSha256:hash(bytes),receiptPath:path};
 }catch(error){
  const cancelled=signal.aborted;controller.abort();await producer?.close().catch(()=>{});await Promise.allSettled(jobs);
  // Returning rejection also waits for archive cleanup. A set marker written
  // before a failed directory sync/final deadline is not a committed success.
  if(receiptWritten){try{if(!receiptStamp||!receiptPath)throw new BackupError('BACKUP_SET_MARKER_COMMIT_UNCERTAIN');const named=await lstat(receiptPath);if(named.ino!==receiptStamp.ino||named.dev!==receiptStamp.dev)fail('BACKUP_SET_MARKER_COMMIT_UNCERTAIN');await unlink(receiptPath);const dir=await open(input.postgresArchiveRoot,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}catch{fail('BACKUP_SET_MARKER_COMMIT_UNCERTAIN');}}
  if(error instanceof PrivateFileCommitUncertain)fail('BACKUP_SET_MARKER_COMMIT_UNCERTAIN');throw error instanceof BackupError?error:new BackupError(cancelled?'BACKUP_CANCELLED_OR_TIMEOUT':'BACKUP_FAILED_'+stage+(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)?'_'+error.code:''));
 }
 finally{clearTimeout(timer);archiveKey.fill(0);await producer?.close().catch(()=>{});await snapshot?.close().catch(()=>{});}
}
/** Explicit operator action only: a reviewed profile/ref is not human approval.
 * The CLI/operator must separately obtain the concrete real-data permission. */
export async function backupProject(raw:unknown,review:{expectedProfileHash:string;reviewReference:string},signal:AbortSignal){
 const plan=planProjectBackup(raw),p=plan.profile,left=Math.max(0,Math.min(p.maxDurationMs,Date.parse(p.validUntil)-Date.now())),controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal]),deadline=performance.now()+left,timer=setTimeout(()=>controller.abort(),left);timer.unref();let key:Buffer|undefined;
 const remaining=()=>{if(bounded.aborted)fail('BACKUP_CANCELLED_OR_TIMEOUT');const left=Math.floor(Math.min(deadline-performance.now(),Date.parse(p.validUntil)-Date.now()));if(left<1000)fail('BACKUP_WINDOW_CLOSED');return left;};
 try{
  const connection=await readProjectBackupSource(p,review,bounded);remaining();
  key=await readOperationsPrivateFile(p.key.file,32);remaining();if(key.length!==32||hash(key)!==p.key.fileSha256)fail('BACKUP_KEY_CHANGED');
  return await createPostgresFileBackup({connection,expectedDatabase:p.source.database,expectedSystemIdentifierSha256:p.source.systemIdentifierSha256,expectedMigrationCount:p.source.migrationCount,expectedSchemaFingerprint:p.source.schemaFingerprint,expiresAt:p.validUntil,maxDurationMs:remaining(),signal:bounded,backupSetId:p.backupSetId,profileHash:plan.profileHash,keyId:p.key.id,key,pgDump:p.pgDump,pgRestore:p.pgRestore,postgresArchiveRoot:p.postgresArchiveRoot,maxPostgresArchiveBytes:p.maxPostgresArchiveBytes,inventoryLimits:p.inventoryLimits,fileStore:{sourceRoot:p.fileStore.sourceRoot,archiveRoot:p.fileStoreArchiveRoot,maxFiles:p.fileStore.maxFiles,maxFileBytes:p.fileStore.maxFileBytes,maxTotalBytes:p.fileStore.maxTotalBytes},expectedFileStoreRootHash:p.fileStore.sourceRootFingerprint});
 }finally{clearTimeout(timer);key?.fill(0);}
}
