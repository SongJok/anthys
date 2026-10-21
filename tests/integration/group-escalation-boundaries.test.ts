import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {Vault} from '../../packages/storage/src/crypto.js';
import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {GroupEscalations} from '../../packages/groups/src/escalations.js';
import {createGroupEscalationAdapter} from '../../packages/groups/src/escalation-adapter.js';
import {createServer} from '../../apps/api/src/server.js';
import {config,secret} from '../../packages/config/src/index.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
let d:Awaited<ReturnType<typeof groupReminderDatabase>>;
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),signal=()=>new AbortController().signal;
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();},60000);afterAll(async()=>{await d?.close();});
async function fixture(){
 const s=await reminderExecution(d,vault,1,{escalation:true}),roster=new GroupCaseRoster(s.w.f.dws,'robot-1'),host=new GroupEscalations(d.db,vault,roster,'robot-1'),adapter=createGroupEscalationAdapter(host),context={principal:s.w.principal,groupId:s.w.f.conversationId,signal:signal()},intent={caseId:s.ids[0]!,expectedCaseVersion:1,expectedContractVersion:1,reason:'SYNTHETIC shared quota and isolation'};
 const prepare=async(contractVersion=1)=>{const result=await adapter.prepare(context,{...intent,expectedContractVersion:contractVersion},randomUUID());expect(result,JSON.stringify(result)).toMatchObject({kind:'PREPARED'});if(result.kind!=='PREPARED')throw Error('SYNTHETIC_PREPARE_REQUIRED');return result;};
 return {s,host,adapter,context,intent,prepare,close:async()=>{await roster.close();await s.close();}};
}
it('actual authenticated owner, another same-admin session and another tenant cannot read, confirm or cancel a source-bound proposal',async()=>{
 const f=await fixture(),api=await createServer({config:config(),db:d.appDb,sessionSecret:secret('SESSION_SECRET')!,groupEscalations:f.adapter});try{
  const p=await f.prepare(),path='/api/v1/groups/'+encodeURIComponent(f.s.w.f.conversationId)+'/case-escalations/'+p.preview.proposalId,otherTenant={tenantId:randomUUID(),actorId:randomUUID()};await d.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC OTHER TENANT','ACTIVE')",[otherTenant.tenantId]);await d.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC','ACTIVE')",[otherTenant.tenantId,otherTenant.actorId]);
  const sessions=await Promise.all([api.sessions.create(f.s.w.f.ctx),api.sessions.create(f.s.w.admin),api.sessions.create(otherTenant)]);
  for(const session of sessions)for(const action of ['read','confirm','cancel']){const response=await api.app.inject({method:action==='read'?'GET':'POST',url:path+(action==='read'?'':'/'+action),headers:{cookie:'oa_session='+session.cookie,origin:config().APP_ORIGIN,'x-csrf-token':session.csrf,'idempotency-key':randomUUID()},...(action==='read'?{}:{payload:{previewHash:p.previewHash}})});expect(response.statusCode).toBe(200);expect(response.json().data).toMatchObject({kind:'DENIED'});expect(response.body).not.toContain(p.preview.case.title);expect(response.body).not.toContain(p.preview.case.resourceRef);}
  expect((await d.root.query('SELECT state,reserved_at FROM group_case_escalations WHERE id=$1',[p.preview.proposalId])).rows[0]).toEqual({state:'PREPARED',reserved_at:null});
 }finally{await api.app.close();await f.close();}
},60000);
it('a real pending reminder already consumes the group escalation ceiling without a second reservation or delivery',async()=>{
 const f=await fixture();try{const q=await f.s.queue();expect(await f.s.scheduler.stage(f.s.w.f.ctx,q.occurrenceId,signal())).toBe('STAGED');const p=await f.prepare();expect(await f.adapter.enqueue(f.context,{proposalId:p.preview.proposalId,previewHash:p.previewHash},randomUUID())).toEqual({kind:'DENIED',code:'GROUP_ESCALATION_LIMIT'});expect((await d.root.query('SELECT state,reserved_at FROM group_case_escalations WHERE id=$1',[p.preview.proposalId])).rows[0]).toEqual({state:'PREPARED',reserved_at:null});expect((await d.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[f.s.w.f.ctx.tenantId])).rows[0].n).toBe('1');}finally{await f.close();}
},60000);
it('a real queued escalation enters the original reminder usage and blocks another reminder for its unresolved case',async()=>{
 const f=await fixture();try{const p=await f.prepare();expect((await f.adapter.enqueue(f.context,{proposalId:p.preview.proposalId,previewHash:p.previewHash},randomUUID())).kind).toBe('QUEUED');const q=await f.s.queue(),usage=(await d.db.scope(f.s.w.f.ctx,c=>c.query('SELECT public.oa_group_reminder_usage($1,1) value',[q.occurrenceId]))).rows[0].value;expect(usage.notifications).toContainEqual(expect.objectContaining({notificationId:p.preview.proposalId,caseIds:[f.intent.caseId],state:'PENDING'}));expect(await f.s.scheduler.stage(f.s.w.f.ctx,q.occurrenceId,signal())).toBe('SKIPPED');expect((await d.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[f.s.w.f.ctx.tenantId])).rows[0].n).toBe('0');}finally{await f.close();}
},60000);
it('local cancellation and a real contract revision never refund the group-wide escalation reservation',async()=>{
 const f=await fixture();try{const first=await f.prepare(),ref={proposalId:first.preview.proposalId,previewHash:first.previewHash};expect((await f.adapter.enqueue(f.context,ref,randomUUID())).kind).toBe('QUEUED');expect((await f.adapter.cancel(f.context,ref,randomUUID())).kind).toBe('CANCELLED_LOCAL');await f.s.w.service.put(f.s.w.principal,{delegationId:f.s.w.profile.document.id,expectedVersion:1,document:{...f.s.w.document,version:2,stateUpdatedAt:new Date().toISOString()}},randomUUID());const next=await f.prepare(2);expect(next.preview.proposalId).not.toBe(first.preview.proposalId);expect(await f.adapter.enqueue(f.context,{proposalId:next.preview.proposalId,previewHash:next.previewHash},randomUUID())).toEqual({kind:'DENIED',code:'GROUP_ESCALATION_LIMIT'});expect((await d.root.query('SELECT count(*) n FROM group_case_escalations WHERE tenant_id=$1 AND reserved_at IS NOT NULL',[f.s.w.f.ctx.tenantId])).rows[0].n).toBe('1');}finally{await f.close();}
},60000);

