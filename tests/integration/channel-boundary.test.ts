import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,type Sealed} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {REVIEW_PROMPT} from '../../packages/runtime/src/narrative-review.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
import {registerDwsCapabilities} from '../../packages/dws/src/capabilities.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {dwsFixture} from '../support/dws-cli.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
import '../support/isolation.js';
const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,6),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault);
afterAll(async()=>{await db.close();await appDb.close();await admin.end();});
const statusName=toolName('dws.connection.status','1.0.0');
const general={schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]};
const sse=(content:string,finish:'stop'|'tool_calls'='stop')=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
it('T028 component: an ordinary question is still answered normally while the personal DWS connection is missing, and a DWS operation pauses at WAITING_AUTH',async()=>{
 const fixture=await dwsFixture();
 try{
  const tenantId=randomUUID(),actorId=randomUUID(),corpId='synthetic-channel-corp-'+tenantId,external='channel-user-'+actorId;
  await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic channel','ACTIVE')",[tenantId,corpId]);
  await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic channel user','ACTIVE')",[tenantId,actorId,external]);
  const ctx={tenantId,actorId},binding={corpId,robotCode:'synthetic-channel-robot',appOrigin:'http://localhost:64700'};
  const resultDeliveries=async(taskId:string)=>(await db.scope(ctx,c=>c.query('SELECT id,content_ref FROM deliveries WHERE task_id=$1 AND finalization_id IS NOT NULL ORDER BY created_at,id',[taskId]))).rows;
  const service=new DwsIdentities(db,vault,fixture.runner),gateway=new Gateway(store);
  registerDwsCapabilities(gateway,service);
  const ingress=new DingTalkIngress(db,vault,{tenantId,...binding});
  const ask=async(goal:string)=>{const msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:external,conversationId:'synthetic-channel-dm-'+actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:goal},createAt:Date.now(),senderId:external,chatbotUserId:'bot'})};
   const task=(await ingress.acceptTrustedCallback(event))!;
   const runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string;
   return {taskId:task.taskId,runId};};
  // The user never authorized DWS, so no personal connection exists at all.
  expect((await admin.query('SELECT id FROM dws_identities WHERE owner_id=$1',[actorId])).rowCount).toBe(0);
  const ordinary=await ask('解释幂等性的含义'),answer='幂等表示同一操作重复执行后，业务结果与执行一次相同。';
  let requests=0;
  const model=new GlmProvider({apiKey:'synthetic-channel-model',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{requests++;const body=JSON.parse(init!.body as string) as {messages:ProviderMessage[]};
   return sse(body.messages[0]?.content===REVIEW_PROMPT?JSON.stringify(general):JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text:answer,claims:[],outcome:'COMPLETE'}));}});
  await new AgentRuntime(store,model,gateway).advance(ctx,ordinary.runId);
  expect(requests).toBe(2);
  expect((await new TaskStore(appDb).get(ctx,ordinary.taskId))!.runs[0]).toMatchObject({status:'SUCCEEDED',result:answer});
  expect((await db.scope(ctx,c=>c.query('SELECT id FROM tool_actions WHERE run_id=$1',[ordinary.runId]))).rowCount).toBe(0);
  const delivered=await resultDeliveries(ordinary.taskId);
  expect(delivered).toHaveLength(1);
  expect(vault.open(JSON.parse(delivered[0].content_ref as string) as Sealed,`${tenantId}:${actorId}:delivery:${delivered[0].id}`)).toBe(answer);
  expect(await fixture.events()).toHaveLength(0);
  // The same user asking for an office action is paused, not answered and not retried.
  const office=await ask('读取我自己的办公身份资料');
  let officeModels=0;
  const officeModel=new GlmProvider({apiKey:'synthetic-channel-model',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async()=>{officeModels++;return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'dws-status',type:'function',function:{name:statusName,arguments:JSON.stringify({requestNonce:randomUUID()})}}]},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
  await new AgentRuntime(store,officeModel,gateway).advance(ctx,office.runId);
  expect(officeModels).toBe(1);
  expect((await new TaskStore(appDb).get(ctx,office.taskId))!.runs[0]).toMatchObject({status:'WAITING_AUTH',last_error:'DWS_USER_CONSENT_REQUIRED',result:null});
  expect(await resultDeliveries(office.taskId)).toHaveLength(0);
  expect(await fixture.events()).toHaveLength(0);
  expect((await admin.query('SELECT id FROM dws_identities WHERE owner_id=$1',[actorId])).rowCount).toBe(0);
 }finally{await fixture.close();}
});
it('T002 component: the standard channel processes only the legal events it received and never reads or claims an undelivered message',async()=>{
 const f=await groupRuntimeFixture(admin,db,vault);
 try{
  const undelivered='UNDELIVERED_GROUP_MESSAGE_MARKER';
  const tasks=async()=>Number((await admin.query('SELECT count(*)::int count FROM tasks WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].count);
  const runs=async()=>Number((await admin.query('SELECT count(*)::int count FROM runs WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].count);
  // One delivered legal event produced exactly one inbox event, one task and one run.
  expect((await admin.query('SELECT id FROM event_inbox WHERE tenant_id=$1',[f.ctx.tenantId])).rows).toHaveLength(1);
  expect(await tasks()).toBe(1);
  expect(await runs()).toBe(1);
  expect((await admin.query('SELECT source_mode FROM conversations WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].source_mode).toBe('MENTION_ONLY');
  const callback=(data:Record<string,unknown>,topic=TOPIC_ROBOT):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:randomUUID(),time:String(Date.now()),topic},data:JSON.stringify(data)});
  const base=(over:Record<string,unknown>={})=>({msgId:randomUUID(),chatbotCorpId:f.corpId,senderCorpId:f.corpId,senderStaffId:f.ownerExternal,senderId:f.ownerExternal,chatbotUserId:'bot-user',conversationId:f.conversationId,conversationType:'2',robotCode:f.binding.robotCode,msgtype:'text',text:{content:undelivered},createAt:Date.now(),...over});
  // A callback that is not a robot callback at all is not a legal event.
  await expect(f.ingress.acceptTrustedCallback(callback(base(),'synthetic-other-topic'))).rejects.toThrow('UNSUPPORTED_CALLBACK');
  // A callback from another robot in the same corp is not this bot's event.
  await expect(f.ingress.acceptTrustedCallback(callback(base({robotCode:'another-robot'})))).rejects.toThrow('IDENTITY_MISMATCH');
  // The bot's own message is not a user event.
  expect(await f.ingress.acceptTrustedCallback(callback(base({senderId:'bot-user'})))).toBeNull();
  // A sender outside the tenant directory is not a legal event either.
  await expect(f.ingress.acceptTrustedCallback(callback(base({senderStaffId:'unmapped-'+randomUUID(),senderId:'unmapped'})))).rejects.toThrow('UNMAPPED_IDENTITY');
  expect((await admin.query('SELECT id FROM event_inbox WHERE tenant_id=$1',[f.ctx.tenantId])).rows).toHaveLength(1);
  expect(await tasks()).toBe(1);
  expect(await runs()).toBe(1);
  // The group answer is produced from the delivered event alone.
  await f.runtime.advance(f.ctx,f.runId);
  expect(await f.state()).toMatchObject({status:'WAITING_USER',last_error:'CLARIFICATION_REQUESTED'});
  expect(f.requests.length).toBeGreaterThan(0);
  expect(f.requests.every(request=>!JSON.stringify(request).includes(undelivered))).toBe(true);
  expect((await f.state()).result as string).not.toContain(undelivered);
  const deliveries=async()=>(await db.scope(f.ctx,c=>c.query('SELECT * FROM deliveries WHERE source_run_id=$1 AND finalization_id IS NOT NULL ORDER BY created_at,id',[f.runId]))).rows;
  let sends=0,delivered='';
  const sender=new DeliveryGateway(db,vault,{sendReply:async(_target,text)=>{sends++;delivered=text;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('GROUP_PROACTIVE_FORBIDDEN');}},f.binding,Date.now,(...a)=>f.gateway.finalSourcesAllowed(...a));
  expect(await deliveries()).toHaveLength(1);
  expect(await sender.process(f.ctx,(await deliveries())[0].id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
  expect(sends).toBe(1);
  expect(delivered).not.toContain(undelivered);
 }finally{await f.close();}
});
