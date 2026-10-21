import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {GroupCases} from '../../packages/groups/src/cases.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {GroupAudience} from '../../packages/groups/src/audience.js';
import {createServer} from '../../apps/api/src/server.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {config} from '../../packages/config/src/index.js';
import {groupCaseReceiptResultAllowed,groupCaseReceiptDeliveryAllowed,groupCaseNarrativeAllowed,groupCaseReceiptProjectionAllowed} from '../../packages/groups/src/receipts.js';
import type {Lease} from '../../packages/runtime/src/store.js';
import type {GroupCaseCommand} from '../../packages/groups/src/commands.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,30),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),cases=new GroupCases(db,vault,'robot-1');
const fixtures:Awaited<ReturnType<typeof groupCaseWorld>>[]=[];
afterAll(async()=>{for(const w of fixtures)await w.f.close();await db.close();await appDb.close();await root.end();});
async function world(nativeCases=cases,timezone='Asia/Shanghai',tenantId?:string){const w=await groupCaseWorld(root,db,appDb,vault,'CNY',tenantId?{tenantId}:{});fixtures.push(w);w.document.workHours.timezone=timezone;await w.approve();await w.save();w.f.store.configureGroupCases(nativeCases);let sends=0;const texts:string[]=[];
 const sender=new DeliveryGateway(db,vault,{sendReply:async(_reply,text)=>{sends++;texts.push(text);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('UNEXPECTED_PROACTIVE_GROUP_SEND');}},w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a));
 const execute=async(text:string)=>{const message=w.f.callback(text),accepted=await w.f.ingress.acceptTrustedCallback(message),run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted!.taskId])).rows[0];await w.f.runtime.advance(w.f.ctx,run.id);return {accepted,message,runId:run.id as string,...(await root.query('SELECT status,result,last_error FROM runs WHERE id=$1',[run.id])).rows[0]};};
 return {...w,execute,sender,texts,sends:()=>sends};}