it('an actually expired queued proposal exposes only suppressed status after scope expiry and never remains an unresolved reminder forever',async()=>{
 const f=await fixture();try{
  const p=await f.prepare(),ref={proposalId:p.preview.proposalId,previewHash:p.previewHash};expect((await f.adapter.enqueue(f.context,ref,randomUUID())).kind).toBe('QUEUED');
  // Updating a scope advances its authority version. Do it only after normal
  // confirmation, then wait for the immutable proposal's real database deadline.
  await d.root.query("UPDATE dws_group_scopes SET expires_at=clock_timestamp()+interval '35 seconds' WHERE id=$1",[f.s.w.f.scopeId]);
  const deadline=performance.now()+70000;for(;;){const expired=(await d.root.query('SELECT expires_at<=clock_timestamp() expired FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0].expired;if(expired)break;if(performance.now()>=deadline)throw Error('SYNTHETIC_EXPIRY_NOT_OBSERVED');await new Promise(resolve=>setTimeout(resolve,100));}
  const status=await f.adapter.read(f.context,ref.proposalId);expect(status).toMatchObject({kind:'DELIVERY_STATUS',delivery:{state:'SUPPRESSED',verification:'UNVERIFIED',physicalDeliveryVerified:false,method:'NO_PROVIDER_RECEIPT'}});expect(JSON.stringify(status)).not.toContain(p.preview.case.title);expect(JSON.stringify(status)).not.toContain(p.preview.case.resourceRef);expect(await f.adapter.enqueue(f.context,ref,randomUUID())).toEqual({kind:'UNKNOWN',code:'GROUP_ESCALATION_RECONCILE_REQUIRED'});expect((await createGroupEscalationAdapter(f.host).enqueue(f.context,ref,randomUUID())).kind).toBe('DENIED');
  const c=await d.root.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[f.s.w.f.ctx.tenantId,f.s.w.f.ctx.actorId]);const usage=(await c.query('SELECT public.oa_group_escalation_usage($1,clock_timestamp()) value',[f.s.w.f.conversationId])).rows[0].value;expect(usage).toEqual([expect.objectContaining({notificationId:ref.proposalId,caseIds:[f.intent.caseId],state:'SUPPRESSED'})]);await c.query('ROLLBACK');}finally{c.release();}
  expect((await d.root.query('SELECT state,reserved_at IS NOT NULL reserved,claim_id FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0]).toEqual({state:'QUEUED',reserved:true,claim_id:null});expect((await d.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[f.s.w.f.ctx.tenantId])).rows[0].n).toBe('0');
 }finally{await f.close();}
},90000);
