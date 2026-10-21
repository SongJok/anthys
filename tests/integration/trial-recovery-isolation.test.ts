import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {PgBoss} from 'pg-boss';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {BudgetRecovery} from '../../packages/runtime/src/budget-recovery.js';
import {ModelBudget} from '../../packages/runtime/src/model-budget.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {glmRequestBody,type ModelProvider} from '../../packages/provider-glm/src/client.js';
import {trialState} from '../../packages/storage/src/trial.js';
import {RunQueue} from '../../packages/tasks/src/queue.js';
import {publishWorkerCycle} from '../../packages/runtime/src/worker-cycle.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),connections:Database[]=[];
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
afterAll(async()=>{await Promise.all(connections.map(db=>db.close()));await admin.end();});
async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corp='SYNTHETIC-ISOLATION-'+ctx.tenantId,robot='synthetic-isolation',conversation='synthetic-isolation-dm',profileHash=hash(randomUUID());
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC ISOLATION','ACTIVE')",[ctx.tenantId,corp]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const policy=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8'))),db=new Database(secret('RUNTIME_DATABASE_URL')!);connections.push(db);
 policy.pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_ISOLATION_NOT_PROVIDER_VERIFIED',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};
 const budget=new ModelBudget(policy),store=new RuntimeStore(db,vault,budget),ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,corpId:corp,robotCode:robot},store);
 const event=():DWClientDownStream=>{const id=randomUUID();return {specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corp,senderCorpId:corp,senderStaffId:'owner',robotCode:robot,conversationId:conversation,conversationType:'1',msgtype:'text',text:{content:'Explain hello.'},createAt:Date.now()+1,senderId:'owner-id',chatbotUserId:'robot-id',sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-isolation',sessionWebhookExpiredTime:Date.now()+60000})};};
 const prepare=async(kind:'PREPARED'|'DISPATCHING'|'UNKNOWN')=>{
  const task=(await ingress.acceptTrustedCallback(event()))!,run=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId])).rows[0].id as string,lease=(await store.acquire(ctx,run,'synthetic-isolation'))!,payload=glmRequestBody([{role:'user',content:'synthetic only'}],[],'high',store.modelLimits()),reservation=await store.prepareModel(ctx,lease,payload);
  if(kind!=='PREPARED')await store.startModel(ctx,lease,reservation,payload,async()=>null);
  if(kind==='UNKNOWN')await store.finishModel(ctx,reservation.id,'UNKNOWN');
  await admin.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[run]);return {run,reservation};
 };
 const history=await Promise.all(['PREPARED','DISPATCHING','UNKNOWN'].map(async kind=>prepare(kind as 'PREPARED'|'DISPATCHING'|'UNKNOWN')));
 const snapshot=async()=>{const out:Record<string,unknown>={};for(const table of ['tasks','runs','quota_ledger','budget_buckets','budget_allocations','outbox'])out[table]=(await admin.query('SELECT to_jsonb(t) row FROM '+table+' t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text',[ctx.tenantId])).rows;return out;};
 const arm=async()=>{await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,clock_timestamp()+interval '10 minutes')",[ctx.tenantId,ctx.actorId,profileHash,hash(JSON.stringify(policy)),corp,robot,conversation]);db.trialProfileHash=profileHash;};
 return {ctx,db,budget,store,prepare,history,snapshot,arm,profileHash,ingress,event,corp,robot};
}
async function expectOnlyBoundTaskClosed(w:Awaited<ReturnType<typeof world>>,before:Record<string,unknown>,runId:string,reason:string,slotBefore:Record<string,unknown>){
 const after=await w.snapshot(),oldRun=(before.runs as {row:Record<string,unknown>}[]).find(r=>r.row.id===runId)!.row,taskId=oldRun.task_id;
 for(const table of Object.keys(before)){
  const prior=before[table] as {row:Record<string,unknown>}[],actual=after[table] as {row:Record<string,unknown>}[];
  if(table==='tasks'||table==='runs'){
   const id=table==='tasks'?taskId:runId;expect(actual.filter(r=>r.row.id!==id)).toEqual(prior.filter(r=>r.row.id!==id));const old=prior.find(r=>r.row.id===id)!.row,current=actual.find(r=>r.row.id===id)!.row;
   const activity:Record<string,unknown>={};if(table==='runs'&&old.active_accounted_at){const upper=(await admin.query('SELECT greatest(0,extract(epoch FROM (least(clock_timestamp(),$2::timestamptz)-$1::timestamptz))*1000)::float8 ms',[old.active_accounted_at,old.lease_until])).rows[0].ms;expect(Number(current.active_ms)).toBeGreaterThanOrEqual(Number(old.active_ms));expect(Number(current.active_ms)).toBeLessThanOrEqual(Number(old.active_ms)+upper);expect(current.active_accounted_at).toBeNull();activity.active_ms=current.active_ms;activity.active_accounted_at=null;}
   expect(current).toEqual({...old,...activity,status:'CANCELLED',version:Number(old.version)+1,...(table==='tasks'?{cancel_requested_at:expect.any(String)}:{lease_owner:null,lease_until:null,last_error:reason})});
   if(table==='tasks')expect(Date.parse(current.cancel_requested_at as string)).toBeGreaterThanOrEqual(Date.parse(old.created_at as string));
  }else expect(actual).toEqual(prior);
 }
 const slot=(await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].row;expect(slot).toEqual({...slotBefore,state:'CLOSED',close_reason:reason,closed_at:expect.any(String)});
}
it('retry discovery on an unbound ARMED trial preserves the slot and every historical reservation',async()=>{
 const w=await world();await w.arm();const before=await w.snapshot(),slot=(await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[w.ctx.tenantId])).rows;
 expect(await new RetryDispatcher(w.db).dispatch(w.ctx)).toBe(0);expect(await w.snapshot()).toEqual(before);expect((await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[w.ctx.tenantId])).rows).toEqual(slot);
});
it('retry discovery closes the sole admitted retry without publishing a continuation or changing old UNKNOWN accounting',async()=>{
 const w=await world();await w.arm();const own=await w.prepare('PREPARED');await admin.query("UPDATE runs SET status='RETRY_SCHEDULED' WHERE id=$1",[own.run]);const before=await w.snapshot(),slot=(await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].row;
 expect((await admin.query('SELECT retry_generation FROM runs WHERE id=$1',[own.run])).rows[0].retry_generation).toBe('0');expect(await new RetryDispatcher(w.db).dispatch(w.ctx)).toBe(0);
 await expectOnlyBoundTaskClosed(w,before,own.run,'TRIAL_RETRY_DISABLED',slot);
});
it('a transient model failure cannot schedule a second attempt inside the one-shot slot',async()=>{
 const w=await world();await w.arm();const task=(await w.ingress.acceptTrustedCallback(w.event()))!,runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId])).rows[0].id as string,lease=(await w.store.acquire(w.ctx,runId,'synthetic-single-attempt'))!;expect(lease).not.toBeNull();const before=await w.snapshot(),slot=(await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].row;
 await w.store.scheduleRetry(w.ctx,lease,'SYNTHETIC_TRANSIENT_FAILURE',1000);await expectOnlyBoundTaskClosed(w,before,runId,'TRIAL_RUN_STOPPED',slot);expect((await admin.query('SELECT id FROM quota_ledger WHERE run_id=$1',[runId])).rowCount).toBe(0);
});
it.each(['owner','tenant'] as const)('ARMED trial %s recovery never enumerates or changes historical orphan rows',async path=>{
 const w=await world();await w.arm();const before=await w.snapshot(),recover=vi.spyOn(w.budget,'recover'),discovery=vi.spyOn(w.db.pool,'query');
 expect(await new BudgetRecovery(w.db,w.budget)[path](w.ctx)).toBe(0);expect(recover).not.toHaveBeenCalled();expect(await w.snapshot()).toEqual(before);discovery.mockRestore();
});
async function legacyReplies(w:Awaited<ReturnType<typeof world>>){
 const source=w.history[0]!,group=w.history[1]!,sourceTask=(await admin.query('SELECT task_id FROM runs WHERE id=$1',[source.run])).rows[0].task_id,groupTask=(await admin.query('SELECT task_id FROM runs WHERE id=$1',[group.run])).rows[0].task_id;
 const fid=randomUUID(),choice=randomUUID(),sourceReply=randomUUID(),review=randomUUID(),scope=randomUUID(),identity=randomUUID(),audience=randomUUID(),groupReply=randomUUID(),opaque=JSON.stringify({fixture:'OPAQUE_OLD_CONTEXT_MUST_NOT_LOAD'}),digest=hash('synthetic-opaque');
 await admin.query("INSERT INTO run_finalizations(tenant_id,id,owner_id,run_id,session_no,run_fence,state,plan_ref,source_hash,output_hash,expires_at) VALUES($1,$2,$3,$4,1,1,'VERIFIED',$5,$6,$6,clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,fid,w.ctx.actorId,source.run,opaque,digest]);
 await admin.query("INSERT INTO run_source_choices(tenant_id,id,owner_id,run_id,finalization_id,session_no,run_fence,option_count,payload_ref,projection_hash,expires_at) VALUES($1,$2,$3,$4,$5,1,1,2,$6,$7,clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,choice,w.ctx.actorId,source.run,fid,opaque,digest]);
 await admin.query("INSERT INTO source_choice_replies(tenant_id,id,owner_id,run_id,choice_id,request_key,input_hash,option_index,answer_ref) VALUES($1,$2,$3,$4,$5,$2::uuid::text,$6,1,$7)",[w.ctx.tenantId,sourceReply,w.ctx.actorId,source.run,choice,digest,opaque]);
 await admin.query('UPDATE runs SET source_reply_id=$2 WHERE id=$1',[source.run,sourceReply]);
 await admin.query("INSERT INTO run_narrative_reviews(tenant_id,id,owner_id,run_id,session_no,run_fence,proposal_hash,scope_hash,dialogue_hash,policy_hash,request_id,model_payload_hash,verdict,review_ref,expires_at) VALUES($1,$2,$3,$4,1,1,$5,$5,$5,$5,$6,$5,'CLARIFICATION',$7,clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,review,w.ctx.actorId,group.run,digest,group.reservation.id,opaque]);
 await admin.query("INSERT INTO dws_group_scopes(tenant_id,id,owner_id,conversation_external_id,info_profile,approved_bots,binary_hash,members_schema_hash,info_schema_hash,contract_hash,authorization_review_ref,directory_review_ref,expires_at) VALUES($1,$2,$3,'synthetic-old-group','{}','[]',$4,$4,$4,$4,'synthetic old fixture','synthetic old fixture',clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,scope,w.ctx.actorId,digest]);
 await admin.query("INSERT INTO dws_identities(tenant_id,id,owner_id,corp_id,external_user_id,auth_epoch,state,binary_hash,delegation_expires_at) VALUES($1,$2,$3,$4,'owner',1,'UNVERIFIED',$5,clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,identity,w.ctx.actorId,w.corp,digest]);
 await admin.query("INSERT INTO run_group_audiences(tenant_id,id,owner_id,run_id,task_id,scope_id,scope_version,identity_id,authorization_version,proof_ref,proof_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,1,$8,$9,clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,audience,w.ctx.actorId,group.run,groupTask,scope,identity,opaque,digest]);
 await admin.query("INSERT INTO group_clarification_messages(tenant_id,id,owner_id,run_id,review_id,group_audience_id,request_key,input_hash,answer_ref,input_scope) VALUES($1,$2,$3,$4,$5,$6,$2::uuid::text,$7,$8,'H5_GROUP_ACK')",[w.ctx.tenantId,groupReply,w.ctx.actorId,group.run,review,audience,digest,opaque]);
 await admin.query('UPDATE runs SET group_reply_id=$2,group_audience_id=$3,clarification_review_id=$4 WHERE id=$1',[group.run,groupReply,audience,review]);
 for(const [i,state]of ['PENDING','SENDING'].entries())await admin.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no,sending_at,attempt_key) VALUES($1,$2,$3,$4,$5,$6,$7,'OPAQUE_OLD_CONTEXT_MUST_NOT_LOAD','INTERNAL',$8,1,clock_timestamp()-interval '1 hour',$9)",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,sourceTask,JSON.stringify({kind:'PRIVATE_USER',targetId:w.ctx.actorId,classificationCeiling:'RESTRICTED'}),hash('old-delivery-'+i),state,source.run,state==='SENDING'?randomUUID():null]);
 return {sourceReply,groupReply};
}
it('dedicated real PgBoss cycle leaves three old queue types, replies, deliveries and UNKNOWN intact while one new task completes',async()=>{
 const w=await world(),oldReplies=await legacyReplies(w),legacyName='historical-'+randomUUID(),names=[legacyName,legacyName+'-source-reply',legacyName+'-group-reply'];
 const legacy=new PgBoss({connectionString:secret('QUEUE_DATABASE_URL')!,schema:'oa_queue',migrate:false,createSchema:false,supervise:false,schedule:false});legacy.on('error',()=>{});
 try{await legacy.start();for(const name of names)await legacy.createQueue(name,{retryLimit:3});
  await legacy.send(names[0]!,{...w.ctx,runId:w.history[0]!.run,generation:0});await legacy.send(names[1]!,{...w.ctx,replyId:oldReplies.sourceReply,generation:0});await legacy.send(names[2]!,{...w.ctx,replyId:oldReplies.groupReply,generation:0});
 }finally{await legacy.stop();}
 const oldJobs=async()=>(await admin.query('SELECT to_jsonb(j) row FROM oa_queue.job j WHERE name=ANY($1::text[]) ORDER BY id',[names])).rows;
 const protectedRows=async()=>{const rows:Record<string,unknown>={jobs:await oldJobs()};for(const table of ['tasks','runs','outbox','quota_ledger','budget_allocations','source_choice_replies','group_clarification_messages','deliveries'])rows[table]=(await admin.query('SELECT to_jsonb(t) row FROM '+table+' t WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[w.ctx.tenantId,protectedIds[table]])).rows;return rows;};
 const protectedIds:Record<string,string[]>={};for(const table of ['tasks','runs','outbox','quota_ledger','budget_allocations','source_choice_replies','group_clarification_messages','deliveries'])protectedIds[table]=(await admin.query('SELECT id FROM '+table+' WHERE tenant_id=$1',[w.ctx.tenantId])).rows.map(r=>r.id as string);
 expect(protectedIds.source_choice_replies).toHaveLength(1);expect(protectedIds.group_clarification_messages).toHaveLength(1);expect(await oldJobs()).toHaveLength(3);const before=await protectedRows();
 await w.arm();const received=(await w.ingress.acceptTrustedCallback(w.event()))!,runId=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[received.taskId])).rows[0].id as string,queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'run',w.profileHash);queue.boss.on('error',()=>{});
 const gateway=new Gateway(w.store),retryDispatcher=new RetryDispatcher(w.db),sourceRecovery=vi.spyOn(w.store,'recoverSourceReplies'),groupRecovery=vi.spyOn(w.store,'recoverGroupReplies'),retry=vi.spyOn(retryDispatcher,'dispatch');let calls=0,sends=0;
 const provider:ModelProvider={describeRequest:(messages,tools,limits)=>glmRequestBody(messages,tools,'high',limits),complete:async(messages,tools)=>{calls++;expect(tools).toEqual([]);expect(JSON.stringify(messages)).not.toContain('OPAQUE_OLD_CONTEXT_MUST_NOT_LOAD');return {message:{role:'assistant',content:JSON.stringify(calls===1?{schemaVersion:1,mode:'CONVERSATION',text:'Hello is a greeting.',claims:[],outcome:'COMPLETE'}:{schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]})},finishReason:'stop',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},requestId:null};}};
 try{
  await queue.start();expect(await queue.boss.getQueue(queue.queueName)).toMatchObject({retryLimit:0});expect((await admin.query('SELECT count(*)::int n FROM oa_queue.queue WHERE name=ANY($1::text[])',[[queue.queueName+'-source-reply',queue.queueName+'-group-reply']])).rows[0].n).toBe(0);
  const subscribe=vi.spyOn(queue.boss,'work');await expect(queue.workSourceReplies(async()=>{throw Error('OLD_SOURCE_SUBSCRIBED');})).rejects.toThrow('TRIAL_CONTINUATION_QUEUE_DISABLED');await expect(queue.workGroupReplies(async()=>{throw Error('OLD_GROUP_SUBSCRIBED');})).rejects.toThrow('TRIAL_CONTINUATION_QUEUE_DISABLED');expect(subscribe).not.toHaveBeenCalled();subscribe.mockRestore();
  await publishWorkerCycle(w.db,[w.ctx],{store:w.store,budgetRecovery:new BudgetRecovery(w.db,w.budget),retryDispatcher,queue});expect(sourceRecovery).not.toHaveBeenCalled();expect(groupRecovery).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();
  const jobs=await queue.boss.fetch(queue.queueName,{batchSize:1});expect(jobs).toHaveLength(1);expect(jobs[0]!.data).toMatchObject({...w.ctx,runId,generation:0});await new AgentRuntime(w.store,provider,gateway).advance(w.ctx,runId);await queue.boss.complete(queue.queueName,jobs[0]!.id);expect(calls).toBe(2);
  const delivery=new DeliveryGateway(w.db,vault,{sendReply:async(_reply,text)=>{sends++;expect(text).toBe(`任务 ${received.taskId}\n\nHello is a greeting.`);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('PROACTIVE_FORBIDDEN');}},{corpId:w.corp,robotCode:w.robot,appOrigin:'http://localhost:52330'},Date.now,(...a)=>gateway.finalSourcesAllowed(...a));
  const pending=await delivery.pending(w.ctx);expect(pending).toHaveLength(1);expect(await delivery.process(w.ctx,pending[0]!,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(sends).toBe(1);expect(await delivery.process(w.ctx,pending[0]!,new AbortController().signal)).toBe('NOT_CLAIMED');expect(await queue.publish(w.db,w.ctx)).toBe(0);
  expect(await protectedRows()).toEqual(before);expect((await admin.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].state).toBe('CLOSED');
 }finally{sourceRecovery.mockRestore();groupRecovery.mockRestore();retry.mockRestore();await queue.stop();}
},30000);
it('BOUND recovery only settles its one admitted run; old UNKNOWN and unrelated orphans remain byte-identical',async()=>{
 const w=await world();await w.arm();const own=await w.prepare('PREPARED'),before=(await admin.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE tenant_id=$1 AND run_id<>$2 ORDER BY id',[w.ctx.tenantId,own.run])).rows,recover=vi.spyOn(w.budget,'recover');
 expect(await new BudgetRecovery(w.db,w.budget).tenant(w.ctx)).toBe(1);expect(recover.mock.calls.map(c=>c[1])).toEqual([own.run]);
 expect((await admin.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE tenant_id=$1 AND run_id<>$2 ORDER BY id',[w.ctx.tenantId,own.run])).rows).toEqual(before);
 expect((await admin.query('SELECT dispatch_state FROM quota_ledger WHERE id=$1',[own.reservation.id])).rows[0].dispatch_state).toBe('RELEASED');
 const unknown=(await admin.query("SELECT reservation,cost_state FROM quota_ledger WHERE tenant_id=$1 AND dispatch_state='UNKNOWN'",[w.ctx.tenantId])).rows;expect(unknown).toHaveLength(1);expect(Number(unknown[0].reservation)).toBeGreaterThan(0);expect(unknown[0].cost_state).toBe('UNKNOWN');
});
it('CLOSED and changed-profile recovery leave all stopped-trial and historical accounting untouched',async()=>{
 const w=await world();await w.arm();const own=await w.prepare('PREPARED');await w.db.scope(w.ctx,c=>trialState(c,own.run,false,'SYNTHETIC_OPERATOR_STOP'));const before=await w.snapshot();
 for(const attestation of [w.profileHash,hash('synthetic-wrong')]){w.db.trialProfileHash=attestation;expect(await new BudgetRecovery(w.db,w.budget).tenant(w.ctx)).toBe(0);expect(await w.snapshot()).toEqual(before);}
});
it('trial queue derives a dedicated full-profile namespace instead of attaching a historical RUN queue',()=>{
 const profileHash=hash('SYNTHETIC_PROFILE_A'),other=hash('SYNTHETIC_PROFILE_B');
 // Before the constructor supports the third argument, JS ignores it and the
 // assertion demonstrates the real shared-queue behavior rather than a mock.
 const Ctor=RunQueue as unknown as new(url:string,name:string,trialHash:string)=>RunQueue;
 const queue=new Ctor(secret('QUEUE_DATABASE_URL')!,'historical-run',profileHash),same=new Ctor(secret('QUEUE_DATABASE_URL')!,'another-legacy-name',profileHash),different=new Ctor(secret('QUEUE_DATABASE_URL')!,'historical-run',other);
 expect(queue.queueName).not.toBe('historical-run');expect(queue.queueName).toContain(profileHash);expect(same.queueName).toBe(queue.queueName);expect(different.queueName).not.toBe(queue.queueName);
});
it('a trial queue cannot publish DEFAULT or FORMAL work when its database profile does not match',async()=>{
 const w=await world(),queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'run',hash(randomUUID()));queue.boss.on('error',()=>{});const before=await w.snapshot();
 try{await queue.start();await expect(queue.publish(w.db,w.ctx)).rejects.toThrow('TRIAL_QUEUE_PROFILE_MISMATCH');expect(await w.snapshot()).toEqual(before);expect(await queue.boss.fetch(queue.queueName,{batchSize:1})).toEqual([]);}finally{await queue.stop();}
});
it.each(['','a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'g'.repeat(64)])('trial queue rejects invalid private profile hash length/encoding %s',trialHash=>{
 expect(()=>new RunQueue(secret('QUEUE_DATABASE_URL')!,'run',trialHash)).toThrow('TRIAL_QUEUE_PROFILE_INVALID');
});
it.each(['legacy-no-proof','changed-profile'] as const)('denied acquire %s never releases historical or unauthenticated reservations',async mode=>{
 const w=await world();await w.arm();let runId:string;
 if(mode==='legacy-no-proof'){
  runId=w.history[0]!.run;const task=(await admin.query('SELECT task_id FROM runs WHERE id=$1',[runId])).rows[0].task_id;
  await admin.query("UPDATE one_shot_trials SET state='BOUND',msg_id=$2,task_id=$3,run_id=$4,bound_at=clock_timestamp() WHERE tenant_id=$1",[w.ctx.tenantId,randomUUID(),task,runId]);
 }else{runId=(await w.prepare('PREPARED')).run;await w.db.scope(w.ctx,c=>trialState(c,runId,false,'SYNTHETIC_CLOSED'));w.db.trialProfileHash=hash('SYNTHETIC_CHANGED_PROFILE');}
 const before=(await admin.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE tenant_id=$1 ORDER BY id',[w.ctx.tenantId])).rows;
 expect(await w.store.acquire(w.ctx,runId,'SYNTHETIC_DENIED_ACQUIRE')).toBeNull();expect((await admin.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE tenant_id=$1 ORDER BY id',[w.ctx.tenantId])).rows).toEqual(before);
});
it('dedicated RUN worker failure is terminal with retryLimit zero and never becomes another claim',async()=>{
 const queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'ignored-legacy',hash(randomUUID()));queue.boss.on('error',()=>{});let calls=0;
 try{
  await queue.start();const id=await queue.boss.send(queue.queueName,{tenantId:randomUUID(),actorId:randomUUID(),runId:randomUUID(),generation:0});expect(id).toBeTruthy();
  await queue.work(async()=>{calls++;throw Error('SYNTHETIC_TERMINAL_TRIAL_FAILURE');});
  await vi.waitFor(async()=>{expect((await admin.query('SELECT state FROM oa_queue.job WHERE id=$1',[id])).rows[0].state).toBe('failed');},{timeout:5000});
  expect(calls).toBe(1);expect(await queue.boss.fetch(queue.queueName,{batchSize:1})).toEqual([]);expect((await queue.boss.getQueue(queue.queueName))!.retryLimit).toBe(0);
 }finally{await queue.stop();}
},10000);
