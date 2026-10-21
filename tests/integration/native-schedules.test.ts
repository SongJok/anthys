import {Schedules} from '../../packages/schedules/src/service.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {secret} from '../../packages/config/src/index.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,30),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await root.end();});
async function world(){const ctx={tenantId:randomUUID(),actorId:randomUUID()},otherId=randomUUID(),corpId='synthetic-native-schedule-'+ctx.tenantId,external='synthetic-owner-'+ctx.actorId,binding={tenantId:ctx.tenantId,corpId,robotCode:'synthetic-reminder-robot'},store=new RuntimeStore(db,vault),gateway=new Gateway(store);
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic native reminders','ACTIVE','America/Los_Angeles')",[ctx.tenantId,corpId]);for(const id of [ctx.actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic native reminders','ACTIVE')",[ctx.tenantId,id,'synthetic-owner-'+id]);
 const ingress=new DingTalkIngress(db,vault,binding,store),due=new Date(Date.now()+86400000).toISOString().slice(0,16).replace('T',' '),text='提醒我 '+due+' [UTC] 核对交付清单';
 const message=(goal=text,changes:Record<string,unknown>={}):DWClientDownStream=>{const id=randomUUID();return {specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:external,senderId:external,chatbotUserId:'synthetic-bot',conversationId:'native-reminder-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:goal},createAt:Date.now(),sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-reminder-webhook',sessionWebhookExpiredTime:Date.now()+600000,...changes})};};
 let sends=0;const delivery=new DeliveryGateway(db,vault,{sendReply:async(_reply,text)=>{expect(text).toMatch(/私人提醒|尚未登记提醒/);sends++;return {state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-setting-receipt'};},sendProactive:async()=>{throw Error('UNEXPECTED_PROACTIVE_CONFIGURATION_RECEIPT');}},{...binding,appOrigin:'http://localhost:52330'},Date.now,(...args)=>gateway.finalSourcesAllowed(...args));
 return {ctx,otherId,binding,ingress,message,due,text,gateway,delivery,sends:()=>sends};
}
it('T047/T060 native SDK callback registration durably persists one explicit reminder and deterministic receipt under twenty duplicates without model work',async()=>{
 const w=await world(),message=w.message(),results=await Promise.all(Array.from({length:20},()=>w.ingress.acceptTrustedCallback(message)));expect(new Set(results.map(r=>r!.taskId)).size).toBe(1);expect(results.filter(r=>!r!.duplicate)).toHaveLength(1);
 const plan=(await root.query('SELECT * FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows;expect(plan).toHaveLength(1);expect(plan[0].state).toBe('ACTIVE');const receipt=(await root.query('SELECT * FROM schedule_control_responses WHERE owner_id=$1',[w.ctx.actorId])).rows;expect(receipt).toHaveLength(1);expect(receipt[0]).toMatchObject({outcome:'CREATED',schedule_id:plan[0].id,revision:'1'});
 const run=(await root.query('SELECT * FROM runs WHERE id=$1',[receipt[0].run_id])).rows[0];expect(run.model_turns).toBe(0);expect(run.result).toContain('私人提醒已持久登记');expect(run.result).toContain('时区：UTC');expect(run.result).toContain(w.due.replace(' ','T')+':00.000Z');expect(run.result).toContain(plan[0].id);expect(run.result).toContain('登记不表示消息已投递');expect(await w.gateway.finalResultAllowed(w.ctx,run.id,run.result)).toBe(true);
 expect((await root.query("SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND kind='RUN'",[w.ctx.tenantId])).rows[0].n).toBe(0);expect((await root.query('SELECT count(*)::int n FROM provider_journals WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
 const delivery=(await root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[run.id])).rows[0].id;expect(await w.delivery.process(w.ctx,delivery,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await w.delivery.process(w.ctx,delivery,new AbortController().signal)).toBe('NOT_CLAIMED');expect(w.sends()).toBe(1);
});
it('native pause/cancel reuses current owner authority and revision; changed plan suppresses old registration bytes rather than replaying a promise',async()=>{
 const w=await world();await w.ingress.acceptTrustedCallback(w.message());const plan=(await root.query('SELECT * FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0],old=(await root.query('SELECT r.id,r.result,d.id delivery_id FROM runs r JOIN deliveries d ON d.source_run_id=r.id WHERE r.owner_id=$1',[w.ctx.actorId])).rows[0];
 await w.ingress.acceptTrustedCallback(w.message('暂停提醒 '+plan.id));expect((await root.query('SELECT state,revision FROM schedules WHERE id=$1',[plan.id])).rows[0]).toEqual({state:'PAUSED',revision:'2'});expect(await w.gateway.finalResultAllowed(w.ctx,old.id,old.result)).toBe(false);expect(await w.delivery.process(w.ctx,old.delivery_id,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
 await w.ingress.acceptTrustedCallback(w.message('取消提醒 '+plan.id));expect((await root.query('SELECT state,revision FROM schedules WHERE id=$1',[plan.id])).rows[0]).toEqual({state:'CANCELLED',revision:'3'});const cancel=(await root.query("SELECT r.id,r.result FROM runs r JOIN schedule_control_responses p ON p.run_id=r.id WHERE r.owner_id=$1 AND p.outcome='CANCELLED'",[w.ctx.actorId])).rows[0];expect(await w.gateway.finalResultAllowed(w.ctx,cancel.id,cancel.result)).toBe(true);
});
it('ambiguous or delayed requests ask a precise clarification, never store a guessed time or spend model tokens',async()=>{
 for(const delayed of [false,true]){const w=await world();await w.ingress.acceptTrustedCallback(w.message(delayed?w.text:'提醒我找个时间核对清单',delayed?{createAt:Date.now()-3600000}:{}));expect((await root.query('SELECT count(*)::int n FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0].n).toBe(0);const receipt=(await root.query('SELECT outcome FROM schedule_control_responses WHERE owner_id=$1',[w.ctx.actorId])).rows[0];expect(receipt.outcome).toBe('CLARIFY');}
});
it('forged corporate source, another owner cancellation, group creation and departed identities cannot acquire personal reminder authority',async()=>{
 const w=await world();await w.ingress.acceptTrustedCallback(w.message());const plan=(await root.query('SELECT * FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0];await expect(w.ingress.acceptTrustedCallback(w.message(w.text,{senderCorpId:'foreign-corp'}))).rejects.toThrow('IDENTITY_MISMATCH');
 await w.ingress.acceptTrustedCallback(w.message('取消提醒 '+plan.id,{senderStaffId:'synthetic-owner-'+w.otherId,senderId:'synthetic-owner-'+w.otherId,conversationId:'native-reminder-dm-'+w.otherId}));expect((await root.query('SELECT state FROM schedules WHERE id=$1',[plan.id])).rows[0].state).toBe('ACTIVE');expect((await root.query('SELECT outcome FROM schedule_control_responses WHERE owner_id=$1',[w.otherId])).rows[0].outcome).toBe('DENIED');
 await w.ingress.acceptTrustedCallback(w.message(w.text,{conversationType:'2',conversationId:'synthetic-unreviewed-reminder-group'}));expect((await root.query('SELECT count(*)::int n FROM schedules WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(1);
 await root.query("UPDATE users SET status='DEPARTED' WHERE id=$1",[w.ctx.actorId]);await expect(w.ingress.acceptTrustedCallback(w.message())).rejects.toThrow('UNMAPPED_IDENTITY');
});
it('T051 weekday creation discloses the adopted calendar and repeated explicit stop commands never revive or increment an already stopped plan',async()=>{
 const w=await world();await w.ingress.acceptTrustedCallback(w.message('每个工作日09:00提醒我核对交付清单'));const plan=(await root.query('SELECT id FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0];const created=(await root.query("SELECT r.result FROM runs r JOIN schedule_control_responses p ON p.run_id=r.id WHERE r.owner_id=$1 AND p.outcome='CREATED'",[w.ctx.actorId])).rows[0].result;expect(created).toContain('工作日仅按周一至周五，未使用企业法定调休日历');expect(created).not.toContain('尚未保存');
 for(const command of ['暂停提醒 ','暂停提醒 ','取消提醒 ','取消提醒 '])await w.ingress.acceptTrustedCallback(w.message(command+plan.id));expect((await root.query('SELECT revision,state FROM schedules WHERE id=$1',[plan.id])).rows[0]).toEqual({revision:'3',state:'CANCELLED'});
 const cancel=(await root.query("SELECT r.id,r.result FROM runs r JOIN schedule_control_responses p ON p.run_id=r.id WHERE r.owner_id=$1 AND p.outcome='CANCELLED' ORDER BY p.created_at DESC LIMIT 1",[w.ctx.actorId])).rows[0];expect(await w.gateway.finalResultAllowed(w.ctx,cancel.id,cancel.result)).toBe(true);
});
it('clarification and denial remain verifiable safe receipts, while a substituted task result is rejected',async()=>{
 const w=await world();await w.ingress.acceptTrustedCallback(w.message('提醒我找个时间核对清单'));await w.ingress.acceptTrustedCallback(w.message('取消提醒 '+randomUUID()));const rows=(await root.query('SELECT r.id,r.result,p.outcome FROM runs r JOIN schedule_control_responses p ON p.run_id=r.id WHERE r.owner_id=$1',[w.ctx.actorId])).rows;expect(new Set(rows.map(r=>r.outcome))).toEqual(new Set(['CLARIFY','DENIED']));for(const row of rows)expect(await w.gateway.finalResultAllowed(w.ctx,row.id,row.result)).toBe(true);
 const altered='未经验证的替换回执';await root.query('UPDATE runs SET result=$2 WHERE id=$1',[rows[0].id,altered]);expect(await w.gateway.finalResultAllowed(w.ctx,rows[0].id,altered)).toBe(false);expect(w.sends()).toBe(0);
});
it('the native service independently rejects a missing, mismatched or non-command inbox source instead of accepting a forged principal',async()=>{
 const w=await world(),service=new Schedules(db,vault);await expect(db.scope(w.ctx,c=>service.applyInbox(c,w.ctx,randomUUID(),w.binding))).rejects.toMatchObject({code:'SCHEDULE_INBOX_INVALID'});
 for(const change of [{conversationType:'2'},{senderStaffId:'other'},{senderCorpId:'other'},{chatbotCorpId:'other'},{robotCode:'other'},{text:{content:'普通解释性问题'}}]){
  const id=randomUUID(),event={...JSON.parse(w.message().data),...change};await db.scope(w.ctx,c=>c.query("INSERT INTO event_inbox(tenant_id,id,owner_id,source,event_key,payload_cipher_ref,state) VALUES($1,$2,$3,'DINGTALK',$2::uuid::text,$4,'RECEIVED')",[w.ctx.tenantId,id,w.ctx.actorId,JSON.stringify(vault.seal(JSON.stringify(event),`${w.ctx.tenantId}:${w.ctx.actorId}:inbox:${id}`))]));await expect(db.scope(w.ctx,c=>service.applyInbox(c,w.ctx,id,w.binding))).rejects.toMatchObject({code:'SCHEDULE_INBOX_INVALID'});
 }
 expect((await root.query('SELECT count(*)::int n FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0].n).toBe(0);
});
