import {createHash} from 'node:crypto';
import {isAbsolute,resolve,relative,join} from 'node:path';
import {z} from 'zod';
import {requiredSchema} from '../../storage/src/schema.js';
import {archiveReceiptSchema,PRIVATE_ARCHIVE_MAX_BYTES} from './archive.js';
import {fileStoreSnapshotManifestSchema,restoreFileStoreSnapshot,FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES} from './filestore-snapshot.js';
import {postgresInventorySchema,validatePostgresInventory,comparePostgresInventories,inventoryLimitsSchema} from './postgres-inventory.js';
import {projectBackupSchemaPrefix} from './project-backup-profile.js';
import {readOperationsPrivateFile} from './private-file.js';
import {restoreAuthenticatedPostgres} from './postgres-authenticated-restore.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid().regex(/^[a-f0-9-]+$/),ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/);
const path=z.string().max(4096).refine(value=>isAbsolute(value)&&resolve(value)===value&&value!=='/'&&!/[\u0000-\u001f\u007f]/.test(value));
const dbName=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const contains=(a:string,b:string)=>{const part=relative(a,b);return part===''||part!=='..'&&!part.startsWith('../')&&!isAbsolute(part);};
class ProjectRestoreError extends Error{constructor(readonly code:string){super(code);}}
function fail(code:string):never{throw new ProjectRestoreError(code);}
const stableSchema=z.strictObject({schemaVersion:z.literal(1),status:z.literal('MATCH'),beforeFingerprint:sha,afterFingerprint:sha,schemaMatches:z.literal(true),metadataMatches:z.literal(true),dataMatches:z.literal(true),sequencesMatch:z.literal(true),externalDispatchResumeAuthorized:z.literal(false),revocationAndExternalStateReconciliationRequired:z.literal(true)});
const setSchema=z.strictObject({
 schemaVersion:z.literal(1),kind:z.literal('POSTGRES_FILESTORE_BACKUP_SET'),backupSetId:uuid,profileHash:sha,sourceSystemIdentifierSha256:sha,sourceSchemaFingerprint:sha,createdAt:z.iso.datetime(),
 postgres:archiveReceiptSchema,fileStore:z.strictObject({archive:archiveReceiptSchema,manifest:fileStoreSnapshotManifestSchema}),inventory:postgresInventorySchema,sourceStable:stableSchema,
 maintenanceIndependentlyVerified:z.literal(false),externalDispatchResumeAuthorized:z.literal(false),revocationAndExternalStateReconciliationRequired:z.literal(true),
});
/** Exact reviewed recovery target, never the live project or shared test DB.
 * Independent provisioning/control and the real-data approval are external.
 * This profile grants no permission and never creates a target or global role. */
