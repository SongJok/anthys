import {lstat,readFile} from 'node:fs/promises';
import {groupDelegationFingerprint} from '../packages/config/src/group-contract-delegation.js';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {Database} from '../packages/storage/src/database.js';
const args=process.argv.slice(2),mode=args.shift()??'plan',flags=new Map<string,string>();
if(!['plan','approve','revoke'].includes(mode)||args.length%2)throw Error('GROUP_DELEGATION_USAGE');
for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--profile','--expected-profile-hash','--review-ref'].includes(key)||flags.has(key)||!value)throw Error('GROUP_DELEGATION_ARGUMENT_INVALID');flags.set(key,value);}
const path=flags.get('--profile');if(!path)throw Error('GROUP_DELEGATION_PROFILE_REQUIRED');const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>65536)throw Error('GROUP_DELEGATION_PRIVATE_PROFILE_REQUIRED');
let frozen:ReturnType<typeof groupDelegationFingerprint>;
try{frozen=groupDelegationFingerprint(JSON.parse(await readFile(path,'utf8')));}catch{throw Error('GROUP_DELEGATION_PROFILE_INVALID');}
if(mode==='plan'){
 if(flags.size!==1)throw Error('GROUP_DELEGATION_PLAN_PROFILE_ONLY');console.log(JSON.stringify({mode:'PLAN_ONLY',profileHash:frozen.hash,validUntil:frozen.document.validUntil,authority:'REVIEWED_DELEGATION',platformPermissionsVerified:false,databaseAccess:false,servicesStarted:false}));
}else{
 const review=flags.get('--review-ref');if(flags.size!==3||flags.get('--expected-profile-hash')!==frozen.hash||!review||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/.test(review)||mode==='approve'&&review!==frozen.document.reviewReference)throw Error('GROUP_DELEGATION_EXACT_REVIEW_REQUIRED');
 loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url)throw Error('MIGRATION_DATABASE_URL_REQUIRED');const db=new Database(url);
 try{if(!await db.ready())throw Error('GROUP_DELEGATION_SCHEMA_NOT_READY');if((await db.pool.query('SELECT current_user role')).rows[0].role!=='oa_migrator')throw Error('GROUP_DELEGATION_MIGRATOR_REQUIRED');
  const result=mode==='approve'?await db.pool.query('SELECT public.oa_group_contract_delegate($1,$2,$3) value',[frozen.serialized,frozen.hash,review]):await db.pool.query('SELECT public.oa_group_contract_delegation_revoke($1,$2,$3) value',[frozen.document.id,frozen.hash,review]);
  console.log(JSON.stringify({mode:mode.toUpperCase(),state:result.rows[0].value,servicesStarted:false,credentialsOrRolesChanged:false}));
 }catch{throw Error('GROUP_DELEGATION_OPERATION_FAILED');}finally{await db.close();}
}
