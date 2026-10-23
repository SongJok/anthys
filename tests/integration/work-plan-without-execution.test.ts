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
import {REVIEW_PROMPT,type ReviewDecision} from '../../packages/runtime/src/narrative-review.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await root.end();});

const general:ReviewDecision={schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]};
// A real plan cites how to proceed without claiming any step already happened.
const plan='支付服务回滚演练推进方案。步骤：一、冻结变更窗口并与值班同步；二、准备回滚包并校验哈希；三、在独立预发命名空间完成回滚演练；四、恢复基线并归档记录。依赖：运维提供回滚包，DBA 提供只读快照，测试提供验收口径。风险：演练可能占用预发共享资源，回滚包版本不一致会导致验证失败；缓解方式是使用独立命名空间并先校验包哈希。验证：以回滚耗时、错误率和关键接口可用率三项指标对照基线。本方案尚未执行任何变更；所有动作都需要你确认后另行发起。';
const conversation=(text:string)=>JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text,claims:[],outcome:'COMPLETE'});
// Both drafts are ordinary CONVERSATION plans whose text asserts work that the
// runtime never performed: none of these sentences may inherit authority.
const executedPlan='回滚演练推进方案：第一步准备回滚包，第二步切换灰度流量，第三步对照基线校验指标。我已执行全部演练步骤并保存了演练报告，当前支付服务运行正常。';
const promisedPlan='回滚演练推进方案：先冻结变更窗口，再切换灰度流量，最后对照基线校验指标。我将每天监控回滚指标并通知值班同学，演练结果会持续同步。';
function eventStream(content:string){return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content}}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}

interface Turn{messages:ProviderMessage[];tools?:{function:{name:string}}[]}
function provider(planAt:()=>string){
 const requests:Turn[]=[],offered:string[]=[];const reviewTools:(unknown[]|undefined)[]=[];let generations=0,reviews=0;
 const client=new GlmProvider({apiKey:'synthetic-t044',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const body=JSON.parse(init!.body as string) as Turn;requests.push(body);
  if(body.messages[0]?.content===REVIEW_PROMPT){reviews++;reviewTools.push(body.tools);return eventStream(JSON.stringify(general));}
  generations++;
  if(generations===1)for(const tool of body.tools??[])offered.push(tool.function.name);
  return eventStream(planAt());
 }});
 return {client,requests,offered,reviewTools,generations:()=>generations,reviews:()=>reviews};
}

async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},store=new RuntimeStore(db,vault);
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic T044','ACTIVE')",[ctx.tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic T044','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-t044-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID();
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,senderId:ctx.actorId,conversationId:'synthetic-t044-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'请帮我制定一份支付服务回滚演练的推进方案，包含步骤、依赖、风险和验证方式'},createAt:Date.now(),chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-t044',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,gateway=new Gateway(store);
 registerTaskCapability(gateway);
 const rows=async(table:string)=>(await db.scope(ctx,c=>c.query('SELECT * FROM '+table+' WHERE run_id=$1',[runId]))).rows;
 return {ctx,store,gateway,taskId:task.taskId,runId,binding,event,rows,state:async()=>(await new TaskStore(db).get(ctx,task.taskId))!.runs[0],deliveries:async()=>(await db.scope(ctx,c=>c.query('SELECT * FROM deliveries WHERE source_run_id=$1',[runId]))).rows};
}

it('T044 a requested work plan is delivered as steps, dependencies, risks and validation without executing it',async()=>{
 const w=await world(),m=provider(()=>conversation(plan));
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 expect({generations:m.generations(),reviews:m.reviews()}).toEqual({generations:1,reviews:1});
 // Reviewing a plan never hands the reviewer tools, and the drafting model is
 // only ever offered the reviewed READ task reader, so a plan cannot execute.
 expect(m.reviewTools.every(tools=>tools===undefined)).toBe(true);
 expect(m.offered).toEqual([toolName('tasks.get','1.0.0')]);
 expect(await w.state()).toMatchObject({status:'SUCCEEDED',result:plan,last_error:'GENERAL_KNOWLEDGE_MODEL_REVIEW'});
 // The delivered plan keeps all four requested elements and says it did not run.
 const deliveries=await w.deliveries();
 expect(deliveries).toHaveLength(1);
 expect(deliveries[0]).toMatchObject({target:{kind:'PRIVATE_USER',targetId:w.ctx.actorId}});
 let sends=0;
 const sender=new DeliveryGateway(db,vault,{sendReply:async(_target,text)=>{sends++;for(const part of ['步骤：','依赖：','风险：','验证：','本方案尚未执行任何变更'])expect(text).toContain(part);return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('T044_PROACTIVE_FORBIDDEN');}},w.binding,Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
 expect(await sender.process(w.ctx,deliveries[0].id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
 expect(sends).toBe(1);
 // Planning produced no ledger action, no approval and no outbound event beyond
 // the initial run dispatch.
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect((await db.scope(w.ctx,c=>c.query('SELECT count(*)::int n FROM approvals WHERE action_id IN (SELECT id FROM tool_actions WHERE run_id=$1)',[w.runId]))).rows[0].n).toBe(0);
 expect((await db.scope(w.ctx,c=>c.query("SELECT kind FROM outbox WHERE aggregate_id=$1 AND kind<>'RUN'",[w.runId]))).rows).toEqual([]);
 expect((await w.rows('run_finalizations'))[0]).toMatchObject({state:'VERIFIED',reason:'GENERAL_KNOWLEDGE_MODEL_REVIEW'});
 expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,plan)).toBe(true);
},60000);

it('T044 a plan claiming the work was already executed is rejected and never delivered',async()=>{
 const w=await world(),m=provider(()=>conversation(executedPlan));
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 // Even though the separate narrative review returned GENERAL, the action
 // prose guard prevents the draft from being treated as performed work.
 expect(m.generations()).toBe(3);
 expect(m.reviews()).toBeGreaterThanOrEqual(1);
 expect(await w.state()).toMatchObject({status:'PARTIAL',result:null,last_error:'UNBACKED_ACTION_PROSE'});
 const rejected=(await w.rows('run_finalizations')).filter(row=>row.state==='REJECTED');
 expect(rejected).toHaveLength(3);
 expect(rejected.every(row=>row.reason==='UNBACKED_ACTION_PROSE')).toBe(true);
 expect(await w.deliveries()).toHaveLength(0);
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect((await db.scope(w.ctx,c=>c.query("SELECT kind FROM outbox WHERE aggregate_id=$1 AND kind<>'RUN'",[w.runId]))).rows).toEqual([]);
},60000);

it('T044 a plan promising future monitoring and notifications is rejected and never delivered',async()=>{
 const w=await world(),m=provider(()=>conversation(promisedPlan));
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 expect(m.generations()).toBe(3);
 expect(await w.state()).toMatchObject({status:'PARTIAL',result:null,last_error:'UNBACKED_ACTION_PROSE'});
 const rejected=(await w.rows('run_finalizations')).filter(row=>row.state==='REJECTED');
 expect(rejected).toHaveLength(3);
 expect(rejected.every(row=>row.reason==='UNBACKED_ACTION_PROSE')).toBe(true);
 expect(await w.deliveries()).toHaveLength(0);
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,promisedPlan)).toBe(false);
},60000);
