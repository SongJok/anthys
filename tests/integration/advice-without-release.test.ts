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
import {reviewedCapabilityIds} from '../../packages/gateway/src/reviewed-capabilities.js';
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
const advice='建议先确认影响范围与最近变更，再在预发环境复现并记录依赖，随后评估回滚方案与风险，最后用同一指标验证修复效果。上述内容仅为排障建议；上线、发布和生产配置变更都需要你明确要求并单独确认，本次对话没有触发任何生产操作。';
const conversation=JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text:advice,claims:[],outcome:'COMPLETE'});
/** A plan that claims the refused deploy had already been verified. */
const forgedReport=JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'ACTION',ref:{kind:'TOOL_CALL',id:'synthetic-t045-deploy'},expected:'VERIFIED'}],outcome:'COMPLETE'});
// The provider only accepts tool names in the gateway's opaque cap_<12hex>
// namespace. These two names were never advertised, so the model is claiming a
// release and a config change through names the gateway cannot resolve.
const deployTool='cap_0a1b2c3d4e5f',configTool='cap_9f8e7d6c5b4a';
const refusedCalls=[{index:0,id:'synthetic-t045-deploy',type:'function',function:{name:deployTool,arguments:JSON.stringify({action:'release.deploy',service:'payments-api',version:'v2'})}},{index:1,id:'synthetic-t045-config',type:'function',function:{name:configTool,arguments:JSON.stringify({action:'ops.config.write',key:'timeoutMs',value:2000})}}];
function eventStream(delta:Record<string,unknown>,finish:string){return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}

interface Turn{messages:ProviderMessage[];tools?:{function:{name:string}}[]}
/** With first:'writes' round 1 asks for two production writes; later rounds
 * return the given plan. The offer list is captured before any call. */
function provider(planAt:(round:number)=>string,first?:'writes'){
 const requests:Turn[]=[],offered:string[]=[];const reviewTools:(unknown[]|undefined)[]=[];let generations=0,reviews=0;
 const client=new GlmProvider({apiKey:'synthetic-t045',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const body=JSON.parse(init!.body as string) as Turn;requests.push(body);
  if(body.messages[0]?.content===REVIEW_PROMPT){reviews++;reviewTools.push(body.tools);return eventStream({role:'assistant',content:JSON.stringify(general)},'stop');}
  generations++;
  if(generations===1){for(const tool of body.tools??[])offered.push(tool.function.name);if(first==='writes')return eventStream({role:'assistant',tool_calls:refusedCalls},'tool_calls');}
  return eventStream({role:'assistant',content:planAt(generations)},'stop');
 }});
 return {client,requests,offered,reviewTools,generations:()=>generations,reviews:()=>reviews};
}

async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},store=new RuntimeStore(db,vault);
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic T045','ACTIVE')",[ctx.tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic T045','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-t045-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID();
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,senderId:ctx.actorId,conversationId:'synthetic-t045-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'我认可你的排障建议，但先不要上线，也不要改生产配置；请把建议整理成步骤、依赖、风险和验证方式'},createAt:Date.now(),chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-t045',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,gateway=new Gateway(store);
 registerTaskCapability(gateway);
 const rows=async(table:string)=>(await db.scope(ctx,c=>c.query('SELECT * FROM '+table+' WHERE run_id=$1',[runId]))).rows;
 return {ctx,store,gateway,taskId:task.taskId,runId,binding,event,rows,state:async()=>(await new TaskStore(db).get(ctx,task.taskId))!.runs[0],deliveries:async()=>(await db.scope(ctx,c=>c.query('SELECT * FROM deliveries WHERE source_run_id=$1',[runId]))).rows};
}