const create=(resource='release:a')=>`登记事项：标题=发布阻塞；资源=${resource}；优先级=HIGH；截止=未设置；合同版本=1`;
const list=()=>`列出事项：起始=${new Date(Date.now()-86400000).toISOString()}；结束=${new Date(Date.now()+86400000).toISOString()}；数量=50`;
async function delivery(runId:string){return (await root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[runId])).rows[0]?.id as string|undefined;}
it('T108/T109 actual native mention registers one proposal under duplicate callbacks and returns protected deterministic group content without model calls',async()=>{
 const w=await world(),message=w.f.callback(create()),accepted=await Promise.all(Array.from({length:12},()=>w.f.ingress.acceptTrustedCallback(message)));expect(new Set(accepted.map(a=>a!.taskId)).size).toBe(1);expect(accepted.filter(a=>!a!.duplicate)).toHaveLength(1);const run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted[0]!.taskId])).rows[0];await w.f.runtime.advance(w.f.ctx,run.id);
 const state=(await root.query('SELECT status,result,model_turns FROM runs WHERE id=$1',[run.id])).rows[0];expect(state.status).toBe('SUCCEEDED');expect(state.model_turns).toBe(0);expect(w.f.requests).toHaveLength(0);expect((await root.query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0].n).toBe(1);expect(state.result).toContain('PROPOSED');expect(state.result).toContain('不覆盖全部群聊');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,run.id,state.result)).toBe(true);
 expect(await w.sender.process(w.f.ctx,(await delivery(run.id))!,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(w.texts[0]).toContain('发布阻塞');expect(w.texts[0]).toContain('release:a');expect(w.texts[0]).not.toContain('详细结果仅发起人');await w.f.runtime.advance(w.f.ctx,run.id);expect(await w.sender.process(w.f.ctx,(await delivery(run.id))!,new AbortController().signal)).toBe('NOT_CLAIMED');expect(w.sends()).toBe(1);
},60000);
it('T110 native owner start/completion preserves WAITING_CONFIRMATION until actual independent administrator confirmation; list discloses the method',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');let item=(await root.query('SELECT id,version FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0];
 const open=await w.cases.update(w.principal,w.f.conversationId,item.id,{contractVersion:1,expectedVersion:Number(item.version),command:{operation:'OPEN'}},randomUUID());const assigned=await w.cases.update(w.principal,w.f.conversationId,item.id,{contractVersion:1,expectedVersion:open.case.version,command:{operation:'ASSIGN',ownerId:w.f.ctx.actorId}},randomUUID());
 const started=await w.execute(`开始事项 ${item.id}；事项版本=${assigned.case.version}；合同版本=1`);expect(started.status).toBe('SUCCEEDED');item=(await root.query('SELECT id,version FROM group_cases WHERE id=$1',[item.id])).rows[0];const completed=await w.execute(`事项已完成 ${item.id}；事项版本=${item.version}；合同版本=1；说明=已处理，等待独立确认`);expect(completed.status).toBe('SUCCEEDED');expect(completed.result).toContain('WAITING_CONFIRMATION');expect(completed.result).toContain('UNVERIFIED');expect(completed.result).not.toContain('ADMIN_CONFIRMED');
 const unclear=await w.execute('好了');expect(unclear.result).toContain('不猜事项');const pending=(await root.query('SELECT id,version,state FROM group_cases WHERE id=$1',[item.id])).rows[0];expect(pending.state).toBe('WAITING_CONFIRMATION');const verified=await w.cases.update(w.principal,w.f.conversationId,item.id,{contractVersion:1,expectedVersion:Number(pending.version),command:{operation:'CONFIRM',statement:'独立人工核对记录'}},randomUUID());expect(verified.case.completion?.method).toBe('ADMIN_CONFIRMED');
 const listed=await w.execute(list());expect(listed.status).toBe('SUCCEEDED');expect(listed.result).toContain('ADMIN_CONFIRMED');expect(listed.result).toContain('不是外部工具自动核验');expect(listed.result).toContain(w.f.ctx.actorId);expect(await w.f.gateway.finalResultAllowed(w.f.ctx,completed.runId,completed.result)).toBe(false);expect(w.f.requests).toHaveLength(0);
},60000);
it('T109 distinct actual mention events and distinct resources are never merged by a matching title; explicit window list remains bounded',async()=>{
 const w=await world();for(const resource of ['release:a','release:b','release:a'])expect((await w.execute(create(resource))).status).toBe('SUCCEEDED');expect((await root.query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0].n).toBe(3);const listed=await w.execute(list());expect(listed.status).toBe('SUCCEEDED');expect(listed.result).toContain('当前页 3 条');expect(listed.result).toContain('不覆盖全部群聊');expect(w.f.requests).toHaveLength(0);
},60000);
it('an initially authorized case result is suppressed after a newly observed external member joins at the last physical send check',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,created.runId,created.result)).toBe(true);let checks=0,sends=0;const sender=new DeliveryGateway(db,vault,{sendReply:async()=>{sends++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('UNEXPECTED_GROUP_PROACTIVE');}},w.f.binding,Date.now,async(...a)=>{const allowed=await w.f.gateway.finalSourcesAllowed(...a);checks++;if(checks===1){expect(allowed).toBe(true);await w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.ownerOpen,w.f.otherOpen,'open-unbound-external-'+randomUUID()]),info:groupInfoReply(3,1,'native-case-roster-changed')});}else expect(allowed).toBe(false);return allowed;});expect(await sender.process(w.f.ctx,(await delivery(created.runId))!,new AbortController().signal)).toBe('SUPPRESSED');expect(checks).toBe(2);expect(sends).toBe(0);expect(await w.f.gateway.finalResultAllowed(w.f.ctx,created.runId,created.result)).toBe(false);
},60000);