export const projectRestoreProfileSchema=z.strictObject({
 schemaVersion:z.literal(1),kind:z.literal('BOUNDED_PROJECT_RESTORE'),reviewReference:ref,repositoryContractFingerprint:sha,
 backup:z.strictObject({backupSetId:uuid,receiptFile:path,receiptSha256:sha,profileHash:sha,sourceDatabase:dbName,sourceSystemIdentifierSha256:sha,migrationCount:z.number().int().min(73).max(requiredSchema.migrations.length),schemaFingerprint:sha,postgresArchiveRoot:path,fileStoreArchiveRoot:path,maxPostgresArchiveBytes:z.number().int().min(1).max(PRIVATE_ARCHIVE_MAX_BYTES),
  fileStore:z.strictObject({sourceRoot:path,maxFiles:z.number().int().min(1).max(10000),maxFileBytes:z.number().int().min(1).max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES),maxTotalBytes:z.number().int().min(1).max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES)})}),
 key:z.strictObject({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),file:path,fileSha256:sha}),
 target:z.strictObject({host:z.literal('127.0.0.1'),port:z.number().int().min(1).max(65535).refine(port=>port!==53330),database:dbName,role:z.literal('oa_migrator'),databaseOid:z.string().regex(/^[1-9][0-9]{0,9}$/),systemIdentifierSha256:sha,connectionFile:path,connectionFileSha256:sha}),
 pgRestore:z.strictObject({path,sha256:sha,version:z.string().max(256).regex(/^pg_restore \(PostgreSQL\) 17\.[0-9]+(?: [\x20-\x7e]+)?$/)}),
 fileRestore:z.strictObject({parent:path,restoreId:uuid}),
 inventoryLimits:inventoryLimitsSchema,validFrom:z.iso.datetime(),validUntil:z.iso.datetime(),maxDurationMs:z.number().int().min(1000).max(600000),
 maintenance:z.strictObject({targetExclusiveControlReference:ref,sourceStopReference:ref,keyRecoveryReference:ref,externalStateReconciliationReference:ref}),
}).superRefine((p,c)=>{
 const b=p.backup,window=Date.parse(p.validUntil)-Date.parse(p.validFrom),roots=[b.postgresArchiveRoot,b.fileStoreArchiveRoot,b.fileStore.sourceRoot,p.fileRestore.parent];
 if(window<=0||window>3600000||p.maxDurationMs>window||p.inventoryLimits.timeoutMs>p.maxDurationMs||p.repositoryContractFingerprint!==requiredSchema.contractHash||b.schemaFingerprint!==projectBackupSchemaPrefix(b.migrationCount)||b.fileStore.maxFileBytes>b.fileStore.maxTotalBytes||b.receiptFile!==join(b.postgresArchiveRoot,b.backupSetId+'.backup-set.json')||[b.sourceDatabase,'open_aider','open_aider_test','postgres','template0','template1'].includes(p.target.database))c.addIssue({code:'custom',message:'RESTORE_EXACT_TARGET_AND_CONTRACT_REQUIRED'});
 if(roots.some((root,i)=>roots.some((other,j)=>i!==j&&(contains(root,other)||contains(other,root))))||roots.some(root=>contains(root,p.key.file)||contains(root,p.target.connectionFile))||p.key.file===p.target.connectionFile)c.addIssue({code:'custom',message:'RESTORE_PATH_SEPARATION_REQUIRED'});
});
export type ProjectRestoreProfile=z.infer<typeof projectRestoreProfileSchema>;
export function planProjectRestore(raw:unknown){
 const profile=projectRestoreProfileSchema.parse(raw),profileHash=hash(JSON.stringify(profile));
 return {profile,profileHash,summary:{schemaVersion:1,status:'OFFLINE_RESTORE_PLAN_ONLY_NOT_AUTHORIZED',profileHash,backupSetId:profile.backup.backupSetId,backupReceiptSha256:profile.backup.receiptSha256,sourceSchemaFingerprint:profile.backup.schemaFingerprint,targetIdentityHash:hash(JSON.stringify(profile.target)),sourceAndTargetClusterPinsDiffer:profile.target.systemIdentifierSha256!==profile.backup.sourceSystemIdentifierSha256,credentialsRead:false,keyRead:false,databaseAccess:false,restored:false,operatorReferencesAreAttestations:true,externalDispatchResumeAuthorized:false}};
}
export function validateProjectBackupSet(raw:unknown,p:ProjectRestoreProfile){
 const parsed=setSchema.safeParse(raw);if(!parsed.success)fail('RESTORE_BACKUP_SET_REJECTED');const r=parsed.data,b=p.backup,inventory=validatePostgresInventory(r.inventory);
 if(r.backupSetId!==b.backupSetId||r.profileHash!==b.profileHash||r.sourceSystemIdentifierSha256!==b.sourceSystemIdentifierSha256||r.sourceSchemaFingerprint!==b.schemaFingerprint||inventory.database!==b.sourceDatabase||hash(inventory.systemIdentifier)!==b.sourceSystemIdentifierSha256||inventory.schemaFingerprint!==b.schemaFingerprint||inventory.migrationCount!==b.migrationCount||JSON.stringify(r.sourceStable)!==JSON.stringify(comparePostgresInventories(inventory,inventory)))fail('RESTORE_BACKUP_SET_BINDING_REJECTED');
 for(const [receipt,type] of [[r.postgres,'POSTGRES_DUMP'],[r.fileStore.archive,'FILESTORE_SNAPSHOT']] as const)if(receipt.backupId!==b.backupSetId||receipt.metadata.keyId!==p.key.id||receipt.metadata.sourceSchemaFingerprint!==b.schemaFingerprint||receipt.metadata.type!==type)fail('RESTORE_BACKUP_SET_BINDING_REJECTED');
 if(r.fileStore.manifest.sourceRootHash!==hash(b.fileStore.sourceRoot)||r.fileStore.manifest.files.length>b.fileStore.maxFiles||r.fileStore.manifest.totalBytes>b.fileStore.maxTotalBytes||r.fileStore.manifest.files.some(f=>f.byteSize>b.fileStore.maxFileBytes)||r.postgres.plaintext.byteSize>b.maxPostgresArchiveBytes)fail('RESTORE_BACKUP_SET_LIMIT_REJECTED');
 return r;
}
/** Full set recovery into a quarantined target. Restored sealed files are kept
 * if the later database step fails, for explicit reconciliation; never auto
 * delete/retry/reuse a target. No app key is installed or service started. */
