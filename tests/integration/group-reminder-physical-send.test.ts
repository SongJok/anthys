import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>|undefined,q:Awaited<ReturnType<Awaited<ReturnType<typeof reminderExecution>>['queue']>>,deliveryId:string,runId:string;
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();},120_000);
beforeEach(async()=>{s=await reminderExecution(d,vault);q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('STAGED');const row=(await d.root.query('SELECT delivery_id,run_id FROM group_reminder_occurrences WHERE id=$1',[q.occurrenceId])).rows[0];deliveryId=row.delivery_id;runId=row.run_id;},120_000);
afterEach(async()=>{await s?.close();s=undefined;});afterAll(async()=>{await d?.close();});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
it.each(['cancel','contract','authorization','roster','abort','expire','source','owner-stop'] as const)('real sender rejects %s occurring during cold OAuth wait before the group message request',async mode=>{
 const current=s!,controller=new AbortController();let oauth=0,physical=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-physical-secret',robotCode:'robot-1',fetch:async(input)=>{
  if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){
   oauth++;
   if(mode==='cancel')await current.w.reminders.mutate(current.w.principal,current.w.f.conversationId,q.scheduleId,'CANCEL',{expectedRevision:1},randomUUID());
   if(mode==='contract')await current.w.service.transition(current.w.principal,current.w.document.id,{delegationId:current.w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());
   if(mode==='authorization')await d.root.query('SELECT public.oa_group_reminder_authorization_revoke($1,$2,$3)',[current.w.grant.document.id,current.w.grant.hash,'SYNTHETIC_OAUTH_WAIT_REVOKE']);
   if(mode==='roster')await current.w.f.configure({reply:groupMembersReply(current.w.f.conversationId,[current.w.f.ownerOpen,current.w.f.otherOpen,'synthetic-external']),info:groupInfoReply(3)});
   if(mode==='source')await d.root.query('UPDATE group_cases SET version=version+1 WHERE tenant_id=$1 AND id=$2',[current.w.principal.tenantId,current.ids[0]]);
   if(mode==='owner-stop')await d.root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'USER',$4,'WRITES',true,'synthetic-cold-oauth-owner-stop')",[current.w.principal.tenantId,randomUUID(),current.w.principal.actorId,current.w.f.ctx.actorId]);
   if(mode==='abort')controller.abort();
   if(mode==='expire')await d.root.query("UPDATE group_reminder_occurrences SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[q.occurrenceId]);
   return json({accessToken:'synthetic-oauth-token',expireIn:7200});
  }
  physical++;throw Error('UNEXPECTED_PLATFORM_MESSAGE');
 }});
 const gateway=new DeliveryGateway(d.db,vault,sender,current.w.f.binding,Date.now,undefined,current.verifier);
 expect(await gateway.process(current.w.f.ctx,deliveryId,controller.signal)).toBe('SUPPRESSED');expect(oauth).toBe(1);expect(physical).toBe(0);expect((await d.root.query('SELECT state,last_error FROM deliveries WHERE id=$1',[deliveryId])).rows[0]).toMatchObject({state:'SUPPRESSED',last_error:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(await gateway.process(current.w.f.ctx,deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(current.w.f.requests).toEqual([]);
},120_000);
it.each(['APPLIED_UNVERIFIED','UNKNOWN'] as const)('real sender rechecks after OAuth, retains %s receipt, and never repeats the platform request',async outcome=>{
 const current=s!,body=(await d.root.query('SELECT result FROM runs WHERE id=$1',[runId])).rows[0].result as string;let oauth=0,physical=0;const before=(await current.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-physical-secret',robotCode:'robot-1',fetch:async(input,init)=>{
  if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){oauth++;return json({accessToken:'synthetic-oauth-token',expireIn:7200});}
  physical++;expect(String(input)).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');expect(init?.redirect).toBe('error');expect(JSON.parse(init!.body as string)).toEqual({robotCode:'robot-1',msgKey:'sampleText',msgParam:JSON.stringify({content:body}),openConversationId:s!.w.f.conversationId});if(outcome==='UNKNOWN')throw Error('SYNTHETIC_RESPONSE_LOST');return json({processQueryKey:'synthetic-physical-receipt'});
 }});
 const gateway=new DeliveryGateway(d.db,vault,sender,current.w.f.binding,Date.now,undefined,current.verifier);expect(await gateway.process(current.w.f.ctx,deliveryId,new AbortController().signal)).toBe(outcome);expect((await current.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length-before).toBe(6);expect(oauth).toBe(1);expect(physical).toBe(1);expect(await gateway.process(current.w.f.ctx,deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(physical).toBe(1);expect((await d.root.query('SELECT state,verification_state FROM deliveries WHERE id=$1',[deliveryId])).rows[0]).toEqual({state:outcome,verification_state:'UNVERIFIED'});
},120_000);
