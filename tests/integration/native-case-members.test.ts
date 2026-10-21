import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {Vault} from '../../packages/storage/src/crypto.js';
import {watchTrial} from '../../packages/storage/src/trial.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {signedNativeCaseRuntime} from '../support/native-case-runtime.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {syntheticCompanyAgentGroupSender} from '../support/company-agent-group-delivery.js';
import {groupMembersReply} from '../support/group-members.js';

const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),signal=()=>new AbortController().signal;
let d:Awaited<ReturnType<typeof groupReminderDatabase>>;
const cleanup:(()=>Promise<void>)[]=[];
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();},60000);
afterAll(async()=>{for(const close of cleanup.reverse())await close();await d?.close();},60000);
const create=(resource='synthetic:member-case')=>`登记事项：标题=合成成员阻塞；资源=${resource}；优先级=NORMAL；截止=未设置；合同版本=1`;
async function world(){
 const w=await groupCaseWorld(d.root,d.db,d.appDb,vault);cleanup.push(()=>w.f.close());await w.approve();await w.save();
 const signed=await signedNativeCaseRuntime(d,w,vault);cleanup.push(()=>signed.close());
 const accept=async(text:string,actor:'MEMBER'|'OWNER'='MEMBER')=>{
  const ctx=actor==='MEMBER'?{tenantId:w.f.ctx.tenantId,actorId:w.f.otherId}:w.f.ctx,external=actor==='MEMBER'?w.f.otherExternal:w.f.ownerExternal;
  const message=w.f.callback(text,{senderStaffId:external,senderId:external}),accepted=(await w.f.ingress.acceptTrustedCallback(message))!,runId=(await d.root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id as string;
  return {ctx,message,accepted,runId};
 };
 const execute=async(text:string,actor:'MEMBER'|'OWNER'='MEMBER')=>{const a=await accept(text,actor);await w.f.runtime.advance(a.ctx,a.runId);return {...a,...(await d.root.query('SELECT status,result,last_error FROM runs WHERE id=$1',[a.runId])).rows[0]};};
 const caseRow=async()=>(await d.root.query('SELECT id,version,state,owner_id FROM group_cases WHERE tenant_id=$1 ORDER BY created_at',[w.f.ctx.tenantId])).rows;
 const delivery=async(runId:string)=>(await d.root.query('SELECT id,state FROM deliveries WHERE source_run_id=$1',[runId])).rows[0];
 const sender=(text:string)=>{const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:text});return {physical,gateway:new DeliveryGateway(d.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a))};};
 return {...w,signed,accept,execute,caseRow,delivery,sender};
}
it('a real member/admin native origin creates, assigns and independently confirms without borrowing an H5 session or private identity',async()=>{
 const w=await world(),created=await w.execute(create());expect(created.status).toBe('SUCCEEDED');
 const item=(await w.caseRow())[0]!;expect(item.state).toBe('PROPOSED');expect(created.result).toContain('不覆盖全部群聊');
 const proof=(await d.root.query('SELECT owner_id,service_owner_id,run_id,worker_id,fence FROM run_native_case_audiences WHERE run_id=$1',[created.runId])).rows[0];expect(proof.owner_id).toBe(w.f.otherId);expect(proof.service_owner_id).toBe(w.f.ctx.actorId);expect(proof.owner_id).not.toBe(proof.service_owner_id);
 expect((await d.root.query('SELECT count(*)::int n FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[w.f.ctx.tenantId,w.f.otherId])).rows[0].n).toBe(0);
 expect((await d.root.query('SELECT count(*)::int n FROM run_group_audiences WHERE run_id=$1 UNION ALL SELECT count(*)::int n FROM run_dws_dependencies WHERE run_id=$1',[created.runId])).rows.map(r=>r.n)).toEqual([0,0]);
 expect((await w.execute(`开放事项 ${item.id}；事项版本=1；合同版本=1`)).status).toBe('SUCCEEDED');
 expect((await w.execute(`指派事项 ${item.id}；事项版本=2；合同版本=1；负责人=${w.f.ctx.actorId}`)).status).toBe('SUCCEEDED');
 const claimed=await w.execute(`事项已完成 ${item.id}；事项版本=3；合同版本=1；说明=合成负责人声明`, 'OWNER');expect(claimed.status).toBe('SUCCEEDED');expect(claimed.result).toContain('WAITING_CONFIRMATION');expect(claimed.result).toContain('UNVERIFIED（负责人声明待确认）');expect(claimed.result).not.toContain('ADMIN_CONFIRMED');
 const claimedRow=(await d.root.query('SELECT payload_ref FROM group_cases WHERE id=$1',[item.id])).rows[0];expect(JSON.parse(vault.open(claimedRow.payload_ref,`${claimed.ctx.tenantId}:group-case:${item.id}`))).toMatchObject({state:'WAITING_CONFIRMATION',completion:{method:'UNVERIFIED',actorId:w.f.ctx.actorId}});
 const confirmed=await w.execute(`确认事项 ${item.id}；事项版本=4；合同版本=1；说明=合成独立管理员确认`);expect(confirmed.status).toBe('SUCCEEDED');expect(confirmed.result).toContain('ADMIN_CONFIRMED');expect(confirmed.result).toContain('不是外部工具自动核验');
 expect(await w.f.gateway.finalResultAllowed(confirmed.ctx,confirmed.runId,confirmed.result)).toBe(true);
 const sender=w.sender(confirmed.result),delivery=await w.delivery(confirmed.runId);expect(await sender.gateway.process(confirmed.ctx,delivery.id,signal())).toBe('APPLIED_UNVERIFIED');expect(await sender.gateway.process(confirmed.ctx,delivery.id,signal())).toBe('NOT_CLAIMED');expect(sender.physical.replyCount()).toBe(1);
 expect((await w.f.ingress.acceptTrustedCallback(created.message))!.duplicate).toBe(true);expect(await w.caseRow()).toHaveLength(1);expect(w.f.requests).toHaveLength(0);
},180000);
it('wrong requester, tenant, worker, fence and phase never turn signed data into a live native authority',async()=>{
 const w=await world(),a=await w.accept(create()),lease=(await w.f.store.acquire(a.ctx,a.runId,randomUUID()))!,before=(await w.f.fixture.events()).length;
 const observe=(ctx:typeof a.ctx,worker:string,fence:number,phase:string,action:string)=>d.db.scope(ctx,c=>c.query('SELECT public.oa_group_case_native_observer($1,$2,$3,$4,$5,$6,$7,NULL)',[w.f.conversationId,lease.taskId,lease.runId,worker,fence,phase,action]));
 for(const [ctx,worker,fence,phase,action] of [[a.ctx,randomUUID(),lease.fence,'EXECUTION','case.create'],[a.ctx,lease.workerId,lease.fence+1,'EXECUTION','case.create'],[w.f.ctx,lease.workerId,lease.fence,'EXECUTION','case.create'],[{tenantId:randomUUID(),actorId:a.ctx.actorId},lease.workerId,lease.fence,'EXECUTION','case.create'],[a.ctx,lease.workerId,lease.fence,'RESULT_VERIFICATION','case.create'],[a.ctx,lease.workerId,lease.fence,'RESULT_VERIFICATION','case.read']] as const)await expect(observe(ctx,worker,fence,phase,action)).rejects.toThrow('GROUP_CASE_NATIVE_LEASE_LOST');
 expect((await w.f.fixture.events()).length).toBe(before);expect(await w.caseRow()).toHaveLength(0);expect(await w.delivery(a.runId)).toBeUndefined();await w.f.store.release(a.ctx,lease);
},60000);
it('a changed roster after the native commit suppresses the physical group result',async()=>{
 const w=await world(),r=await w.execute(create());expect(r.status).toBe('SUCCEEDED');expect(await w.f.gateway.finalResultAllowed(r.ctx,r.runId,r.result)).toBe(true);
 await w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.ownerOpen,w.f.otherOpen,'synthetic-unreviewed-arrival'])});
 expect(await w.f.gateway.finalResultAllowed(r.ctx,r.runId,r.result)).toBe(false);const s=w.sender(r.result);expect(await s.gateway.process(r.ctx,(await w.delivery(r.runId)).id,signal())).toBe('SUPPRESSED');expect(s.physical.replyCount()).toBe(0);
},60000);
it('cancellation before native admission makes no case or response and cannot use the service owner as requester',async()=>{
 const w=await world(),a=await w.accept(create());await d.root.query('UPDATE tasks SET cancel_requested_at=clock_timestamp() WHERE id=$1',[a.accepted.taskId]);await w.f.runtime.advance(a.ctx,a.runId);
 expect(await w.caseRow()).toHaveLength(0);expect(await w.delivery(a.runId)).toBeUndefined();expect((await d.root.query('SELECT id FROM run_native_case_audiences WHERE run_id=$1',[a.runId])).rows).toHaveLength(0);expect(w.f.requests).toHaveLength(0);
},60000);
it.each(['ABORT','SQL_TIMEOUT'] as const)('%s after an actual member case insert rolls back mutation, receipt and delivery together',async mode=>{
 const w=await world(),a=await w.accept(create()),controller=new AbortController(),original=w.cases.applyNative.bind(w.cases);let inserted=false;
 vi.spyOn(w.cases,'applyNative').mockImplementation(async(...args)=>{const result=await original(...args);inserted=(await args[0].query('SELECT id FROM group_cases WHERE tenant_id=$1',[a.ctx.tenantId])).rowCount===1;if(mode==='ABORT')controller.abort();else{await args[0].query("SET LOCAL statement_timeout='30ms'");await args[0].query('SELECT pg_sleep(1)');}return result;});
 await w.f.runtime.advance(a.ctx,a.runId,undefined,controller.signal);expect(inserted).toBe(true);
 for(const table of ['group_cases','group_case_sources','group_case_requests','group_case_changes','group_case_responses','deliveries'])expect((await d.root.query(`SELECT id FROM ${table} WHERE tenant_id=$1`,[a.ctx.tenantId])).rows).toHaveLength(0);
 expect(w.f.requests).toHaveLength(0);
},60000);
it('only a new actual worker/fence can replace an interrupted pre-mutation audience and RLS keeps each proof with its requester',async()=>{
 const w=await world(),a=await w.accept(create()),first=(await w.f.store.acquire(a.ctx,a.runId,randomUUID()))!;expect(await w.f.gateway.prepareAudience(a.ctx,first,signal())).toBe(true);expect(first.nativeCaseAudience).toBeDefined();expect(first.groupAudience).toBeUndefined();await w.f.store.release(a.ctx,first);
 const next=(await w.f.store.acquire(a.ctx,a.runId,randomUUID()))!;expect(next.fence).toBeGreaterThan(first.fence);expect(await w.f.gateway.prepareAudience(a.ctx,next,signal())).toBe(true);expect(next.nativeCaseAudience?.id).not.toBe(first.nativeCaseAudience?.id);
 await d.db.scope(a.ctx,async c=>{expect(await w.signed.audiences.current(c,a.ctx,first,signal())).toBe(false);expect(await w.signed.audiences.current(c,a.ctx,next,signal())).toBe(true);});
 expect((await d.db.scope(w.f.ctx,c=>c.query('SELECT id FROM run_native_case_audiences WHERE run_id=$1',[a.runId]))).rows).toHaveLength(0);
 expect(await w.f.gateway.tools(a.ctx,next)).toEqual([]);expect(await w.f.store.processNativeGroupCase(a.ctx,next,signal())).toBe(true);expect(await w.caseRow()).toHaveLength(1);expect((await d.root.query('SELECT status FROM runs WHERE id=$1',[a.runId])).rows[0].status).toBe('SUCCEEDED');expect(w.f.requests).toHaveLength(0);
},90000);

