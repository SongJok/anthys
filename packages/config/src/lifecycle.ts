import {readFile,lstat} from 'node:fs/promises';
import {initializeTrial,assertTrialScopes,assertTrialBinding,type TrialProfile} from './one-shot-trial.js';
import {formalProfileFingerprint,type FormalProfile,type LifecycleService} from './formal-profile.js';
import type {Database,DbContext} from '../../storage/src/database.js';
import {loadModelBudgetPolicy} from '../../runtime/src/budget-policy.js';
import {hash} from '../../storage/src/crypto.js';
export type Lifecycle={mode:'DEFAULT';profile:null}|{mode:'TRIAL';profile:TrialProfile}|{mode:'FORMAL';profile:FormalProfile};
export async function initializeLifecycle(db:Database,env:NodeJS.ProcessEnv,scopes:DbContext[],service:LifecycleService):Promise<Lifecycle>{
 const path=env['FORMAL_RUNTIME_PROFILE_FILE'];db.formalProfileHash=null;
 if(!path){const trial=await initializeTrial(db,env,scopes,service);return trial?{mode:'TRIAL',profile:trial}:{mode:'DEFAULT',profile:null};}
 if(env['ONE_SHOT_TRIAL_PROFILE_FILE'])throw Error('LIFECYCLE_PROFILE_CONFLICT');
 const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||file.size>131072)throw Error('FORMAL_PRIVATE_PROFILE_REQUIRED');
 const frozen=formalProfileFingerprint(JSON.parse(await readFile(path,'utf8'))),profile=frozen.profile;
 if(!profile.entrypoints.includes(service))throw Error('FORMAL_ENTRYPOINT_NOT_APPROVED');
 if(!scopes.length||scopes.some(s=>s.tenantId!==profile.tenantId)||!['INGRESS','API'].includes(service)&&(scopes.length!==1||scopes[0]?.actorId!==profile.actorId))throw Error('FORMAL_SERVICE_SCOPE_MISMATCH');
 db.trialProfileHash=null;db.formalProfileHash=frozen.hash;
 const result=(await db.scope({tenantId:profile.tenantId,actorId:profile.actorId},c=>c.query('SELECT public.oa_lifecycle_bootstrap($1,$2,$3) state',[null,frozen.hash,service]))).rows[0].state as {blocked?:boolean;mode?:string;authorizationId?:string;tenantId?:string;actorId?:string;corpId?:string;robotCode?:string;budgetPolicyHash?:string}|null;
 if(!result||result.blocked||result.mode!=='FORMAL')throw Error('FORMAL_STARTUP_BLOCKED');
 if(result.authorizationId!==profile.authorizationId||result.tenantId!==profile.tenantId||result.actorId!==profile.actorId||result.corpId!==profile.corpId||result.robotCode!==profile.robotCode||result.budgetPolicyHash!==profile.budgetPolicyHash)throw Error('FORMAL_PROFILE_BINDING_MISMATCH');
 const budget=loadModelBudgetPolicy(env);if(!budget.policy||hash(JSON.stringify(budget.policy))!==profile.budgetPolicyHash||Date.parse(budget.policy.validUntil)<=Date.now())throw Error('FORMAL_BUDGET_POLICY_MISMATCH');
 return {mode:'FORMAL',profile};
}
export function assertLifecycleScopes(lifecycle:Lifecycle,scopes:DbContext[]){if(lifecycle.mode==='TRIAL')return assertTrialScopes(lifecycle.profile,scopes);if(lifecycle.mode==='FORMAL'&&(scopes.length!==1||scopes[0]?.tenantId!==lifecycle.profile.tenantId||scopes[0]?.actorId!==lifecycle.profile.actorId))throw Error('FORMAL_WORKER_SCOPE_MISMATCH');}
export function assertLifecycleBinding(lifecycle:Lifecycle,corpId:string|undefined,robotCode:string|undefined){if(lifecycle.mode==='TRIAL')return assertTrialBinding(lifecycle.profile,corpId,robotCode);if(lifecycle.mode==='FORMAL'&&(corpId!==lifecycle.profile.corpId||robotCode!==lifecycle.profile.robotCode))throw Error('FORMAL_CONNECTOR_BINDING_MISMATCH');}
export function copyLifecycleAttestation(from:Database,to:Database){to.trialProfileHash=from.trialProfileHash;to.formalProfileHash=from.formalProfileHash;}
