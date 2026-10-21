import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {runReviewedGroupReminderCycle} from '../../packages/groups/src/reminder-cycle.js';
import {groupReminderRuntimeProfile} from '../../packages/config/src/group-reminder-runtime.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
import {signedReminderRuntime} from '../support/group-reminder-signed-runtime.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>,rpc:Awaited<ReturnType<typeof signedReminderRuntime>>,q:Awaited<ReturnType<Awaited<ReturnType<typeof reminderExecution>>['queue']>>,other:typeof q,p:ReturnType<typeof groupReminderRuntimeProfile.parse>,sender:DingTalkSender,oauth=0,physical=0;
beforeAll(async()=>{
 d=await groupReminderDatabase();await d.install();s=await reminderExecution(d,vault,2);q=await s.queue();other=await s.queue();rpc=await signedReminderRuntime(d,s,vault,q);
 p=groupReminderRuntimeProfile.parse({schemaVersion:1,approved:true,purpose:'GROUP_REMINDER_RUN_ONCE',reviewReference:'SYNTHETIC_RUN_ONCE_REVIEW',sourceReviewHash:'a'.repeat(64),validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+90000).toISOString(),maxNotifications:1,targets:[{...s.w.f.ctx,groupId:s.w.f.conversationId,scheduleId:q.scheduleId,authorizationId:s.w.grant.document.id,authorizationHash:s.w.grant.hash}],modelCalls:0,allowMentionAll:false,allowDirectMessages:false,allowEscalation:false});
 sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-cycle-secret',robotCode:'robot-1',fetch:async(input,init)=>{if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){oauth++;return new Response(JSON.stringify({accessToken:'synthetic-cycle-token',expireIn:7200}));}physical++;expect(String(input)).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');expect(JSON.parse(init!.body as string).openConversationId).toBe(s.w.f.conversationId);return new Response(JSON.stringify({processQueryKey:'synthetic-cycle-message'}));}});
});
afterAll(async()=>{await rpc?.close();await s?.close();await d?.close();});
const deps=()=>({db:d.db,vault,identities:rpc.identities,sender,binding:s.w.f.binding});
const state=async(id:string)=>(await d.root.query('SELECT state,delivery_id FROM group_reminder_occurrences WHERE id=$1',[id])).rows[0];
describe('finite separately reviewed group runtime entry',{concurrent:false},()=>{
 it('rejects unsigned transport, expired profile and prior cancellation before queue mutation',async()=>{
  await expect(runReviewedGroupReminderCycle({...deps(),identities:s.w.f.dws},p,new AbortController().signal)).rejects.toThrow('SIGNED_SERVICE_REQUIRED');await expect(runReviewedGroupReminderCycle(deps(),{...p,validFrom:new Date(Date.now()-2000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()},new AbortController().signal)).rejects.toThrow('EXPIRED');await expect(runReviewedGroupReminderCycle(deps(),p,AbortSignal.abort())).rejects.toThrow();const wall=Date.now(),skew=vi.spyOn(Date,'now').mockReturnValue(wall-1500);try{await expect(runReviewedGroupReminderCycle(deps(),{...p,validFrom:new Date(wall-2000).toISOString(),expiresAt:new Date(wall-1000).toISOString()},new AbortController().signal)).rejects.toThrow('TARGET_CHANGED');}finally{skew.mockRestore();}expect(await state(q.occurrenceId)).toEqual({state:'QUEUED',delivery_id:null});expect(physical).toBe(0);expect(oauth).toBe(0);
 });
 it('preflights all exact authorization pins before touching even the first valid target',async()=>{
  await expect(runReviewedGroupReminderCycle(deps(),{...p,targets:[p.targets[0],{...p.targets[0],scheduleId:randomUUID()}]},new AbortController().signal)).rejects.toThrow('TARGET_CHANGED');await expect(runReviewedGroupReminderCycle(deps(),{...p,targets:[{...p.targets[0],authorizationHash:'0'.repeat(64)}]},new AbortController().signal)).rejects.toThrow('TARGET_CHANGED');expect(await state(q.occurrenceId)).toEqual({state:'QUEUED',delivery_id:null});expect(await state(other.occurrenceId)).toEqual({state:'QUEUED',delivery_id:null});expect(physical).toBe(0);
 });
 it('stages and sends only its reviewed schedule through actual signed observer, PG and real sender',async()=>{
  expect(await runReviewedGroupReminderCycle(deps(),p,new AbortController().signal)).toEqual({mode:'FINITE_REVIEWED_GROUP_REMINDER_CYCLE',processed:1,attempted:1,outcomes:{APPLIED_UNVERIFIED:1},modelCalls:0,automaticRepeat:false});expect(oauth).toBe(1);expect(physical).toBe(1);expect((await state(q.occurrenceId)).state).toBe('STAGED');expect(await state(other.occurrenceId)).toEqual({state:'QUEUED',delivery_id:null});expect(s.w.f.requests).toEqual([]);
 });
 it('repeating the finite profile sends nothing and leaves unreviewed schedules untouched',async()=>{
  expect(await runReviewedGroupReminderCycle(deps(),p,new AbortController().signal)).toEqual({mode:'FINITE_REVIEWED_GROUP_REMINDER_CYCLE',processed:0,attempted:0,outcomes:{},modelCalls:0,automaticRepeat:false});expect(oauth).toBe(1);expect(physical).toBe(1);expect(await state(other.occurrenceId)).toEqual({state:'QUEUED',delivery_id:null});expect(Number((await d.root.query('SELECT count(*) n FROM group_reminder_notifications WHERE tenant_id=$1',[s.w.f.ctx.tenantId])).rows[0].n)).toBe(1);
 });
});