it('a current actual member native case retains the contract watcher until a real pause',async()=>{
 const w=await world(),a=await w.accept(create()),lease=(await w.f.store.acquire(a.ctx,a.runId,randomUUID()))!,watch=await watchTrial(d.db,a.ctx,a.runId);
 try{expect(watch.signal.reason).toBeUndefined();expect(watch.signal.aborted).toBe(false);await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());await vi.waitFor(()=>expect(watch.signal.aborted).toBe(true));expect(watch.signal.reason?.message).toBe('GROUP_CONTRACT_CHANGED');}finally{await watch.stop();await w.f.store.release(a.ctx,lease);}
},60000);

it('the native contract observer reads committed state while its own case transaction holds contract and requester/run locks',async()=>{
 const w=await world(),a=await w.accept(create()),lease=(await w.f.store.acquire(a.ctx,a.runId,randomUUID()))!;
 let held!:()=>void,release!:()=>void;const acquired=new Promise<void>(r=>{held=r;}),released=new Promise<void>(r=>{release=r;});
 const transaction=w.f.store.guarded(a.ctx,lease,async()=>{held();await released;});await acquired;
 let watch:Awaited<ReturnType<typeof watchTrial>>|undefined;
 try{watch=await watchTrial(d.db,a.ctx,a.runId);expect(watch.signal.reason).toBeUndefined();expect(watch.signal.aborted).toBe(false);}finally{release();await transaction;await watch?.stop();await w.f.store.release(a.ctx,lease);}
},60000);
it('T108 T109 two actual members keep different resources and full origins while today lists only registered group cases',async()=>{
 const w=await world(),a=await w.execute(create('synthetic:release-alpha'),'MEMBER'),b=await w.execute(create('synthetic:release-beta'),'OWNER');expect(a.status).toBe('SUCCEEDED');expect(b.status).toBe('SUCCEEDED');
 const rows=await w.caseRow();expect(rows).toHaveLength(2);expect(rows[0]!.id).not.toBe(rows[1]!.id);
 const sources=(await d.root.query('SELECT s.submitted_by,s.source_event_id,t.source_event_id task_event FROM group_case_sources s JOIN tasks t ON t.tenant_id=s.tenant_id AND t.source_event_id=s.source_event_id WHERE s.tenant_id=$1 ORDER BY s.submitted_by',[a.ctx.tenantId])).rows;
 expect(new Set(sources.map(s=>s.submitted_by))).toEqual(new Set([w.f.ctx.actorId,w.f.otherId]));expect(new Set(sources.map(s=>s.source_event_id)).size).toBe(2);expect(sources.every(s=>s.source_event_id===s.task_event)).toBe(true);
 const today=await w.execute('汇总今日事项');expect(today.status).toBe('SUCCEEDED');expect(today.result).toContain('synthetic:release-alpha');expect(today.result).toContain('synthetic:release-beta');expect(today.result).toContain('Asia/Shanghai');expect(today.result).toContain('当前页 2 条');expect(today.result).toContain('不覆盖全部群聊');expect(await w.f.gateway.finalResultAllowed(today.ctx,today.runId,today.result)).toBe(true);
 const s=w.sender(today.result);expect(await s.gateway.process(today.ctx,(await w.delivery(today.runId)).id,signal())).toBe('APPLIED_UNVERIFIED');expect(s.physical.replyCount()).toBe(1);expect(w.f.requests).toHaveLength(0);
},90000);
it('without the new native policy the legacy owner path remains usable while another member is denied',async()=>{
 const w=await groupCaseWorld(d.root,d.db,d.appDb,vault);cleanup.push(()=>w.f.close());await w.approve();await w.save();w.f.store.configureGroupCases(w.cases);expect(w.f.store.nativeCaseAudiences).toBeUndefined();
 const member=(await w.f.ingress.acceptTrustedCallback(w.f.callback(create('synthetic:unconfigured-member'),{senderStaffId:w.f.otherExternal,senderId:w.f.otherExternal})))!,memberCtx={tenantId:w.f.ctx.tenantId,actorId:w.f.otherId},memberRun=(await d.root.query('SELECT id FROM runs WHERE task_id=$1',[member.taskId])).rows[0].id as string;
 await w.f.runtime.advance(memberCtx,memberRun);expect((await d.root.query('SELECT status FROM runs WHERE id=$1',[memberRun])).rows[0].status).toBe('WAITING_AUTH');expect((await d.root.query('SELECT id FROM group_cases WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toHaveLength(0);
 const owner=(await w.f.ingress.acceptTrustedCallback(w.f.callback(create('synthetic:legacy-owner'))))!,ownerRun=(await d.root.query('SELECT id FROM runs WHERE task_id=$1',[owner.taskId])).rows[0].id as string;
 await w.f.runtime.advance(w.f.ctx,ownerRun);const final=(await d.root.query('SELECT status,result,group_audience_id,native_case_audience_id FROM runs WHERE id=$1',[ownerRun])).rows[0];expect(final.status).toBe('SUCCEEDED');expect(final.group_audience_id).not.toBeNull();expect(final.native_case_audience_id).toBeNull();expect(await w.f.gateway.finalResultAllowed(w.f.ctx,ownerRun,final.result)).toBe(true);expect(w.f.requests).toHaveLength(0);
},60000);