export async function restoreProject(raw:unknown,review:{expectedProfileHash:string;reviewReference:string},signal:AbortSignal){
 const plan=planProjectRestore(raw),p=plan.profile,b=p.backup;
 if(review.expectedProfileHash!==plan.profileHash||review.reviewReference!==p.reviewReference)fail('RESTORE_REVIEW_MISMATCH');
 const left=Math.max(0,Math.min(p.maxDurationMs,Date.parse(p.validUntil)-Date.now())),controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal]),deadline=performance.now()+left,timer=setTimeout(()=>controller.abort(),left);timer.unref();
 const remaining=()=>{if(bounded.aborted)fail('RESTORE_CANCELLED_OR_TIMEOUT');const now=Date.now(),left=Math.floor(Math.min(deadline-performance.now(),Date.parse(p.validUntil)-now));if(now<Date.parse(p.validFrom)||left<1000)fail('RESTORE_WINDOW_CLOSED');return left;};
 let key:Buffer|undefined,bytes:Buffer|undefined,stage='INPUT';
 try{
  remaining();bytes=await readOperationsPrivateFile(b.receiptFile,4*1024*1024);remaining();if(hash(bytes)!==b.receiptSha256)fail('RESTORE_RECEIPT_CHANGED');
  const receipt=validateProjectBackupSet(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),p);bytes.fill(0);bytes=undefined;
  key=await readOperationsPrivateFile(p.key.file,32);remaining();if(key.length!==32||hash(key)!==p.key.fileSha256)fail('RESTORE_KEY_CHANGED');
  bytes=await readOperationsPrivateFile(p.target.connectionFile,8192);remaining();if(hash(bytes)!==p.target.connectionFileSha256)fail('RESTORE_CONNECTION_CHANGED');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();if(!/^postgresql:\/\/oa_migrator:[^/?#@\s]+@127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-z][a-z0-9_]{0,62}$/.test(text))fail('RESTORE_CONNECTION_REJECTED');
  const url=new URL(text),password=decodeURIComponent(url.password);if(url.hostname!==p.target.host||Number(url.port)!==p.target.port||url.pathname!=='/'+p.target.database||url.username!==p.target.role||url.search||url.hash||!password||/[\u0000-\u001f\u007f]/.test(password))fail('RESTORE_CONNECTION_REJECTED');bytes.fill(0);bytes=undefined;
  stage='FILESTORE';const files=await restoreFileStoreSnapshot({sourceRoot:b.fileStore.sourceRoot,archiveRoot:b.fileStoreArchiveRoot,backupId:b.backupSetId,keyId:p.key.id,key,schemaFingerprint:b.schemaFingerprint,maxFiles:b.fileStore.maxFiles,maxFileBytes:b.fileStore.maxFileBytes,maxTotalBytes:b.fileStore.maxTotalBytes,signal:bounded,restoreParent:p.fileRestore.parent,restoreId:p.fileRestore.restoreId});remaining();
  if(JSON.stringify(files.receipt)!==JSON.stringify(receipt.fileStore))fail('RESTORE_FILESTORE_RECEIPT_MISMATCH');
  stage='POSTGRES';const postgres=await restoreAuthenticatedPostgres({archive:{root:b.postgresArchiveRoot,backupId:b.backupSetId,key,maxBytes:b.maxPostgresArchiveBytes,signal:bounded,expectedMetadata:receipt.postgres.metadata},expectedArchiveReceipt:receipt.postgres,connection:{host:p.target.host,port:p.target.port,database:p.target.database,user:p.target.role,password,ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off'},expectedDatabaseOid:p.target.databaseOid,expectedSystemIdentifierSha256:p.target.systemIdentifierSha256,before:receipt.inventory,pgRestore:p.pgRestore,limits:p.inventoryLimits,expiresAt:p.validUntil,maxDurationMs:remaining(),signal:bounded});remaining();
  return {schemaVersion:1,status:'RESTORED_SET_RECONCILIATION_REQUIRED',profileHash:plan.profileHash,backupSetId:b.backupSetId,backupReceiptSha256:b.receiptSha256,postgresContentFingerprint:postgres.inventory.contentFingerprint,fileStoreManifestSha256:hash(JSON.stringify(files.receipt.manifest)),restoredRoot:files.root,sourceAndTargetClustersDiffer:hash(postgres.inventory.systemIdentifier)!==b.sourceSystemIdentifierSha256,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true,applicationKeyRecoveryVerified:false,servicesStarted:false};
 }catch(error){const stopped=bounded.aborted;controller.abort();throw error instanceof ProjectRestoreError?error:new ProjectRestoreError(stopped?'RESTORE_CANCELLED_OR_TIMEOUT_RECONCILIATION_REQUIRED':'RESTORE_FAILED_'+stage+'_RECONCILIATION_REQUIRED');}
 finally{clearTimeout(timer);bytes?.fill(0);key?.fill(0);}
}
