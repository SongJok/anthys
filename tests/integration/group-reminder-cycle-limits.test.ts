import '../support/isolation.js';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {GroupReminderAudience} from '../../packages/groups/src/reminder-audience.js';
import {GroupReminderScheduler} from '../../packages/groups/src/reminder-runner.js';
import {runReviewedGroupReminderCycle} from '../../packages/groups/src/reminder-cycle.js';
import {groupReminderRuntimeProfile} from '../../packages/config/src/group-reminder-runtime.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
import {signedReminderRuntime} from '../support/group-reminder-signed-runtime.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>|undefined,rpc:Awaited<ReturnType<typeof signedReminderRuntime>>|undefined,scheduler:GroupReminderScheduler|undefined,p:ReturnType<typeof groupReminderRuntimeProfile.parse>,ids:string[],oauth:number,physical:number;
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();});
beforeEach(async()=>{
 s=await reminderExecution(d,vault,30);const first=await s.queue(),second=await s.queue();rpc=await signedReminderRuntime(d,s,vault,first,[second]);scheduler=new GroupReminderScheduler(d.db,vault,new GroupReminderAudience(rpc.identities,'robot-1'),'robot-1',[first.scheduleId,second.scheduleId]);for(const q of [first,second])expect(await scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('STAGED');ids=(await d.root.query('SELECT delivery_id FROM group_reminder_occurrences WHERE id=ANY($1::uuid[]) ORDER BY scheduled_at',[ [first.occurrenceId,second.occurrenceId] ])).rows.map(r=>r.delivery_id as string);expect(ids).toHaveLength(2);
 // Volume CARD fixtures are explicit; no claim of30 real UI submissions. Both
 // immutable notices share the same current source hash but disjoint cases.
 const overlap=(await d.root.query('SELECT count(*) n FROM group_reminder_notification_cases a JOIN group_reminder_notification_cases b ON b.tenant_id=a.tenant_id AND b.case_id=a.case_id AND b.notification_id<>a.notification_id WHERE a.tenant_id=$1',[s.w.f.ctx.tenantId])).rows[0].n;expect(Number(overlap)).toBe(0);
 p=groupReminderRuntimeProfile.parse({schemaVersion:1,approved:true,purpose:'GROUP_REMINDER_RUN_ONCE',reviewReference:'SYNTHETIC_DURABLE_LIMIT_REVIEW',sourceReviewHash:'a'.repeat(64),validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+90000).toISOString(),maxNotifications:1,targets:[first,second].map(q=>({...s!.w.f.ctx,groupId:s!.w.f.conversationId,scheduleId:q.scheduleId,authorizationId:s!.w.grant.document.id,authorizationHash:s!.w.grant.hash})),modelCalls:0,allowMentionAll:false,allowDirectMessages:false,allowEscalation:false});oauth=0;physical=0;
});
afterEach(async()=>{await scheduler?.audience.close();scheduler=undefined;await rpc?.close();rpc=undefined;await s?.close();s=undefined;});afterAll(async()=>{await d?.close();});
const deps=(sender:DingTalkSender)=>({db:d.db,vault,identities:rpc!.identities,sender,binding:s!.w.f.binding});
const token=()=>new Response(JSON.stringify({accessToken:'synthetic-limit-token',expireIn:7200}));
it.each(['UNKNOWN','FAILED'] as const)('a new cycle and sender cannot refund an earlier %s to send another pending notice',async outcome=>{
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-limit-secret',robotCode:'robot-1',fetch:async input=>{if(String(input).includes('/oauth2/')){oauth++;if(outcome==='FAILED')throw Error('SYNTHETIC_TOKEN_FAILURE');return token();}physical++;throw Error('SYNTHETIC_RESPONSE_LOST');}});
 const first=await runReviewedGroupReminderCycle(deps(sender),p,new AbortController().signal);expect(first).toMatchObject({attempted:1,processed:1,outcomes:{[outcome]:1}});expect(oauth).toBe(1);expect(physical).toBe(outcome==='UNKNOWN'?1:0);
 const fresh=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-limit-secret',robotCode:'robot-1',fetch:async()=>{throw Error('UNEXPECTED_RESTART_PROVIDER');}});
 const second=await runReviewedGroupReminderCycle(deps(fresh),p,new AbortController().signal);expect(second).toMatchObject({attempted:0,processed:1,outcomes:{SUPPRESSED:1}});expect((await d.root.query('SELECT state,last_error FROM deliveries WHERE id=$1',[ids[1]])).rows[0]).toEqual({state:'SUPPRESSED',last_error:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(oauth).toBe(1);expect(physical).toBe(outcome==='UNKNOWN'?1:0);expect(s!.w.f.requests).toEqual([]);
});
it('two live cycles cannot exceed one durable attempt while the first token is delayed',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;});const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-limit-secret',robotCode:'robot-1',fetch:async input=>{if(String(input).includes('/oauth2/')){oauth++;entered();await resume;return token();}physical++;throw Error('UNEXPECTED_GROUP_MESSAGE');}}),a=new AbortController();
 const first=runReviewedGroupReminderCycle(deps(sender),p,a.signal);try{await started;const second=await runReviewedGroupReminderCycle(deps(sender),p,new AbortController().signal);expect(second).toMatchObject({attempted:0,processed:1,outcomes:{SUPPRESSED:1}});}finally{release();}
 expect(await first).toMatchObject({attempted:1,processed:1,outcomes:{SUPPRESSED:1}});expect(oauth).toBe(1);expect(physical).toBe(0);expect((await d.root.query('SELECT state FROM deliveries WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.state)).toEqual(['SUPPRESSED','SUPPRESSED']);
});