it('separate API result reader and notifier stores independently verify writer evidence, with current source checks rather than sharing writer configuration',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');
 const readerStore=new RuntimeStore(db,vault),notifierStore=new RuntimeStore(db,vault),readerAudience=new GroupAudience(db,vault,w.f.dws,'robot-1'),notifierAudience=new GroupAudience(db,vault,w.f.dws,'robot-1');
 readerStore.configureGroupAudience(readerAudience);notifierStore.configureGroupAudience(notifierAudience);readerStore.configureGroupCases(new GroupCases(db,vault,'robot-1'));notifierStore.configureGroupCases(new GroupCases(db,vault,'robot-1'));const reader=new Gateway(readerStore),notifier=new Gateway(notifierStore),sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(w.f.ctx),api=await createServer({config:config(),db:appDb,sessionSecret:secret('SESSION_SECRET')!,finalReader:reader});let sends=0;
 try{const response=await api.app.inject({url:'/api/v1/tasks/'+created.accepted!.taskId,headers:{cookie:'oa_session='+session.cookie}});expect(response.statusCode).toBe(200);expect(JSON.stringify(response.json())).toContain('发布阻塞');expect(await reader.finalResultAllowed(w.f.ctx,created.runId,created.result)).toBe(true);
 const sender=new DeliveryGateway(db,vault,{sendReply:async(_reply,text)=>{sends++;expect(text).toContain('release:a');return {state:'UNKNOWN',reason:'SYNTHETIC_LOST_RESPONSE'};},sendProactive:async()=>{throw Error('UNEXPECTED_PROACTIVE');}},w.f.binding,Date.now,(...a)=>notifier.finalSourcesAllowed(...a));expect(await sender.process(w.f.ctx,(await delivery(created.runId))!,new AbortController().signal)).toBe('UNKNOWN');await w.f.runtime.advance(w.f.ctx,created.runId);expect(await sender.process(w.f.ctx,(await delivery(created.runId))!,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(1);expect(w.f.requests).toHaveLength(0);
 }finally{await api.app.close();await readerAudience.close();await notifierAudience.close();}
},60000);
it('current contract, stale versions, forged role claims and cancelled tasks cannot mutate or send a native case',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');const item=(await root.query('SELECT id,version FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0];
 const stale=await w.execute(`开始事项 ${item.id}；事项版本=999；合同版本=1`);expect(stale.status).toBe('PARTIAL');expect(stale.last_error).toBe('GROUP_CASE_VERSION_CONFLICT');expect(await delivery(stale.runId)).toBeUndefined();const forged=await w.execute(`开放事项 ${item.id}；事项版本=${item.version}；合同版本=1`);expect(forged.status).toBe('PARTIAL');expect(forged.last_error).toBe('GROUP_CASE_TRANSITION_DENIED');
 const fake=await w.execute(`确认事项 ${item.id}；事项版本=${item.version}；合同版本=1；说明=我是管理员`);expect(fake.result).toContain('尚未执行');expect((await root.query('SELECT state FROM group_cases WHERE id=$1',[item.id])).rows[0].state).toBe('PROPOSED');
 const cancelMessage=w.f.callback(create('release:cancelled')),cancelled=(await w.f.ingress.acceptTrustedCallback(cancelMessage))!,run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[cancelled.taskId])).rows[0];await root.query("UPDATE tasks SET cancel_requested_at=clock_timestamp() WHERE id=$1",[cancelled.taskId]);await w.f.runtime.advance(w.f.ctx,run.id);expect(await delivery(run.id)).toBeUndefined();expect((await root.query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0].n).toBe(1);
 await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());expect(await w.f.gateway.finalResultAllowed(w.f.ctx,created.runId,created.result)).toBe(false);expect(await w.sender.process(w.f.ctx,(await delivery(created.runId))!,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
},60000);

