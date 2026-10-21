import {dirname} from 'node:path';
import {lstat} from 'node:fs/promises';
import {z} from 'zod';
import {readFinitePrivatePilotProfile} from '../packages/config/src/finite-private-pilot.js';
import {formalProfileFingerprint} from '../packages/config/src/formal-profile.js';
import {readOperationsPrivateFile} from '../packages/operations/src/private-file.js';
import {canonical} from '../packages/gateway/src/index.js';
import {hash} from '../packages/storage/src/crypto.js';
import {Database} from '../packages/storage/src/database.js';
import {requiredSchema} from '../packages/storage/src/schema.js';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
async function main(){
 const [mode='plan',...args]=process.argv.slice(2);if(!['plan','install'].includes(mode)||args.length%2)throw Error('FINITE_PILOT_ARGUMENT_INVALID');
 const flags=new Map<string,string>();for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--profile','--formal-profile','--manifest-id','--descriptor-hash','--expected-plan-hash','--review-ref'].includes(key)||flags.has(key)||!value)throw Error('FINITE_PILOT_ARGUMENT_INVALID');flags.set(key,value);}
 const path=flags.get('--profile'),formalPath=flags.get('--formal-profile');if(!path||!formalPath)throw Error('FINITE_PILOT_PRIVATE_PROFILES_REQUIRED');
 const pilot=await readFinitePrivatePilotProfile(path),parent=await lstat(dirname(formalPath));if((parent.mode&0o777)!==0o700)throw Error('FINITE_PILOT_PRIVATE_PROFILES_REQUIRED');
 const bytes=await readOperationsPrivateFile(formalPath,131072);let formal:ReturnType<typeof formalProfileFingerprint>;try{formal=formalProfileFingerprint(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}finally{bytes.fill(0);}
 const manifestId=z.uuid().parse(flags.get('--manifest-id')),descriptorHash=sha.parse(flags.get('--descriptor-hash')),p=pilot.document;
 if(formal.profile.schemaVersion!==1||formal.hash!==p.formalProfileHash||formal.profile.authorizationId!==p.formalAuthorizationId||formal.profile.tenantId!==p.tenantId||formal.profile.actorId!==p.actorId||formal.profile.sourceTrialProfileHash!==p.sourceTrialProfileHash||formal.profile.modelApprovalReference!==p.modelApprovalReference||formal.profile.budgetPolicyHash!==p.budgetPolicyHash||formal.profile.corpId!==p.corpId||formal.profile.externalUserId!==p.externalUserId||formal.profile.robotCode!==p.robotCode||formal.profile.conversationId!==p.conversationId||Date.parse(p.validFrom)<Date.parse(formal.profile.validFrom)||Date.parse(p.expiresAt)>Date.parse(formal.profile.validUntil)||formal.profile.inputPolicy.attachments||formal.profile.inputPolicy.controls||formal.profile.capabilities.length!==1||formal.profile.capabilities[0]?.id!=='company.agent.ask')throw Error('FINITE_PILOT_FORMAL_BINDING_MISMATCH');
 if(p.enterpriseCost.kind!=='FIXED_INTERNAL'||p.enterpriseCost.maxAmountMinor!==0)throw Error('FINITE_PILOT_COMPANY_COVERED_COST_DECLARATION_REQUIRED');
 const plan={schemaVersion:1,purpose:'FINITE_PRIVATE_PILOT_INSTALL',profileHash:pilot.hash,pilotKey:pilot.pilotKey,formalProfileHash:formal.hash,manifestId,descriptorHash,sourceSchemaHash:requiredSchema.contractHash},planHash=hash(canonical(plan));
 if(mode==='plan'){
  if(flags.size!==4)throw Error('FINITE_PILOT_PLAN_ONLY');console.log(JSON.stringify({status:'PLAN_ONLY',planHash,profileHash:pilot.hash,pilotKey:pilot.pilotKey,sourceSchemaHash:requiredSchema.contractHash,expiresAt:p.expiresAt,maxModelRequests:p.maxModelRequests,maxEnterpriseRequests:1,maxPhysicalMessages:1,modelCurrency:'CNY',modelMaxAmountMinor:p.modelMaxAmountMinor,enterpriseCostBasis:'USER_DECLARED_COMPANY_COVERED_NO_INCREMENTAL_CHARGE',databaseAccess:false,installed:false,servicesStarted:false}));return;
 }
 if(flags.size!==6||flags.get('--expected-plan-hash')!==planHash||flags.get('--review-ref')!==p.reviewReference)throw Error('FINITE_PILOT_EXACT_INSTALL_REVIEW_REQUIRED');
 if(Date.parse(p.validFrom)>Date.now()||Date.parse(p.expiresAt)<=Date.now())throw Error('FINITE_PILOT_WINDOW_INVALID');
 // Only this explicit, exact-plan install branch loads connection credentials.
 // It creates no model budget, does not start services and never sends a message.
 loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url)throw Error('FINITE_PILOT_MIGRATION_CONNECTION_REQUIRED');const db=new Database(url,1,8000);
 try{
  if(!await db.ready())throw Error('FINITE_PILOT_SCHEMA_NOT_READY');if((await db.pool.query('SELECT current_user role')).rows[0].role!=='oa_migrator')throw Error('FINITE_PILOT_MIGRATOR_REQUIRED');
  const c=await db.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
   await c.query('SELECT public.oa_finite_private_pilot_bootstrap($1,$2,$3,$4,$5,$6,$7)',[pilot.serialized,pilot.hash,pilot.pilotKey,formal.serialized,manifestId,descriptorHash,p.enterpriseApprovalReference]);
   if(Date.parse(p.expiresAt)<=Date.now())throw Error('FINITE_PILOT_WINDOW_INVALID');await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  console.log(JSON.stringify({status:'INSTALLED',planHash,profileHash:pilot.hash,servicesStarted:false,modelCalls:0,enterpriseCalls:0,messagesSent:0,budgetWrites:false}));
 }finally{await db.close();}
}
try{await main();}catch(error){const code=error instanceof Error&&/^(?:FINITE_PILOT|FINITE_PRIVATE_PILOT|FORMAL)_[A-Z0-9_]+$/.test(error.message)?error.message:'FINITE_PILOT_INSTALL_NOT_CONFIRMED';console.error(JSON.stringify({status:'NOT_CONFIRMED',code,automaticRetry:false}));process.exitCode=1;}
