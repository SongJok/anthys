import {readOperationsPrivateFile} from '../packages/operations/src/private-file.js';
import {planProjectBackup} from '../packages/operations/src/project-backup-profile.js';
import {backupProject} from '../packages/operations/src/project-backup-driver.js';

// Explicit operator entry, never loaded by app/worker/scheduler. A matching
// review reference is an input pin, not evidence of human real-data approval.
const [action,...args]=process.argv.slice(2),controller=new AbortController();
const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 if(!['plan','backup'].includes(action??'')||args.length%2!==0)throw Error('BACKUP_CLI_USAGE');
 const allowed=action==='plan'?['--profile']:['--profile','--expect-profile-hash','--review-reference'],flags=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!allowed.includes(key)||flags.has(key)||!value||value.startsWith('--'))throw Error('BACKUP_CLI_USAGE');flags.set(key,value);}
 if(allowed.some(key=>!flags.has(key)))throw Error('BACKUP_CLI_USAGE');
 const bytes=await readOperationsPrivateFile(flags.get('--profile')!,65536);let raw:unknown;
 try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
 const plan=planProjectBackup(raw);
 if(action==='plan')console.log(JSON.stringify(plan.summary));
 else{
  const result=await backupProject(plan.profile,{expectedProfileHash:flags.get('--expect-profile-hash')!,reviewReference:flags.get('--review-reference')!},controller.signal);
  console.log(JSON.stringify({status:'SEALED_BACKUP_SET_RESTORE_UNVERIFIED',backupSetId:result.receipt.backupSetId,profileHash:result.receipt.profileHash,receiptSha256:result.receiptSha256,sourceSchemaFingerprint:result.receipt.sourceSchemaFingerprint,maintenanceIndependentlyVerified:false,restoreVerified:false,externalDispatchResumeAuthorized:false,servicesStarted:false}));
 }
}catch(error){
 const candidate=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof Error?error.message:'';
 const code=/^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)?candidate:'BACKUP_PROFILE_OR_INPUT_REJECTED';
 console.log(JSON.stringify({status:code.includes('COMMIT_UNCERTAIN')?'OUTCOME_UNCERTAIN_RECONCILIATION_REQUIRED':'REJECTED_POSSIBLE_QUARANTINED_ARCHIVES',code,automaticRetry:false,servicesStarted:false,externalDispatchResumeAuthorized:false}));process.exitCode=1;
}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
