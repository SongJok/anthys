import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import type {DbContext} from '../../packages/storage/src/database.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,scenario:Awaited<ReturnType<typeof reminderExecution>>|undefined;
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();});afterEach(async()=>{vi.restoreAllMocks();await scenario?.close();scenario=undefined;});afterAll(async()=>{await d?.close();});
const sourceRow=async(id:string)=>(await d.root.query('SELECT * FROM group_reminder_occurrences WHERE id=$1',[id])).rows[0];

it.each(['roster','contract','authorization','source','owner-stop'] as const)('a real %s change after the first accepted send check vetoes the second check and physical sender',async mode=>{
 const s=scenario=await reminderExecution(d,vault),q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('STAGED');const row=await sourceRow(q.occurrenceId);let accepted=0,sends=0,oauth=0;
 const scope=d.db.scope.bind(d.db);
 // Alter the actual upstream/PG only after the first authority transaction has
 // committed. Both verifier passes and every SQL/DWS call remain real.
 vi.spyOn(d.db,'scope').mockImplementation(async<T>(ctx:DbContext,fn:(c:pg.PoolClient)=>Promise<T>)=>{const value=await scope(ctx,fn);if(value&&typeof value==='object'&&'group_proactive_authorized' in value&&value.group_proactive_authorized===true&&accepted++===0){
  if(mode==='roster')await s.w.f.configure({reply:groupMembersReply(s.w.f.conversationId,[s.w.f.ownerOpen,s.w.f.otherOpen,'synthetic-unknown-external']),info:groupInfoReply(3)});
  if(mode==='contract')await s.w.service.transition(s.w.principal,s.w.document.id,{delegationId:s.w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());
  if(mode==='authorization')await d.root.query('SELECT public.oa_group_reminder_authorization_revoke($1,$2,$3)',[s.w.grant.document.id,s.w.grant.hash,'SYNTHETIC_RUNTIME_REVOKE']);
  if(mode==='source')await d.root.query("UPDATE group_cases SET version=version+1 WHERE tenant_id=$1 AND id=$2",[s.w.principal.tenantId,s.ids[0]]);
  if(mode==='owner-stop')await d.root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'USER',$4,'WRITES',true,'synthetic-owner-stop')",[s.w.principal.tenantId,randomUUID(),s.w.principal.actorId,s.w.f.ctx.actorId]);
 }return value;});
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-denial-secret',robotCode:'robot-1',fetch:async input=>{if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){oauth++;return new Response(JSON.stringify({accessToken:'synthetic-denial-token',expireIn:7200}));}sends++;return new Response(JSON.stringify({processQueryKey:'synthetic-unexpected-message'}));}}),gateway=new DeliveryGateway(d.db,vault,sender,s.w.f.binding,Date.now,undefined,s.verifier);
 expect(await gateway.process(s.w.f.ctx,row.delivery_id,new AbortController().signal)).toBe('SUPPRESSED');expect(accepted).toBe(1);expect(sends).toBe(0);expect(oauth).toBe(0);expect((await d.root.query('SELECT state FROM deliveries WHERE id=$1',[row.delivery_id])).rows[0].state).toBe('SUPPRESSED');expect(s.w.f.requests).toEqual([]);
});
it('prior cancellation leaves no task or reservation, and explicit administrator cancellation revokes the queued occurrence',async()=>{
 const s=scenario=await reminderExecution(d,vault),q=await s.queue(),a=new AbortController();a.abort();await expect(s.scheduler.stage(s.w.f.ctx,q.occurrenceId,a.signal)).rejects.toThrow();expect((await sourceRow(q.occurrenceId)).state).toBe('QUEUED');
 await s.w.reminders.mutate(s.w.principal,s.w.f.conversationId,q.scheduleId,'CANCEL',{expectedRevision:1},randomUUID());expect((await sourceRow(q.occurrenceId)).state).toBe('REVOKED');expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(Number((await d.root.query('SELECT count(*) n FROM group_reminder_notifications WHERE tenant_id=$1',[s.w.principal.tenantId])).rows[0].n)).toBe(0);
});
it('an actual provider timeout blocks further scheduling with no task, reservation, sender or automatic observation loop',async()=>{
 const s=scenario=await reminderExecution(d,vault),q=await s.queue(),before=(await s.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length;await s.w.f.configure({delayMs:5000});
 expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('BLOCKED');expect((await d.root.query('SELECT state FROM group_reminder_schedules WHERE id=$1',[q.scheduleId])).rows[0].state).toBe('BLOCKED');expect((await sourceRow(q.occurrenceId)).state).toBe('REVOKED');const after=(await s.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length;expect(after-before).toBe(1);await s.scheduler.tick(s.w.f.ctx,new AbortController().signal);expect((await s.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(after);expect(Number((await d.root.query("SELECT count(*) n FROM tasks WHERE tenant_id=$1 AND control_kind='GROUP_REMINDER'",[s.w.principal.tenantId])).rows[0].n)).toBe(0);
});