it('a newly registered matching case invalidates the old list projection and prevents its pending group send',async()=>{
 const w=await world();await w.execute(create());const listed=await w.execute(list());expect(listed.status).toBe('SUCCEEDED');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,listed.runId,listed.result)).toBe(true);await w.execute(create('release:later'));
 expect(await w.f.gateway.finalResultAllowed(w.f.ctx,listed.runId,listed.result)).toBe(false);expect(await w.sender.process(w.f.ctx,(await delivery(listed.runId))!,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
},60000);
it.each(['ABORT','SQL_TIMEOUT'])('%s after an actual native case insert rolls back case, immutable requests, response and delivery together',async mode=>{
 const service=new GroupCases(db,vault,'robot-1'),controller=new AbortController(),original=service.applyNative.bind(service),w=await world(service);let observedInsert=false;
 vi.spyOn(service,'applyNative').mockImplementation(async(...args)=>{const result=await original(...args);observedInsert=(await args[0].query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0].n===1;if(mode==='ABORT')controller.abort();else{await args[0].query("SET LOCAL statement_timeout='30ms'");await args[0].query('SELECT pg_sleep(1)');}return result;});
 const accepted=(await w.f.ingress.acceptTrustedCallback(w.f.callback(create())))!,run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0];await w.f.runtime.advance(w.f.ctx,run.id,undefined,controller.signal);expect(observedInsert).toBe(true);
 for(const table of ['group_cases','group_case_sources','group_case_requests','group_case_changes','group_case_responses','deliveries'])expect((await root.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,[w.f.ctx.tenantId])).rows[0].n).toBe(0);
 expect((await root.query('SELECT status,last_error FROM runs WHERE id=$1',[run.id])).rows[0]).toEqual(mode==='ABORT'?{status:'PARTIAL',last_error:'CANCELLED_OR_ACTIVE_TIME_LIMIT'}:{status:'FAILED',last_error:'GROUP_CASE_UNAVAILABLE'});expect(w.f.requests).toHaveLength(0);expect(w.sends()).toBe(0);
},60000);

