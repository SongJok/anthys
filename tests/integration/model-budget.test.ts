import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {secret,config} from '../../packages/config/src/index.js';
import {createServer} from '../../apps/api/src/server.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {ModelBudget,estimateModelPayload,quotaMoney} from '../../packages/runtime/src/model-budget.js';
import {modelBudgetPolicySchema,type ModelBudgetPolicy} from '../../packages/runtime/src/budget-policy.js';
import {BudgetRecovery} from '../../packages/runtime/src/budget-recovery.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {GlmProvider,glmRequestBody} from '../../packages/provider-glm/src/client.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {SYSTEM_PROMPT} from '../../packages/runtime/src/checkpoint.js';
import {Gateway} from '../../packages/gateway/src/index.js';

const db=new Database(secret('RUNTIME_DATABASE_URL')!,20),appDb=new Database(secret('DATABASE_URL')!),root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
afterAll(async()=>{await db.close();await appDb.close();await root.end();});
function policy(){const p=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));p.maxOutputTokens=64;p.ceiling={inputPerMillion:'2',outputPerMillion:'3'};p.pricing={inputPerMillion:'1.25',outputPerMillion:'2.5',sourceReference:'SYNTHETIC_APPROVED_RATE_ONLY',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};return p;}
const payload=(p:ModelBudgetPolicy)=>glmRequestBody([{role:'system',content:'Synthetic quota accounting.'},{role:'user',content:'Synthetic question.'},{role:'assistant',content:'Synthetic draft.',reasoning_content:'PRIVATE_NATIVE_QUOTA_REASONING_SENTINEL'},{role:'user',content:'Synthetic follow-up.'}],[{type:'function',function:{name:'cap_0123456789ab',description:'Synthetic tool schema',parameters:{type:'object',properties:{note:{type:'string'}}}}}],'high',{maxOutputTokens:p.maxOutputTokens});
async function world(p=policy()){
 const tenantId=randomUUID(),ownerId=randomUUID(),departmentId=randomUUID();await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic quota','ACTIVE')",[tenantId]);await root.query("INSERT INTO departments(tenant_id,id,external_dept_id,name) VALUES($1,$2,$2::uuid::text,'synthetic quota department')",[tenantId,departmentId]);const budget=new ModelBudget(p),store=new RuntimeStore(db,vault,budget);
 const create=async(actorId:string=ownerId,taskId?:string)=>{
  const ctx={tenantId,actorId};await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic quota user','ACTIVE') ON CONFLICT DO NOTHING",[tenantId,actorId]);await root.query("INSERT INTO memberships(tenant_id,id,department_id,user_id,source_version) VALUES($1,$2,$3,$4,'SYNTHETIC_QUOTA_V1') ON CONFLICT DO NOTHING",[tenantId,randomUUID(),departmentId,actorId]);
  let task:{taskId:string;runId:string};if(taskId){const runId=randomUUID();await root.query("INSERT INTO runs(tenant_id,id,owner_id,task_id,status,budget) VALUES($1,$2,$3,$4,'QUEUED',$5)",[tenantId,runId,actorId,taskId,JSON.stringify({schemaVersion:1,maxTurns:16,maxTools:24,maxActiveMs:240000})]);task={taskId,runId};}else task=await new TaskStore(appDb).create(ctx,'synthetic quota request',randomUUID());const lease=(await store.acquire(ctx,task.runId,randomUUID()))!;expect(lease).not.toBeNull();return {ctx,...task,lease};
 };
 const buckets=async()=>(await root.query('SELECT * FROM budget_buckets WHERE tenant_id=$1 ORDER BY scope_kind,scope_id',[tenantId])).rows;
 return {tenantId,ownerId,departmentId,budget,store,create,buckets,p};
}
async function request(w:Awaited<ReturnType<typeof world>>,f:Awaited<ReturnType<Awaited<ReturnType<typeof world>>['create']>>,start=true){const body=payload(w.p),r=await w.store.prepareModel(f.ctx,f.lease,body);if(start)await w.store.startModel(f.ctx,f.lease,r,body,async()=>null);return r;}
const knownUsage={prompt_tokens:10,completion_tokens:2,total_tokens:12};

