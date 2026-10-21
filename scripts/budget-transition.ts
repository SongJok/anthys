import {lstat,readFile} from 'node:fs/promises';
import {budgetTransitionFingerprint} from '../packages/config/src/budget-transition.js';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {Database} from '../packages/storage/src/database.js';
const args=process.argv.slice(2),mode=args.shift()??'plan',flags=new Map<string,string>();
if(!['plan','authorize'].includes(mode)||args.length%2)throw Error('BUDGET_TRANSITION_USAGE');
for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--request','--policy','--profile','--expected-request-hash','--review-ref'].includes(key)||flags.has(key)||!value)throw Error('BUDGET_TRANSITION_ARGUMENT_INVALID');flags.set(key,value);}
async function document(key:string){const path=flags.get(key);if(!path)throw Error('BUDGET_TRANSITION_DOCUMENT_REQUIRED');const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>131072)throw Error('BUDGET_TRANSITION_PRIVATE_DOCUMENT_REQUIRED');return JSON.parse(await readFile(path,'utf8')) as unknown;}
const frozen=budgetTransitionFingerprint(await document('--request'),await document('--policy'),await document('--profile'));
if(mode==='plan'){
 if(flags.size!==3)throw Error('BUDGET_TRANSITION_PLAN_DOCUMENTS_ONLY');
 console.log(JSON.stringify({mode:'PLAN_ONLY',requestHash:frozen.hash,policyHash:frozen.policyHash,formalProfileHash:frozen.formal.hash,validUntil:frozen.policy.validUntil,windowOnlyProtocol:true,databaseAccess:false,activation:false}));
}else{
 if(flags.size!==5||flags.get('--expected-request-hash')!==frozen.hash||flags.get('--review-ref')!==frozen.request.reviewReference)throw Error('BUDGET_TRANSITION_EXACT_REVIEW_REQUIRED');
 // Only this explicit mode loads credentials; SQL performs CAS, immutable
 // snapshots, window-only comparison and formal authorization atomically.
 loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url)throw Error('MIGRATION_DATABASE_URL_REQUIRED');const db=new Database(url);
 try{if(!await db.ready())throw Error('BUDGET_TRANSITION_SCHEMA_NOT_READY');if((await db.pool.query('SELECT current_user role')).rows[0].role!=='oa_migrator')throw Error('BUDGET_TRANSITION_MIGRATOR_REQUIRED');
  const state=(await db.pool.query('SELECT public.oa_budget_transition_authorize($1,$2,$3) state',[frozen.serialized,frozen.policyText,frozen.formal.serialized])).rows[0].state;
  console.log(JSON.stringify({mode:'AUTHORIZED',state,servicesStarted:false,ledgerOrBucketWrites:false,profileFilesWritten:false}));
 }finally{await db.close();}
}
