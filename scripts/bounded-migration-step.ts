import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readOperationsPrivateFile} from '../packages/operations/src/private-file.js';
import {planBoundedMigrationStep,applyBoundedMigrationStep} from '../packages/operations/src/bounded-migration.js';
export async function boundedMigrationStepCommand(args:readonly string[],signal:AbortSignal){
 const [mode='plan',...rest]=args,flags=new Map<string,string>();if(!['plan','apply'].includes(mode)||rest.length%2)throw Error('BOUNDED_MIGRATION_USAGE');for(let i=0;i<rest.length;i+=2){if(!['--profile','--expected-profile-hash','--review-ref'].includes(rest[i]!)||flags.has(rest[i]!)||!rest[i+1])throw Error('BOUNDED_MIGRATION_USAGE');flags.set(rest[i]!,rest[i+1]!);}if(!flags.has('--profile'))throw Error('BOUNDED_MIGRATION_USAGE');signal.throwIfAborted();
 const profile=JSON.parse((await readOperationsPrivateFile(flags.get('--profile')!,65536)).toString('utf8'));
 signal.throwIfAborted();
 if(mode==='plan'){if(flags.size!==1)throw Error('BOUNDED_MIGRATION_USAGE');const plan=await planBoundedMigrationStep(profile,signal);signal.throwIfAborted();return plan.summary;}
 if(flags.size!==3)throw Error('BOUNDED_MIGRATION_USAGE');return applyBoundedMigrationStep(profile,{profileHash:flags.get('--expected-profile-hash')!,reviewReference:flags.get('--review-ref')!},signal);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);try{const r=await boundedMigrationStepCommand(process.argv.slice(2),controller.signal);console.log(JSON.stringify(r));if(!(r.status==='PLAN_ONLY_NOT_AUTHORIZED'||r.status==='STEP_COMMITTED'&&'cleanupOutcome'in r&&r.cleanupOutcome==='CONFIRMED'&&'deadlineOverrunObserved'in r&&r.deadlineOverrunObserved===false))process.exitCode=1;}catch{console.log(JSON.stringify({status:'REJECTED',code:'BOUNDED_MIGRATION_STEP_REJECTED'}));process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