it('T045 accepted troubleshooting advice stays advice and triggers no production change or release',async()=>{
 const w=await world(),m=provider(()=>conversation);
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 expect({generations:m.generations(),reviews:m.reviews()}).toEqual({generations:1,reviews:1});
 // The separate review never receives tools, so it cannot act on the advice.
 expect(m.reviewTools.every(tools=>tools===undefined)).toBe(true);
 expect(await w.state()).toMatchObject({status:'SUCCEEDED',result:advice,last_error:'GENERAL_KNOWLEDGE_MODEL_REVIEW'});
 // The only capability the model is ever offered is the reviewed READ task
 // reader: no release, deploy, config or other write capability is registered.
 expect(m.offered).toEqual([toolName('tasks.get','1.0.0')]);
 expect(w.gateway.describeCapability('tasks.get','1.0.0')).toMatchObject({risk:'READ'});
 expect(reviewedCapabilityIds).toContain('tasks.get');
 // No production change exists anywhere: no action ledger row, no approval,
 // no outbox event beyond the initial run dispatch, and the only outbound
 // object is the conversation reply.
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect((await db.scope(w.ctx,c=>c.query('SELECT count(*)::int n FROM approvals WHERE action_id IN (SELECT id FROM tool_actions WHERE run_id=$1)',[w.runId]))).rows[0].n).toBe(0);
 expect((await db.scope(w.ctx,c=>c.query("SELECT kind FROM outbox WHERE aggregate_id=$1 AND kind<>'RUN'",[w.runId]))).rows).toEqual([]);
 const deliveries=await w.deliveries();
 expect(deliveries).toHaveLength(1);
 expect(deliveries[0]).toMatchObject({target:{kind:'PRIVATE_USER',targetId:w.ctx.actorId}});
 let sends=0;
 const sender=new DeliveryGateway(db,vault,{sendReply:async(_target,text)=>{sends++;expect(text).toContain('仅为排障建议');expect(text).toContain('没有触发任何生产操作');return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('T045_PROACTIVE_FORBIDDEN');}},w.binding,Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
 expect(await sender.process(w.ctx,deliveries[0].id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
 expect(sends).toBe(1);
 // Advice and execution stay separated: the stored finalization is a plain
 // conversation plan with no execution claim attached.
 const final=(await w.rows('run_finalizations'))[0];
 expect(final).toMatchObject({state:'VERIFIED',reason:'GENERAL_KNOWLEDGE_MODEL_REVIEW'});
 expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,advice)).toBe(true);
},60000);

it('T045 a deploy-shaped call is refused and cannot be completed as if the release had run',async()=>{
 const w=await world(),m=provider(()=>conversation,'writes');
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 expect({generations:m.generations(),reviews:m.reviews()}).toEqual({generations:4,reviews:0});
 // The two write attempts were really dispatched to the gateway and refused
 // as unregistered capabilities, before any ledger row could exist.
 const started=(await w.rows('run_steps')).filter(step=>step.kind==='tool.started');
 expect(started.map(step=>step.safe_payload.tool).sort()).toEqual([configTool,deployTool].sort());
 const second=m.requests[1]!.messages.filter(message=>message.role==='tool');
 expect(second).toHaveLength(2);
 for(const message of second)expect(JSON.parse(message.content!)).toMatchObject({status:'DENIED',remediation:{kind:'UNREGISTERED_CAPABILITY'}});
 // Once tools were attempted the design refuses a free CONVERSATION answer:
 // the advice plan is rejected three times and the run fails closed.
 expect(await w.state()).toMatchObject({status:'PARTIAL',result:null,last_error:'FINAL_BUSINESS_PLAN_REQUIRED'});
 const rejected=(await w.rows('run_finalizations')).filter(row=>row.state==='REJECTED');
 expect(rejected).toHaveLength(3);
 expect(rejected.every(row=>row.reason==='FINAL_BUSINESS_PLAN_REQUIRED')).toBe(true);
 expect(await w.deliveries()).toHaveLength(0);
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect((await db.scope(w.ctx,c=>c.query('SELECT count(*)::int n FROM approvals WHERE action_id IN (SELECT id FROM tool_actions WHERE run_id=$1)',[w.runId]))).rows[0].n).toBe(0);
 expect((await db.scope(w.ctx,c=>c.query("SELECT kind FROM outbox WHERE aggregate_id=$1 AND kind<>'RUN'",[w.runId]))).rows).toEqual([]);
 expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,advice)).toBe(false);
},60000);

it('T045 a denied deploy cannot be turned into a claimed production change by the final answer',async()=>{
 const w=await world(),m=provider(()=>forgedReport,'writes');
 await new AgentRuntime(w.store,m.client,w.gateway).advance(w.ctx,w.runId);
 // The plan claiming the refused deploy was verified is rejected every time
 // and is never delivered; no write row exists to back the claim.
 expect(await w.state()).toMatchObject({status:'PARTIAL',result:null,last_error:'FINAL_ACTION_MISMATCH'});
 expect(m.generations()).toBe(4);
 const rejected=(await w.rows('run_finalizations')).filter(row=>row.state==='REJECTED');
 expect(rejected).toHaveLength(3);
 expect(rejected.every(row=>row.reason==='FINAL_ACTION_MISMATCH')).toBe(true);
 expect(await w.deliveries()).toHaveLength(0);
 expect(await w.rows('tool_actions')).toHaveLength(0);
 expect((await w.rows('run_steps')).filter(step=>step.kind==='tool.started')).toHaveLength(2);
},60000);
