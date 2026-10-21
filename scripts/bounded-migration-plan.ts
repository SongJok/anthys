import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const ledgerSchema=z.array(z.object({name:z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(999);
const _errors=['USAGE_INVALID','PATH_INVALID','INPUT_NOT_REGULAR','INPUT_TOO_LARGE','INPUT_CHANGED','INPUT_UNREADABLE','INPUT_INVALID_JSON','LEDGER_INVALID','LEDGER_PREFIX_MISMATCH','CONTRACT_MISMATCH','RANGE_INVALID','MIGRATION_SET_MISMATCH','MIGRATION_HASH_MISMATCH','MIGRATION_EMPTY'] as const;
type ErrorCode=typeof _errors[number];
class PlanError extends Error{constructor(readonly code:ErrorCode){super(code);}}
function fail(code:ErrorCode):never{throw new PlanError(code);}
function fingerprint(rows:readonly {name:string;hash:string}[]){return digest(rows.map(row=>row.name+'\0'+row.hash+'\0').join(''));}

/** Data files only: never import code, execute SQL, or load configuration from the selected repository. */
async function boundedRead(path:string,limit:number):Promise<Buffer>{
 let file:Awaited<ReturnType<typeof open>>|undefined;
 try{
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await file.stat();
  if(!before.isFile())fail('INPUT_NOT_REGULAR');if(before.size>limit)fail('INPUT_TOO_LARGE');
  const buffer=Buffer.alloc(limit+1);let count=0;
  while(count<buffer.length){const result=await file.read(buffer,count,buffer.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
  if(count>limit)fail('INPUT_TOO_LARGE');const after=await file.stat();
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('INPUT_CHANGED');
  return buffer.subarray(0,count);
 }catch(error){if(error instanceof PlanError)throw error;throw new PlanError('INPUT_UNREADABLE');}
 finally{await file?.close();}
}
function json(bytes:Buffer):unknown{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INPUT_INVALID_JSON');}}
export type BoundedMigrationPlanInput={repository:string;ledger:string;from:number;to:number};

export async function boundedMigrationPlan(input:BoundedMigrationPlanInput){
 if(!isAbsolute(input.repository)||!isAbsolute(input.ledger)||input.repository.includes('\0')||input.ledger.includes('\0'))fail('PATH_INVALID');
 let schema:typeof import('../packages/storage/src/schema.js');try{schema=await import('../packages/storage/src/schema.js');}catch{fail('CONTRACT_MISMATCH');}
 const {requiredSchema,matchesRequiredSchema}=schema,{from,to}=input;
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to||to>requiredSchema.migrations.length)fail('RANGE_INVALID');
 const ledgerBytes=await boundedRead(input.ledger,256*1024),parsed=ledgerSchema.safeParse(json(ledgerBytes));
 if(!parsed.success)fail('LEDGER_INVALID');const rows=parsed.data;
 if(rows.length!==from||rows.some((row,index)=>row.name!==requiredSchema.migrations[index]?.name)||!matchesRequiredSchema([...rows,...requiredSchema.migrations.slice(from)]))fail('LEDGER_PREFIX_MISMATCH');
 const contractBytes=await boundedRead(join(input.repository,'packages/storage/src/required-migrations.json'),512*1024);
 if(!isDeepStrictEqual(json(contractBytes),requiredSchema))fail('CONTRACT_MISMATCH');
 const directory=join(input.repository,'db/migrations');let names:string[];
 try{names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();}catch{fail('INPUT_UNREADABLE');}
 if(!isDeepStrictEqual(names,requiredSchema.migrations.map(row=>row.name)))fail('MIGRATION_SET_MISMATCH');
 const files:{ordinal:number;name:string;sha256:string;byteSize:number;semanticReview:'REQUIRED_NOT_PERFORMED'}[]=[];let totalBytes=0;
 for(const [index,migration] of requiredSchema.migrations.entries()){
  const sql=await boundedRead(join(directory,migration.name),4*1024*1024);totalBytes+=sql.length;
  if(totalBytes>64*1024*1024)fail('INPUT_TOO_LARGE');if(!sql.toString('utf8').trim())fail('MIGRATION_EMPTY');
  if(digest(sql)!==migration.hash)fail('MIGRATION_HASH_MISMATCH');
  if(index>=from&&index<to)files.push({ordinal:index+1,name:migration.name,sha256:migration.hash,byteSize:sql.length,semanticReview:'REQUIRED_NOT_PERFORMED'});
 }
 return {
  schemaVersion:1 as const,status:'OFFLINE_PLAN_ONLY' as const,authorization:'NOT_AUTHORIZED' as const,executionImplemented:false as const,
  interval:{from,to,firstSelected:from+1,lastSelected:to,selectedCount:files.length,repositoryLast:requiredSchema.migrations.length,selectsAllRemaining:to===requiredSchema.migrations.length},
  source:{capturedLedgerSha256:digest(ledgerBytes),repositoryContractSha256:digest(contractBytes),contractFingerprint:requiredSchema.contractHash,ledgerEntries:rows.length,allRepositorySqlHashesVerified:true},
  start:{migration:from===0?null:requiredSchema.migrations[from-1]!.name,fingerprint:fingerprint(requiredSchema.migrations.slice(0,from))},
  target:{migration:requiredSchema.migrations[to-1]!.name,fingerprint:fingerprint(requiredSchema.migrations.slice(0,to))},
  migrations:files,
  prerequisites:[
   'INDEPENDENT_APPROVAL_FOR_THIS_EXACT_INTERVAL_AND_FINGERPRINTS',
   'CURRENT_READ_ONLY_LEDGER_CAPTURE_PROVENANCE_AND_RECHECK',
   'STOP_QUEUE_WORKER_NOTIFIER_SCHEDULER_INGRESS_AND_OTHER_DISPATCHERS',
   'INDEPENDENT_ENCRYPTED_BACKUP_BEFORE_ANY_MIGRATION',
   'CONTROLLED_KEY_RECOVERY_AND_CIPHERTEXT_RESTORE_VERIFIED',
   'RESTORE_DRILL_IN_SEPARATE_CONTROLLED_ENVIRONMENT',
   'REVIEW_EACH_SQL_DATA_PERMISSION_AND_IRREVERSIBILITY_CHANGE',
   'STEPWISE_GATES_AND_EXPLICIT_STOP_DECISIONS',
   'RECONCILE_EXTERNAL_IN_FLIGHT_AND_UNKNOWN_ACTIONS_WITHOUT_RESENDING',
   'PRESERVE_REVOKED_AUTHORIZATIONS_AND_CLOSED_TRIAL_TOMBSTONES',
   'RESTORE_ONLY_TO_CONTROLLED_NO_DISPATCH_STATE_UNTIL_RECONCILED',
  ],
  stopConditions:[
   'LEDGER_CONTRACT_SQL_OR_APPROVED_INTERVAL_CHANGED',
   'BACKUP_KEY_RECOVERY_OR_RESTORE_DRILL_NOT_VERIFIED',
   'DISPATCHERS_NOT_STOPPED_OR_EXTERNAL_STATE_UNRECONCILED',
   'AUTHORIZATION_OR_CLOSED_TRIAL_STATE_COULD_BE_REVIVED',
   'MIGRATION_LOCK_FAILURE_OR_POST_STEP_VERIFICATION_UNCERTAIN',
  ],
  riskBoundaries:{liveDatabaseVerified:false,sqlSemanticsVerified:false,backupVerified:false,restoreVerified:false,authorizationGranted:false,rollbackStrategy:'INDEPENDENT_RESTORE_AND_EXTERNAL_STATE_RECONCILIATION_REQUIRED',automaticRollbackSql:false,reactivateRevokedAuthority:false,treatUnknownExternalActionAsUnsent:false},
 };
}

function argumentsFor(args:readonly string[]):BoundedMigrationPlanInput{
 const fields=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key||!['--repository','--ledger','--from','--to'].includes(key)||value===undefined||fields.has(key))fail('USAGE_INVALID');fields.set(key,value);}
 if(fields.size!==4||!['--from','--to'].every(key=>/^(0|[1-9][0-9]{0,2})$/.test(fields.get(key)!)))fail('USAGE_INVALID');
 return {repository:fields.get('--repository')!,ledger:fields.get('--ledger')!,from:Number(fields.get('--from')),to:Number(fields.get('--to'))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log(JSON.stringify(await boundedMigrationPlan(argumentsFor(process.argv.slice(2)))));}
 catch(error){console.log(JSON.stringify({schemaVersion:1,status:'REJECTED',error:{code:error instanceof PlanError?error.code:'INPUT_UNREADABLE'}}));process.exitCode=1;}
}
