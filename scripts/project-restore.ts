import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readOperationsPrivateFile} from '../packages/operations/src/private-file.js';
import {planProjectRestore,restoreProject} from '../packages/operations/src/project-restore.js';

export async function projectRestoreCommand(args:readonly string[],signal:AbortSignal){
 signal.throwIfAborted();const [action,...rest]=args;
 if(!['plan','restore'].includes(action??'')||rest.length%2)throw Error('RESTORE_CLI_USAGE');
 const allowed=action==='plan'?['--profile']:['--profile','--expect-profile-hash','--review-reference'],flags=new Map<string,string>();
 for(let i=0;i<rest.length;i+=2){const key=rest[i]!,value=rest[i+1]!;if(!allowed.includes(key)||flags.has(key)||!value||value.startsWith('--'))throw Error('RESTORE_CLI_USAGE');flags.set(key,value);}
 if(allowed.some(key=>!flags.has(key)))throw Error('RESTORE_CLI_USAGE');
 const bytes=await readOperationsPrivateFile(flags.get('--profile')!,65536);let raw:unknown;
 try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
 signal.throwIfAborted();const plan=planProjectRestore(raw);
 if(action==='plan')return plan.summary;
 const result=await restoreProject(plan.profile,{expectedProfileHash:flags.get('--expect-profile-hash')!,reviewReference:flags.get('--review-reference')!},signal);
 // Only reviewed digests/status on stdout; sealed output stays at the exact
 // profile-pinned path. Recovery does not authorize a service or external replay.
 const {restoredRoot,...summary}=result;return {...summary,restoredRootSha256:createHash('sha256').update(restoredRoot).digest('hex')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{console.log(JSON.stringify(await projectRestoreCommand(process.argv.slice(2),controller.signal)));}
 catch(error){const candidate=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof Error?error.message:'';
  console.log(JSON.stringify({status:'REJECTED_OR_QUARANTINED_RECONCILIATION_REQUIRED',code:/^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)?candidate:'RESTORE_PRIVATE_INPUT_OR_PROFILE_REJECTED',automaticRetry:false,servicesStarted:false,externalDispatchResumeAuthorized:false}));process.exitCode=1;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
