import {finalizeSyntheticText,syntheticTextGateway} from '../support/final-answer.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {loadEnvFile,secret,config} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {DeliveryGateway as ProductionDeliveryGateway,type DeliverySender} from '../../packages/gateway/src/delivery.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {ids,seed} from '../../scripts/seed.js';
loadEnvFile();const db=new Database(secret('RUNTIME_DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
const ctx={tenantId:ids.tenantA,actorId:ids.bob},store=new RuntimeStore(db,vault),binding={corpId:'TENANT_A',robotCode:'synthetic-robot',appOrigin:'http://localhost:64700'};

class DeliveryGateway extends ProductionDeliveryGateway {constructor(...args:ConstructorParameters<typeof ProductionDeliveryGateway>){super(args[0],args[1],args[2],args[3],args[4]??Date.now,(...params)=>syntheticTextGateway(store,'synthetic private result',params[1].audience['kind']==='GROUP'?'MCP':'CORE').finalSourcesAllowed(...params));}}
const ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding});
const event=(kind:'1'|'2'='1',webhook=true,replyUrl='https://oapi.dingtalk.com/robot/send?access_token=synthetic',replyExpiresAt=Date.now()+60000):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:randomUUID(),time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:randomUUID(),chatbotCorpId:'TENANT_A',senderCorpId:'TENANT_A',senderStaffId:'bob',conversationId:kind==='1'?'synthetic-dm-bob':'synthetic-group-delivery',conversationType:kind,robotCode:'synthetic-robot',msgtype:'text',text:{content:'synthetic question'},createAt:Date.now(),senderId:'bob-id',chatbotUserId:'bot-id',...(webhook?{sessionWebhook:replyUrl,sessionWebhookExpiredTime:replyExpiresAt}:{})})});
async function finished(kind:'1'|'2'='1',webhook=true,replyUrl?:string,replyExpiresAt?:number){const received=await ingress.acceptTrustedCallback(event(kind,webhook,replyUrl,replyExpiresAt));const q=await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[received!.taskId]));if(kind==='2')await db.scope(ctx,c=>c.query("UPDATE tasks SET audience=jsonb_set(audience,'{membershipVersion}','1') WHERE id=$1",[received!.taskId]));const lease=(await store.acquire(ctx,q.rows[0].id as string,randomUUID()))!;await finalizeSyntheticText(store,ctx,lease,'synthetic private result');const d=await db.scope(ctx,c=>c.query('SELECT id FROM deliveries WHERE task_id=$1',[received!.taskId]));return {taskId:received!.taskId,id:d.rows[0].id as string,result:(await new TaskStore(db).get(ctx,received!.taskId))!.runs[0].result};}
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();await admin.end();});
it('T119 stages encrypted delivery atomically and sends a completed result only once',async()=>{
 const sessionUrl='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',job=await finished('1',true,sessionUrl);let effects=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic',robotCode:binding.robotCode,replyOnly:config({DINGTALK_REPLY_ONLY:'true'}).DINGTALK_REPLY_ONLY==='true',fetch:async(url,init)=>{effects++;expect(String(url)).toBe(sessionUrl);expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/json'}});expect(JSON.parse(init!.body as string)).toEqual({msgtype:'text',text:{content:`任务 ${job.taskId}\n\n${job.result}`}});return new Response('{"errcode":0}');}});
 const gateway=new DeliveryGateway(db,vault,sender,binding);
 const outputs=await Promise.all(Array.from({length:20},()=>gateway.process(ctx,job.id,new AbortController().signal)));expect(effects).toBe(1);expect(outputs.filter(s=>s==='APPLIED_UNVERIFIED')).toHaveLength(1);
 const q=await db.scope(ctx,c=>c.query('SELECT state,content_ref,verification_state FROM deliveries WHERE id=$1',[job.id]));expect(q.rows[0].state).toBe('APPLIED_UNVERIFIED');expect(q.rows[0].verification_state).toBe('UNVERIFIED');expect(q.rows[0].content_ref).not.toContain('synthetic private result');
 expect((await db.scope(ctx,c=>c.query('SELECT status FROM tasks WHERE id=$1',[job.taskId]))).rows[0].status).toBe('COMPLETED');
});
it('T032 source-free group stop replies contain safe coverage/status only, never private task details',async()=>{
 const stopped=async(webhook=true)=>{const e=event('2',webhook),raw=JSON.parse(e.data);raw.text.content='停止';e.data=JSON.stringify(raw);const receipt=(await ingress.acceptTrustedCallback(e))!;const d=(await db.scope(ctx,c=>c.query('SELECT id FROM deliveries WHERE task_id=$1',[receipt.taskId]))).rows[0];expect(d).toBeDefined();return d.id as string;};
 const job=await stopped();let sent='';const sender:DeliverySender={sendReply:async(_reply,text)=>{sent=text;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('unexpected proactive send');}};
 expect(await new DeliveryGateway(db,vault,sender,binding).process(ctx,job,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(sent).not.toContain('synthetic private result');expect(sent).toContain('仅为 @机器人消息');
 const expired=await stopped(false);sent='';expect(await new DeliveryGateway(db,vault,sender,binding).process(ctx,expired,new AbortController().signal)).toBe('SUPPRESSED');expect(sent).toBe('');
});
it('T032 manually granting GROUP access cannot finalize a private tool body or create an outbound delivery',async()=>{
 const received=(await ingress.acceptTrustedCallback(event('2')))!;const run=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[received.taskId]))).rows[0],lease=(await store.acquire(ctx,run.id as string,randomUUID()))!;
 try{await finalizeSyntheticText(store,ctx,lease,'synthetic private result');const task=(await new TaskStore(db).get(ctx,received.taskId))!;expect(task.runs[0].status).not.toBe('SUCCEEDED');expect(task.runs[0].result).toBeNull();expect(task.deliveries).toHaveLength(0);expect((await db.scope(ctx,c=>c.query('SELECT id FROM tool_actions WHERE run_id=$1',[run.id]))).rowCount).toBe(0);}finally{await store.release(ctx,lease);}
});
it('revoked identity, changed audience and wrong enterprise block all outbound requests',async()=>{
 let effects=0;const sender:DeliverySender={sendReply:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};}};
 for(const mode of ['identity','audience','enterprise']){
  const job=await finished();
  if(mode==='identity')await admin.query('UPDATE tasks SET auth_epoch=auth_epoch-1 WHERE id=$1',[job.taskId]);
  if(mode==='audience')await admin.query("UPDATE tasks SET audience=jsonb_set(audience,'{targetId}','\"wrong-recipient\"') WHERE id=$1",[job.taskId]);
  const g=new DeliveryGateway(db,vault,sender,{...binding,corpId:mode==='enterprise'?'OTHER_CORP':binding.corpId});expect(await g.process(ctx,job.id,new AbortController().signal)).toBe('SUPPRESSED');
 }expect(effects).toBe(0);
});
it('T117 response loss and abandoned SENDING writes become UNKNOWN without automatic retry',async()=>{
 const job=await finished();let effects=0;const sender:DeliverySender={sendReply:async()=>{effects++;throw Error('provider applied write but response was lost');},sendProactive:async()=>{throw Error('unexpected');}};const g=new DeliveryGateway(db,vault,sender,binding);
 expect(await g.process(ctx,job.id,new AbortController().signal)).toBe('UNKNOWN');expect(await g.process(ctx,job.id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(effects).toBe(1);
 const old=await finished();await admin.query("UPDATE deliveries SET state='SENDING',sending_at=now()-interval '2 minutes' WHERE id=$1",[old.id]);expect(await g.pending(ctx)).not.toContain(old.id);expect((await db.scope(ctx,c=>c.query('SELECT state FROM deliveries WHERE id=$1',[old.id]))).rows[0].state).toBe('UNKNOWN');
});
it('T009 expired private reply uses the explicit authorized robot proactive channel',async()=>{
 const job=await finished('1',false);let replies=0,proactive=0;
 const sender:DeliverySender={sendReply:async()=>{replies++;return {state:'FAILED'};},sendProactive:async(target)=>{proactive++;expect(target).toEqual({kind:'PRIVATE_USER',externalId:'bob'});return {state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-receipt'};}};
 expect(await new DeliveryGateway(db,vault,sender,binding).process(ctx,job.id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(replies).toBe(0);expect(proactive).toBe(1);
});
it.each(['MISSING','EXPIRED'] as const)('T009 reply-only %s session address fails with zero token or provider requests and no retry',async mode=>{
 const job=await finished('1',mode!=='MISSING','https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',Date.now()-1000);let requests=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic',robotCode:binding.robotCode,replyOnly:config({DINGTALK_REPLY_ONLY:'true'}).DINGTALK_REPLY_ONLY==='true',fetch:async()=>{requests++;throw Error('REPLY_ONLY_FALLBACK_MUST_NOT_FETCH');}});
 const gateway=new DeliveryGateway(db,vault,sender,binding);
 expect(await gateway.process(ctx,job.id,new AbortController().signal)).toBe('FAILED');
 expect(await gateway.process(ctx,job.id,new AbortController().signal)).toBe('NOT_CLAIMED');
 expect(await gateway.pending(ctx)).not.toContain(job.id);expect(requests).toBe(0);
 expect((await db.scope(ctx,c=>c.query('SELECT state,last_error,verification_state FROM deliveries WHERE id=$1',[job.id]))).rows[0]).toEqual({state:'FAILED',last_error:'PROACTIVE_REPLY_ONLY_MODE',verification_state:'UNVERIFIED'});
});
it('T117 reply-only lost reply response stays UNKNOWN across concurrent reprocessing with only one physical request',async()=>{
 const url='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',job=await finished('1',true,url);let requests=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic',robotCode:binding.robotCode,replyOnly:true,fetch:async(input)=>{requests++;expect(String(input)).toBe(url);throw TypeError('synthetic response lost after dispatch');}});
 const gateway=new DeliveryGateway(db,vault,sender,binding),outcomes=await Promise.all(Array.from({length:20},()=>gateway.process(ctx,job.id,new AbortController().signal)));
 expect(outcomes.filter(s=>s==='UNKNOWN')).toHaveLength(1);expect(requests).toBe(1);
 expect(await gateway.pending(ctx)).not.toContain(job.id);expect(await gateway.process(ctx,job.id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(requests).toBe(1);
 expect((await db.scope(ctx,c=>c.query('SELECT state,verification_state FROM deliveries WHERE id=$1',[job.id]))).rows[0]).toEqual({state:'UNKNOWN',verification_state:'UNVERIFIED'});
});
it('T119/T120 completed computation can still cancel PENDING delivery with zero provider effects',async()=>{
 const job=await finished();expect((await db.scope(ctx,c=>c.query('SELECT state FROM deliveries WHERE id=$1',[job.id]))).rows[0].state).toBe('PENDING');
 expect(await new TaskStore(db).cancel(ctx,job.taskId)).toMatchObject({status:'COMPLETED',deliveryCancellationRequested:true});
 let effects=0;const sender:DeliverySender={sendReply:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};}};expect(await new DeliveryGateway(db,vault,sender,binding).process(ctx,job.id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(effects).toBe(0);
 const task=await new TaskStore(db).get(ctx,job.taskId);expect(task!.cancel_requested_at).not.toBeNull();expect(task!.runs[0].status).toBe('SUCCEEDED');expect(task!.deliveries[0].state).toBe('SUPPRESSED');
});
it('a persisted task write stop suppresses an already staged delivery with zero physical sends',async()=>{
 const job=await finished();await admin.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'TASK',$4,'WRITES',true,'synthetic')",[ctx.tenantId,randomUUID(),ctx.actorId,job.taskId]);let effects=0;const sender:DeliverySender={sendReply:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{effects++;return {state:'APPLIED_UNVERIFIED'};}};expect(await new DeliveryGateway(db,vault,sender,binding).process(ctx,job.id,AbortSignal.timeout(10000))).toBe('SUPPRESSED');expect(effects).toBe(0);expect((await db.scope(ctx,c=>c.query('SELECT state FROM deliveries WHERE id=$1',[job.id]))).rows[0].state).toBe('SUPPRESSED');
});
