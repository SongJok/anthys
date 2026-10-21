import '../support/isolation.js';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {z} from 'zod';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret,config} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {ModelBudget} from '../../packages/runtime/src/model-budget.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {REVIEW_PROMPT} from '../../packages/runtime/src/narrative-review.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {RunQueue} from '../../packages/tasks/src/queue.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createServer} from '../../apps/api/src/server.js';

assert.equal(process.versions.node,'24.21.0');
export async function browserSelfDm(runtime:Database,vault:Vault,resources?:{appDb:Database;admin:pg.Pool;queueUrl:string}){
const tenantId=randomUUID(),corpId='SYNTHETIC-'+tenantId,robotCode='synthetic-self-dm',appDb=resources?.appDb??new Database(secret('DATABASE_URL')!);
const admin=resources?.admin??new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC SELF DM','ACTIVE')",[tenantId,corpId]);
const actors={desktop:randomUUID(),mobile:randomUUID()},external={desktop:'synthetic-alice-'+randomUUID(),mobile:'synthetic-alice-'+randomUUID()};
for(const [project,id] of Object.entries(actors))await admin.query("INSERT INTO users(tenant_id,id,external_user_id,union_id,display_name,status) VALUES($1,$2,$3,$3,'ALICE','ACTIVE')",[tenantId,id,external[project as keyof typeof actors]]);
if(!resources)await admin.end();
const policy=modelBudgetPolicySchema.parse(JSON.parse(await readFile(secret('BUDGET_POLICY_FILE')!,'utf8')));
policy.maxOutputTokens=1024;policy.limits.task.concurrent=1;policy.limits.task.money='0.20';
policy.pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_RATE_ONLY',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};
const store=new RuntimeStore(runtime,vault,new ModelBudget(policy)),gateway=new Gateway(store);
const answer='幂等表示同一操作重复执行后，业务结果与执行一次相同。';
const requests:Record<string,unknown>[]=[],sent:{url:string;text:string}[]=[],workerErrors:unknown[]=[];
const model=new GlmProvider({apiKey:'synthetic-only',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
 const body=JSON.parse(init!.body as string) as Record<string,unknown>;requests.push(body);
 assert.equal(body['model'],'glm-5.3-flash');assert.equal(body['max_tokens'],1024);
 assert(!JSON.stringify(body).includes('synthetic-session-'));
 const review=(body['messages'] as {content?:string}[])[0]?.content===REVIEW_PROMPT;
 const content=JSON.stringify(review?{schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]}:{schemaVersion:1,mode:'CONVERSATION',text:answer,claims:[],outcome:'COMPLETE'});
 return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic',robotCode,replyOnly:true,fetch:async(url,init)=>{
 const address=new URL(String(url));assert.equal(address.hostname,'oapi.dingtalk.com');assert.equal(address.pathname,'/robot/sendBySession');
 assert(address.searchParams.get('session')?.startsWith('synthetic-session-'));
 const body=JSON.parse(init!.body as string) as {msgtype:string;text:{content:string}};assert.equal(body.msgtype,'text');
 sent.push({url:String(url),text:body.text.content});return new Response(JSON.stringify({errcode:0}),{headers:{'content-type':'application/json'}});
}});
const delivery=new DeliveryGateway(runtime,vault,sender,{corpId,robotCode,appOrigin:'http://localhost:64702'},Date.now,(...args)=>gateway.finalSourcesAllowed(...args));
const queue=new RunQueue(resources?.queueUrl??secret('QUEUE_DATABASE_URL')!,'synthetic-self-dm-'+randomUUID());
await queue.start();await queue.work(async job=>{
 try{const ctx={tenantId:job.tenantId,actorId:job.actorId};await new AgentRuntime(store,model,gateway).advance(ctx,job.runId);for(const id of await delivery.pending(ctx))await delivery.process(ctx,id,new AbortController().signal);}
 catch(error){workerErrors.push(error);throw error;}
});
async function until(check:()=>boolean|Promise<boolean>){const stop=performance.now()+15000;while(!await check()){assert.equal(workerErrors.length,0);if(performance.now()>=stop)throw Error('SYNTHETIC_SELF_DM_BOUNDARY_TIMEOUT');await delay(25);}}
const identity=(code:string)=>{const project=code.replace(/^synthetic-self-dm-/,'');return code.startsWith('synthetic-self-dm-')&&(project==='desktop'||project==='mobile')?{corpId,unionId:external[project]}:null;};
const {app}=await createServer({config:config({APP_ENV:'test',APP_ORIGIN:'http://localhost:64702',PORT:'64702'}),db:appDb,sessionSecret:randomBytes(32).toString('hex'),finalReader:gateway,webRoot:resolve('dist/web'),login:{tenantId,corpId,clientId:'synthetic-self-dm',provider:{exchange:async code=>{const value=identity(code);if(!value)throw Error('SYNTHETIC_CODE_REJECTED');return value;}}}});
// The same scenario retains its own tenant, immutable budget and real API
// sessions in both E2E entrypoints. No shared fixture policy is replaced.
const scenario=async(request:FastifyRequest)=>{
 const {project}=z.object({project:z.enum(['desktop','mobile'])}).strict().parse(request.body),ctx={tenantId,actorId:actors[project]};
 const ingress=new DingTalkIngress(runtime,vault,{tenantId,corpId,robotCode},store),client=new DWClient({clientId:'synthetic',clientSecret:'synthetic'}),acks:string[]=[],errors:string[]=[];
 client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,ingress,code=>errors.push(code));
 const id=randomUUID(),conversationId='synthetic-dm-'+project,url='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-session-'+project;
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:external[project],conversationId,conversationType:'1',robotCode,msgtype:'text',text:{content:'解释幂等性的含义'},createAt:Date.now(),senderId:external[project],chatbotUserId:'synthetic-bot',sessionWebhook:url,sessionWebhookExpiredTime:Date.now()+60000})};
 client.onCallback(event);assert.equal(acks.length,0);await until(()=>acks.length===1);assert.deepEqual(errors,[]);
 for(let i=0;i<20;i++)client.onCallback(event);await until(()=>acks.length===21);assert.deepEqual(errors,[]);assert(acks.every(ack=>ack===id));
 const records=await runtime.scope(ctx,c=>c.query("SELECT t.id task_id,r.id run_id,conv.external_id conversation_id,t.requester_id FROM event_inbox e JOIN tasks t ON t.tenant_id=e.tenant_id AND t.source_event_id=e.id JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id JOIN conversations conv ON conv.tenant_id=t.tenant_id AND conv.id=t.conversation_id WHERE e.event_key=$1",[`${robotCode}:${conversationId}:${id}`]));
 assert.equal(records.rowCount,1);const row=records.rows[0],taskId=row.task_id as string,runId=row.run_id as string;
 assert.equal(row.requester_id,ctx.actorId);assert.equal(row.conversation_id,conversationId);
 assert.equal(await queue.publish(runtime,ctx),1);assert.equal(await queue.publish(runtime,ctx),0);
 await until(async()=>!!(await runtime.scope(ctx,c=>c.query("SELECT id FROM deliveries WHERE task_id=$1 AND state='APPLIED_UNVERIFIED'",[taskId]))).rowCount);
 const deliveries=(await runtime.scope(ctx,c=>c.query('SELECT id,state FROM deliveries WHERE task_id=$1',[taskId]))).rows;assert.equal(deliveries.length,1);
 await Promise.all(Array.from({length:20},()=>delivery.process(ctx,deliveries[0].id as string,new AbortController().signal)));
 const replies=sent.filter(reply=>reply.url===url);assert.equal(replies.length,1);assert.equal(replies[0]!.text,`任务 ${taskId}\n\n${answer}`);
 const ledger=(await runtime.scope(ctx,c=>c.query('SELECT dispatch_state,token_state,cost_state FROM quota_ledger WHERE run_id=$1',[runId]))).rows;assert.equal(ledger.length,2);assert(ledger.every(r=>r.dispatch_state==='COMPLETE'&&r.token_state==='SETTLED'&&r.cost_state==='SETTLED'));
 const audit=(await runtime.scope(ctx,c=>c.query('SELECT action,result FROM audit_events ORDER BY created_at,id'))).rows;
 assert.deepEqual(audit.map(a=>[a.action,a.result]),[['message.accepted','ENQUEUED'],['run.finalized','SUCCEEDED'],['message.receipt','SUPPRESSED'],['delivery.claimed','SENDING'],['delivery.finished','APPLIED_UNVERIFIED']]);
 return {taskId,runId,actorId:ctx.actorId,tenantId,answer,acks:acks.length,logicalTasks:records.rowCount,replies:replies.length,replyText:replies[0]!.text,audit,modelRequests:ledger.length,maxOutputTokens:policy.maxOutputTokens};
};
const routes=(outer:FastifyInstance)=>{
 outer.post('/__test/self-dm',scenario);
 outer.route({method:['GET','POST','PATCH','DELETE'],url:'/__test/self-dm-api/*',handler:async(request,reply)=>{
  const url=request.url.slice('/__test/self-dm-api'.length);if(!url.startsWith('/api/'))return reply.code(400).send({error:'SYNTHETIC_API_PATH_REQUIRED'});
  const headers={...request.headers};delete headers['content-length'];delete headers['host'];
  const response=await app.inject({method:request.method as 'GET'|'POST'|'PATCH'|'DELETE',url,headers,...(request.body!==undefined?{payload:request.body as Record<string,unknown>}:{})});
  // The outer HTTP response owns its framing. Injected response headers must
  // not forward a prior connection's length/chunking/keepalive state.
  const outgoing={...response.headers};for(const key of ['content-length','transfer-encoding','connection','keep-alive'])delete outgoing[key];
  return reply.code(response.statusCode).headers(outgoing).send(response.rawPayload);
 }});
};
routes(app);
return {app,routes,close:async()=>{await app.close();await queue.stop();if(!resources)await appDb.close();}};
}