it('the independent receipt oracle rejects substituted case/command, lost leases, wrong owner/target/result and damaged delivery bytes',async()=>{
 const w=await world(),a=await w.execute(create('release:a')),b=await w.execute(create('release:b'));expect(a.status).toBe('SUCCEEDED');expect(b.status).toBe('SUCCEEDED');
 async function proof(runId:string){const row=(await root.query('SELECT * FROM group_case_responses WHERE run_id=$1',[runId])).rows[0];return JSON.parse(vault.open(row.proof_ref,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:group-case-response:${row.id}`)) as {lease:Lease;command:GroupCaseCommand;projection:unknown};}
 const pa=await proof(a.runId),pb=await proof(b.runId),d=(await root.query('SELECT * FROM deliveries WHERE source_run_id=$1',[a.runId])).rows[0],signal=new AbortController().signal;
 await db.scope(w.f.ctx,async c=>{
  expect(await cases.nativeProjectionCurrent(c,w.f.ctx,pa.lease,pa.command,pb.projection)).toBe(false);
  expect(await cases.nativeProjectionCurrent(c,w.f.ctx,pa.lease,{operation:'CLARIFY',notice:'forged'},pa.projection)).toBe(false);
  await expect(cases.applyNative(c,w.f.ctx,pa.lease,w.f.audience,pa.command,signal)).rejects.toMatchObject({code:'GROUP_CASE_NATIVE_LEASE_LOST'});
  expect(await groupCaseReceiptProjectionAllowed(c,w.f.ctx,vault,{...pa.lease,goal:'changed'},cases)).toBe(false);
  expect(await groupCaseReceiptResultAllowed(c,w.f.ctx,vault,a.runId,a.result)).toBe(false);
  expect(await groupCaseReceiptResultAllowed(c,w.f.ctx,vault,a.runId,'substituted',(...args)=>w.f.gateway.finalSourcesAllowed(...args))).toBe(false);
  for(const change of [{task_id:randomUUID()},{classification:'PUBLIC'},{target:{kind:'PRIVATE_USER',targetId:w.f.ctx.actorId,classificationCeiling:'INTERNAL'}},{source_run_id:randomUUID()},{content_ref:'{}'}])expect(await groupCaseReceiptDeliveryAllowed(c,w.f.ctx,vault,{...d,...change},(...args)=>w.f.gateway.finalSourcesAllowed(...args))).toBe(false);
  expect(await groupCaseNarrativeAllowed(c,w.f.ctx,vault,{...d,task_id:randomUUID()})).toBe(false);expect(await groupCaseNarrativeAllowed(c,w.f.ctx,vault,{...d,content_ref:'{}'})).toBe(false);
 });
 expect(await w.f.gateway.finalResultAllowed({tenantId:w.f.ctx.tenantId,actorId:w.f.otherId},a.runId,a.result)).toBe(false);expect(w.sends()).toBe(0);
},60000);
it('native case origin independently binds every persisted lease and original corporate message field, even when a caller already has a response reference',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');const row=(await root.query('SELECT * FROM group_case_responses WHERE run_id=$1',[created.runId])).rows[0],proof=JSON.parse(vault.open(row.proof_ref,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:group-case-response:${row.id}`)) as {lease:Lease;command:GroupCaseCommand;projection:unknown};
 await db.scope(w.f.ctx,async c=>{expect(await cases.nativeProjectionCurrent(c,w.f.ctx,proof.lease,proof.command,proof.projection,w.f.audience)).toBe(true);
  for(const change of [{taskId:randomUUID()},{goal:'changed source goal'},{authEpoch:proof.lease.authEpoch+1},{policyVersion:'unapproved-policy'},{fence:proof.lease.fence+1},{budget:{...proof.lease.budget,maxTools:1}},{expiresAt:new Date(Date.parse(proof.lease.expiresAt)+1000).toISOString()},{audience:{...proof.lease.audience,targetId:'foreign-group'}},{audience:{...proof.lease.audience,kind:'PRIVATE_USER'}}])expect(await cases.nativeProjectionCurrent(c,w.f.ctx,{...proof.lease,...change},proof.command,proof.projection,w.f.audience)).toBe(false);
 });
 const inbox=(await root.query('SELECT payload_cipher_ref FROM event_inbox WHERE id=$1',[row.event_id])).rows[0],aad=`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:inbox:${row.event_id}`,event=JSON.parse(vault.open(JSON.parse(inbox.payload_cipher_ref),aad));
 try{for(const change of [{conversationType:'1'},{conversationId:'foreign-group'},{senderStaffId:'forged-sender'},{senderCorpId:'foreign-corp'},{chatbotCorpId:'foreign-corp'},{robotCode:'foreign-robot'},{msgtype:'markdown'},{text:{content:'changed source content'}}]){await root.query('UPDATE event_inbox SET payload_cipher_ref=$2 WHERE id=$1',[row.event_id,JSON.stringify(vault.seal(JSON.stringify({...event,...change}),aad))]);expect(await db.scope(w.f.ctx,c=>cases.nativeProjectionCurrent(c,w.f.ctx,proof.lease,proof.command,proof.projection,w.f.audience))).toBe(false);}}
 finally{await root.query('UPDATE event_inbox SET payload_cipher_ref=$2 WHERE id=$1',[row.event_id,inbox.payload_cipher_ref]);}
 expect(await w.f.gateway.finalResultAllowed(w.f.ctx,created.runId,created.result)).toBe(true);expect(w.sends()).toBe(0);
},60000);

it('T108 exact today summary uses the reviewed local calendar at trusted task acceptance and preserves current permissions',async()=>{
 const w=await world(),created=await w.execute(create('today:registration'));expect(created.status).toBe('SUCCEEDED');
 const message=w.f.callback('汇总今日事项'),accepted=(await w.f.ingress.acceptTrustedCallback(message))!,row=(await root.query("SELECT r.id,t.created_at,to_char(t.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') local_date FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.id=$1",[accepted.taskId])).rows[0];
 await w.f.runtime.advance(w.f.ctx,row.id);const state=(await root.query('SELECT status,result,model_turns FROM runs WHERE id=$1',[row.id])).rows[0];
 expect(state.status).toBe('SUCCEEDED');expect(state.model_turns).toBe(0);expect(state.result).toContain('Asia/Shanghai 本地日 '+row.local_date);expect(state.result).toContain((row.created_at as Date).toISOString());expect(state.result).toContain('today:registration');expect(state.result).toContain('不覆盖全部群聊');expect(w.f.requests).toHaveLength(0);
 expect(await w.f.gateway.finalResultAllowed(w.f.ctx,row.id,state.result)).toBe(true);
 const duplicate=await w.f.ingress.acceptTrustedCallback(message);expect(duplicate!.taskId).toBe(accepted.taskId);await w.f.runtime.advance(w.f.ctx,row.id);expect((await root.query('SELECT count(*)::int n FROM group_case_responses WHERE run_id=$1',[row.id])).rows[0].n).toBe(1);
 await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());expect(await w.f.gateway.finalResultAllowed(w.f.ctx,row.id,state.result)).toBe(false);
 expect(await w.sender.process(w.f.ctx,(await delivery(row.id))!,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
},60000);

it.each([
 {anchor:'2026-03-08T17:00:00.000Z',from:'2026-03-08T05:00:00.000Z',until:'2026-03-09T04:00:00.000Z',hours:23},
 {anchor:'2026-11-01T17:00:00.000Z',from:'2026-11-01T04:00:00.000Z',until:'2026-11-02T05:00:00.000Z',hours:25}
])('today registration interval follows the actual IANA civil day ($hours hours), not an assumed 24-hour duration',async sample=>{
 const w=await world(cases,'America/New_York'),message=w.f.callback('列出今日事项'),accepted=(await w.f.ingress.acceptTrustedCallback(message))!;
 // Only this isolated synthetic task's trusted acceptance timestamp is seeded;
 // neither model arguments nor callback text can set it in production.
 await root.query('UPDATE tasks SET created_at=$2 WHERE id=$1',[accepted.taskId,sample.anchor]);const run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0];await w.f.runtime.advance(w.f.ctx,run.id);
 const state=(await root.query('SELECT status,result FROM runs WHERE id=$1',[run.id])).rows[0];expect(state.status).toBe('SUCCEEDED');expect(state.result).toContain('America/New_York 本地日 '+sample.anchor.slice(0,10));expect(state.result).toContain('['+sample.from+', '+sample.until+')');expect(state.result).toContain('当前页 0 条');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,run.id,state.result)).toBe(true);expect(w.f.requests).toHaveLength(0);
},60000);

