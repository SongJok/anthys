import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {finalizeSyntheticText} from '../support/final-answer.js';

const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
afterAll(async()=>{await db.close();await admin.end();});
async function fresh(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='SYNTHETIC-'+ctx.tenantId,robotCode='synthetic-receipt',id=randomUUID(),url='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-receipt';
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC','ACTIVE')",[ctx.tenantId,corpId]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'alice','ALICE','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:'alice',conversationId:'synthetic-dm',conversationType:'1',robotCode,msgtype:'text',text:{content:'SYNTHETIC_PRIVATE_GOAL'},createAt:Date.now(),senderId:'alice',chatbotUserId:'synthetic-bot',sessionWebhook:url,sessionWebhookExpiredTime:Date.now()+60000})};
 const store=new RuntimeStore(db,vault),ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,corpId,robotCode},store),task=(await ingress.acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string;
 const sent:string[]=[],gateway=new DeliveryGateway(db,vault,{sendReply:async(reply,text)=>{expect(reply.url).toBe(url);sent.push(text);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('UNEXPECTED_PROACTIVE');}},{corpId,robotCode,appOrigin:'http://localhost:64702'});
 return {ctx,event,ingress,taskId:task.taskId,runId,store,gateway,sent};
}

it('T001 received-task marker is durable and idempotent; a queued long task gets one original-DM receipt without model use or false completion',async()=>{
 const f=await fresh();await Promise.all(Array.from({length:20},()=>f.ingress.acceptTrustedCallback(f.event)));
 expect((await db.scope(f.ctx,c=>c.query("SELECT id FROM outbox WHERE kind='TASK_RECEIPT' AND aggregate_id=$1",[f.taskId]))).rowCount).toBe(1);
 const ids=await f.gateway.pending(f.ctx);expect(ids).toHaveLength(1);expect(await f.gateway.pending(f.ctx)).toEqual(ids);
 expect(await f.gateway.process(f.ctx,ids[0]!,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await f.gateway.process(f.ctx,ids[0]!,new AbortController().signal)).toBe('NOT_CLAIMED');expect(f.sent).toHaveLength(1);
 expect(f.sent[0]).toContain(`任务 ${f.taskId} 已接收`);expect(f.sent[0]).toContain('不代表任务已经完成');expect(f.sent[0]).not.toContain('SYNTHETIC_PRIVATE_GOAL');
 expect((await db.scope(f.ctx,c=>c.query('SELECT status FROM tasks WHERE id=$1',[f.taskId]))).rows[0].status).toBe('OPEN');expect((await db.scope(f.ctx,c=>c.query('SELECT status FROM runs WHERE id=$1',[f.runId]))).rows[0].status).toBe('QUEUED');expect((await db.scope(f.ctx,c=>c.query('SELECT id FROM quota_ledger WHERE run_id=$1',[f.runId]))).rowCount).toBe(0);
});

it.each(['unstaged','staged'] as const)('a final result ready before the %s receipt is sent suppresses the obsolete receipt',async mode=>{
 const f=await fresh(),early=mode==='staged'?(await f.gateway.pending(f.ctx))[0]:undefined,lease=(await f.store.acquire(f.ctx,f.runId,'synthetic-receipt'))!;
 await finalizeSyntheticText(f.store,f.ctx,lease,'SYNTHETIC_FINAL');
 const final=(await db.scope(f.ctx,c=>c.query('SELECT id FROM deliveries WHERE task_id=$1 AND finalization_id IS NOT NULL',[f.taskId]))).rows[0].id as string;
 if(early)expect(await f.gateway.process(f.ctx,early,new AbortController().signal)).toBe('SUPPRESSED');
 expect(await f.gateway.pending(f.ctx)).toEqual([final]);expect(f.sent).toEqual([]);
 expect((await db.scope(f.ctx,c=>c.query("SELECT id FROM outbox WHERE kind='TASK_RECEIPT' AND published_at IS NULL"))).rowCount).toBe(0);
});

it.each(['identity','content','missing-proof'] as const)('an initial receipt with %s changes is refused with zero physical sends',async mode=>{
 const f=await fresh(),id=(await f.gateway.pending(f.ctx))[0]!;
 if(mode==='identity')await admin.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND id=$2',[f.ctx.tenantId,f.ctx.actorId]);
 if(mode==='content')await db.scope(f.ctx,c=>c.query('UPDATE deliveries SET content_ref=$2 WHERE id=$1',[id,JSON.stringify(vault.seal('SYNTHETIC_UNAUTHORIZED_BODY',`${f.ctx.tenantId}:${f.ctx.actorId}:delivery:${id}`))]));
 if(mode==='missing-proof')await db.scope(f.ctx,c=>c.query("DELETE FROM run_steps WHERE run_id=$1 AND kind='message.received'",[f.runId]));
 expect(await f.gateway.process(f.ctx,id,new AbortController().signal)).toBe('SUPPRESSED');expect(f.sent).toEqual([]);
});
