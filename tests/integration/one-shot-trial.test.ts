import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {secret} from '../../packages/config/src/index.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {AgentRuntime,registerTaskCapability} from '../../packages/runtime/src/loop.js';
import {glmRequestBody,type ModelProvider} from '../../packages/provider-glm/src/client.js';
import {ModelBudget,estimateModelPayload,quotaMoney} from '../../packages/runtime/src/model-budget.js';
import {SYSTEM_PROMPT} from '../../packages/runtime/src/checkpoint.js';
import {modelBudgetPolicySchema,type ModelBudgetPolicy} from '../../packages/runtime/src/budget-policy.js';
import {trialState,assertTrial} from '../../packages/storage/src/trial.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {BudgetRecovery} from '../../packages/runtime/src/budget-recovery.js';
import {RunQueue} from '../../packages/tasks/src/queue.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {DeliveryGateway,type DeliverySender} from '../../packages/gateway/src/delivery.js';
import {initializeTrial,trialProfileSchema,assertTrialScopes,assertTrialBinding} from '../../packages/config/src/one-shot-trial.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),connections:Database[]=[];
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
async function world(trial=true,options:{ttlMs?:number;policy?:ModelBudgetPolicy}={}){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},other=randomUUID(),corpId='SYNTHETIC-'+ctx.tenantId,robotCode='synthetic-robot',conversationId='synthetic-dm';
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC ONE SHOT','ACTIVE')",[ctx.tenantId,corpId]);
 for(const [id,external] of [[ctx.actorId,'owner'],[other,'other']])await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'SYNTHETIC','ACTIVE')",[ctx.tenantId,id,external]);
 const policy=options.policy??modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));
 const profile=trialProfileSchema.parse({schemaVersion:1,tenantId:ctx.tenantId,actorId:ctx.actorId,corpId,externalUserId:'owner',robotCode,conversationId,deadline:new Date(Date.now()+(options.ttlMs??3600000)).toISOString(),budgetPolicyHash:hash(JSON.stringify(policy)),approvalReference:'SYNTHETIC_OFFLINE_ONLY_NO_REAL_APPROVAL'});
 const profileHash=hash(JSON.stringify(profile)),db=new Database(secret('RUNTIME_DATABASE_URL')!);connections.push(db);
 // Intended profile attestation plus a real persisted record. Before the fix,
 // existing entrypoints ignore both and violate the business assertions below.
 Object.assign(db,{trialProfileHash:trial?profileHash:null});
 if(trial){
  const slot=await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,$8::timestamptz) RETURNING ceil(extract(epoch FROM created_at)*1000)::text cutoff_ms",[ctx.tenantId,ctx.actorId,profileHash,hash(JSON.stringify(policy)),corpId,robotCode,conversationId,profile.deadline]);
  const cutoff=Number(slot.rows[0].cutoff_ms);
  // Generate legal events only after both real clocks reach the database's
  // microsecond-derived cutoff. Never backdate authority or invent event time.
  await vi.waitFor(async()=>{const sample=await admin.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text now_ms");expect(Number(sample.rows[0].now_ms)).toBeGreaterThanOrEqual(cutoff);expect(Date.now()).toBeGreaterThanOrEqual(cutoff);},{timeout:250,interval:1});
 }
 const store=new RuntimeStore(db,vault,new ModelBudget(policy)),gateway=new Gateway(store);registerTaskCapability(gateway);
 const ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,corpId,robotCode},store);
 const event=(patch:Record<string,unknown>={},id=randomUUID()):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:'owner',conversationId,conversationType:'1',robotCode,msgtype:'text',text:{content:'Explain the word hello.'},createAt:Date.now(),senderId:'owner-id',chatbotUserId:'bot-id',sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',sessionWebhookExpiredTime:Date.now()+60000,...patch})});
 const count=async(table:string)=>Number((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,[ctx.tenantId])).rows[0].n);
 const admit=async()=>{const result=await ingress.acceptTrustedCallback(event());expect(result).not.toBeNull();const run=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[result!.taskId])).rows[0];return {...result!,runId:run.id as string};};
 const state=async()=>(await admin.query('SELECT * FROM one_shot_trials WHERE tenant_id=$1',[ctx.tenantId])).rows[0];
 return {ctx,other,db,store,gateway,ingress,event,count,admit,profileHash,state,policy,profile,corpId,robotCode};
}
afterAll(async()=>{await Promise.all(connections.map(db=>db.close()));await admin.end();});