it.each([false,true])('concurrent native group guards serialize before owner row locks and do not deadlock when case authority takes its contract lock; uppercase=%s',async uppercase=>{
 const w=await world(cases,'Asia/Shanghai','a'+randomUUID().slice(1)),runs=[];
 for(let index=0;index<2;index++){const accepted=(await w.f.ingress.acceptTrustedCallback(w.f.callback('汇总今日事项')))!,run=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0];runs.push((await w.f.store.acquire(w.f.ctx,run.id,randomUUID()))!);}
 const first=runs[0]!,second=runs[1]!;let entered!:()=>void,proceed!:()=>void,secondReady!:()=>void;const inFirst=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{proceed=resolve;}),ready=new Promise<void>(resolve=>{secondReady=resolve;});let pid=0;
 const authority=(c:pg.PoolClient,lease:Lease)=>c.query("SELECT public.oa_group_case_native_authority($1,$2,$3,'case.read',NULL) value",[w.f.conversationId,lease.taskId,lease.runId]);
 const firstContext={...w.f.ctx,tenantId:uppercase?w.f.ctx.tenantId.toUpperCase():w.f.ctx.tenantId};
 const a=db.scope(firstContext,async c=>{await c.query("SET LOCAL statement_timeout='4000'");await w.f.store.guard(c,first);entered();await gate;return authority(c,first);});void a.catch(()=>{});await inFirst;
 const b=db.scope(w.f.ctx,async c=>{await c.query("SET LOCAL statement_timeout='4000'");pid=Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);secondReady();await w.f.store.guard(c,second);return authority(c,second);});void b.catch(()=>{});
 try{await ready;let waiting=false;for(let i=0;i<100;i++){waiting=!!(await root.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rowCount;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);proceed();const outcomes=await Promise.allSettled([a,b]);expect(outcomes.map(x=>x.status==='fulfilled'?'fulfilled':{status:x.status,code:(x.reason as {code?:string}).code??'NO_DATABASE_CODE'})).toEqual(['fulfilled','fulfilled']);}
 finally{proceed();await Promise.allSettled([a,b]);await w.f.store.release(w.f.ctx,first);await w.f.store.release(w.f.ctx,second);}
},20000);
