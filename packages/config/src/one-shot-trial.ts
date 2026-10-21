import type {LifecycleService} from './formal-profile.js';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {loadModelBudgetPolicy} from '../../runtime/src/budget-policy.js';
export const trialProfileSchema=z.object({schemaVersion:z.literal(1),tenantId:z.uuid(),actorId:z.uuid(),corpId:z.string().min(1),externalUserId:z.string().min(1),robotCode:z.string().min(1),conversationId:z.string().min(1),deadline:z.iso.datetime({offset:true}),budgetPolicyHash:z.string().regex(/^[a-f0-9]{64}$/),approvalReference:z.string().min(1)}).strict();
export type TrialProfile=z.infer<typeof trialProfileSchema>;
// Loading a file never arms a trial. Provisioning is a separate, explicit
// migrator operation. Missing/changed files cannot fall through to full mode.
export async function initializeTrial(db:Database,env:NodeJS.ProcessEnv=process.env,scopes:DbContext[]=[],service?:LifecycleService):Promise<TrialProfile|null>{
 if(env['FORMAL_RUNTIME_PROFILE_FILE'])throw Error('LIFECYCLE_ENTRYPOINT_REQUIRED');
 const path=env['ONE_SHOT_TRIAL_PROFILE_FILE'],profile=path?trialProfileSchema.parse(JSON.parse(await readFile(path,'utf8'))):null;
 db.trialProfileHash=profile?hash(JSON.stringify(profile)):null;
 const inspect=(c:Pick<import('pg').PoolClient,'query'>)=>service?c.query('SELECT public.oa_lifecycle_bootstrap($1,NULL,$2) state',[db.trialProfileHash,service]):c.query('SELECT public.oa_trial_bootstrap($1) state',[db.trialProfileHash]);
 if(!profile&&scopes.length){for(const scope of scopes){const check=(await db.scope(scope,inspect)).rows[0].state;if(check)throw Error('TRIAL_STARTUP_BLOCKED');}return null;}
 const result=(profile?await db.scope({tenantId:profile.tenantId,actorId:profile.actorId},inspect):await inspect(db.pool)).rows[0].state as {blocked?:boolean;tenantId?:string;actorId?:string;corpId?:string;robotCode?:string;budgetPolicyHash?:string}|null;
 if(result?.blocked||!!profile!==!!result)throw Error('TRIAL_STARTUP_BLOCKED');
 if(profile){
  if(result?.tenantId!==profile.tenantId||result.actorId!==profile.actorId||result.corpId!==profile.corpId||result.robotCode!==profile.robotCode||result.budgetPolicyHash!==profile.budgetPolicyHash)throw Error('TRIAL_PROFILE_BINDING_MISMATCH');
  const budget=loadModelBudgetPolicy();if(!budget.policy||hash(JSON.stringify(budget.policy))!==profile.budgetPolicyHash)throw Error('TRIAL_BUDGET_POLICY_MISMATCH');
 }
 return profile;
}
export function assertTrialScopes(profile:TrialProfile|null,scopes:DbContext[]){if(profile&&(scopes.length!==1||scopes[0]?.tenantId!==profile.tenantId||scopes[0]?.actorId!==profile.actorId))throw Error('TRIAL_WORKER_SCOPE_MISMATCH');}
export function assertTrialBinding(profile:TrialProfile|null,corpId:string|undefined,robotCode:string|undefined){if(profile&&(profile.corpId!==corpId||profile.robotCode!==robotCode))throw Error('TRIAL_CONNECTOR_BINDING_MISMATCH');}
