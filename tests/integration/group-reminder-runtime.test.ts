import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {secret} from '../../packages/config/src/index.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupReminderWorld} from '../support/group-reminder-world.js';
import {GroupReminderAudience} from '../../packages/groups/src/reminder-audience.js';
import {GroupReminderScheduler} from '../../packages/groups/src/reminder-runner.js';
import {GroupReminderVerifier} from '../../packages/groups/src/reminder-delivery.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,w:Awaited<ReturnType<typeof groupReminderWorld>>,scheduler:GroupReminderScheduler,verifier:GroupReminderVerifier,scheduleId:string,scheduledAt:string,occurrenceId:string,deliveryId:string,runId:string,mentionId:string;
let sends=0,delivered='';
beforeAll(async()=>{
 d=await groupReminderDatabase();await d.install();w=await groupReminderWorld(d.root,d.db,d.appDb,vault,{workHours:{timezone:'UTC',windows:[{daysOfWeek:[1,2,3,4,5,6,7],start:'00:00',end:'12:00'},{daysOfWeek:[1,2,3,4,5,6,7],start:'12:00',end:'00:00'}]}});
 // One real production card lifecycle proves the existing entry is reused.
 const first=(await w.cases.create(w.principal,w.f.conversationId,{contractVersion:1,details:{title:'合成逾期事项',resourceRef:'synthetic:reminder-resource:real',priority:'NORMAL',dueAt:new Date(Date.now()-60000).toISOString()},source:{kind:'CARD',shareWithGroup:true}},randomUUID())).case;
 const opened=(await w.cases.update(w.principal,w.f.conversationId,first.id,{contractVersion:1,expectedVersion:first.version,command:{operation:'OPEN'}},randomUUID())).case;
 await w.cases.update(w.principal,w.f.conversationId,first.id,{contractVersion:1,expectedVersion:opened.version,command:{operation:'ASSIGN',ownerId:w.principal.actorId}},randomUUID());
 const sessions=new Sessions(d.appDb,secret('SESSION_SECRET')!),ownerSession=await sessions.create(w.f.ctx),owner=(await sessions.authenticate(ownerSession.cookie))!;
 const mentioned=(await w.cases.create(owner,w.f.conversationId,{contractVersion:1,details:{title:'来自实际可信群 @ 的逾期事项',resourceRef:'synthetic:reminder-resource:mention',priority:'HIGH',dueAt:new Date(Date.now()-3600000).toISOString()},source:{kind:'MENTION',taskId:w.f.taskId}},randomUUID())).case;mentionId=mentioned.id;const mentionOpen=(await w.cases.update(w.principal,w.f.conversationId,mentionId,{contractVersion:1,expectedVersion:mentioned.version,command:{operation:'OPEN'}},randomUUID())).case;await w.cases.update(w.principal,w.f.conversationId,mentionId,{contractVersion:1,expectedVersion:mentionOpen.version,command:{operation:'ASSIGN',ownerId:owner.actorId}},randomUUID());
 // Explicit synthetic volume fixture; the other two cases used real entry paths.
 for(let n=0;n<28;n++){const id=randomUUID(),payload={title:'合成逾期事项 '+n,resourceRef:'synthetic:reminder-resource:'+n,priority:'NORMAL',dueAt:new Date(Date.now()-60000-n*1000).toISOString(),state:'ASSIGNED',ownerId:w.principal.actorId,createdBy:w.principal.actorId,blockedReason:null,completion:null},text=canonical(payload);await d.root.query('INSERT INTO group_cases(tenant_id,id,group_id,contract_id,contract_version,created_by,owner_id,state,resource_hash,payload_ref,payload_hash) VALUES($1,$2,$3,$4,1,$5,$5,$6,$7,$8,$9)',[w.principal.tenantId,id,w.f.conversationId,w.document.id,w.principal.actorId,payload.state,hash(payload.resourceRef),JSON.stringify(vault.seal(text,`${w.principal.tenantId}:group-case:${id}`)),hash(text)]);await d.root.query("INSERT INTO group_case_sources(tenant_id,id,group_id,case_id,kind,source_key,submitted_by) VALUES($1,$2,$3,$4,'CARD',$5,$6)",[w.principal.tenantId,randomUUID(),w.f.conversationId,id,hash('synthetic explicit shared-card volume '+id),w.principal.actorId]);}
 scheduledAt=new Date(Math.ceil((Date.now()+5000)/1000)*1000).toISOString();const created=await w.reminders.create(w.principal,w.f.conversationId,{authorizationId:w.grant.document.id,contractVersion:1,rule:{schemaVersion:1,tz:'UTC',kind:'ONCE',start:{kind:'UTC',at:scheduledAt},misfire:{kind:'REMINDER_LATEST'}},confirmGroupNotifications:true},randomUUID());if(!('schedule' in created))throw Error('Schedule receipt required');scheduleId=created.schedule.id;
 scheduler=new GroupReminderScheduler(d.db,vault,new GroupReminderAudience(w.f.dws,'robot-1'),'robot-1');verifier=new GroupReminderVerifier(vault,new GroupReminderAudience(w.f.dws,'robot-1'),'robot-1');
});
afterAll(async()=>{await scheduler?.audience.close();await verifier?.close();await w?.f.close();await d?.close();});
// Same persisted occurrence across bounded phases. No provider, authority,
// dispatcher or source proof is replaced with an affirmative mock.
describe('T111 registered overdue cases to controlled physical group reminder',{concurrent:false},()=>{
 it('claims one logical occurrence across schedulers, never queues a model, and atomically reserves a bounded merged digest',async()=>{
  expect(await scheduler.claimDue(w.f.ctx)).toEqual([]);await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(scheduledAt)-Date.now())+30));
  const claims=await Promise.all([scheduler.claimDue(w.f.ctx),scheduler.claimDue(w.f.ctx)]);expect(claims.flat()).toHaveLength(1);occurrenceId=claims.flat()[0]!;
  const staged=await Promise.all([scheduler.stage(w.f.ctx,occurrenceId,new AbortController().signal),scheduler.stage(w.f.ctx,occurrenceId,new AbortController().signal)]);expect(staged.sort()).toEqual(['NOT_CLAIMED','STAGED']);
  const occurrence=(await d.root.query('SELECT * FROM group_reminder_occurrences WHERE id=$1',[occurrenceId])).rows[0];expect(occurrence).toMatchObject({state:'STAGED',fence:'1'});deliveryId=occurrence.delivery_id;runId=occurrence.run_id;
  const items=(await d.root.query('SELECT case_id,resource_hash FROM group_reminder_notification_cases WHERE notification_id=$1',[occurrence.notification_id])).rows;expect(items.length).toBeGreaterThan(1);expect(items.length).toBeLessThanOrEqual(20);expect(new Set(items.map(i=>i.resource_hash)).size).toBe(items.length);expect(items.some(i=>i.case_id===mentionId)).toBe(true);
  const run=(await d.root.query('SELECT status,model_turns,tool_calls,result FROM runs WHERE id=$1',[runId])).rows[0];expect(run).toMatchObject({status:'SUCCEEDED',model_turns:0,tool_calls:0});expect(Buffer.byteLength(run.result)).toBeLessThanOrEqual(6000);expect(run.result).toContain('不覆盖全部群聊');expect(run.result).toContain('未使用@全员');expect(run.result).toContain('未在本条展示');
  expect(Number((await d.root.query("SELECT count(*) n FROM tasks WHERE tenant_id=$1 AND control_kind='GROUP_REMINDER'",[w.principal.tenantId])).rows[0].n)).toBe(1);expect(w.f.requests).toEqual([]);
 });
 it('loads current source proof for result access and physically sends one exact authorized GROUP digest through both current checks',async()=>{
  expect(deliveryId).toBeTruthy();const content=(await d.root.query('SELECT result FROM runs WHERE id=$1',[runId])).rows[0].result as string;
  expect(await d.db.scope(w.f.ctx,c=>verifier.resultAllowed(c,w.f.ctx,runId,content))).toBe(true);
  const gateway=new DeliveryGateway(d.db,vault,{sendReply:async()=>{throw Error('UNEXPECTED_WEBHOOK');},sendProactive:async(target,text)=>{expect(target).toEqual({kind:'GROUP',externalId:w.f.conversationId});sends++;delivered=text;return {state:'APPLIED_UNVERIFIED',requestId:'synthetic-group-reminder-request'};}},w.f.binding,Date.now,undefined,verifier);
  expect(await gateway.process(w.f.ctx,deliveryId,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(sends).toBe(1);expect(delivered).toBe(content);expect(w.f.requests).toEqual([]);
  expect((await d.root.query('SELECT state,verification_state FROM deliveries WHERE id=$1',[deliveryId])).rows[0]).toEqual({state:'APPLIED_UNVERIFIED',verification_state:'UNVERIFIED'});
 });
 it('keeps the consumed receipt and never repeats the same physical send, occurrence, quota reservation or model request',async()=>{
  const gateway=new DeliveryGateway(d.db,vault,{sendReply:async()=>{throw Error('UNEXPECTED');},sendProactive:async()=>{sends++;throw Error('UNEXPECTED_DUPLICATE');}},w.f.binding,Date.now,undefined,verifier);
  expect(await gateway.process(w.f.ctx,deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');await scheduler.tick(w.f.ctx,new AbortController().signal);expect(sends).toBe(1);
  expect(Number((await d.root.query('SELECT count(*) n FROM group_reminder_occurrences WHERE schedule_id=$1',[scheduleId])).rows[0].n)).toBe(1);expect(Number((await d.root.query('SELECT count(*) n FROM group_reminder_notifications WHERE owner_id=$1',[w.f.ctx.actorId])).rows[0].n)).toBe(1);expect(w.f.requests).toEqual([]);
 });
});
