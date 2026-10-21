import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {companyFixture,syntheticRepo,syntheticCommit,syntheticPath} from '../support/company-mcp.js';
import {registerCompanyCodeCapabilities} from '../../packages/company/src/code.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret,config} from '../../packages/config/src/index.js';
import {createServer} from '../../apps/api/src/server.js';
import {trialProfileSchema} from '../../packages/config/src/one-shot-trial.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {initializeLifecycle} from '../../packages/config/src/lifecycle.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {trialState} from '../../packages/storage/src/trial.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {AgentRuntime,registerTaskCapability} from '../../packages/runtime/src/loop.js';
import {ModelBudget} from '../../packages/runtime/src/model-budget.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {BudgetRecovery} from '../../packages/runtime/src/budget-recovery.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {glmRequestBody,type ModelProvider} from '../../packages/provider-glm/src/client.js';
import {RunQueue,runJobSchema} from '../../packages/tasks/src/queue.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,admin:pg.Pool;const connections:Database[]=[],directories:string[]=[];
// The source shared schema is never upgraded. The CLI's original readiness
// guard is exercised against a verified schema-only disposable candidate.
const isolatedUrl=(key:string)=>{const url=new URL(secret(key)!);url.pathname='/'+isolated.name;return url.href;};
beforeAll(async()=>{
 isolated=await groupReminderDatabase();await isolated.install();admin=isolated.root;expect(await isolated.db.ready()).toBe(true);
 // Schema-only restore deliberately excludes all queue jobs and metadata rows.
 // Copy only the independently checked installed queue version; production workers
 // retain migrate:false, and the shared source remains read-only.
 const source=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL'),max:1,connectionTimeoutMillis:3000,query_timeout:12000});
 try{
  const rows=(await source.query('SELECT version FROM oa_queue.version')).rows;
  expect(rows).toEqual([{version:46}]);expect((await admin.query('SELECT version FROM oa_queue.version')).rows).toEqual([]);
  await admin.query('INSERT INTO oa_queue.version(version) VALUES($1)',[rows[0].version]);
 }finally{await source.end();}
});
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
class AdmissionObservedDatabase extends Database {
 readonly admissions:Record<string,unknown>[]=[];
 override scope<T>(context:DbContext,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  return super.scope(context,client=>fn(new Proxy(client,{get:(target,key)=>{
   if(key!=='query')return Reflect.get(target,key,target);
   return async(...args:unknown[])=>{
    const result=await (Reflect.apply(target.query,target,args) as Promise<pg.QueryResult<{state?:Record<string,unknown>}>>);
    if(typeof args[0]==='string'&&args[0].includes('SELECT public.oa_lifecycle_admit(')){
     const state=result.rows[0]?.state??{},parameters=Array.isArray(args[1])?args[1]:[];
     this.admissions.push({allowed:state['allowed'],reason:state['reason'],mode:state['mode'],providerMs:parameters[8],cutoffMs:state['admissionCutoffMs']});
    }
    return result;
   };
  }})));
 }
}
afterEach(async()=>{await Promise.all(connections.splice(0).map(d=>d.close()));});
afterAll(async()=>{await Promise.all(connections.map(d=>d.close()));await isolated?.close();await Promise.all(directories.map(d=>rm(d,{recursive:true,force:true})));});
async function world(probeCeilBoundary=false){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='SYNTHETIC-'+ctx.tenantId,robotCode='synthetic-lifecycle',conversationId='synthetic-formal-dm';
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC LIFECYCLE','ACTIVE')",[ctx.tenantId,corpId]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const policy=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));policy.pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_LOCAL_ONLY',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};
 const profile=trialProfileSchema.parse({schemaVersion:1,...ctx,corpId,externalUserId:'owner',robotCode,conversationId,deadline:new Date(Date.now()+3600000).toISOString(),budgetPolicyHash:hash(JSON.stringify(policy)),approvalReference:'SYNTHETIC_TRIAL_ONLY'}),trialHash=hash(JSON.stringify(profile));
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,created_at) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,$8,CASE WHEN $9 THEN date_trunc('milliseconds',clock_timestamp())+interval '123 microseconds' ELSE clock_timestamp() END)",[ctx.tenantId,ctx.actorId,trialHash,profile.budgetPolicyHash,corpId,robotCode,conversationId,profile.deadline,probeCeilBoundary]);
 const db=new AdmissionObservedDatabase(isolatedUrl('RUNTIME_DATABASE_URL'));connections.push(db);db.trialProfileHash=trialHash;
 const store=new RuntimeStore(db,vault,new ModelBudget(policy)),gateway=new Gateway(store),ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,corpId,robotCode},store);
 const event=(patch:Record<string,unknown>={},id=randomUUID()):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:'owner',conversationId,conversationType:'1',robotCode,msgtype:'text',text:{content:'Explain the word hello.'},createAt:Date.now(),senderId:'owner-id',chatbotUserId:'bot-id',sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',sessionWebhookExpiredTime:Date.now()+60000,...patch})});
 // A millisecond SDK timestamp must follow the persisted microsecond authorization
 // cutoff. Observe the database clock; never sleep, backdate authority or retry admission.
 const freshEvent=async(patch:Record<string,unknown>={})=>{for(let attempt=0;attempt<100;attempt++){
  const row=await db.scope(ctx,async c=>(await c.query("SELECT public.oa_formal_state(NULL) state,ceil(extract(epoch FROM created_at)*1000)::text trial_cutoff_ms,floor(extract(epoch FROM clock_timestamp())*1000)::text event_ms FROM one_shot_trials WHERE tenant_id=$1 AND owner_id=$2",[ctx.tenantId,ctx.actorId])).rows[0]);
  if(row.state)expect(row.state).toMatchObject({mode:'FORMAL',allowed:true});
  const cutoff=Number(row.state?.admissionCutoffMs??row.trial_cutoff_ms),observed=Number(row.event_ms);expect(Number.isSafeInteger(cutoff)).toBe(true);expect(Number.isSafeInteger(observed)).toBe(true);
  if(observed>=cutoff){const current=event({...patch,createAt:observed});expect(JSON.parse(current.data).createAt).toBeGreaterThanOrEqual(cutoff);return current;}
 }throw Error('SYNTHETIC_FORMAL_EVENT_CLOCK_NOT_READY');};
 let oldEvent=await freshEvent();
 const snapshot=async()=>{const rows:Record<string,unknown>={};for(const table of ['one_shot_trials','one_shot_trial_admissions','tasks','runs','event_inbox','outbox','deliveries','quota_ledger','budget_buckets','budget_allocations','tool_actions','formal_admissions'])rows[table]=(await admin.query(`SELECT to_jsonb(t) value FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[ctx.tenantId])).rows;return rows;};
 if(probeCeilBoundary){
  const row=(await admin.query('SELECT floor(extract(epoch FROM created_at)*1000)::text floor_ms,ceil(extract(epoch FROM created_at)*1000)::text ceil_ms FROM one_shot_trials WHERE tenant_id=$1',[ctx.tenantId])).rows[0],cutoff=Number(row.ceil_ms);expect(Number(row.floor_ms)).toBe(cutoff-1);const before=await snapshot();
  expect(await ingress.acceptTrustedCallback(event({createAt:cutoff-1}))).toBeNull();expect(db.admissions.at(-1)).toMatchObject({allowed:false,reason:'PRE_TRIAL_EVENT_REJECTED',providerMs:cutoff-1});
  expect(await snapshot()).toEqual(before);
  oldEvent=event({createAt:cutoff});
 }
 const old=await ingress.acceptTrustedCallback(oldEvent);expect(old,JSON.stringify(db.admissions)).not.toBeNull();const oldRun=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[old!.taskId])).rows[0].id as string;
 const lease=(await store.acquire(ctx,oldRun,'synthetic-old'))!,payload=glmRequestBody([{role:'user',content:'synthetic'}],[],'high',store.modelLimits()),request=await store.prepareModel(ctx,lease,payload);await store.startModel(ctx,lease,request,payload,async()=>null);await store.finishModel(ctx,request.id,'UNKNOWN');
 const formal=formalProfileFingerprint({schemaVersion:1,authorizationId:randomUUID(),...ctx,sourceTrialProfileHash:trialHash,corpId,externalUserId:'owner',robotCode,conversationId,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+1800000).toISOString(),budgetPolicyHash:profile.budgetPolicyHash,approvalReference:'SYNTHETIC_FORMAL_ONLY',modelAllowed:true,modelApprovalReference:'SYNTHETIC_PAID_MODEL_LOCAL_STUB_ONLY',entrypoints:['INGRESS','WORKER','NOTIFIER','API','MAINTENANCE'],inputPolicy:{attachments:false,controls:true},capabilities:[]});
 const authorize=()=>admin.query('SELECT public.oa_formal_authorize($1,$2,$3) state',[formal.serialized,trialHash,formal.profile.approvalReference]);
 const activate=()=>{db.trialProfileHash=null;db.formalProfileHash=formal.hash;};
 return {ctx,db,store,gateway,ingress,event,freshEvent,oldEvent,old:old!,oldRun,policy,trialHash,formal,authorize,activate,snapshot,request,corpId,robotCode,conversationId};
}
function dailyTransition(w:Awaited<ReturnType<typeof world>>){
 const nextPolicy=modelBudgetPolicySchema.parse({...w.policy,approvalReference:'SYNTHETIC_NEW_BUDGET_REVIEW',validUntil:new Date(Date.now()+7200000).toISOString()});
 const policyText=JSON.stringify(nextPolicy),policyHash=hash(policyText);
 const formal=formalProfileFingerprint({...w.formal.profile,authorizationId:randomUUID(),budgetPolicyHash:policyHash,approvalReference:'SYNTHETIC_NEW_FORMAL_REVIEW',modelApprovalReference:'SYNTHETIC_NEW_MODEL_REVIEW'});
 const request={schemaVersion:1,transitionId:randomUUID() as string,...w.ctx,sourceTrialProfileHash:w.trialHash,expectedPolicyHash:hash(JSON.stringify(w.policy)),expectedPolicyVersion:'1',policyHash,formalProfileHash:formal.hash,reviewReference:nextPolicy.approvalReference};
 const apply=(document:unknown=request,policy=policyText,profile=formal.serialized)=>admin.query('SELECT public.oa_budget_transition_authorize($1,$2,$3) state',[JSON.stringify(document),policy,profile]);
 return {nextPolicy,policyText,policyHash,formal,request,apply};
}
it('daily transition preserves UNKNOWN, archives old policy and pins new formal model admission to the reviewed version',async()=>{
 const w=await world(),before=await w.snapshot(),next=dailyTransition(w);
 const result=(await next.apply()).rows[0].state;expect(result).toMatchObject({state:'AUTHORIZED',replayed:false,policyHash:next.policyHash});
 expect(await w.snapshot()).toEqual(before);
 expect((await admin.query('SELECT previous_policy,request_document FROM budget_policy_transitions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0]).toMatchObject({previous_policy:{policy_hash:next.request.expectedPolicyHash,document:w.policy},request_document:next.request});
 expect((await next.apply()).rows[0].state.replayed).toBe(true);expect(await w.snapshot()).toEqual(before);
 w.db.trialProfileHash=null;w.db.formalProfileHash=next.formal.hash;
 const store=new RuntimeStore(w.db,vault,new ModelBudget(next.nextPolicy));const incoming=await w.ingress.acceptTrustedCallback(await w.freshEvent());expect(incoming).not.toBeNull();
 const runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[incoming!.taskId])).rows[0].id as string,lease=(await store.acquire(w.ctx,runId,'synthetic-daily'))!;expect(lease).toBeTruthy();
 const payload=glmRequestBody([{role:'user',content:'synthetic daily'}],[],'high',store.modelLimits()),reservation=await store.prepareModel(w.ctx,lease,payload);
 expect(reservation.policyHash).toBe(next.policyHash);await store.startModel(w.ctx,lease,reservation,payload,async()=>null);await store.finishModel(w.ctx,reservation.id,'COMPLETE',{prompt_tokens:10,completion_tokens:2,total_tokens:12});
 expect((await admin.query('SELECT dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[reservation.id])).rows[0]).toEqual({dispatch_state:'COMPLETE',cost_state:'SETTLED'});
 expect((await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE id=$1',[w.request.id])).rows).toEqual((before.quota_ledger as unknown[]));
 expect((await admin.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].state).toBe('CLOSED');
});
it('daily transition atomically rolls back policy and lineage when exact fresh formal authority is invalid',async()=>{
 const w=await world(),next=dailyTransition(w),before=(await admin.query('SELECT to_jsonb(b) value FROM budget_policies b WHERE tenant_id=$1',[w.ctx.tenantId])).rows;
 const bad=formalProfileFingerprint({...next.formal.profile,externalUserId:'synthetic-wrong-owner'}),request={...next.request,formalProfileHash:bad.hash};
 await expect(next.apply(request,next.policyText,bad.serialized)).rejects.toThrow('FORMAL_CLOSED_TRIAL_BINDING_REQUIRED');
 expect((await admin.query('SELECT to_jsonb(b) value FROM budget_policies b WHERE tenant_id=$1',[w.ctx.tenantId])).rows).toEqual(before);
 expect((await admin.query('SELECT count(*)::int n FROM budget_policy_transitions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
});
it.each(['version','hash','owner','trial','blocked','active-formal','capacity','currency','tariff','expired-window','window-beyond-budget','nonce-shape'] as const)('daily transition denies %s without changing budget, authority or history',async mode=>{
 const w=await world(),next=dailyTransition(w),request={...next.request};let policy=next.policyText,formal=next.formal.serialized;
 if(mode==='version')request.expectedPolicyVersion='2';if(mode==='hash')request.expectedPolicyHash='b'.repeat(64);if(mode==='owner')request.actorId=randomUUID();if(mode==='trial')request.sourceTrialProfileHash='c'.repeat(64);if(mode==='nonce-shape')request.transitionId='invalid';
 if(mode==='blocked')await admin.query("UPDATE budget_policies SET blocked_reason='PROVIDER_USAGE_OUTSIDE_RESERVATION' WHERE tenant_id=$1",[w.ctx.tenantId]);
 if(mode==='active-formal')await w.authorize();
 if(['capacity','currency','tariff','expired-window'].includes(mode)){
  const changed=JSON.parse(policy) as typeof next.nextPolicy;
  if(mode==='capacity')changed.limits.tenant.money='999999';if(mode==='currency')changed.currency='USD';if(mode==='tariff')changed.pricing!.inputPerMillion='0';if(mode==='expired-window')changed.validUntil='2000-01-01T00:00:00.000Z';
  policy=JSON.stringify(changed);request.policyHash=hash(policy);const changedFormal=formalProfileFingerprint({...next.formal.profile,budgetPolicyHash:request.policyHash});formal=changedFormal.serialized;request.formalProfileHash=changedFormal.hash;
 }
 if(mode==='window-beyond-budget'){const changed=formalProfileFingerprint({...next.formal.profile,validUntil:new Date(Date.now()+10800000).toISOString()});formal=changed.serialized;request.formalProfileHash=changed.hash;}
 const snapshot=async()=>({...await w.snapshot(),policy:(await admin.query('SELECT to_jsonb(b) value FROM budget_policies b WHERE tenant_id=$1',[w.ctx.tenantId])).rows,transitions:(await admin.query('SELECT to_jsonb(x) value FROM budget_policy_transitions x WHERE tenant_id=$1',[w.ctx.tenantId])).rows,authorities:(await admin.query('SELECT to_jsonb(a) value FROM formal_authorizations a WHERE tenant_id=$1',[w.ctx.tenantId])).rows});
 const before=await snapshot();
 const expected=mode==='nonce-shape'?null:['version','hash'].includes(mode)?'BUDGET_TRANSITION_VERSION_CONFLICT':mode==='owner'?'BUDGET_TRANSITION_BINDING_MISMATCH':mode==='trial'?'BUDGET_TRANSITION_CLOSED_TRIAL_REQUIRED':mode==='blocked'?'BUDGET_TRANSITION_BLOCKED_POLICY':mode==='active-formal'?'BUDGET_TRANSITION_REVOKE_FORMAL_FIRST':mode==='tariff'?'BUDGET_TRANSITION_TARIFF_CHANGE_FORBIDDEN':'BUDGET_TRANSITION_WINDOW_ONLY';
 if(expected)await expect(next.apply(request,policy,formal)).rejects.toThrow(expected);else await expect(next.apply(request,policy,formal)).rejects.toMatchObject({code:'22P02'});
 expect(await snapshot()).toEqual(before);
});
it('daily transition requires migrator; exact lineage cannot approve another profile, resurrect revoked authority or mutate snapshots',async()=>{
 const w=await world(),next=dailyTransition(w),app=new Database(isolatedUrl('DATABASE_URL'));connections.push(app);
 for(const db of [app,w.db])await expect(db.scope(w.ctx,c=>c.query('SELECT public.oa_budget_transition_authorize($1,$2,$3)',[JSON.stringify(next.request),next.policyText,next.formal.serialized]))).rejects.toMatchObject({code:'42501'});
 await next.apply();const other=formalProfileFingerprint({...next.formal.profile,authorizationId:randomUUID()});await expect(admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[other.serialized,w.trialHash,other.profile.approvalReference])).rejects.toThrow('FORMAL_APPROVED_BUDGET_MISMATCH');
 await expect(admin.query('DELETE FROM budget_policy_transitions WHERE tenant_id=$1',[w.ctx.tenantId])).rejects.toThrow('BUDGET_TRANSITION_IMMUTABLE');
 await expect(admin.query("UPDATE budget_policy_transitions SET review_reference='SYNTHETIC_REWRITE' WHERE tenant_id=$1",[w.ctx.tenantId])).rejects.toThrow('BUDGET_TRANSITION_IMMUTABLE');
 await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[next.formal.profile.authorizationId,next.formal.hash,'SYNTHETIC_STOP','SYNTHETIC_REVOKE_REVIEW']);await expect(next.apply()).rejects.toThrow('BUDGET_TRANSITION_REPLAY_CONFLICT');
 expect((await admin.query('SELECT state FROM formal_authorizations WHERE tenant_id=$1',[w.ctx.tenantId])).rows).toEqual([{state:'REVOKED'}]);
});
it.each(['inactive','epoch'] as const)('daily transition exact replay fails closed after current identity change: %s',async mode=>{
 const w=await world(),next=dailyTransition(w);await next.apply();
 await admin.query(mode==='inactive'?"UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2":'UPDATE users SET auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND id=$2',[w.ctx.tenantId,w.ctx.actorId]);
 await expect(next.apply()).rejects.toThrow('BUDGET_TRANSITION_REPLAY_CONFLICT');
});
it('daily transition direct SQL rejects an unbounded policy expiry even with matching approved hashes',async()=>{
 const w=await world(),next=dailyTransition(w),policy=JSON.stringify({...next.nextPolicy,validUntil:'infinity'}),digest=hash(policy),formal=formalProfileFingerprint({...next.formal.profile,budgetPolicyHash:digest}),request={...next.request,policyHash:digest,formalProfileHash:formal.hash};
 await expect(next.apply(request,policy,formal.serialized)).rejects.toThrow('BUDGET_TRANSITION_WINDOW_ONLY');
});
it('daily transition serializes competing versions under the original CLOSED tenant lock; only one commits',async()=>{
 const w=await world(),a=dailyTransition(w),b=dailyTransition(w);const before=await w.snapshot(),results=await Promise.allSettled([a.apply(),b.apply()]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(await w.snapshot()).toEqual(before);expect((await admin.query('SELECT count(*)::int n FROM budget_policy_transitions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(1);
 expect((await admin.query('SELECT version::text FROM budget_policies WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].version).toBe('2');
});
it('daily transition cannot bypass an exhausted cumulative bucket and late old usage never revives the CLOSED task',async()=>{
 const w=await world(),next=dailyTransition(w);await admin.query("UPDATE budget_buckets SET used_money=limit_money-reserved_money WHERE tenant_id=$1 AND scope_kind='TENANT'",[w.ctx.tenantId]);
 const before=(await admin.query("SELECT to_jsonb(b) value FROM budget_buckets b WHERE tenant_id=$1 AND scope_kind='TENANT'",[w.ctx.tenantId])).rows;await next.apply();w.db.trialProfileHash=null;w.db.formalProfileHash=next.formal.hash;
 const store=new RuntimeStore(w.db,vault,new ModelBudget(next.nextPolicy)),task=(await w.ingress.acceptTrustedCallback(await w.freshEvent()))!,runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId])).rows[0].id as string,lease=(await store.acquire(w.ctx,runId,'synthetic-no-reset'))!;
 await expect(store.prepareModel(w.ctx,lease,glmRequestBody([{role:'user',content:'synthetic budget denial'}],[],'high',store.modelLimits()))).rejects.toThrow('MODEL_MONEY_BUDGET_EXHAUSTED_TENANT');
 expect((await admin.query("SELECT to_jsonb(b) value FROM budget_buckets b WHERE tenant_id=$1 AND scope_kind='TENANT'",[w.ctx.tenantId])).rows).toEqual(before);
 const oldTask=(await admin.query('SELECT to_jsonb(t) value FROM tasks t WHERE id=$1',[w.old.taskId])).rows;
 await store.finishModel(w.ctx,w.request.id,'COMPLETE',{prompt_tokens:10,completion_tokens:2,total_tokens:12});
 expect((await admin.query('SELECT policy_hash,dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[w.request.id])).rows[0]).toEqual({policy_hash:next.request.expectedPolicyHash,dispatch_state:'COMPLETE',cost_state:'SETTLED'});
 expect((await admin.query('SELECT to_jsonb(t) value FROM tasks t WHERE id=$1',[w.old.taskId])).rows).toEqual(oldTask);expect(await store.acquire(w.ctx,w.oldRun,'never-revive')).toBeNull();
});
it('daily transition operator CLI uses the exact offline review plan for a synthetic expired policy without starting services',async()=>{
 const w=await world(),next=dailyTransition(w),dir=await mkdtemp(join(tmpdir(),'oa-daily-operator-'));directories.push(dir);
 await admin.query("UPDATE budget_policies SET valid_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",[w.ctx.tenantId]);
 const before=await w.snapshot(),flags:string[]=[];
 for(const [name,body] of [['request',JSON.stringify(next.request)],['policy',next.policyText],['profile',next.formal.serialized]]){const path=join(dir,name!+'.json');await writeFile(path,body!,{mode:0o600});flags.push('--'+name,path);}
 const run=(mode:string,tail:string[]=[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx','scripts/budget-transition.ts',mode,...flags,...tail],{encoding:'utf8',env:{...process.env,...Object.fromEntries(['MIGRATION_DATABASE_URL','RUNTIME_DATABASE_URL','DATABASE_URL','QUEUE_DATABASE_URL'].map(key=>[key,isolatedUrl(key)]))},stdio:['ignore','pipe','pipe']}));
 const plan=run('plan');expect(plan).toMatchObject({mode:'PLAN_ONLY',databaseAccess:false,activation:false});expect(await w.snapshot()).toEqual(before);
 expect((await admin.query('SELECT valid_until<clock_timestamp() expired FROM budget_policies WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].expired).toBe(true);
 const applied=run('authorize',['--expected-request-hash',plan.requestHash,'--review-ref',next.request.reviewReference]);expect(applied).toMatchObject({mode:'AUTHORIZED',servicesStarted:false,ledgerOrBucketWrites:false,profileFilesWritten:false,state:{policyHash:next.policyHash,state:'AUTHORIZED'}});
 expect(await w.snapshot()).toEqual(before);expect((await admin.query('SELECT valid_until>clock_timestamp() valid FROM budget_policies WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].valid).toBe(true);
 expect(readFileSync(join(dir,'request.json'),'utf8')).toBe(JSON.stringify(next.request));expect(readFileSync(join(dir,'policy.json'),'utf8')).toBe(next.policyText);expect(readFileSync(join(dir,'profile.json'),'utf8')).toBe(next.formal.serialized);
});
it('real database ceil cutoffs reject the preceding millisecond and admit the boundary without changing authority',async()=>{
 const w=await world(true);expect(w.db.admissions.at(-1)).toMatchObject({allowed:true,providerMs:JSON.parse(w.oldEvent.data).createAt});
 await w.authorize();w.activate();const row=await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_formal_state(NULL) state')).rows[0]);const cutoff=Number(row.state.admissionCutoffMs),authority=await admin.query('SELECT to_jsonb(a) value,floor(extract(epoch FROM greatest(valid_from,created_at))*1000)::text floor_ms,ceil(extract(epoch FROM greatest(valid_from,created_at))*1000)::text ceil_ms FROM formal_authorizations a WHERE tenant_id=$1',[w.ctx.tenantId]);expect(Number(authority.rows[0].ceil_ms)).toBe(cutoff);expect(cutoff-Number(authority.rows[0].floor_ms)).toBeGreaterThanOrEqual(0);expect(cutoff-Number(authority.rows[0].floor_ms)).toBeLessThanOrEqual(1);await w.freshEvent();const before=await w.snapshot();
 expect(await w.ingress.acceptTrustedCallback(w.event({createAt:cutoff-1}))).toBeNull();expect(w.db.admissions.at(-1)).toMatchObject({allowed:false,reason:'PRE_FORMAL_EVENT_REJECTED',providerMs:cutoff-1,cutoffMs:cutoff});
 expect(await w.snapshot()).toEqual(before);
 expect((await admin.query('SELECT to_jsonb(a) value FROM formal_authorizations a WHERE tenant_id=$1',[w.ctx.tenantId])).rows).toEqual(authority.rows.map(({value})=>({value})));
 const fresh=await w.ingress.acceptTrustedCallback(w.event({createAt:cutoff}));expect(fresh?.taskId).toBeTruthy();expect(w.db.admissions.at(-1)).toMatchObject({allowed:true,providerMs:cutoff,cutoffMs:cutoff});
 console.log(JSON.stringify({probe:'REAL_PG_CEIL_ADMISSION_BOUNDARIES',trialPrecedingMsDenied:true,formalPrecedingMsDenied:true,exactBoundaryAdmitted:true,authorityBackdated:false}));
});
it('a formal control-only task reference refusal keeps its exact admission binding and never creates a model job',async()=>{
 const w=await world();await w.authorize();w.activate();const before=(await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE tenant_id=$1 ORDER BY id',[w.ctx.tenantId])).rows;
 const event=await w.freshEvent({text:{content:'继续任务 malformed 00000000：回答'}}),response=(await w.ingress.acceptTrustedCallback(event))!;expect(response.taskId).not.toBe(w.old.taskId);expect(await w.ingress.acceptTrustedCallback(event)).toMatchObject({taskId:response.taskId,duplicate:true});
 const row=(await admin.query("SELECT t.control_kind,r.status,r.last_error,(SELECT count(*)::int FROM outbox WHERE aggregate_id=r.id AND kind='RUN') jobs FROM tasks t JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id WHERE t.tenant_id=$1 AND t.id=$2",[w.ctx.tenantId,response.taskId])).rows[0];expect(row).toMatchObject({control_kind:'CLARIFICATION_REPLY',status:'PARTIAL',last_error:'CLARIFICATION_NOT_RESUMED',jobs:0});
 expect((await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE tenant_id=$1 ORDER BY id',[w.ctx.tenantId])).rows).toEqual(before);expect((await w.db.scope(w.ctx,c=>trialState(c))).mode).toBe('FORMAL');
});
it('privileged authorization is append-only and never resets CLOSED, old rows or UNKNOWN reservations; stale restart remains blocked',async()=>{
 const w=await world(),before=await w.snapshot();expect((before.quota_ledger as {value:Record<string,unknown>}[])[0]!.value).toMatchObject({dispatch_state:'UNKNOWN',cost_state:'UNKNOWN'});
 const app=new Database(isolatedUrl('DATABASE_URL'));connections.push(app);
 for(const db of [app,w.db])await expect(db.scope(w.ctx,c=>c.query('SELECT public.oa_formal_authorize($1,$2,$3)',[w.formal.serialized,w.trialHash,w.formal.profile.approvalReference]))).rejects.toMatchObject({code:'42501'});
 expect((await w.authorize()).rows[0].state).toMatchObject({state:'AUTHORIZED',replayed:false});expect((await w.authorize()).rows[0].state.replayed).toBe(true);
 expect(await w.snapshot()).toEqual(before);await new BudgetRecovery(w.db).owner(w.ctx);expect(await new RetryDispatcher(w.db).dispatch(w.ctx)).toBe(0);expect(await w.snapshot()).toEqual(before);
 w.activate();await new BudgetRecovery(w.db).owner(w.ctx);expect(await new RetryDispatcher(w.db).dispatch(w.ctx)).toBe(0);expect(await w.store.acquire(w.ctx,w.oldRun,'must-not-resume')).toBeNull();expect(await w.snapshot()).toEqual(before);
 await expect(admin.query("UPDATE formal_authorizations SET profile_hash=repeat('b',64) WHERE tenant_id=$1",[w.ctx.tenantId])).rejects.toThrow('FORMAL_PROFILE_IMMUTABLE');
 await expect(admin.query("UPDATE one_shot_trials SET state='ARMED',closed_at=NULL,close_reason=NULL WHERE tenant_id=$1",[w.ctx.tenantId])).rejects.toThrow('TRIAL_CLOSED_IMMUTABLE');
 const revoked=(await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4) state',[w.formal.profile.authorizationId,w.formal.hash,'SYNTHETIC_REVOKED','SYNTHETIC_REVIEW_REFERENCE'])).rows[0].state;expect(revoked.state).toBe('REVOKED');expect(await w.snapshot()).toEqual(before);
 expect((await w.db.scope(w.ctx,c=>trialState(c))).allowed).toBe(false);await new BudgetRecovery(w.db).owner(w.ctx);expect(await w.snapshot()).toEqual(before);
 expect((await admin.query('SELECT operation FROM formal_lifecycle_events WHERE tenant_id=$1 ORDER BY recorded_at',[w.ctx.tenantId])).rows.map(r=>r.operation)).toEqual(['AUTHORIZE','REVOKE']);
});
it.each([false,true])('per-run budget recovery rechecks real formal authority after discovery; revoke=%s',async revoke=>{
 const w=await world();await w.authorize();w.activate();
 const task=await w.ingress.acceptTrustedCallback(await w.freshEvent());expect(task?.taskId).toBeTruthy();
 const runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[task!.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-recovery-race'))!;expect(lease).toBeTruthy();
 const prepared=await w.store.prepareModel(w.ctx,lease,glmRequestBody([{role:'user',content:'synthetic prepared orphan'}],[],'high',w.store.modelLimits()));
 await admin.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[runId]);
 expect((await admin.query('SELECT dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[prepared.id])).rows).toEqual([{dispatch_state:'PREPARED',cost_state:'RESERVED'}]);
 const safetySnapshot=async()=>({...await w.snapshot(),formal_admissions:(await admin.query('SELECT to_jsonb(a) value FROM formal_admissions a WHERE tenant_id=$1 ORDER BY id',[w.ctx.tenantId])).rows});
 const before=await safetySnapshot(),oldQuota=(await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE id=$1',[w.request.id])).rows;
 const auditBefore=(await admin.query('SELECT operation FROM formal_lifecycle_events WHERE tenant_id=$1 ORDER BY recorded_at',[w.ctx.tenantId])).rows;expect(auditBefore).toEqual([{operation:'AUTHORIZE'}]);
 const budget=new ModelBudget(w.policy),recover=vi.spyOn(budget,'recover'),startModel=vi.spyOn(w.store,'startModel'),originalScope=w.db.scope.bind(w.db);let scopes=0;
 // This barrier preserves every real transaction/result. Only scheduling changes:
 // the independent migrator commits revocation after discovery, before the next scope.
 const scope=vi.spyOn(w.db,'scope').mockImplementation(async <T>(ctx:DbContext,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>=>{
  const result=await originalScope<T>(ctx,fn);scopes++;
  if(scopes===1)expect(result).toMatchObject({mode:'FORMAL',allowed:true});
  if(scopes===2){expect(result).toEqual([{run_id:runId}]);if(revoke){const changed=await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4) state',[w.formal.profile.authorizationId,w.formal.hash,'SYNTHETIC_DISCOVERY_RACE','SYNTHETIC_REVIEW_REFERENCE']);expect(changed.rows[0].state.state).toBe('REVOKED');expect(await safetySnapshot()).toEqual(before);}}
  return result;
 });
 try{
  expect(await new BudgetRecovery(w.db,budget).owner(w.ctx)).toBe(revoke?0:1);expect(scopes).toBe(3);expect(startModel).not.toHaveBeenCalled();
  if(revoke){expect(recover).not.toHaveBeenCalled();expect(await safetySnapshot()).toEqual(before);expect((await admin.query('SELECT dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[prepared.id])).rows).toEqual([{dispatch_state:'PREPARED',cost_state:'RESERVED'}]);}
  else{expect(recover).toHaveBeenCalledOnce();expect(recover.mock.calls[0]![1]).toBe(runId);expect((await admin.query('SELECT dispatch_state,token_state,cost_state,failure_code FROM quota_ledger WHERE id=$1',[prepared.id])).rows).toEqual([{dispatch_state:'RELEASED',token_state:'RELEASED',cost_state:'RELEASED',failure_code:'RECOVERED_BEFORE_DISPATCH'}]);}
  expect((await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE id=$1',[w.request.id])).rows).toEqual(oldQuota);expect(oldQuota[0].value).toMatchObject({dispatch_state:'UNKNOWN',cost_state:'UNKNOWN'});
  expect((await admin.query('SELECT operation FROM formal_lifecycle_events WHERE tenant_id=$1 ORDER BY recorded_at',[w.ctx.tenantId])).rows).toEqual(revoke?[...auditBefore,{operation:'REVOKE'}]:auditBefore);
 }finally{scope.mockRestore();recover.mockRestore();startModel.mockRestore();}
});
it.each([null,'','UNKNOWN'])('database bootstrap rejects malformed service %s even with a valid profile',async service=>{
 const w=await world();await w.authorize();w.activate();expect((await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_lifecycle_bootstrap(NULL,$1,$2) state',[w.formal.hash,service])).rows[0].state)).blocked).toBe(true);
});
it('old message/inbox/unlogged delayed message and malformed timestamps never mint a new task or admission',async()=>{
 const w=await world();
 // Observe the authority database clock before authorization. Host Date.now may
 // lead PostgreSQL by a millisecond; that is not evidence of a pre-cutoff event.
 const observedMs=Number((await admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms);
 const delayed=w.event({createAt:observedMs}),inboxId=randomUUID(),inboxEvent=w.event({createAt:observedMs});await admin.query("INSERT INTO event_inbox(tenant_id,id,owner_id,source,event_key,payload_cipher_ref,state) VALUES($1,$2,$3,'DINGTALK',$4,'synthetic-old','PROCESSED')",[w.ctx.tenantId,inboxId,w.ctx.actorId,`${w.robotCode}:${w.conversationId}:${inboxEvent.headers.messageId}`]);
 await w.authorize();w.activate();const cutoff=Number((await w.db.scope(w.ctx,c=>c.query('SELECT public.oa_formal_state(NULL) state'))).rows[0].state.admissionCutoffMs);expect(observedMs).toBeLessThan(cutoff);const before=await w.snapshot();expect(await w.ingress.acceptTrustedCallback(w.oldEvent)).toEqual({...w.old,duplicate:true});expect(await w.ingress.acceptTrustedCallback(inboxEvent)).toBeNull();expect(await w.ingress.acceptTrustedCallback(delayed)).toBeNull();
 for(const patch of [{createAt:0},{createAt:Date.now()+60000},{createAt:1.5},{conversationType:'2'},{msgtype:'file',content:{downloadCode:'synthetic',fileName:'a.txt'}}])expect(await w.ingress.acceptTrustedCallback(w.event(patch))).toBeNull();
 expect(await w.snapshot()).toEqual(before);expect((await admin.query('SELECT id FROM formal_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rowCount).toBe(0);
});
it('new SDK callback traverses real PgBoss publish/claim, model stub and notifier stub while stale outbox is excluded before LIMIT',async()=>{
 const w=await world();await w.authorize();w.activate();
 await admin.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) SELECT $1::uuid,gen_random_uuid(),$2::uuid,'RUN',$3::uuid,jsonb_build_object('tenantId',$1::text,'actorId',$2::text,'runId',$3::text),'synthetic-old-'||n FROM generate_series(1,60) n",[w.ctx.tenantId,w.ctx.actorId,w.oldRun]);
 const oldQuota=(await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE id=$1',[w.request.id])).rows;
 const oldDeliveryIds=[randomUUID(),randomUUID()];for(const [i,id] of oldDeliveryIds.entries())await admin.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no,sending_at,attempt_key) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-old-retained','INTERNAL',$8,1,clock_timestamp()-interval '1 hour',$9)",[w.ctx.tenantId,id,w.ctx.actorId,w.old.taskId,JSON.stringify({kind:'PRIVATE_USER',targetId:w.ctx.actorId,classificationCeiling:'RESTRICTED'}),hash('synthetic-old:'+i),i===0?'PENDING':'SENDING',w.oldRun,i===0?null:randomUUID()]);
 const oldDeliveries=(await admin.query('SELECT to_jsonb(d) value FROM deliveries d WHERE id=ANY($1::uuid[]) ORDER BY id',[oldDeliveryIds])).rows;
 const client=new DWClient({clientId:'synthetic',clientSecret:'synthetic',debug:false}),acks:string[]=[],errors:string[]=[];client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,w.ingress,code=>errors.push(code));
 const e=await w.freshEvent();client.onCallback(e);expect(acks).toEqual([]);await vi.waitFor(()=>expect(acks).toEqual([e.headers.messageId]));expect(errors).toEqual([]);
 const receipt=(await admin.query('SELECT * FROM formal_admissions WHERE tenant_id=$1 AND msg_id=$2',[w.ctx.tenantId,e.headers.messageId])).rows[0];expect(receipt.task_id).toBeTruthy();expect(receipt.run_id).toBeTruthy();expect(receipt.run_id).not.toBe(w.oldRun);
 const queue=new RunQueue(isolatedUrl('QUEUE_DATABASE_URL'),'lifecycle-'+randomUUID());queue.boss.on('error',()=>{});
 try{
  await queue.start();expect(await queue.publish(w.db,w.ctx)).toBe(1);const jobs=await queue.boss.fetch(queue.queueName,{batchSize:1});expect(jobs).toHaveLength(1);const job=runJobSchema.parse(jobs[0]!.data);expect(job.runId).toBe(receipt.run_id);
  let calls=0;const provider:ModelProvider={describeRequest:(messages,tools,limits)=>glmRequestBody(messages,tools,'high',limits),complete:async(_messages,tools)=>{calls++;expect(tools).toEqual([]);return {message:{role:'assistant',content:JSON.stringify(calls===1?{schemaVersion:1,mode:'CONVERSATION',text:'Hello is a greeting.',claims:[],outcome:'COMPLETE'}:{schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]})},finishReason:'stop',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},requestId:null};}};
  await new AgentRuntime(w.store,provider,w.gateway).advance(w.ctx,job.runId,undefined,undefined,job.generation);expect(calls).toBe(2);await queue.boss.complete(queue.queueName,jobs[0]!.id);
  expect((await admin.query('SELECT status FROM runs WHERE id=$1',[job.runId])).rows[0].status).toBe('SUCCEEDED');
  let sends=0;const delivery=new DeliveryGateway(w.db,vault,{sendReply:async(_r,text)=>{sends++;expect(text).toBe(`任务 ${String(receipt.task_id)}\n\nHello is a greeting.`);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('UNEXPECTED_PROACTIVE');}},{corpId:w.corpId,robotCode:w.robotCode,appOrigin:'http://localhost:52330'},Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
  const pending=await delivery.pending(w.ctx);expect(pending).toHaveLength(1);for(const id of oldDeliveryIds)expect(await delivery.process(w.ctx,id,new AbortController().signal)).toBe('NOT_CLAIMED');expect((await admin.query('SELECT to_jsonb(d) value FROM deliveries d WHERE id=ANY($1::uuid[]) ORDER BY id',[oldDeliveryIds])).rows).toEqual(oldDeliveries);expect(await delivery.process(w.ctx,pending[0]!,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(sends).toBe(1);expect(await delivery.process(w.ctx,pending[0]!,new AbortController().signal)).toBe('NOT_CLAIMED');
  expect((await w.db.scope(w.ctx,c=>trialState(c,job.runId))).allowed).toBe(true);expect((await admin.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].state).toBe('CLOSED');
  expect((await admin.query('SELECT to_jsonb(q) value FROM quota_ledger q WHERE id=$1',[w.request.id])).rows).toEqual(oldQuota);expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND dedup_key LIKE 'synthetic-old-%' AND published_at IS NULL",[w.ctx.tenantId])).rows[0].n).toBe(60);
  expect(await w.ingress.acceptTrustedCallback(e)).toEqual({taskId:receipt.task_id,duplicate:true});expect(await queue.publish(w.db,w.ctx)).toBe(0);
 }finally{await queue.stop();}
},30000);
it('formal model permission is separate; fresh native stop receipts bind without reopening old targets',async()=>{
 const w=await world(),formal=formalProfileFingerprint({...w.formal.profile,modelAllowed:false,modelApprovalReference:null});await admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[formal.serialized,w.trialHash,formal.profile.approvalReference]);w.db.trialProfileHash=null;w.db.formalProfileHash=formal.hash;
 const old=(await admin.query('SELECT to_jsonb(r) value FROM runs r WHERE id=$1',[w.oldRun])).rows;
 const stop=await w.ingress.acceptTrustedCallback(await w.freshEvent({text:{content:'停止 '+w.old.taskId}}));expect(stop?.taskId).toBeTruthy();const control=(await admin.query('SELECT control_kind FROM tasks WHERE id=$1',[stop!.taskId])).rows[0];expect(control.control_kind).toBe('STOP');expect((await admin.query('SELECT to_jsonb(r) value FROM runs r WHERE id=$1',[w.oldRun])).rows).toEqual(old);
 const fresh=await w.ingress.acceptTrustedCallback(await w.freshEvent()),runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[fresh!.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-model-denial'))!;
 expect(lease).toBeTruthy();await expect(w.store.prepareModel(w.ctx,lease,glmRequestBody([{role:'user',content:'synthetic'}],[],'high',w.store.modelLimits()))).rejects.toThrow('FORMAL_MODEL_NOT_APPROVED');expect((await admin.query('SELECT id FROM quota_ledger WHERE run_id=$1',[runId])).rowCount).toBe(0);
});
it('private formal startup verifies scope and service; ordinary no-slot application creation still works',async()=>{
 const w=await world();await w.authorize();const dir=await mkdtemp(join(tmpdir(),'oa-formal-startup-'));directories.push(dir);const path=join(dir,'formal.json'),budget=join(dir,'budget.json');await writeFile(path,w.formal.serialized,{mode:0o600});await writeFile(budget,JSON.stringify(w.policy),{mode:0o600});
 const env={FORMAL_RUNTIME_PROFILE_FILE:path,BUDGET_POLICY_FILE:budget};expect((await initializeLifecycle(w.db,env,[w.ctx],'WORKER')).mode).toBe('FORMAL');await expect(initializeLifecycle(w.db,env,[{...w.ctx,actorId:randomUUID()}],'WORKER')).rejects.toThrow('FORMAL_SERVICE_SCOPE_MISMATCH');
 const closedApp=new Database(isolatedUrl('DATABASE_URL'),2);connections.push(closedApp);await expect(initializeLifecycle(closedApp,{},[w.ctx],'API')).rejects.toThrow('TRIAL_STARTUP_BLOCKED');
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC DEFAULT','ACTIVE')",[ctx.tenantId,'SYNTHETIC-'+ctx.tenantId]);await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'default','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);const app=new Database(isolatedUrl('DATABASE_URL'));connections.push(app);expect((await initializeLifecycle(app,{},[ctx],'API')).mode).toBe('DEFAULT');expect((await new TaskStore(app).create(ctx,'SYNTHETIC DEFAULT','synthetic-default')).taskId).toBeTruthy();
});

it('SQL rejects malformed authority documents, null array members and forged JSON types before recording authorization',async()=>{
 const w=await world(),before=await w.snapshot();
 const invalid=[null,{...w.formal.profile,schemaVersion:null},{...w.formal.profile,entrypoints:['INGRESS',null]},{...w.formal.profile,entrypoints:['INGRESS','INGRESS']},{...w.formal.profile,capabilities:[{id:'tasks.get',version:'1.0.0',bindingHash:null}]},{...w.formal.profile,inputPolicy:{attachments:false,controls:null}},{...w.formal.profile,modelAllowed:false},{...w.formal.profile,modelApprovalReference:'a'.repeat(513)},{...w.formal.profile,approvalReference:'a'.repeat(513)},{...w.formal.profile,hiddenAuthority:true}];
 for(const doc of invalid)await expect(admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[JSON.stringify(doc),w.trialHash,w.formal.profile.approvalReference])).rejects.toThrow();
 expect(await w.snapshot()).toEqual(before);expect((await admin.query('SELECT id FROM formal_authorizations WHERE tenant_id=$1',[w.ctx.tenantId])).rowCount).toBe(0);
});
it.each(['NONE','WRONG_HASH','EXACT'] as const)('formal tools require the exact approved binding: %s',async kind=>{
 const w=await world();registerTaskCapability(w.gateway);const descriptor=w.gateway.describeCapability('tasks.get','1.0.0')!;
 const frozen=formalProfileFingerprint({...w.formal.profile,capabilities:kind==='NONE'?[]:[{id:descriptor.id,version:descriptor.version,bindingHash:kind==='EXACT'?descriptor.bindingHash:hash('synthetic-wrong-binding')}]});
 await admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[frozen.serialized,w.trialHash,frozen.profile.approvalReference]);w.db.trialProfileHash=null;w.db.formalProfileHash=frozen.hash;
 const admitted=await w.ingress.acceptTrustedCallback(await w.freshEvent()),runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[admitted!.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-tools'))!;
 expect((await w.gateway.tools(w.ctx,lease)).length).toBe(kind==='EXACT'?1:0);expect((await w.gateway.execute(w.ctx,lease,toolName('tasks.get','1.0.0'),{},new AbortController().signal)).status).toBe(kind==='EXACT'?'OK':'DENIED');
 expect((await admin.query('SELECT id FROM tool_actions WHERE run_id=$1',[runId])).rowCount).toBe(kind==='EXACT'?1:0);await w.store.release(w.ctx,lease);
});
it('revocation between prepare and dispatch blocks the model and retains the new PREPARED exposure for review',async()=>{
 const w=await world();await w.authorize();w.activate();const fresh=await w.ingress.acceptTrustedCallback(await w.freshEvent()),runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[fresh!.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-revoke'))!,payload=glmRequestBody([{role:'user',content:'synthetic'}],[],'high',w.store.modelLimits()),request=await w.store.prepareModel(w.ctx,lease,payload);
 const before=await w.snapshot();await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[w.formal.profile.authorizationId,w.formal.hash,'SYNTHETIC_REVOKED','SYNTHETIC_REVIEW_REFERENCE']);await expect(w.store.startModel(w.ctx,lease,request,payload,async()=>null)).rejects.toThrow('FORMAL_AUTHORIZATION_REVOKED');await new BudgetRecovery(w.db).owner(w.ctx);expect(await w.snapshot()).toEqual(before);
});

it('one real source fixture calls the READ checker with exact READ approval and makes zero additional calls under SEARCH-only approval',async()=>{
 const w=await world(),fixture=await companyFixture(admin,w.ctx,w.oldRun);try{
  registerCompanyCodeCapabilities(w.gateway,fixture.chat);const search=w.gateway.describeCapability('company.code.search','1.0.0')!,read=w.gateway.describeCapability('company.code.read','1.0.0')!;
  for(const descriptor of [search,read]){await admin.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,'READ','READY')",[w.ctx.tenantId,randomUUID(),descriptor.id,descriptor.bindingHash]);await admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,descriptor.id,fixture.resource]);}
  const projection={next:{id:read.id,version:read.version,bindingHash:read.bindingHash},options:[{label:'synthetic',args:{repo:syntheticRepo,commit:syntheticCommit,path:syntheticPath,startLine:1,endLine:1}}],observedCount:1,coverage:'COMPLETE' as const};
  for(const exactRead of [true,false]){
   const frozen=formalProfileFingerprint({...w.formal.profile,authorizationId:randomUUID(),capabilities:(exactRead?[search,read]:[search]).map(d=>({id:d.id,version:d.version,bindingHash:d.bindingHash}))});await admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[frozen.serialized,w.trialHash,frozen.profile.approvalReference]);w.db.trialProfileHash=null;w.db.formalProfileHash=frozen.hash;
   const fresh=await w.ingress.acceptTrustedCallback(await w.freshEvent());expect(fresh).not.toBeNull();const runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[fresh!.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-choice-proof'))!,before=fixture.counts();
   expect(await w.db.scope(w.ctx,c=>w.gateway.choiceTargetAllowed(w.ctx,lease,c,projection,1))).toBe(exactRead);if(exactRead)expect(fixture.counts().checks-before.checks).toBeGreaterThan(0);else expect(fixture.counts()).toEqual(before);await w.store.release(w.ctx,lease);
   await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[frozen.profile.authorizationId,frozen.hash,'SYNTHETIC_REVIEW_COMPLETE','SYNTHETIC_REVIEW_REFERENCE']);
  }
 }finally{await fixture.close();}
});
it('a new authorization after revocation does not admit or resume runs from the previous authorization',async()=>{
 const w=await world();await w.authorize();w.activate();const fresh=await w.ingress.acceptTrustedCallback(await w.freshEvent()),runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[fresh!.taskId])).rows[0].id as string,before=await w.snapshot();
 await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[w.formal.profile.authorizationId,w.formal.hash,'SYNTHETIC_REVOKED','SYNTHETIC_REVIEW_REFERENCE']);const next=formalProfileFingerprint({...w.formal.profile,authorizationId:randomUUID(),approvalReference:'SYNTHETIC_NEW_FORMAL_REVIEW'});await admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[next.serialized,w.trialHash,next.profile.approvalReference]);w.db.formalProfileHash=next.hash;
 expect(await w.store.acquire(w.ctx,runId,'must-not-resume')).toBeNull();expect(await w.snapshot()).toEqual(before);expect((await w.db.scope(w.ctx,c=>trialState(c,runId))).reason).toBe('FORMAL_RUN_NOT_ADMITTED');
});

it('formal API uses real sessions and PostgreSQL authority to admit only its owner and deny revoked or foreign subjects',async()=>{
 const w=await world();await w.authorize();const appDb=new Database(isolatedUrl('DATABASE_URL'),2);connections.push(appDb);appDb.formalProfileHash=w.formal.hash;
 const peer={tenantId:w.ctx.tenantId,actorId:randomUUID()},foreign={tenantId:randomUUID(),actorId:randomUUID()};await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC API PEER','ACTIVE')",[peer.tenantId,peer.actorId]);await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC API FOREIGN','ACTIVE')",[foreign.tenantId]);await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC API FOREIGN','ACTIVE')",[foreign.tenantId,foreign.actorId]);
 const server=await createServer({config:config({APP_ENV:'test'}),db:appDb,sessionSecret:secret('SESSION_SECRET')!,formalSubject:w.ctx});try{
  const owner=await server.sessions.create(w.ctx),other=await server.sessions.create(peer),outsider=await server.sessions.create(foreign),get=(cookie?:string)=>server.app.inject({method:'GET',url:'/api/v1/me',...(cookie?{headers:{cookie:'oa_session='+cookie}}:{})});
  expect((await get()).statusCode).toBe(401);const allowed=await get(owner.cookie);expect(allowed.statusCode).toBe(200);expect(allowed.json().data).toMatchObject({id:w.ctx.actorId,tenantId:w.ctx.tenantId});
  for(const session of [other,outsider]){expect(await server.sessions.authenticate(session.cookie)).toBeTruthy();const denied=await get(session.cookie);expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe('FORMAL_SUBJECT_DENIED');}
  await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[w.formal.profile.authorizationId,w.formal.hash,'SYNTHETIC_REVOKED','SYNTHETIC_HTTP_REVIEW']);expect(await server.sessions.authenticate(owner.cookie)).toBeTruthy();const revoked=await get(owner.cookie);expect(revoked.statusCode).toBe(403);expect(revoked.json().error.code).toBe('FORMAL_SUBJECT_DENIED');expect((await get()).statusCode).toBe(401);
 }finally{await server.app.close();}
});
