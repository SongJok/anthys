import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readGroupReminderRuntimeProfile} from '../packages/config/src/group-reminder-runtime.js';
import {loadEnvFile,config,secret} from '../packages/config/src/index.js';
import {Database} from '../packages/storage/src/database.js';
import {Vault} from '../packages/storage/src/crypto.js';
import {configureDws} from '../packages/dws/src/configuration.js';
import {DingTalkSender} from '../packages/dingtalk/src/sender.js';
import {runReviewedGroupReminderCycle} from '../packages/groups/src/reminder-cycle.js';
export async function groupReminderRuntimeCommand(args:readonly string[]){
 const [mode='plan',...rest]=args,flags=new Map<string,string>();if(!['plan','run-once'].includes(mode)||rest.length%2)throw Error('GROUP_REMINDER_RUNTIME_USAGE');
 for(let i=0;i<rest.length;i+=2){const key=rest[i]!,value=rest[i+1]!;if(!['--profile','--expected-profile-hash','--review-ref'].includes(key)||flags.has(key)||!value)throw Error('GROUP_REMINDER_RUNTIME_ARGUMENT_INVALID');flags.set(key,value);}
 const path=flags.get('--profile');if(!path)throw Error('GROUP_REMINDER_RUNTIME_PROFILE_REQUIRED');const frozen=await readGroupReminderRuntimeProfile(path);
 if(mode==='plan'){if(flags.size!==1)throw Error('GROUP_REMINDER_RUNTIME_PLAN_PROFILE_ONLY');return {mode:'PLAN_ONLY',profileHash:frozen.hash,expiresAt:frozen.document.expiresAt,maxNotifications:frozen.document.maxNotifications,modelCalls:0,databaseAccess:false,servicesStarted:false,messagesSent:0};}
 if(flags.size!==3||flags.get('--expected-profile-hash')!==frozen.hash||flags.get('--review-ref')!==frozen.document.reviewReference)throw Error('GROUP_REMINDER_RUNTIME_EXACT_REVIEW_REQUIRED');
 // A separately approved operator command is required even after plan. No env
 // toggle or default service startup can invoke this finite sending path.
 loadEnvFile();if(process.env['ONE_SHOT_TRIAL_PROFILE_FILE']||process.env['FORMAL_RUNTIME_PROFILE_FILE'])throw Error('GROUP_REMINDER_RUNTIME_LIFECYCLE_BLOCKED');
 const cfg=config(),required=(key:string)=>{const v=secret(key);if(!v)throw Error('GROUP_REMINDER_RUNTIME_CONFIGURATION_REQUIRED');return v;},db=new Database(required('RUNTIME_DATABASE_URL'),4),controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{if(!await db.ready())throw Error('GROUP_REMINDER_RUNTIME_SCHEMA_NOT_READY');const vault=new Vault(new Map([['1',Buffer.from(required('APP_MASTER_KEY'),'hex')]]),'1'),identities=await configureDws(db,vault),binding={corpId:required('DINGTALK_CORP_ID'),robotCode:required('DINGTALK_ROBOT_CODE'),appOrigin:cfg.APP_ORIGIN},sender=new DingTalkSender({clientId:required('DINGTALK_CLIENT_ID'),clientSecret:required('DINGTALK_CLIENT_SECRET'),robotCode:binding.robotCode,replyOnly:cfg.DINGTALK_REPLY_ONLY==='true'});return await runReviewedGroupReminderCycle({db,vault,identities,sender,binding},frozen.document,controller.signal);}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await db.close();}
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href)await groupReminderRuntimeCommand(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('GROUP_REMINDER_RUNTIME_FAILED');process.exitCode=1;});
