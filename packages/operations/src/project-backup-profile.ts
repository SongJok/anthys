import {createHash} from 'node:crypto';
import {isAbsolute,resolve,relative} from 'node:path';
import {z} from 'zod';
import {requiredSchema} from '../../storage/src/schema.js';
import {inventoryLimitsSchema} from './postgres-inventory.js';
import {PRIVATE_ARCHIVE_MAX_BYTES} from './archive.js';
import {FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES} from './filestore-snapshot.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/);
const path=z.string().max(4096).refine(value=>isAbsolute(value)&&resolve(value)===value&&!/[\u0000-\u001f\u007f]/.test(value),'CANONICAL_ABSOLUTE_PATH_REQUIRED');
const maxBytes=PRIVATE_ARCHIVE_MAX_BYTES;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export const projectBackupSchemaPrefix=(count:number)=>{
 if(!Number.isSafeInteger(count)||count<73||count>requiredSchema.migrations.length)throw Error('BACKUP_SCHEMA_PREFIX_REJECTED');
 return hash(requiredSchema.migrations.slice(0,count).map(m=>m.name+'\0'+m.hash+'\0').join(''));
};
const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||part!=='..'&&!part.startsWith('../')&&!isAbsolute(part);};
const binary=(name:'pg_dump'|'pg_restore')=>z.object({path,sha256:sha,version:z.string().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'PRINTABLE_VERSION_REQUIRED').regex(new RegExp('^'+name+' \\(PostgreSQL\\) 17\\.[0-9]+(?: [\\x20-\\x7e]+)?$'))}).strict();

/** Operator preparation only. This schema neither attests maintenance nor
 * grants permission to read the production database or create a backup. */
export const projectBackupProfileSchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('BOUNDED_PROJECT_BACKUP'),backupSetId:z.uuid().regex(/^[a-f0-9-]+$/),reviewReference:ref,
 source:z.object({host:z.literal('127.0.0.1'),port:z.literal(64710),database:z.literal('anthys'),role:z.literal('oa_migrator'),systemIdentifierSha256:sha,migrationCount:z.number().int().min(73).max(requiredSchema.migrations.length),schemaFingerprint:sha,connectionFile:path,connectionFileSha256:sha}).strict(),
 repositoryContractFingerprint:sha,
 pgDump:binary('pg_dump'),pgRestore:binary('pg_restore'),
 postgresArchiveRoot:path,fileStoreArchiveRoot:path,
 key:z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),file:path,fileSha256:sha}).strict(),
 fileStore:z.object({sourceRoot:path,sourceRootFingerprint:sha,maxFiles:z.number().int().min(1).max(10000),maxFileBytes:z.number().int().min(1).max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES),maxTotalBytes:z.number().int().min(1).max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES)}).strict(),
 maxPostgresArchiveBytes:z.number().int().min(1).max(maxBytes),inventoryLimits:inventoryLimitsSchema,
 validFrom:z.iso.datetime(),validUntil:z.iso.datetime(),maxDurationMs:z.number().int().min(1000).max(600000),
 maintenance:z.object({stopReference:ref,independentWriteFenceReference:ref,externalStateReconciliationReference:ref}).strict(),
}).strict().superRefine((p,c)=>{
 const window=Date.parse(p.validUntil)-Date.parse(p.validFrom);
 if(window<=0||window>3600000||p.maxDurationMs>window||p.inventoryLimits.timeoutMs>p.maxDurationMs||p.fileStore.maxFileBytes>p.fileStore.maxTotalBytes||p.repositoryContractFingerprint!==requiredSchema.contractHash||p.source.schemaFingerprint!==projectBackupSchemaPrefix(p.source.migrationCount))c.addIssue({code:'custom',message:'BACKUP_EXACT_LIMITS_AND_SCHEMA_REQUIRED'});
 const roots=[p.postgresArchiveRoot,p.fileStoreArchiveRoot,p.fileStore.sourceRoot];
 if(roots.some((root,i)=>roots.some((other,j)=>i!==j&&(contains(root,other)||contains(other,root))))||roots.some(root=>contains(root,p.key.file)||contains(root,p.source.connectionFile))||p.key.file===p.source.connectionFile||p.pgDump.path===p.pgRestore.path)c.addIssue({code:'custom',message:'BACKUP_PATH_SEPARATION_REQUIRED'});
});
export type ProjectBackupProfile=z.infer<typeof projectBackupProfileSchema>;

/** Pure deterministic plan: does not inspect paths, read credentials/keys,
 * spawn processes, connect to PostgreSQL, or claim that a backup exists. */
export function planProjectBackup(raw:unknown){
 const profile=projectBackupProfileSchema.parse(raw),serialized=JSON.stringify(profile);
 return {profile,serialized,profileHash:hash(serialized),summary:{schemaVersion:1,status:'OFFLINE_PLAN_ONLY_NOT_AUTHORIZED' as const,profileHash:hash(serialized),backupSetId:profile.backupSetId,sourceSchemaFingerprint:profile.source.schemaFingerprint,sourceMigrationCount:profile.source.migrationCount,repositoryContractFingerprint:profile.repositoryContractFingerprint,credentialsRead:false as const,keyRead:false as const,databaseAccess:false as const,processesStarted:false as const,backupCreated:false as const,restoreVerified:false as const,maintenanceIndependentlyVerified:false as const,operatorReferencesAreAttestations:true as const,servicesStarted:false as const,externalDispatchResumeAuthorized:false as const}};
}
