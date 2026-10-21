import {readFile,lstat} from 'node:fs/promises';
import {formalProfileFingerprint} from '../packages/config/src/formal-profile.js';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {Database} from '../packages/storage/src/database.js';
const args=process.argv.slice(2),mode=args.shift()??'plan';
if(!['plan','authorize','revoke'].includes(mode)||args.length%2)throw Error('USAGE: formal-runtime plan|authorize|revoke --profile <private-json> [--expected-profile-hash <sha256> --review-ref <reference> --reason <revoke-reason>]');
const flags=new Map<string,string>();for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--profile','--expected-profile-hash','--review-ref','--reason'].includes(key)||flags.has(key)||!value)throw Error('FORMAL_ARGUMENT_INVALID');flags.set(key,value);}
const path=flags.get('--profile');if(!path)throw Error('FORMAL_PROFILE_REQUIRED');
const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>131072)throw Error('FORMAL_PRIVATE_PROFILE_REQUIRED');
const frozen=formalProfileFingerprint(JSON.parse(await readFile(path,'utf8'))),profile=frozen.profile;
if(mode==='plan'){
 if(flags.size!==1)throw Error('FORMAL_PLAN_PROFILE_ONLY');
 console.log(JSON.stringify({mode:'PLAN_ONLY',profileHash:frozen.hash,authorizationId:profile.authorizationId,sourceTrialProfileHash:profile.sourceTrialProfileHash,entrypoints:profile.entrypoints,validFrom:profile.validFrom,validUntil:profile.validUntil,modelAllowed:profile.modelAllowed,capabilityCount:profile.capabilities.length,databaseAccess:false,activation:false}));
}else{
 const review=flags.get('--review-ref');if(flags.get('--expected-profile-hash')!==frozen.hash||!review||!(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/).test(review))throw Error('FORMAL_REVIEWED_PROFILE_REQUIRED');
 if(mode==='authorize'&&(flags.has('--reason')||review!==profile.approvalReference))throw Error('FORMAL_APPROVAL_REFERENCE_MISMATCH');
 const reason=flags.get('--reason');if(mode==='revoke'&&(!reason||reason.length>128))throw Error('FORMAL_REVOCATION_REASON_REQUIRED');
 // Only the explicit write modes read configured credentials. Neither mode
 // starts services, changes budgets or overwrites the private profile.
 loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url)throw Error('MIGRATION_DATABASE_URL_REQUIRED');const db=new Database(url);
 try{
  if(!await db.ready())throw Error('FORMAL_SCHEMA_NOT_READY');
  if((await db.pool.query('SELECT current_user role')).rows[0].role!=='oa_migrator')throw Error('FORMAL_MIGRATOR_REQUIRED');
  const state=mode==='authorize'?(await db.pool.query('SELECT public.oa_formal_authorize($1,$2,$3) state',[frozen.serialized,profile.sourceTrialProfileHash,review])).rows[0].state:(await db.pool.query('SELECT public.oa_formal_revoke($1,$2,$3,$4) state',[profile.authorizationId,frozen.hash,reason,review])).rows[0].state;
  console.log(JSON.stringify({mode:mode.toUpperCase(),state,servicesStarted:false,budgetWrites:false}));
 }finally{await db.close();}
}