it('owner model accounting exposes actual ledger uncertainty separately from task outcome without projecting private provider or policy data',async()=>{
 for(const mode of ['none','pending','tariff','usage','settled'] as const){
  const p=policy();if(mode==='tariff')p.pricing=null;const w=await world(p),f=await w.create();let id:string|undefined;
  if(mode!=='none'){const r=await request(w,f);id=r.id;if(mode==='tariff'||mode==='settled')await w.store.finishModel(f.ctx,r.id,'COMPLETE',knownUsage);if(mode==='usage')await w.store.finishModel(f.ctx,r.id,'COMPLETE',null);}
  if(id)await root.query("UPDATE quota_ledger SET failure_code=CASE WHEN $2 THEN failure_code ELSE 'PRIVATE_ACCOUNTING_FAILURE_SENTINEL' END,provider_usage=coalesce(provider_usage,'{}'::jsonb)||'{\"private\":\"PRIVATE_ACCOUNTING_USAGE_SENTINEL\"}'::jsonb,policy_snapshot=policy_snapshot||'{\"private\":\"PRIVATE_ACCOUNTING_POLICY_SENTINEL\"}'::jsonb WHERE id=$1",[id,mode==='usage']);
  if(mode==='tariff'){await root.query("UPDATE tasks SET status='COMPLETED' WHERE id=$1",[f.taskId]);await root.query("UPDATE runs SET status='SUCCEEDED',last_error=NULL WHERE id=$1",[f.runId]);}
  const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex')}),session=await api.sessions.create(f.ctx);
  try{const response=await api.app.inject({url:'/api/v1/tasks/'+f.taskId,headers:{cookie:'oa_session='+session.cookie}});expect(response.statusCode).toBe(200);const run=response.json().data.runs[0],accounting=run.model_accounting;
   expect(accounting).toMatchObject({status:mode==='none'?'NONE':mode==='pending'?'PENDING':mode==='settled'?'RECORDED':'UNKNOWN',requestCount:mode==='none'?0:1,heldReservation:mode!=='none'&&mode!=='settled',providerInvoiceVerified:false});
   if(mode==='tariff'){expect(accounting.reasons).toContain('TARIFF_UNCONFIRMED');expect(run.status).toBe('SUCCEEDED');}if(mode==='usage')expect(accounting.reasons).toContain('USAGE_UNAVAILABLE');
   for(const marker of ['PRIVATE_ACCOUNTING_FAILURE_SENTINEL','PRIVATE_ACCOUNTING_USAGE_SENTINEL','PRIVATE_ACCOUNTING_POLICY_SENTINEL','policy_snapshot','provider_usage','payload_hash'])expect(response.body).not.toContain(marker);
  }finally{await api.app.close();}
 }
});
it('model accounting retains legacy uncertainty even with zero recorded reservation and remains private to the run owner',async()=>{
 const w=await world(),f=await w.create(),other=await w.create(randomUUID());await root.query("INSERT INTO quota_ledger(tenant_id,id,owner_id,run_id,subject,period,reservation,cost_state) VALUES($1,$2,$3,$4,'synthetic legacy','synthetic',0,'UNKNOWN')",[w.tenantId,randomUUID(),w.ownerId,f.runId]);
 const own=(await new TaskStore(appDb).get(f.ctx,f.taskId))!.runs[0];expect(own.model_accounting).toMatchObject({status:'UNKNOWN',requestCount:1,heldReservation:false,legacyUnmetered:true,providerInvoiceVerified:false});
 expect(await new TaskStore(appDb).get(other.ctx,f.taskId)).toBeNull();const clean=(await new TaskStore(appDb).get(other.ctx,other.taskId))!.runs[0];expect(clean.model_accounting).toMatchObject({status:'NONE',requestCount:0});
});
it('model accounting prioritizes unknown exposure over a later pending request and observing it never alters the quota ledger',async()=>{
 const p=policy();p.pricing=null;const w=await world(p),f=await w.create(),first=await request(w,f);await w.store.finishModel(f.ctx,first.id,'COMPLETE',knownUsage);await request(w,f);
 const ledger=async()=>(await root.query('SELECT dispatch_state,token_state,cost_state,reservation,used,reserved_tokens,used_tokens FROM quota_ledger WHERE run_id=$1 ORDER BY attempt_no',[f.runId])).rows,before=await ledger();
 const view=(await new TaskStore(appDb).get(f.ctx,f.taskId))!.runs[0];expect(view.model_accounting).toMatchObject({status:'UNKNOWN',requestCount:2,heldReservation:true,legacyUnmetered:false,reasons:['TARIFF_UNCONFIRMED'],providerInvoiceVerified:false});expect(await ledger()).toEqual(before);
});
it('model accounting distinguishes an interrupted dispatch from released pre-dispatch reservations without claiming invoice verification',async()=>{
 for(const sent of [false,true]){const w=await world(),f=await w.create(),r=await request(w,f,sent);await w.store.finishModel(f.ctx,r.id,sent?'UNKNOWN':'NOT_SENT');const view=(await new TaskStore(appDb).get(f.ctx,f.taskId))!.runs[0];expect(view.model_accounting).toMatchObject({status:sent?'UNKNOWN':'RECORDED',requestCount:1,heldReservation:sent,providerInvoiceVerified:false});if(sent)expect((view.model_accounting as {reasons:string[]}).reasons).toContain('DISPATCH_UNCONFIRMED');}
});
it('model accounting treats a contradictory ledger disposition as unknown instead of interpreting it as a zero-cost or verified bill',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,'COMPLETE',knownUsage);
 // Explicit stored-state corruption fixture, not a supported accounting transition.
 await root.query("UPDATE quota_ledger SET cost_state='RELEASED' WHERE id=$1",[r.id]);
 const view=(await new TaskStore(appDb).get(f.ctx,f.taskId))!.runs[0];expect(view.model_accounting).toMatchObject({status:'UNKNOWN',requestCount:1,reasons:['STATE_UNCONFIRMED'],providerInvoiceVerified:false});
 expect((await root.query('SELECT used,cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toMatchObject({used:'0.000017500000',cost_state:'RELEASED'});
});

it('reviewed cache usage settles total tokens and the exact mixed tariff once across every shared scope without reducing the original reservation',async()=>{
 const p=policy();Object.assign(p.pricing!,{cache:{inputPerMillion:'0.25',storagePerMillionTokenHour:'0'}});const w=await world(p),f=await w.create(),r=await request(w,f);
 const before=(await root.query('SELECT reservation,reserved_tokens FROM quota_ledger WHERE id=$1',[r.id])).rows[0];
 await Promise.all(Array.from({length:20},()=>w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:4}})));
 const row=(await root.query('SELECT reservation,reserved_tokens,used,used_tokens,dispatch_state,cost_state,token_state,provider_usage FROM quota_ledger WHERE id=$1',[r.id])).rows[0];
 expect(row).toMatchObject({...before,dispatch_state:'COMPLETE',cost_state:'SETTLED',token_state:'SETTLED',used:'0.000013500000',used_tokens:'12',provider_usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,cached_tokens:4}});
 for(const b of await w.buckets())expect(b).toMatchObject({reserved_tokens:'0',reserved_money:'0.000000000000',used_tokens:'12',used_money:'0.000013500000'});
 expect(Number(before.reservation)).toBeGreaterThan(0.0000135);
});
it('all-cached usage and late completion use the frozen reviewed tariff after cancellation rather than the current in-memory quote',async()=>{
 const p=policy();Object.assign(p.pricing!,{cache:{inputPerMillion:'0.25',storagePerMillionTokenHour:'0'}});const w=await world(p),f=await w.create(),r=await request(w,f);
 await new TaskStore(appDb).cancel(f.ctx,f.taskId);await new BudgetRecovery(db,w.budget).owner(f.ctx);
 w.budget.policy!.pricing!.inputPerMillion='0';
 await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:10}});
 const row=(await root.query('SELECT used,used_tokens,cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row).toMatchObject({used:'0.000007500000',used_tokens:'12',cost_state:'SETTLED'});
 expect((await root.query('SELECT status FROM runs WHERE id=$1',[f.runId])).rows[0].status).toBe('CANCELLED');
});
it('a changed cached-token count cannot replace a settled proof or refund any scope',async()=>{
 const p=policy();Object.assign(p.pricing!,{cache:{inputPerMillion:'0.25',storagePerMillionTokenHour:'0'}});const w=await world(p),f=await w.create(),r=await request(w,f);
 await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:4}});
 const before=(await root.query('SELECT used,used_tokens,provider_usage,usage_hash FROM quota_ledger WHERE id=$1',[r.id])).rows[0],buckets=await w.buckets();
 await expect(w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:5}})).rejects.toThrow('MODEL_USAGE_OUTSIDE_RESERVATION');
 expect((await root.query('SELECT used,used_tokens,provider_usage,usage_hash FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toEqual(before);expect(await w.buckets()).toEqual(buckets);
 const next=await w.create();await expect(request(w,next,false)).rejects.toThrow('MODEL_BUDGET_POLICY_BLOCKED');
});
it('reviewed cache pricing does not settle malformed cache usage or an expired tariff',async()=>{
 for(const cached of [undefined,-1,11,0.5,'4',null]){
  const p=policy();Object.assign(p.pricing!,{cache:{inputPerMillion:'0.25',storagePerMillionTokenHour:'0'}});const w=await world(p),f=await w.create(),r=await request(w,f);
  await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:cached}});
  expect((await root.query('SELECT cost_state,token_state,used FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toMatchObject({cost_state:'UNKNOWN',token_state:'UNKNOWN',used:null});expect((await w.buckets()).every(b=>Number(b.reserved_money)>0&&Number(b.reserved_tokens)>0)).toBe(true);
 }
 const p=policy();p.pricing!.validUntil='2001-01-01T00:00:00.000Z';Object.assign(p.pricing!,{cache:{inputPerMillion:'0.25',storagePerMillionTokenHour:'0'}});const w=await world(p),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:4}});
 expect((await root.query('SELECT cost_state,token_state,used FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toMatchObject({cost_state:'UNKNOWN',token_state:'SETTLED',used:null});expect((await w.buckets()).every(b=>Number(b.reserved_money)>0)).toBe(true);
});

it('conservative estimates include the native tool schema, settings and untouched opaque fields; monetary ceilings match independent integer arithmetic',()=>{
 const p=policy(),body=payload(p),full=estimateModelPayload(body),without=estimateModelPayload({...body,tools:[],messages:[{role:'user',content:'Synthetic question.'}]});expect(full.tokens).toBeGreaterThan(without.tokens);expect(full.hash).not.toBe(without.hash);expect(JSON.stringify(body)).toContain('PRIVATE_NATIVE_QUOTA_REASONING_SENTINEL');
 const rates={inputPerMillion:'999999999999.12345670',outputPerMillion:'999999999999.12345670'},scaled=(s:string)=>BigInt(s.replace('.','').padEnd(s.includes('.')?s.indexOf('.')+8:s.length+8,'0')),sum=65536n*scaled(rates.inputPerMillion)+8192n*scaled(rates.outputPerMillion),units=(sum+99n)/100n,reference=String(units/1000000000000n)+'.'+String(units%1000000000000n).padStart(12,'0');expect(quotaMoney(65536,8192,rates)).toBe(reference);expect(reference).toBe('73727999999.935374215578');expect(quotaMoney(1,1,{inputPerMillion:'0.00000001',outputPerMillion:'0.00000001'})).toBe('0.000000000001');
});
it('ten different runs atomically compete for tenant, department and user quotas without partial hierarchical allocation',async()=>{
 for(const kind of ['tenant','department','user'] as const){const p=policy(),bound=estimateModelPayload(payload(p)).tokens+p.maxOutputTokens;p.limits[kind].tokens=String(bound*2);const w=await world(p),runs=await Promise.all(Array.from({length:10},()=>w.create(kind==='user'?w.ownerId:randomUUID()))),results=await Promise.allSettled(runs.map(f=>request(w,f,false)));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(results.filter(r=>r.status==='rejected')).toHaveLength(8);for(const result of results)if(result.status==='rejected')expect(result.reason).toMatchObject({code:'MODEL_TOKEN_BUDGET_EXHAUSTED_'+kind.toUpperCase()});const buckets=await w.buckets(),selected=buckets.filter(b=>b.scope_kind===kind.toUpperCase());expect(selected).toHaveLength(1);expect(selected[0].reserved_tokens).toBe(String(bound*2));expect(Number(selected[0].reserved_money)).toBeGreaterThan(0);expect((await root.query('SELECT count(*)::int n FROM quota_ledger WHERE tenant_id=$1',[w.tenantId])).rows[0].n).toBe(2);for(let i=0;i<results.length;i++)if(results[i]!.status==='fulfilled')await w.store.finishModel(runs[i]!.ctx,(results[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof request>>>).value.id,'NOT_SENT');expect((await w.buckets()).every(b=>Number(b.reserved_tokens)===0&&Number(b.reserved_money)===0)).toBe(true);}
});
it('a rejected downstream money quota rolls back the tenant allocation, request row and attempt counter',async()=>{
 const p=policy();p.limits.user.money='0';const w=await world(p),f=await w.create();await expect(request(w,f,false)).rejects.toThrow('MODEL_MONEY_BUDGET_EXHAUSTED_USER');expect(await w.buckets()).toEqual([]);expect((await root.query('SELECT count(*)::int n FROM quota_ledger WHERE tenant_id=$1',[w.tenantId])).rows[0].n).toBe(0);expect((await root.query('SELECT model_attempts,model_turns FROM runs WHERE id=$1',[f.runId])).rows[0]).toMatchObject({model_attempts:'0',model_turns:0});
});
it('twenty concurrent settlements book each shared scope once and release only the unused reservation',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f);await Promise.all(Array.from({length:20},()=>w.store.finishModel(f.ctx,r.id,'COMPLETE',knownUsage)));const row=(await root.query('SELECT * FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row).toMatchObject({dispatch_state:'COMPLETE',token_state:'SETTLED',cost_state:'SETTLED',used_tokens:'12',billing_basis:'ADMIN_APPROVED_RATE_AND_PROVIDER_USAGE'});expect(row.used).toBe('0.000017500000');for(const b of await w.buckets()){expect(b.reserved_tokens).toBe('0');expect(Number(b.reserved_money)).toBe(0);expect(b.used_tokens).toBe('12');expect(b.used_money).toBe('0.000017500000');}expect((await root.query('SELECT model_turns FROM runs WHERE id=$1',[f.runId])).rows[0].model_turns).toBe(1);
});
it('known usage with an unconfirmed tariff settles tokens but retains strictly positive UNKNOWN money exposure',async()=>{
 const p=policy();p.pricing=null;const w=await world(p),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,'COMPLETE',knownUsage);const row=(await root.query('SELECT * FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row).toMatchObject({cost_state:'UNKNOWN',used:null,token_state:'SETTLED',used_tokens:'12'});expect(Number(row.reservation)).toBeGreaterThan(0);for(const b of await w.buckets()){expect(b.reserved_tokens).toBe('0');expect(Number(b.reserved_money)).toBeGreaterThan(0);expect(Number(b.used_money)).toBe(0);}
});
it('an interrupted or malformed-usage dispatch retains token and monetary reservations rather than charging zero',async()=>{
 for(const kind of ['UNKNOWN','COMPLETE'] as const){const w=await world(),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,kind,kind==='COMPLETE'?{prompt_tokens:10,completion_tokens:2,total_tokens:999}:null);const row=(await root.query('SELECT * FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row.cost_state).toBe('UNKNOWN');expect(row.token_state).toBe('UNKNOWN');expect(row.used).toBeNull();expect(row.used_tokens).toBeNull();for(const b of await w.buckets()){expect(Number(b.reserved_tokens)).toBeGreaterThan(0);expect(Number(b.reserved_money)).toBeGreaterThan(0);}}
});
it('cancelled, expired, departed and active-budget-exhausted orphan runs release only PREPARED requests and preserve DISPATCHING fees as UNKNOWN',async()=>{
 for(const mode of ['cancel','expiry','departure','active'] as const)for(const sent of [false,true]){const w=await world(),f=await w.create(),r=await request(w,f,sent);if(mode==='cancel')await new TaskStore(appDb).cancel(f.ctx,f.taskId);if(mode==='expiry'){await root.query("UPDATE tasks SET expires_at=now()-interval '1 second' WHERE id=$1",[f.taskId]);await root.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.runId]);}if(mode==='departure'){await root.query("UPDATE users SET status='DEPARTED' WHERE id=$1",[f.ctx.actorId]);await root.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.runId]);}if(mode==='active'){await root.query("UPDATE runs SET active_ms=240000,lease_until=now()-interval '1 second' WHERE id=$1",[f.runId]);}await new RetryDispatcher(db).dispatch(f.ctx);await new BudgetRecovery(db).tenant(f.ctx);const row=(await root.query('SELECT * FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row.dispatch_state).toBe(sent?'UNKNOWN':'RELEASED');expect(row.cost_state).toBe(sent?'UNKNOWN':'RELEASED');if(sent){expect(row.used).toBeNull();expect((await w.buckets()).every(b=>Number(b.reserved_money)>0&&Number(b.reserved_tokens)>0)).toBe(true);}else expect((await w.buckets()).every(b=>Number(b.reserved_money)===0&&Number(b.reserved_tokens)===0)).toBe(true);}
});
it('late valid usage after an abandoned dispatch settles its original reservation even after the run is cancelled',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f);await new TaskStore(appDb).cancel(f.ctx,f.taskId);await new BudgetRecovery(db).tenant(f.ctx);expect((await root.query('SELECT cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0].cost_state).toBe('UNKNOWN');await w.store.finishModel(f.ctx,r.id,'COMPLETE',knownUsage);expect((await root.query('SELECT cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0].cost_state).toBe('SETTLED');expect((await root.query('SELECT status FROM runs WHERE id=$1',[f.runId])).rows[0].status).toBe('CANCELLED');
});
it('provider usage above the reserved bounds is retained as a violation and blocks future dispatch without exceeding normal settlement',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f);await expect(w.store.finishModel(f.ctx,r.id,'COMPLETE',{prompt_tokens:r.inputTokens+1,completion_tokens:1,total_tokens:r.inputTokens+2})).rejects.toThrow('MODEL_USAGE_OUTSIDE_RESERVATION');expect((await root.query('SELECT cost_state,token_state,used FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toMatchObject({cost_state:'UNKNOWN',token_state:'UNKNOWN',used:null});expect((await w.buckets()).every(b=>Number(b.reserved_money)>0&&Number(b.used_money)===0)).toBe(true);const next=await w.create();await expect(request(w,next,false)).rejects.toThrow('MODEL_BUDGET_POLICY_BLOCKED');
});
it('a task lifetime quota persists across different runs and a current department change invalidates an unsent quote',async()=>{
 const p=policy(),bound=estimateModelPayload(payload(p)).tokens+p.maxOutputTokens;p.limits.task.tokens=String(bound);const w=await world(p),first=await w.create(),r=await request(w,first);await w.store.finishModel(first.ctx,r.id,'COMPLETE',knownUsage);await w.store.release(first.ctx,first.lease);const second=await w.create(w.ownerId,first.taskId);await expect(request(w,second,false)).rejects.toThrow('MODEL_TOKEN_BUDGET_EXHAUSTED_TASK');expect((await w.buckets()).find(b=>b.scope_kind==='TASK')?.period).toBe('LIFETIME');const different=await w.create(),q=await request(w,different,false);await root.query('UPDATE memberships SET valid_to=now() WHERE tenant_id=$1 AND user_id=$2',[w.tenantId,w.ownerId]);await expect(w.store.startModel(different.ctx,different.lease,q,payload(p),async()=>null)).rejects.toThrow('MODEL_DEPARTMENT_SCOPE_CHANGED');await w.store.finishModel(different.ctx,q.id,'NOT_SENT');
});
it('a different namespace cannot settle a request, and unmetered legacy exposure anywhere in the tenant blocks new quotas',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f),other=await world(),foreign=await other.create(w.ownerId);await expect(other.store.finishModel(foreign.ctx,r.id,'COMPLETE',knownUsage)).rejects.toThrow('MODEL_RESERVATION_NOT_FOUND');await expect(appDb.scope(f.ctx,c=>c.query('SELECT policy_snapshot FROM quota_ledger WHERE id=$1',[r.id]))).rejects.toMatchObject({code:'42501'});const legacy=await w.create(randomUUID());await root.query("INSERT INTO quota_ledger(tenant_id,id,owner_id,run_id,subject,period,reservation,cost_state) VALUES($1,$2,$3,$4,$3::uuid::text,to_char(now(),'YYYY-MM-DD'),0,'UNKNOWN')",[w.tenantId,randomUUID(),legacy.ctx.actorId,legacy.runId]);const next=await w.create();await expect(request(w,next,false)).rejects.toThrow('LEGACY_MODEL_COST_RECONCILIATION_REQUIRED');expect((await w.buckets()).every(b=>Number(b.reserved_money)>0)).toBe(true);
});
it('the database rejects incomplete v1 ledgers instead of allowing a NULL CHECK to admit unmetered requests',async()=>{
 const w=await world(),f=await w.create();await expect(root.query("INSERT INTO quota_ledger(tenant_id,id,owner_id,run_id,subject,period,reservation,cost_state,accounting_version) VALUES($1,$2,$3,$4,'synthetic','synthetic',0,'UNKNOWN',1)",[w.tenantId,randomUUID(),w.ownerId,f.runId])).rejects.toMatchObject({code:'23514'});
});
it('UNKNOWN fees from an invoked native substitute block the next task at every shared token or money quota without another provider call',async()=>{
 for(const kind of ['tenant','department','user'] as const)for(const dimension of ['tokens','money'] as const){
  const p=policy(),body=glmRequestBody([{role:'system',content:SYSTEM_PROMPT},{role:'user',content:'synthetic quota request'}],[],'high',{maxOutputTokens:p.maxOutputTokens}),input=estimateModelPayload(body).tokens;
  p.limits[kind][dimension]=dimension==='tokens'?String(input+p.maxOutputTokens):quotaMoney(input,p.maxOutputTokens,p.ceiling).replace(/0+$/,'').replace(/\.$/,'');
  const w=await world(p),first=await w.create();await w.store.release(first.ctx,first.lease);let providerCalls=0;
  const model=new GlmProvider({apiKey:'synthetic-not-a-credential',baseUrl:'http://127.0.0.1',reasoningEffort:'high',fetch:async()=>{
   providerCalls++;await new TaskStore(appDb).cancel(first.ctx,first.taskId);
   // Native client receives an incomplete stream after invocation. No usage or
   // definitive no-send proof exists, even though cancellation is durable.
   return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'synthetic incomplete fragment'},finish_reason:null}]})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  await new AgentRuntime(w.store,model,new Gateway(w.store)).advance(first.ctx,first.runId);
  const original=(await root.query('SELECT * FROM quota_ledger WHERE run_id=$1',[first.runId])).rows[0];expect(original.dispatch_state).toBe('UNKNOWN');expect(original.cost_state).toBe('UNKNOWN');expect(Number(original.reservation)).toBeGreaterThan(0);expect(providerCalls).toBe(1);
  const second=await w.create(kind==='user'?w.ownerId:randomUUID());await w.store.release(second.ctx,second.lease);await new AgentRuntime(w.store,model,new Gateway(w.store)).advance(second.ctx,second.runId);
  expect(providerCalls).toBe(1);expect((await root.query('SELECT status,last_error FROM runs WHERE id=$1',[second.runId])).rows[0]).toMatchObject({status:'PARTIAL',last_error:'MODEL_'+(dimension==='tokens'?'TOKEN':'MONEY')+'_BUDGET_EXHAUSTED_'+kind.toUpperCase()});expect((await root.query('SELECT count(*)::int n FROM quota_ledger WHERE tenant_id=$1',[w.tenantId])).rows[0].n).toBe(1);
 }
});
it('owner recovery commits each run before recovering the next while a concurrent late settlement holds that next run',async()=>{
 const w=await world(),runs=(await Promise.all([w.create(),w.create()])).sort((a,b)=>a.runId.localeCompare(b.runId)),first=runs[0]!,second=runs[1]!,a=await request(w,first,false),b=await request(w,second,true);
 await new TaskStore(appDb).cancel(first.ctx,first.taskId);await new TaskStore(appDb).cancel(second.ctx,second.taskId);
 let firstRecovered!:()=>void,allowCommit!:()=>void,nextLocked!:()=>void;
 const recovered=new Promise<void>(r=>{firstRecovered=r;}),commit=new Promise<void>(r=>{allowCommit=r;}),locked=new Promise<void>(r=>{nextLocked=r;}),recover=w.budget.recover.bind(w.budget);
 const spy=vi.spyOn(w.budget,'recover').mockImplementation(async(c,id)=>{await c.query("SET LOCAL lock_timeout='3s'");const n=await recover(c,id);if(id===first.runId){firstRecovered();await commit;}return n;});
 const recovery=new BudgetRecovery(db,w.budget).owner(first.ctx);let settlement:Promise<unknown>|undefined;
 try{
  await recovered;settlement=db.scope(second.ctx,async c=>{await c.query("SET LOCAL lock_timeout='3s'");await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[second.runId]);await c.query('SELECT id FROM quota_ledger WHERE id=$1 FOR UPDATE',[b.id]);nextLocked();return w.budget.finish(c,b.id,'COMPLETE',knownUsage);});
  await locked;allowCommit();expect(await recovery).toBeGreaterThanOrEqual(1);expect(await settlement).toEqual({violation:false});
  const states=(await root.query('SELECT id,dispatch_state FROM quota_ledger WHERE id=ANY($1::uuid[]) ORDER BY id',[[a.id,b.id]])).rows;expect(states.find(r=>r.id===a.id)?.dispatch_state).toBe('RELEASED');expect(states.find(r=>r.id===b.id)?.dispatch_state).toBe('COMPLETE');for(const bucket of await w.buckets()){expect(Number(bucket.reserved_money)).toBe(0);expect(bucket.reserved_tokens).toBe('0');}
 }finally{allowCommit();await Promise.allSettled([recovery,...(settlement?[settlement]:[])]);spy.mockRestore();}
});
it('trusted no-send proof releases a dispatch and restores its model round once while attempts remain charged',async()=>{
 const w=await world(),f=await w.create(),r=await request(w,f);await Promise.all(Array.from({length:10},()=>w.store.finishModel(f.ctx,r.id,'NOT_SENT',null,'SYNTHETIC_TRUSTED_LOCAL_NO_SEND')));expect((await root.query('SELECT model_turns,model_attempts FROM runs WHERE id=$1',[f.runId])).rows[0]).toMatchObject({model_turns:0,model_attempts:'1'});expect((await w.buckets()).every(b=>Number(b.reserved_tokens)===0&&Number(b.reserved_money)===0)).toBe(true);expect((await root.query('SELECT billing_basis FROM quota_ledger WHERE id=$1',[r.id])).rows[0].billing_basis).toBe('CONFIRMED_NOT_SENT');
});
it('a live model slot is shared across tasks and released without discarding UNKNOWN fee exposure',async()=>{
 const p=policy();p.limits.user.concurrent=1;const w=await world(p),first=await w.create(),r=await request(w,first);const next=await w.create();await expect(request(w,next,false)).rejects.toMatchObject({code:'MODEL_CONCURRENCY_LIMIT',retryable:true});await new TaskStore(appDb).cancel(first.ctx,first.taskId);await new BudgetRecovery(db,w.budget).owner(first.ctx);const q=await request(w,next,false);expect(q.id).not.toBe(r.id);expect((await root.query('SELECT cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0].cost_state).toBe('UNKNOWN');await w.store.finishModel(next.ctx,q.id,'NOT_SENT');expect((await w.buckets()).find(b=>b.scope_kind==='USER')?.reserved_tokens).toBe(String(r.inputTokens+r.outputTokens));
});
it('policy expiry or a changed approved policy blocks dispatch before a new request can reserve funds',async()=>{
 for(const mode of ['expired','changed'] as const){const w=await world(),f=await w.create(),r=await request(w,f,false);await w.store.finishModel(f.ctx,r.id,'NOT_SENT');if(mode==='expired')await root.query("UPDATE budget_policies SET valid_until=now()-interval '1 second' WHERE tenant_id=$1",[w.tenantId]);else await root.query("UPDATE budget_policies SET policy_hash='synthetic-different-approved-version' WHERE tenant_id=$1",[w.tenantId]);await expect(request(w,f,false)).rejects.toThrow(mode==='expired'?'MODEL_BUDGET_POLICY_EXPIRED':'MODEL_BUDGET_POLICY_VERSION_MISMATCH');expect((await root.query('SELECT count(*)::int n FROM quota_ledger WHERE run_id=$1',[f.runId])).rows[0].n).toBe(1);}
});
it('native output/input bounds and accumulated attempt/round limits reject requests without allocations',async()=>{
 for(const mode of ['output','input','attempts','rounds','missing'] as const){const p=policy();if(mode==='input')p.maxInputTokens=1;const w=await world(p),f=await w.create();if(mode==='attempts')await root.query('UPDATE runs SET model_attempts=64 WHERE id=$1',[f.runId]);if(mode==='rounds')await root.query('UPDATE runs SET model_turns=16 WHERE id=$1',[f.runId]);const body=payload(p);if(mode==='output')body['max_tokens']=p.maxOutputTokens+1;let store=w.store;if(mode==='missing'){const previous=process.env['BUDGET_POLICY_FILE'];try{process.env['BUDGET_POLICY_FILE']='';store=new RuntimeStore(db,vault);}finally{process.env['BUDGET_POLICY_FILE']=previous;}}await expect(store.prepareModel(f.ctx,f.lease,body)).rejects.toThrow({output:'MODEL_OUTPUT_BUDGET_MISMATCH',input:'MODEL_INPUT_BUDGET_EXHAUSTED',attempts:'MODEL_BUDGET_EXHAUSTED',rounds:'MODEL_BUDGET_EXHAUSTED',missing:'MODEL_BUDGET_POLICY_UNCONFIGURED'}[mode]);expect(await w.buckets()).toEqual([]);}
});
it('an outstanding request cannot reserve again, and a changed body, day or exhausted round invalidates the prepared dispatch',async()=>{
 for(const mode of ['pending','body','day','round','stale'] as const){const w=await world(),f=await w.create(),r=await request(w,f,false);if(mode==='pending'){await expect(request(w,f,false)).rejects.toMatchObject({code:'MODEL_RUN_REQUEST_IN_PROGRESS',retryable:true});continue;}if(mode==='day')await root.query("UPDATE quota_ledger SET period='1900-01-01' WHERE id=$1",[r.id]);if(mode==='round')await root.query('UPDATE runs SET model_turns=16 WHERE id=$1',[f.runId]);const body=payload(w.p);if(mode==='body')body['temperature']=0;const selected=mode==='stale'?{...r,id:randomUUID()}:r;await expect(w.store.startModel(f.ctx,f.lease,selected,body,async()=>null)).rejects.toThrow({body:'MODEL_PAYLOAD_CHANGED_BEFORE_DISPATCH',day:'MODEL_BUDGET_PERIOD_CHANGED',round:'MODEL_BUDGET_EXHAUSTED',stale:'MODEL_RESERVATION_STALE'}[mode]);expect((await root.query('SELECT dispatch_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0].dispatch_state).toBe('PREPARED');await w.store.finishModel(f.ctx,r.id,'NOT_SENT');}
});
it('a final source or kill rejection rolls the dispatch marker and model round back in the same transaction',async()=>{
 for(const reason of ['MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH','MODEL_KILL_SWITCH']){const w=await world(),f=await w.create(),r=await request(w,f,false);await expect(w.store.startModel(f.ctx,f.lease,r,payload(w.p),async()=>reason)).rejects.toThrow(reason);expect((await root.query('SELECT dispatch_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0].dispatch_state).toBe('PREPARED');expect((await root.query('SELECT model_turns FROM runs WHERE id=$1',[f.runId])).rows[0].model_turns).toBe(0);await w.store.finishModel(f.ctx,r.id,'NOT_SENT');expect((await w.buckets()).every(b=>Number(b.reserved_money)===0)).toBe(true);}
});
it('untracked completion and conflicting late usage freeze future requests and preserve the original settled proof',async()=>{
 const unsent=await world(),first=await unsent.create(),a=await request(unsent,first,false);await expect(unsent.store.finishModel(first.ctx,a.id,'COMPLETE',knownUsage)).rejects.toThrow('MODEL_USAGE_OUTSIDE_RESERVATION');expect((await root.query('SELECT dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[a.id])).rows[0]).toMatchObject({dispatch_state:'UNKNOWN',cost_state:'UNKNOWN'});
 const w=await world(),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,private_extra:'SYNTHETIC_USAGE_PRIVATE_FIELD'});const original=(await root.query('SELECT used,used_tokens,provider_usage,usage_hash FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(JSON.stringify(original)).not.toContain('SYNTHETIC_USAGE_PRIVATE_FIELD');await expect(w.store.finishModel(f.ctx,r.id,'COMPLETE',{prompt_tokens:11,completion_tokens:2,total_tokens:13})).rejects.toThrow('MODEL_USAGE_OUTSIDE_RESERVATION');expect((await root.query('SELECT used,used_tokens,provider_usage,usage_hash FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toEqual(original);await expect(w.store.finishModel(f.ctx,r.id,'NOT_SENT')).rejects.toThrow('SETTLED_MODEL_COST_CANNOT_BE_RELEASED');await w.store.finishModel(f.ctx,r.id,'UNKNOWN');await w.store.finishModel(f.ctx,r.id,'COMPLETE',null);expect((await root.query('SELECT used,used_tokens,provider_usage,usage_hash FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toEqual(original);
});
it('unconfirmed cache or expired tariff retains money while invalid cached usage also retains token exposure',async()=>{
 for(const mode of ['cache','expired','invalid'] as const){const p=policy();if(mode==='expired')p.pricing!.validUntil='2001-01-01T00:00:00.000Z';const w=await world(p),f=await w.create(),r=await request(w,f);await w.store.finishModel(f.ctx,r.id,'COMPLETE',{...knownUsage,prompt_tokens_details:{cached_tokens:mode==='invalid'?11:1}});const row=(await root.query('SELECT cost_state,token_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0];expect(row.cost_state).toBe('UNKNOWN');expect(row.token_state).toBe(mode==='invalid'?'UNKNOWN':'SETTLED');expect((await w.buckets()).every(b=>Number(b.reserved_money)>0)).toBe(true);}
});
it('corrupt counters cannot release or settle any partial hierarchy and the original exposure is retained',async()=>{
 for(const mode of ['money','round'] as const){const w=await world(),f=await w.create(),r=await request(w,f);if(mode==='money')await root.query("UPDATE budget_buckets SET reserved_money=0 WHERE tenant_id=$1 AND scope_kind='USER'",[w.tenantId]);else await root.query('UPDATE runs SET model_turns=0 WHERE id=$1',[f.runId]);const before=await w.buckets();await expect(w.store.finishModel(f.ctx,r.id,mode==='money'?'COMPLETE':'NOT_SENT',knownUsage)).rejects.toThrow(mode==='money'?'MODEL_QUOTA_ACCOUNTING_INTEGRITY':'MODEL_TURN_ACCOUNTING_INTEGRITY');expect(await w.buckets()).toEqual(before);expect((await root.query('SELECT dispatch_state,token_state,cost_state FROM quota_ledger WHERE id=$1',[r.id])).rows[0]).toMatchObject({dispatch_state:'DISPATCHING',token_state:'RESERVED',cost_state:'RESERVED'});}
});
