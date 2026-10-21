import {readFile,lstat,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {trialProfileSchema} from '../packages/config/src/one-shot-trial.js';
import {loadEnvFile,config} from '../packages/config/src/index.js';
import {hash} from '../packages/storage/src/crypto.js';
import {TrialSupervisor} from '../packages/runtime/src/trial-supervisor.js';
import {isolatedTrialFixtureAllowed} from '../packages/runtime/src/trial-supervision.js';
const argv=process.argv.slice(2),mode=argv.shift()??'plan';
if(!['plan','run'].includes(mode)||argv.length%2)throw Error('USAGE_TRIAL_RUNTIME_PLAN_OR_RUN');
const flags=new Map<string,string>();for(let i=0;i<argv.length;i+=2){const key=argv[i]!,value=argv[i+1]!;if(!['--profile','--expected-profile-hash','--review-ref','--runtime-dir'].includes(key)||flags.has(key)||!value)throw Error('TRIAL_ARGUMENT_INVALID');flags.set(key,value);}
const path=resolve(flags.get('--profile')??'');if(!flags.has('--profile'))throw Error('TRIAL_PROFILE_REQUIRED');
const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>131072)throw Error('TRIAL_PRIVATE_PROFILE_REQUIRED');
const profile=trialProfileSchema.parse(JSON.parse(await readFile(path,'utf8'))),profileHash=hash(JSON.stringify(profile));
if(mode==='plan'){
 if(flags.size!==1)throw Error('TRIAL_PLAN_PROFILE_ONLY');
 console.log(JSON.stringify({mode:'PLAN_ONLY',profileHash,deadline:profile.deadline,existingArmedSlotRequired:true,fixedWindowLimitMs:1200000,slotBindingAndRemainingTime:'NOT_CHECKED_OFFLINE',databaseAccess:false,activation:false}));
}else{
 if(flags.size!==4||flags.get('--expected-profile-hash')!==profileHash||flags.get('--review-ref')!==profile.approvalReference)throw Error('TRIAL_REVIEWED_PROFILE_REQUIRED');
 loadEnvFile();config();if(process.env['FORMAL_RUNTIME_PROFILE_FILE'])throw Error('TRIAL_FORMAL_PROFILE_CONFLICT');
 const directory=resolve(flags.get('--runtime-dir')!);await mkdir(directory,{recursive:true,mode:0o700});
 const fixture=isolatedTrialFixtureAllowed()&&process.env['OA_TRIAL_TEST_CLI_FIXTURE']==='idle';
 const controller=new TrialSupervisor({profilePath:path,profileHash,runtimeDirectory:directory,services:fixture?[{service:'ingress',fixture:'idle'},{service:'worker',fixture:'idle'},{service:'notifier',fixture:'idle'}]:[{service:'ingress'},{service:'worker'},{service:'notifier'}],env:process.env,onEvent:event=>{if(event.kind!=='PONG')console.log(JSON.stringify({kind:event.kind,...('service'in event?{service:event.service}:{}),...('pid'in event?{pid:event.pid}:{}),...('guardianPid'in event?{guardianPid:event.guardianPid}:{})}));}});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void controller.stop();});
 try{await controller.ready;
  // Fault injection exists only with the isolated test target/network guard.
  // It changes the launcher's fallback connection after the guardian is READY;
  // the production branch never substitutes a model, service or DB endpoint.
  if(fixture&&process.env['OA_TRIAL_TEST_PARENT_BLACKHOLE_PORT']==='64702'){delete process.env['RUNTIME_DATABASE_URL_FILE'];process.env['RUNTIME_DATABASE_URL']='postgresql://synthetic:synthetic@127.0.0.1:64702/blackhole';}
  console.log(JSON.stringify({kind:'TRIAL_SERVICES_READY',profileHash,deadline:profile.deadline}));const receipt=await controller.finished;console.log(JSON.stringify({kind:'TRIAL_STOPPED',receipt}));if(!receipt.databaseClosed||!receipt.ownedGroupsClosed)process.exitCode=78;}
  catch{console.error('TRIAL_SUPERVISION_FAILED_NO_PRIVATE_VALUES_PRINTED');process.exitCode=78;}
 process.exit(process.exitCode??0);
}
