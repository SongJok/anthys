import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {capturePostgresInventory,comparePostgresInventories,inventoryLimitsSchema,InventoryError} from '../packages/operations/src/postgres-inventory.js';
import {compareRecoverySafety} from '../packages/operations/src/recovery-safety-comparison.js';
import {readOperationsPrivateFile,writeOperationsPrivateFile} from '../packages/operations/src/private-file.js';
const profileSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('POSTGRES_READ_ONLY_RESTORE_VERIFICATION'),connectionFile:z.string().min(1),expectedDatabase:z.string().min(1).max(256),expectedSystemIdentifier:z.string().regex(/^[0-9]{1,24}$/),expectedSchemaFingerprint:z.string().regex(/^[a-f0-9]{64}$/),limits:inventoryLimitsSchema}).strict();
const json=(bytes:Buffer):unknown=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
export async function restoreVerificationCommand(args:readonly string[],signal:AbortSignal){
 signal.throwIfAborted();const [mode,...rest]=args,flags=new Map<string,string>();if(!['capture','compare','compare-safety'].includes(mode??'')||rest.length%2)throw Error('USAGE_INVALID');
 for(let i=0;i<rest.length;i+=2){if(flags.has(rest[i]!)||!rest[i+1])throw Error('USAGE_INVALID');flags.set(rest[i]!,rest[i+1]!);}
 if(mode==='compare-safety'){
  if(flags.size!==2||!flags.has('--current')||!flags.has('--restored'))throw Error('USAGE_INVALID');
  // These labels identify supplied snapshots, not independently proven current authority.
  // Direction: added exists only in restored; missing exists only in current.
  const currentBytes=await readOperationsPrivateFile(flags.get('--current')!,4*1024*1024);signal.throwIfAborted();
  const current=json(currentBytes);signal.throwIfAborted();
  const restoredBytes=await readOperationsPrivateFile(flags.get('--restored')!,4*1024*1024);signal.throwIfAborted();
  const restored=json(restoredBytes);signal.throwIfAborted();return compareRecoverySafety(current,restored);
 }
 if(mode==='compare'){
  if(flags.size!==2||!flags.has('--before')||!flags.has('--after'))throw Error('USAGE_INVALID');const before=json(await readOperationsPrivateFile(flags.get('--before')!,4*1024*1024)),after=json(await readOperationsPrivateFile(flags.get('--after')!,4*1024*1024));signal.throwIfAborted();return comparePostgresInventories(before,after);
 }
 if(flags.size!==2||!flags.has('--profile')||!flags.has('--output'))throw Error('USAGE_INVALID');const profile=profileSchema.parse(json(await readOperationsPrivateFile(flags.get('--profile')!,32768))),connectionString=(await readOperationsPrivateFile(profile.connectionFile,8192)).toString('utf8').trim();
 signal.throwIfAborted();const inventory=await capturePostgresInventory({...profile,connectionString,signal}),bytes=Buffer.from(JSON.stringify(inventory,null,2)+'\n');await writeOperationsPrivateFile(flags.get('--output')!,bytes,signal);
 return {schemaVersion:1,status:'CAPTURED_READ_ONLY',fileSha256:createHash('sha256').update(bytes).digest('hex'),contentFingerprint:inventory.contentFingerprint,migrationCount:inventory.migrationCount,tables:inventory.tables.length,sequences:inventory.sequences.length,externalDispatchResumeAuthorized:false,revocationAndExternalStateReconciliationRequired:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);try{const value=await restoreVerificationCommand(process.argv.slice(2),controller.signal);console.log(JSON.stringify(value));if(value.status==='DIFFERENT'||value.status==='DIFFERENCE_REQUIRES_RECONCILIATION')process.exitCode=1;}catch(error){console.log(JSON.stringify({schemaVersion:1,status:'REJECTED',code:controller.signal.aborted?'CANCELLED':error instanceof InventoryError?error.code:'PRIVATE_INPUT_OR_COMMAND_INVALID'}));process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
