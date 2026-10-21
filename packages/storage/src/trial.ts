import type pg from 'pg';
import type {Database,DbContext} from './database.js';
import {groupGovernance,groupGovernanceSchema} from '../../groups/src/governance.js';
export type TrialState={mode?:'TRIAL'|'FORMAL';channel?:'GROUP';authorizationId?:string;budgetPolicyHash?:string;modelAllowed?:boolean;capabilities?:{id:string;version:string;bindingHash:string}[];inputPolicy?:{attachments:boolean;controls:boolean};restricted:boolean;allowed:boolean;reason:string|null;state?:string;taskId?:string;runId?:string;msgId?:string;deadline?:string;duplicate?:boolean};
export class TrialStopped extends Error {
 constructor(readonly reason:string){super(reason);}
}
export async function trialState(c:pg.PoolClient,runId?:string,recovery=false,closeReason?:string):Promise<TrialState>{
 return (await c.query('SELECT public.oa_trial_check($1,$2,$3) state',[runId??null,recovery,closeReason??null])).rows[0].state as TrialState;
}
export async function assertTrial(c:pg.PoolClient,runId:string):Promise<void>{
 const state=await trialState(c,runId);if(state.restricted&&!state.allowed)throw new TrialStopped(state.reason??'TRIAL_DENIED');
}
// FORMAL monitoring reads the same committed schema69 predicates through MVCC.
// Dispatch still uses the authoritative oa_trial_check/assertTrial row locks.
// Slow bounded reads can hold those locks; a separate monitoring connection must
// continue observing current authorization rather than time out behind its own run.
async function observeFormalAuthority(c:pg.PoolClient,runId:string):Promise<TrialState>{
 // Match oa_formal_state's UTC serialization of the immutable trial snapshot.
 await c.query("SET LOCAL timezone='UTC'");
 const q=await c.query<{state:TrialState}>(`
 WITH settings AS (
  SELECT nullif(current_setting('app.tenant_id',true),'')::uuid tenant,
   nullif(current_setting('app.actor_id',true),'')::uuid actor,
   nullif(current_setting('app.formal_profile_hash',true),'') attestation
 ), slot AS (
  SELECT s.* FROM public.one_shot_trials s,settings x WHERE s.tenant_id=x.tenant
 ), reviewed_auth AS (
  SELECT a.* FROM public.formal_authorizations a,settings x
   WHERE a.tenant_id=x.tenant AND a.owner_id=x.actor AND a.profile_hash=x.attestation
 ), observation AS (
  SELECT CASE
   WHEN s.tenant_id IS NULL OR s.owner_id IS DISTINCT FROM x.actor OR s.state<>'CLOSED'
    THEN 'FORMAL_CLOSED_TRIAL_BINDING_REQUIRED'
   WHEN a.id IS NULL THEN 'FORMAL_PROFILE_NOT_AUTHORIZED'
   WHEN a.state<>'AUTHORIZED' THEN 'FORMAL_AUTHORIZATION_REVOKED'
   WHEN a.valid_from>clock_timestamp() OR a.valid_until<=clock_timestamp() THEN 'FORMAL_AUTHORIZATION_EXPIRED'
   WHEN a.source_trial_profile_hash IS DISTINCT FROM s.profile_hash
    OR a.source_trial_snapshot_hash IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')
    THEN 'FORMAL_TRIAL_TOMBSTONE_CHANGED'
   WHEN NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.tenant_id=u.tenant_id
    WHERE u.tenant_id=x.tenant AND u.id=x.actor AND u.status='ACTIVE' AND t.status='ACTIVE'
     AND u.auth_epoch=a.auth_epoch AND u.external_user_id=s.external_user_id AND t.corp_id=s.corp_id)
    THEN 'FORMAL_IDENTITY_CHANGED'
   WHEN $1::uuid=s.run_id THEN 'CLOSED_TRIAL_RUN_NEVER_RESUMES'
   WHEN NOT EXISTS(SELECT 1 FROM public.formal_admissions r
    WHERE r.tenant_id=x.tenant AND r.owner_id=x.actor AND r.authorization_id=a.id AND r.candidate_run_id=$1::uuid
     AND (r.run_id IS NOT NULL OR r.admitted_txid=txid_current())) THEN 'FORMAL_RUN_NOT_ADMITTED'
   ELSE NULL END reason
  FROM settings x LEFT JOIN slot s ON true LEFT JOIN reviewed_auth a ON true
 ) SELECT jsonb_build_object('mode','FORMAL','restricted',true,'allowed',reason IS NULL,'reason',reason) state FROM observation
 `,[runId]);
 if(q.rows.length!==1||q.rows[0]!.state.mode!=='FORMAL'||q.rows[0]!.state.restricted!==true||typeof q.rows[0]!.state.allowed!=='boolean')throw Error('FORMAL_OBSERVATION_AMBIGUOUS');
 return q.rows[0]!.state;
}
async function observeGroupContract(c:pg.PoolClient,runId:string){
 const row=(await c.query("SELECT t.audience,t.control_kind FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.id=$1 AND r.owner_id=nullif(current_setting('app.actor_id',true),'')::uuid",[runId])).rows[0];
 if(!row||row.audience?.kind!=='GROUP')return null;
 const groupId=row.audience.targetId;if(typeof groupId!=='string'||!groupId.length)throw Error('GROUP_CONTRACT_CONTEXT_UNAVAILABLE');
 const state=row.control_kind==='GROUP_CASE'?groupGovernanceSchema.parse((await c.query('SELECT public.oa_group_case_native_watch($1) value',[runId])).rows[0]?.value):await groupGovernance(c,groupId);return {key:JSON.stringify({groupId,state}),allowed:state.allowed,deadline:state.mode==='CONTRACT'?state.deadline:null};
}
export async function watchTrial(db:Database,ctx:DbContext,runId:string){
 const controller=new AbortController(),authority=db.forkForAuthority(1,1000);let pending:Promise<void>|undefined,formalObservation=false;
 let initialGroup:Awaited<ReturnType<typeof observeGroupContract>>=null;
 const poll=async()=>{try{const observed=await authority.scope(ctx,async c=>({state:await (formalObservation?observeFormalAuthority(c,runId):trialState(c,runId,true)),group:initialGroup?await observeGroupContract(c,runId):null}));if(observed.state.restricted&&!observed.state.allowed)controller.abort(new TrialStopped(observed.state.reason??'TRIAL_DENIED'));if(initialGroup&&(!observed.group?.allowed||observed.group.key!==initialGroup.key))controller.abort(new TrialStopped('GROUP_CONTRACT_CHANGED'));}catch{controller.abort(new TrialStopped('TRIAL_AUTHORITY_UNAVAILABLE'));}};
 const started=performance.now(),sample=await db.scope(ctx,async c=>{const state=await trialState(c,runId,true),group=await observeGroupContract(c,runId),deadlines=[state.deadline,group?.deadline].filter((v):v is string=>typeof v==='string');const deadline=deadlines.reduce<string|null>((prior,next)=>prior===null||Date.parse(next)<Date.parse(prior)?next:prior,null);const remaining=deadline?(await c.query('SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 ms',[deadline])).rows[0].ms as number:null;return {state,group,remaining};}),initial=sample.state;initialGroup=sample.group;formalObservation=initial.mode==='FORMAL';
 if(!initial.restricted&&!initialGroup){await authority.close();return {signal:controller.signal,stop:async()=>{}};}
 if(initial.restricted&&!initial.allowed)controller.abort(new TrialStopped(initial.reason??'TRIAL_DENIED'));
 if(initialGroup&&!initialGroup.allowed)controller.abort(new TrialStopped('GROUP_CONTRACT_CHANGED'));
 // Monotonic local fallback remains independent of a blocked authority query.
 // Subtract the entire initial DB roundtrip conservatively; host wall-clock
 // skew never grants extra time. The database still authorizes every dispatch.
 // Native timers accept at most 2^31-1 ms. Keep the same conservative
 // monotonic deadline across chunks instead of overflowing a long contract.
 const hardStopAt=sample.remaining===null?null:started+Math.floor(sample.remaining);let hardStop:ReturnType<typeof setTimeout>|undefined;
 const armHardStop=()=>{if(hardStopAt===null||controller.signal.aborted)return;hardStop=setTimeout(()=>{if(performance.now()<hardStopAt)armHardStop();else controller.abort(new TrialStopped(initial.restricted?'TRIAL_DEADLINE':'GROUP_CONTRACT_EXPIRED'));},Math.min(2147483647,Math.max(0,hardStopAt-performance.now())));hardStop.unref();};armHardStop();
 const timer=setInterval(()=>{if(!pending&&!controller.signal.aborted)pending=poll().finally(()=>{pending=undefined;});},100);timer.unref();
 return {signal:controller.signal,stop:async()=>{clearInterval(timer);clearTimeout(hardStop);await pending;await authority.close();}};
}
