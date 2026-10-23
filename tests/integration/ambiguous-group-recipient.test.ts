import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {AgentRuntime,registerTaskCapability} from '../../packages/runtime/src/loop.js';
import {REVIEW_PROMPT,renderClarification,type ReviewDecision} from '../../packages/runtime/src/narrative-review.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await root.end();});

const general:ReviewDecision={schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]};
const asks:ReviewDecision={...general,verdict:'CLARIFICATION',fulfillsGoal:false,isQuestion:true};
const conversation=(text:string)=>JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text,claims:[],outcome:'COMPLETE'});
const questionText='你要求把周报发到“项目群”，但当前请求没有给出唯一可核验的群标识，可能存在多个同名群。请确认唯一的目标群名称或群 ID；在确认前我不会发送任何消息。';
const questionPlan=JSON.stringify({schemaVersion:1,mode:'CLARIFICATION',text:questionText,claims:[],outcome:'CLARIFICATION'});
function eventStream(content:string){return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content}}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}

interface Turn{messages:ProviderMessage[];tools?:{function:{name:string}}[]}
function provider(proposalAt:()=>string,decision:ReviewDecision){
 const requests:Turn[]=[],offered:string[]=[];const reviewTools:(unknown[]|undefined)[]=[];let generations=0,reviews=0;
 const client=new GlmProvider({apiKey:'synthetic-t021',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const body=JSON.parse(init!.body as string) as Turn;requests.push(body);
  if(body.messages[0]?.content===REVIEW_PROMPT){reviews++;reviewTools.push(body.tools);return eventStream(JSON.stringify(decision));}
  generations++;
  if(generations===1)for(const tool of body.tools??[])offered.push(tool.function.name);
  return eventStream(proposalAt());
 }});
 return {client,requests,offered,reviewTools,generations:()=>generations,reviews:()=>reviews};
}

async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},store=new RuntimeStore(db,vault);
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic T021','ACTIVE')",[ctx.tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic T021','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-t021-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID();
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,senderId:ctx.actorId,conversationId:'synthetic-t021-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'把这份周报发到项目群，群名你看着办就行'},createAt:Date.now(),chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-t021',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,gateway=new Gateway(store);
 registerTaskCapability(gateway);
 const rows=async(table:string)=>(await db.scope(ctx,c=>c.query('SELECT * FROM '+table+' WHERE run_id=$1',[runId]))).rows;
 const deliveries=async()=>(await db.scope(ctx,c=>c.query('SELECT * FROM deliveries WHERE source_run_id=$1',[runId]))).rows;
 return {ctx,store,gateway,taskId:task.taskId,runId,binding,rows,deliveries,state:async()=>(await new TaskStore(db).get(ctx,task.taskId))!.runs[0]};
}
const nonRunOutbox=async(w:Awaited<ReturnType<typeof world>>)=>(await db.scope(w.ctx,c=>c.query("SELECT kind FROM outbox WHERE aggregate_id=$1 AND kind<>'RUN'",[w.runId]))).rows;

it('T021 an ambiguous group-send request pauses for one audience and sends nothing',async()=>{
 const w=await world(),m=provider(()=>questionPlan,asks);
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 expect({generations:m.generations(),reviews:m.reviews()}).toEqual({generations:1,reviews:1});
 // A private task is offered only the reviewed task reader; no capability can
 // accept a guessed group name, so there is no sending path to misuse.
 expect(m.reviewTools.every(tools=>tools===undefined)).toBe(true);
 expect(m.offered).toEqual([toolName('tasks.get','1.0.0')]);
 const waiting=await w.state(),reviewId=waiting.clarification_review_id as string;
 expect(waiting).toMatchObject({status:'WAITING_USER',last_error:'CLARIFICATION_REQUESTED',result:renderClarification(questionText,reviewId,true)});
 expect((await new TaskStore(db).get(w.ctx,w.taskId))!.status).toBe('ACTIVE');
 // The only delivery is the question, addressed to the requester, and it asks
 // for exactly one audience instead of asserting a send.
 const deliveries=await w.deliveries();
 expect(deliveries).toHaveLength(1);
 expect(deliveries[0]).toMatchObject({target:{kind:'PRIVATE_USER',targetId:w.ctx.actorId}});
 let sends=0;const targets:unknown[]=[];
 const sender=new DeliveryGateway(db,vault,{sendReply:async(target,text)=>{sends++;targets.push(target);expect(text).toContain(waiting.result!);for(const part of ['唯一的目标群','请确认','不会发送任何消息'])expect(text).toContain(part);expect(text).not.toMatch(/已(?:经)?发送|发送成功/);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('T021_PROACTIVE_FORBIDDEN');}},w.binding,Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
 expect(await sender.process(w.ctx,deliveries[0].id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
 expect(sends).toBe(1);
 // The physical route is the requester's own DM session webhook; no proactive
 // or group channel is ever opened for this question.
 expect(targets[0]).toEqual({url:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-t021',expiresAt:expect.any(Number)});
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect(await nonRunOutbox(w)).toEqual([]);
 expect((await db.scope(w.ctx,c=>c.query('SELECT count(*)::int n FROM approvals WHERE action_id IN (SELECT id FROM tool_actions WHERE run_id=$1)',[w.runId]))).rows[0].n).toBe(0);
 // Naming a candidate group in the answer only resumes the task; it cannot
 // create a group delivery or a ledger write on its own.
 const answered=await w.store.reply(w.ctx,w.taskId,reviewId,'只发给「项目群 A」（group-a）',randomUUID());
 expect(answered).toMatchObject({generation:1});
 expect(await w.state()).toMatchObject({status:'QUEUED',result:null});
 expect(await w.deliveries()).toHaveLength(1);
 expect((await w.deliveries())[0]).toMatchObject({state:'APPLIED_UNVERIFIED',target:{kind:'PRIVATE_USER',targetId:w.ctx.actorId}});
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect(await nonRunOutbox(w)).toEqual([]);
},60000);

it('T021 a guessed send after the answer is rejected and stays undelivered',async()=>{
 const w=await world(),q=provider(()=>questionPlan,asks);
 await new AgentRuntime(w.store,q.client,w.gateway).advance(w.ctx,w.runId);
 const waiting=await w.state(),answered=await w.store.reply(w.ctx,w.taskId,waiting.clarification_review_id as string,'只发给「项目群 A」（group-a）',randomUUID());
 if(!answered||!('generation' in answered))throw Error('T021_REPLY_NOT_RESUMED');
 const claimed=conversation('已发送到「项目群 A」，周报已经发出，请查收。'),m=provider(()=>claimed,general);
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId,undefined,undefined,answered.generation);
 expect(m.generations()).toBe(3);
 expect(await w.state()).toMatchObject({status:'PARTIAL',result:null,last_error:'UNBACKED_ACTION_PROSE'});
 const rejected=(await w.rows('run_finalizations')).filter(row=>row.state==='REJECTED');
 expect(rejected).toHaveLength(3);
 expect(rejected.every(row=>row.reason==='UNBACKED_ACTION_PROSE')).toBe(true);
 // The guessed send never becomes a delivery to any group, a tool action or
 // an outbound event; the only delivery remains the earlier question.
 expect(await w.deliveries()).toHaveLength(1);
 expect((await w.deliveries())[0]).toMatchObject({target:{kind:'PRIVATE_USER',targetId:w.ctx.actorId}});
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect(await nonRunOutbox(w)).toEqual([]);
 expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,claimed)).toBe(false);
},60000);