it.each([
 ['wrong employee',{senderStaffId:'other'}],
 ['wrong enterprise',{senderCorpId:'SYNTHETIC_OTHER_CORP'}],
 ['group',{conversationType:'2'}],
 ['wrong DM',{conversationId:'another-dm'}],
 ['attachment',{msgtype:'file',content:{downloadCode:'synthetic',fileName:'synthetic.txt'}}],
 ['stop command',{text:{content:'停止'}}],
 ['clarification command',{text:{content:'补充 12345678：synthetic'}}],
 ['memory command',{text:{content:'记住：SYNTHETIC_TRIAL_MEMORY_MUST_NOT_WRITE'}}],
 ['persona command',{text:{content:'/persona personal view'}}]
] as const)('trial admission rejects %s before any control/task/inbox/outbox side effects',async(_name,patch)=>{
 const w=await world();await Promise.allSettled([w.ingress.acceptTrustedCallback(w.event(patch))]);
 for(const table of ['tasks','event_inbox','outbox','memory_items','personas']){
  expect(await w.count(table),table).toBe(0);
 }
 expect((await admin.query('SELECT state,task_id FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0]).toMatchObject({state:'ARMED',task_id:null});
});
it('two concurrent eligible messages bind exactly one task, run and RUN outbox',async()=>{
 const w=await world(),events=[w.event(),w.event()];await Promise.allSettled(events.map(e=>w.ingress.acceptTrustedCallback(e)));
 expect(await w.count('tasks')).toBe(1);expect(await w.count('runs')).toBe(1);expect(await w.count('outbox')).toBe(1);
 const slot=(await admin.query('SELECT * FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0];expect(slot.state).toBe('BOUND');expect(events.map(e=>JSON.parse(e.data).msgId)).toContain(slot.msg_id);expect(slot.task_id).toBeTruthy();
});
it('eligible first message and 20 identical duplicates reuse the one durable task',async()=>{
 const w=await world(),event=w.event(),results=await Promise.all(Array.from({length:20},()=>w.ingress.acceptTrustedCallback(event)));
 expect(new Set(results.map(r=>r?.taskId)).size).toBe(1);expect(results.filter(r=>!r?.duplicate)).toHaveLength(1);expect(await w.count('tasks')).toBe(1);
});
it('trial CORE and forged tools are neither advertised nor executed',async()=>{
 const w=await world(),job=await w.admit(),lease=(await w.store.acquire(w.ctx,job.runId,'synthetic-trial'))!;
 expect(lease).toBeTruthy();expect(await w.gateway.tools(w.ctx,lease)).toEqual([]);
 for(const name of [toolName('tasks.get','1.0.0'),'forged'])expect((await w.gateway.execute(w.ctx,lease,name,{},new AbortController().signal)).status).toBe('DENIED');
 expect(await w.count('tool_actions')).toBe(0);await w.store.release(w.ctx,lease);
});
it('default mode still admits different messages and exposes the existing CORE tool',async()=>{
 const w=await world(false),a=await w.admit(),b=await w.admit();expect(a.taskId).not.toBe(b.taskId);
 const lease=(await w.store.acquire(w.ctx,a.runId,'synthetic-default'))!;expect((await w.gateway.tools(w.ctx,lease)).map(t=>t.function.name)).toContain(toolName('tasks.get','1.0.0'));
 expect((await w.gateway.execute(w.ctx,lease,toolName('tasks.get','1.0.0'),{},new AbortController().signal)).status).toBe('OK');await w.store.release(w.ctx,lease);
});

const usage={prompt_tokens:10,completion_tokens:2,total_tokens:12};
const policy=()=>{const p=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));p.pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_RATE_NO_REAL_APPROVAL',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};return p;};
const general={schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]};
const proposal=JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text:'Hello is a greeting.',claims:[],outcome:'COMPLETE'});
function model(complete?:ModelProvider['complete']){let calls=0;const toolsSeen:unknown[]=[];return {get calls(){return calls;},toolsSeen,provider:{describeRequest:(messages,tools,limits)=>glmRequestBody(messages,tools,'high',limits),complete:async(...args)=>{calls++;toolsSeen.push(args[1]);if(complete)return complete(...args);return {message:{role:'assistant',content:calls===1?proposal:JSON.stringify(general)},finishReason:'stop',usage,requestId:null};}} satisfies ModelProvider};}
async function prepared(w:Awaited<ReturnType<typeof world>>,sent=false){const job=await w.admit(),lease=(await w.store.acquire(w.ctx,job.runId,'synthetic-quota'))!,payload=glmRequestBody([{role:'user',content:'synthetic'}],[],'high',w.store.modelLimits()),request=await w.store.prepareModel(w.ctx,lease,payload);if(sent)await w.store.startModel(w.ctx,lease,request,payload,async()=>null);return {...job,lease,payload,request};}

it('admission checks DB wall clock after waiting on the slot lock',async()=>{
 const w=await world(true,{ttlMs:900}),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT * FROM one_shot_trials WHERE tenant_id=$1 FOR UPDATE',[w.ctx.tenantId]);
 const accept=w.ingress.acceptTrustedCallback(w.event());await lock.query('SELECT pg_sleep(1.1)');await lock.query('COMMIT');lock.release();expect(await accept).toBeNull();expect(await w.count('tasks')).toBe(0);expect(await w.state()).toMatchObject({state:'CLOSED',close_reason:'TRIAL_DEADLINE'});
});
it('dispatch deadline crossed behind a run lock rolls back dispatch but commits CLOSED separately',async()=>{
 const w=await world(true,{ttlMs:1500}),p=await prepared(w),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[p.runId]);
 const dispatch=w.store.startModel(w.ctx,p.lease,p.request,p.payload,async()=>null);const caught=dispatch.catch(e=>e as Error);await lock.query('SELECT pg_sleep(1.7)');await lock.query('COMMIT');lock.release();expect((await caught as Error).message).toBe('TRIAL_DEADLINE');
 expect(await w.state()).toMatchObject({state:'CLOSED',close_reason:'TRIAL_DEADLINE'});expect((await admin.query('SELECT dispatch_state FROM quota_ledger WHERE id=$1',[p.request.id])).rows[0].dispatch_state).toBe('PREPARED');expect((await admin.query('SELECT fence,model_turns FROM runs WHERE id=$1',[p.runId])).rows[0]).toMatchObject({fence:String(p.lease.fence),model_turns:0});await w.store.finishModel(w.ctx,p.request.id,'NOT_SENT');
});
it('an in-flight model is aborted by DB deadline, retains UNKNOWN exposure, and cannot retry',async()=>{
 const w=await world(true,{ttlMs:1200}),job=await w.admit();let aborted=false;
 const m=model(async(_messages,_tools,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});}));
 await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);expect(aborted).toBe(true);expect(m.calls).toBe(1);expect(await w.state()).toMatchObject({state:'CLOSED'});
 const q=(await admin.query('SELECT dispatch_state,cost_state,reservation FROM quota_ledger WHERE run_id=$1',[job.runId])).rows[0];expect(q).toMatchObject({dispatch_state:'UNKNOWN',cost_state:'UNKNOWN'});expect(Number(q.reservation)).toBeGreaterThan(0);
 await new RetryDispatcher(w.db).dispatch(w.ctx);await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);expect(m.calls).toBe(1);
});
it.each(['same','missing','changed'] as const)('model UNKNOWN permanently blocks %s-profile restart, stale outbox and forged execution',async kind=>{
 const w=await world(),p=await prepared(w,true);await w.store.finishModel(w.ctx,p.request.id,'UNKNOWN');expect((await w.state()).state).toBe('CLOSED');
 const next=new Database(secret('RUNTIME_DATABASE_URL')!);connections.push(next);next.trialProfileHash=kind==='same'?w.profileHash:kind==='changed'?hash('different'):null;const nextStore=new RuntimeStore(next,vault),m=model();
 const queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'synthetic-unstarted-trial'),send=vi.spyOn(queue.boss,'send');
 const fence=(await admin.query('SELECT fence FROM runs WHERE id=$1',[p.runId])).rows[0].fence;
 expect(await queue.publish(next,w.ctx)).toBe(0);expect(send).not.toHaveBeenCalled();expect(await new RetryDispatcher(next).dispatch(w.ctx)).toBe(0);
 await new AgentRuntime(nextStore,m.provider,new Gateway(nextStore)).advance(w.ctx,p.runId);expect(m.calls).toBe(0);expect((await admin.query('SELECT fence FROM runs WHERE id=$1',[p.runId])).rows[0].fence).toBe(fence);
 expect((await new Gateway(nextStore).execute(w.ctx,p.lease,'forged',{},new AbortController().signal)).status).toBe('DENIED');expect(Number((await admin.query("SELECT reserved_money FROM budget_buckets WHERE tenant_id=$1 AND scope_kind='TASK'",[w.ctx.tenantId])).rows[0].reserved_money)).toBeGreaterThan(0);send.mockRestore();
});
it('orphan DISPATCHING closes before recovery can change fence or publish, retaining positive money',async()=>{
 const w=await world(),p=await prepared(w,true);await admin.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[p.runId]);
 const queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'synthetic-unstarted-orphan'),send=vi.spyOn(queue.boss,'send');expect(await queue.publish(w.db,w.ctx)).toBe(0);expect(send).not.toHaveBeenCalled();expect((await w.state()).state).toBe('CLOSED');
 expect(await w.store.acquire(w.ctx,p.runId,'new-worker')).toBeNull();await new BudgetRecovery(w.db).owner(w.ctx);expect((await admin.query('SELECT fence FROM runs WHERE id=$1',[p.runId])).rows[0].fence).toBe(String(p.lease.fence));expect((await admin.query('SELECT dispatch_state,cost_state FROM quota_ledger WHERE id=$1',[p.request.id])).rows[0]).toMatchObject({dispatch_state:'UNKNOWN',cost_state:'UNKNOWN'});send.mockRestore();
});
it('scoped startup cannot close or reveal another tenant or employee trial',async()=>{
 const w=await world(),before=await w.state(),otherCtx={tenantId:randomUUID(),actorId:randomUUID()};
 for(const ctx of [otherCtx,{...w.ctx,actorId:w.other}]){
  const result=await w.db.scope(ctx,async c=>(await c.query('SELECT public.oa_trial_bootstrap($1) state',[hash('wrong-profile')])).rows[0].state);expect(result).toEqual({blocked:true});expect(await w.state()).toEqual(before);
  expect(await w.db.scope(ctx,c=>trialState(c,undefined,true,'TRIAL_FORGED_CLOSE'))).not.toHaveProperty('taskId');expect(await w.state()).toEqual(before);
 }
 expect((await w.db.pool.query('SELECT public.oa_trial_bootstrap(NULL) state')).rows[0].state).toEqual({blocked:true});expect(await w.state()).toEqual(before);
});
it('fresh healthy DISPATCHING refuses a second process without closing its peer, then expired lease closes',async()=>{
 const w=await world(),p=await prepared(w,true);expect(await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_trial_bootstrap($1) state',[w.profileHash])).rows[0].state)).toEqual({blocked:true});expect((await w.state()).state).toBe('BOUND');
 await admin.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[p.runId]);expect(await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_trial_bootstrap($1) state',[w.profileHash])).rows[0].state)).toEqual({blocked:true});expect((await w.state()).state).toBe('CLOSED');await new BudgetRecovery(w.db).owner(w.ctx);
});
it('H5 creation cannot allocate a second task even with the same profile; CLOSED cannot be reopened or deleted',async()=>{
 const w=await world(),job=await w.admit();await expect(new TaskStore(w.db).create(w.ctx,'SYNTHETIC BYPASS','another')).rejects.toThrow('TRIAL_RUN_MISMATCH');expect(await w.count('tasks')).toBe(1);
 await w.db.scope(w.ctx,c=>trialState(c,job.runId,false,'TRIAL_OPERATOR_STOP'));await expect(admin.query("UPDATE one_shot_trials SET state='ARMED',closed_at=NULL,close_reason=NULL WHERE tenant_id=$1",[w.ctx.tenantId])).rejects.toThrow('TRIAL_CLOSED_IMMUTABLE');await expect(admin.query('DELETE FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rejects.toThrow('TRIAL_DELETE_FORBIDDEN');
 await expect(w.db.scope(w.ctx,c=>assertTrial(c,job.runId))).rejects.toThrow('TRIAL_CLOSED');expect(await w.ingress.acceptTrustedCallback(w.event())).toBeNull();
});
async function finished(){const w=await world(true,{policy:policy()}),job=await w.admit(),m=model();await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);expect(m.calls).toBe(2);expect(m.toolsSeen).toEqual([[],[]]);const delivery=(await admin.query('SELECT id FROM deliveries WHERE task_id=$1',[job.taskId])).rows[0];expect(delivery).toBeTruthy();return {...w,...job,m,deliveryId:delivery.id as string};}
const transport=(w:Awaited<ReturnType<typeof finished>>,sender:DeliverySender)=>new DeliveryGateway(w.db,vault,sender,{corpId:w.corpId,robotCode:w.robotCode,appOrigin:'http://localhost:52330'},Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
it('T001 component: generation and semantic review use the sole LIFETIME task budget and send one text reply before CLOSED',async()=>{
 const w=await finished();const ledgers=(await admin.query('SELECT run_id,dispatch_state,cost_state FROM quota_ledger WHERE tenant_id=$1',[w.ctx.tenantId])).rows;expect(ledgers).toHaveLength(2);expect(ledgers.every(q=>q.run_id===w.runId&&q.dispatch_state==='COMPLETE'&&q.cost_state==='SETTLED')).toBe(true);
 expect((await admin.query("SELECT scope_id,period,used_tokens FROM budget_buckets WHERE tenant_id=$1 AND scope_kind='TASK'",[w.ctx.tenantId])).rows).toEqual([{scope_id:w.taskId,period:'LIFETIME',used_tokens:'24'}]);let sends=0;
 const delivery=transport(w,{sendReply:async(_reply,text)=>{sends++;expect(text).toBe(`任务 ${w.taskId}\n\nHello is a greeting.`);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('TRIAL_MUST_NOT_PROACT');}});expect(await delivery.process(w.ctx,w.deliveryId,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await delivery.process(w.ctx,w.deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(1);expect(await w.state()).toMatchObject({state:'CLOSED',close_reason:'TRIAL_DELIVERED'});
 const audit=(await w.db.scope(w.ctx,c=>c.query('SELECT action,result,resource,trace_id FROM audit_events ORDER BY created_at,id'))).rows;
 expect(audit.map(a=>[a.action,a.result])).toEqual([['message.accepted','ENQUEUED'],['run.finalized','SUCCEEDED'],['delivery.claimed','SENDING'],['delivery.finished','APPLIED_UNVERIFIED']]);
 expect(audit.slice(0,2).every(a=>a.resource===w.taskId&&a.trace_id===w.runId)).toBe(true);expect(audit[2].trace_id).toBe(audit[3].trace_id);
});
it.each(['lost','orphan'] as const)('delivery %s closes permanently with zero repeated physical sends',async kind=>{
 const w=await finished();let sends=0;const delivery=transport(w,{sendReply:async()=>{sends++;throw Error('synthetic response lost');},sendProactive:async()=>{throw Error('unexpected');}});
 if(kind==='orphan')await admin.query("UPDATE deliveries SET state='SENDING',sending_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[w.deliveryId]);
 if(kind==='lost')expect(await delivery.process(w.ctx,w.deliveryId,new AbortController().signal)).toBe('UNKNOWN');
 expect(await delivery.pending(w.ctx)).toEqual([]);expect((await w.state()).state).toBe('CLOSED');expect(await delivery.process(w.ctx,w.deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(kind==='lost'?1:0);expect((await admin.query('SELECT state FROM deliveries WHERE id=$1',[w.deliveryId])).rows[0].state).toBe('UNKNOWN');
 expect((await w.db.scope(w.ctx,c=>c.query("SELECT id FROM audit_events WHERE action='delivery.finished' AND resource=$1 AND result='UNKNOWN'",[w.deliveryId]))).rowCount).toBe(1);
});
it('deadline prevents delivery regardless of caller clock skew and aborts an in-flight send',async()=>{
 const w=await world(true,{policy:policy(),ttlMs:1600}),job=await w.admit(),m=model();await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);const deliveryId=(await admin.query('SELECT id FROM deliveries WHERE task_id=$1',[job.taskId])).rows[0].id as string;let aborted=false,sends=0;
 const gateway=new DeliveryGateway(w.db,vault,{sendReply:async(_r,_t,signal)=>{sends++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));},sendProactive:async()=>{throw Error('unexpected');}},{corpId:w.corpId,robotCode:w.robotCode,appOrigin:'http://localhost:52330'},()=>Date.now()-120000,(...a)=>w.gateway.finalSourcesAllowed(...a));
 expect(await gateway.process(w.ctx,deliveryId,new AbortController().signal)).toBe('UNKNOWN');expect(aborted).toBe(true);expect(sends).toBe(1);expect((await w.state()).state).toBe('CLOSED');expect(await gateway.process(w.ctx,deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(1);
});
it.each(['tokens','money'] as const)('day rollover and process restart cannot reset the sole task lifetime %s',async dimension=>{
 const p=policy();p.maxOutputTokens=64;const payload=glmRequestBody([{role:'user',content:'synthetic'}],[],'high',{maxOutputTokens:p.maxOutputTokens}),bound=estimateModelPayload(payload).tokens+p.maxOutputTokens;if(dimension==='tokens')p.limits.task.tokens=String(bound+11);else p.limits.task.money=((bound+11)/1000000).toFixed(8);
 const w=await world(true,{policy:p}),first=await prepared(w,true);await w.store.finishModel(w.ctx,first.request.id,'COMPLETE',usage);await w.store.release(w.ctx,first.lease);
 const restarted=new RuntimeStore(w.db,vault,new ModelBudget(p)),lease=(await restarted.acquire(w.ctx,first.runId,'synthetic-restart-next-day'))!;
 const stamp=(await admin.query("SELECT date_trunc('day',clock_timestamp())+interval '1 day' starts")).rows[0].starts as Date;
 // Deterministic calendar fault injection only: the DB wall clock remains real
 // for deadline checks. The actual ModelBudget path receives a different day.
 const calendar=vi.spyOn(restarted.modelBudget as unknown as {day:(c:pg.PoolClient,zone:string)=>Promise<{period:string;starts:Date;ends:Date}>},'day').mockResolvedValue({period:stamp.toISOString().slice(0,10),starts:stamp,ends:new Date(stamp.getTime()+86400000)});
 try{await expect(restarted.prepareModel(w.ctx,lease,payload)).rejects.toThrow('MODEL_'+(dimension==='tokens'?'TOKEN':'MONEY')+'_BUDGET_EXHAUSTED_TASK');expect(calendar).toHaveBeenCalled();}finally{calendar.mockRestore();}
 const buckets=(await admin.query("SELECT scope_id,period,used_tokens,used_money FROM budget_buckets WHERE tenant_id=$1 AND scope_kind='TASK'",[w.ctx.tenantId])).rows;expect(buckets).toHaveLength(1);expect(buckets[0]).toMatchObject({scope_id:first.taskId,period:'LIFETIME',used_tokens:'12'});expect(Number(buckets[0].used_money)).toBeGreaterThan(0);expect(await w.ingress.acceptTrustedCallback(w.event())).toBeNull();expect(await w.count('tasks')).toBe(1);await restarted.release(w.ctx,lease);
});
it('semantic review cannot obtain extra money after generation has consumed the sole lifetime ceiling',async()=>{
 const p=policy();p.maxOutputTokens=64;const initial=glmRequestBody([{role:'system',content:SYSTEM_PROMPT},{role:'user',content:'Explain the word hello.'}],[],'high',{maxOutputTokens:64});p.limits.task.money=Number(quotaMoney(estimateModelPayload(initial).tokens,64,p.ceiling)).toFixed(8);
 const w=await world(true,{policy:p}),job=await w.admit(),m=model(async(messages,tools,_signal,_observer,limits)=>{const input=estimateModelPayload(glmRequestBody(messages,tools,'high',limits)).tokens;return {message:{role:'assistant',content:proposal},finishReason:'stop',requestId:null,usage:{prompt_tokens:input,completion_tokens:2,total_tokens:input+2}};});
 await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);expect(m.calls).toBe(1);expect((await w.state()).state).toBe('CLOSED');expect(await w.count('quota_ledger')).toBe(1);expect(await w.count('deliveries')).toBe(0);expect((await admin.query("SELECT period,used_money FROM budget_buckets WHERE tenant_id=$1 AND scope_kind='TASK'",[w.ctx.tenantId])).rows[0].period).toBe('LIFETIME');
});
it('profile file attests an existing slot; missing/changed files cannot reactivate CLOSED, other namespaces keep default startup',async()=>{
 const w=await world(),dir=await mkdtemp(join(tmpdir(),'oa-trial-synthetic-')),path=join(dir,'profile.json');
 try{
  await writeFile(path,JSON.stringify(w.profile));expect(await initializeTrial(w.db,{ONE_SHOT_TRIAL_PROFILE_FILE:path})).toEqual(w.profile);expect(()=>assertTrialScopes(w.profile,[w.ctx])).not.toThrow();expect(()=>assertTrialScopes(w.profile,[])).toThrow('TRIAL_WORKER_SCOPE_MISMATCH');expect(()=>assertTrialBinding(w.profile,'other',w.robotCode)).toThrow('TRIAL_CONNECTOR_BINDING_MISMATCH');
  const defaultWorld=await world(false);expect(await initializeTrial(defaultWorld.db,{},[defaultWorld.ctx])).toBeNull();expect((await w.state()).state).toBe('ARMED');
  await writeFile(path,JSON.stringify({...w.profile,approvalReference:'SYNTHETIC_CHANGED_CONFIG'}));await expect(initializeTrial(w.db,{ONE_SHOT_TRIAL_PROFILE_FILE:path})).rejects.toThrow('TRIAL_STARTUP_BLOCKED');expect((await w.state()).state).toBe('CLOSED');
  for(const env of [{ONE_SHOT_TRIAL_PROFILE_FILE:path},{}])await expect(initializeTrial(w.db,env,[w.ctx])).rejects.toThrow('TRIAL_STARTUP_BLOCKED');expect((await w.state()).state).toBe('CLOSED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('an in-flight model aborts at deadline even while the trial row remains locked against polling',async()=>{
 const w=await world(true,{ttlMs:1400}),job=await w.admit();let entered!:()=>void,aborted!:()=>void;
 const fork=w.db.forkForAuthority.bind(w.db);vi.spyOn(w.db,'forkForAuthority').mockImplementation(max=>fork(max,5000));
 const inside=new Promise<void>(r=>{entered=r;}),stopped=new Promise<string>(r=>{aborted=()=>r('ABORTED');});
 let reason='';const m=model(async(_messages,_tools,signal)=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>{reason=(signal.reason as Error).message;aborted();reject(signal.reason);},{once:true});}));
 const running=new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId);await inside;
 const lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT tenant_id FROM one_shot_trials WHERE tenant_id=$1 FOR UPDATE',[w.ctx.tenantId]);let observed:string;
 try{observed=await Promise.race([stopped,new Promise<string>(r=>setTimeout(()=>r('NO_ABORT_WHILE_LOCKED'),1900))]);}
 finally{await lock.query('COMMIT');lock.release();await running;}
 expect(observed).toBe('ABORTED');expect(reason).toBe('TRIAL_DEADLINE');expect(m.calls).toBe(1);expect((await w.state()).state).toBe('CLOSED');
});
it.each(['tools','policy'] as const)('direct model reservation with forged %s closes before allocating or dispatching',async mode=>{
 const w=await world(),job=await w.admit(),lease=(await w.store.acquire(w.ctx,job.runId,'synthetic-direct-bypass'))!,payload=glmRequestBody([{role:'user',content:'synthetic'}],[],'high',w.store.modelLimits());
 let store=w.store;if(mode==='tools')payload['tools']=[{type:'function',function:{name:'forged',parameters:{}}}];else{const different=structuredClone(w.policy);different.id='synthetic-unapproved-replacement';store=new RuntimeStore(w.db,vault,new ModelBudget(different));}
 await expect(store.prepareModel(w.ctx,lease,payload)).rejects.toThrow(mode==='tools'?'TRIAL_MODEL_TOOLS_FORBIDDEN':'TRIAL_BUDGET_POLICY_MISMATCH');expect((await w.state()).state).toBe('CLOSED');expect(await w.count('quota_ledger')).toBe(0);expect(await w.count('tool_actions')).toBe(0);
});
it('trial binding metadata is invisible to another employee at the table RLS boundary',async()=>{
 const w=await world();expect((await w.db.scope({...w.ctx,actorId:w.other},c=>c.query('SELECT * FROM one_shot_trials'))).rows).toEqual([]);expect((await w.db.scope(w.ctx,c=>c.query('SELECT * FROM one_shot_trials'))).rows).toHaveLength(1);
});
it('a restored continuation generation cannot reacquire or dispatch the sole trial task',async()=>{
 const w=await world(true,{policy:policy()}),job=await w.admit(),m=model();await admin.query('UPDATE runs SET retry_generation=1 WHERE id=$1',[job.runId]);
 await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,job.runId,undefined,undefined,1);expect(m.calls).toBe(0);expect((await w.state()).state).toBe('CLOSED');expect((await admin.query('SELECT fence FROM runs WHERE id=$1',[job.runId])).rows[0].fence).toBe('0');expect(await w.count('quota_ledger')).toBe(0);
});
it('a valid clarification answer through the existing H5 continuation path cannot add a second trial input',async()=>{
 const w=await world(true,{policy:policy()}),received=(await w.ingress.acceptTrustedCallback(w.event({text:{content:'Draft a meeting invite; ask me for the date.'}})))!,runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[received.taskId])).rows[0].id as string;let calls=0;
 const m=model(async()=>({message:{role:'assistant',content:++calls===1?JSON.stringify({schemaVersion:1,mode:'CLARIFICATION',text:'Which date should the meeting use?',claims:[],outcome:'CLARIFICATION'}):JSON.stringify({...general,verdict:'CLARIFICATION',fulfillsGoal:false,requiresTools:true,isQuestion:true})},finishReason:'stop',usage,requestId:null}));
 await new AgentRuntime(w.store,m.provider,w.gateway).advance(w.ctx,runId);const before=(await admin.query('SELECT status,clarification_review_id,retry_generation FROM runs WHERE id=$1',[runId])).rows[0];expect(before.status).toBe('WAITING_USER');expect(before.clarification_review_id).toBeTruthy();
 expect(await w.store.reply(w.ctx,received.taskId,before.clarification_review_id as string,'Tomorrow','synthetic-trial-reply')).toBeNull();expect(await w.count('run_user_messages')).toBe(0);expect((await admin.query('SELECT status,retry_generation FROM runs WHERE id=$1',[runId])).rows[0]).toMatchObject({status:'WAITING_USER',retry_generation:'0'});expect(m.calls).toBe(2);expect((await w.state()).state).toBe('BOUND');
});
