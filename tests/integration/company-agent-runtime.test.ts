import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {glmRequestBody,type ModelProvider} from '../../packages/provider-glm/src/client.js';
import {toolName} from '../../packages/gateway/src/index.js';
import {CompanyAgentWorker} from '../../packages/company/src/agent-worker.js';
import {connectCompanyAgent} from '../../packages/company/src/agent-connection.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {companyAgentWorld} from '../support/company-agent-world.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';

type World=Awaited<ReturnType<typeof companyAgentWorld>>;
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
const message='SYNTHETIC exact question',text='SYNTHETIC upstream text: latency candidate only; not independently verified.';
const schema={type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}};
const endpoint='https://synthetic-runtime-agent.invalid/mcp';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>;
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();},60000);
afterAll(async()=>{await isolated?.close();},60000);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>,milliseconds=5000){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('SYNTHETIC_FIXTURE_STAGE_TIMEOUT')),milliseconds);})]);}
 finally{if(timer)clearTimeout(timer);}
}
async function runState(w:World){return (await w.root.query('SELECT status,last_error,result,active_ms::text,active_accounted_at,model_turns,tool_calls,retry_generation FROM runs WHERE id=$1',[w.runId])).rows[0];}
async function continuationCount(w:World,id:string){return Number((await w.root.query('SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND dedup_key=$2',[w.ctx.tenantId,'company-agent-resume:'+id])).rows[0].n);}

async function nativeWorld(){
 const w=await companyAgentWorld(isolated,vault);expect(w.store.modelBudget.policy?.environment).toBe('SYNTHETIC_TEST');
 w.admission.inputSchemaHash=agentChatInputSchemaHash(schema);w.admission.waitBudgetMs=120000;w.admission.budgetExpiresAt=new Date(Date.now()+180000).toISOString();
 // The world acquires a lease for its direct-Gateway tests. Native AgentRuntime
 // must acquire its own real lease rather than inherit or forge that lease.
 await w.store.release(w.ctx,w.lease);
 const callId='synthetic-runtime-call-'+randomUUID(),name=toolName('company.agent.ask','1.0.0');let modelCalls=0;
 const provider:ModelProvider={describeRequest:(messages,tools,limits)=>glmRequestBody(messages,tools,'high',limits),complete:async(messages,tools,signal)=>{
  signal.throwIfAborted();modelCalls++;if(modelCalls>2)throw Error('UNEXPECTED_SYNTHETIC_MODEL_CALL');
  if(modelCalls===1){expect(tools.some(tool=>tool.function.name===name)).toBe(true);expect(messages.some(item=>item.role==='tool')).toBe(false);}
  else{
   const original=messages.flatMap(item=>item.tool_calls??[]).filter(call=>call.id===callId);expect(original).toHaveLength(1);expect(JSON.parse(original[0]!.function.arguments)).toEqual({message});
   const replies=messages.filter(item=>item.role==='tool'&&item.tool_call_id===callId);expect(replies).toHaveLength(1);
   expect(JSON.parse(replies[0]!.content!)).toMatchObject({status:'OK',completeness:'UNKNOWN',verification:{state:'UNVERIFIED'},data:{text,source:{kind:'ENTERPRISE_AGENT_MCP',verification:'UNVERIFIED'}}});
  }
  return {message:modelCalls===1?{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify({message})}}]}:{role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'QUOTE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/text',quote:text,coverage:'OBSERVED'}],outcome:'PARTIAL'})},finishReason:modelCalls===1?'tool_calls':'stop',usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40},requestId:null};
 }};
 return {w,runtime:new AgentRuntime(w.store,provider,w.gateway),modelCalls:()=>modelCalls,callId};
}

function syntheticWorker(w:World,mode:'success-35s'|'cancel'|'disconnect'){
 const controller=new AbortController(),entered=deferred(),lost=deferred(),token=randomBytes(32).toString('hex');let calls=0,startedAt=0,finishedAt=0,aborted=false;
 const fetcher:typeof fetch=async(input,init)=>{
  expect(String(input)).toBe(endpoint);expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);
  const request=JSON.parse(init?.body as string) as {id?:number|string;method:string;params?:{protocolVersion?:string;name?:string;arguments?:unknown}};
  if(request.method==='notifications/initialized'||request.method==='notifications/cancelled')return new Response(null,{status:202});
  if(request.method==='tools/call'){
   calls++;startedAt=performance.now();expect(request.params?.name).toBe('chat');expect(request.params?.arguments).toEqual({message});entered.resolve();
   const signal=init?.signal;if(!signal)throw Error('SYNTHETIC_TRANSPORT_SIGNAL_REQUIRED');
   const onAbort=()=>{aborted=true;};signal.addEventListener('abort',onAbort,{once:true});
   try{
    if(mode==='success-35s'){const readyAt=startedAt+35000;while(performance.now()<readyAt)await delay(Math.max(1,Math.ceil(readyAt-performance.now())),undefined,{signal});}
    else if(mode==='disconnect'){await bounded(lost.promise);throw Error('SYNTHETIC_TRANSPORT_CONNECTION_LOST');}
    else await new Promise<never>((_resolve,reject)=>{
     const stop=()=>reject(Error('SYNTHETIC_TRANSPORT_LOCAL_ABORT'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
    });
   }finally{finishedAt=performance.now();signal.removeEventListener('abort',onAbort);}
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text}]}}),{headers:{'content-type':'application/json'}});
  }
  const result=request.method==='initialize'?{protocolVersion:request.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-runtime-agent',version:'1'}}:request.method==='tools/list'?{tools:[{name:'chat',inputSchema:schema}]}:null;
  if(!result)throw Error('UNEXPECTED_SYNTHETIC_SDK_METHOD');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 };
 const worker=new CompanyAgentWorker(w.ledger,(row,signal)=>connectCompanyAgent({connectorId:w.admission.connectorId,endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(endpoint),credentialHash:hash(token),server:{name:'synthetic-runtime-agent',version:'1'},toolName:'chat',inputSchemaHash:w.admission.inputSchemaHash},{signal,absoluteDeadlineMs:row.deadline.getTime()},{AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token},fetcher));
 // Attach rejection observation immediately; callers still await the original
 // job so any actual worker failure fails the test and cleanup always aborts.
 const job=worker.once(w.ctx,controller.signal,'native-synthetic-'+randomUUID());void job.catch(()=>{});
 return {worker,controller,job,entered:entered.promise,disconnect:lost.resolve,calls:()=>calls,elapsed:()=>finishedAt-startedAt,aborted:()=>aborted};
}

it('actual runtime releases activity during a real 35-second SDK wait, renews across its claim lease, and continues the original tool call once',async()=>{
 const n=await nativeWorld(),{w}=n,began=performance.now();await n.runtime.advance(w.ctx,w.runId);
 expect(performance.now()-began).toBeLessThan(10000);expect(n.modelCalls()).toBe(1);
 const waiting=await runState(w);expect(waiting).toMatchObject({status:'WAITING_EXTERNAL',active_accounted_at:null});expect(Number(waiting.model_turns)).toBe(1);expect(Number(waiting.tool_calls)).toBe(1);
 const initialRequest=await w.row();expect(initialRequest).toMatchObject({state:'QUEUED',dispatch_started_at:null});const background=syntheticWorker(w,'success-35s');
 try{
  await bounded(background.entered);const leased=await w.row();expect(leased.state).toBe('DISPATCHING');const initialLease=leased.lease_until.getTime(),initialFence=String(leased.fence),initialOwner=leased.worker_id;
  // Real time, deliberately longer than the unmodified production 30s lease.
  await delay(31000);
  const sampled=await w.row(),during=await runState(w),serverTime=(await w.root.query('SELECT clock_timestamp() now')).rows[0].now as Date;
  expect(sampled.state).toBe('DISPATCHING');expect(String(sampled.fence)).toBe(initialFence);expect(sampled.worker_id).toBe(initialOwner);expect(sampled.lease_until.getTime()).toBeGreaterThan(initialLease);expect(sampled.lease_until.getTime()).toBeGreaterThan(serverTime.getTime());
  expect(during).toMatchObject({status:'WAITING_EXTERNAL',active_accounted_at:null,active_ms:waiting.active_ms});expect(n.modelCalls()).toBe(1);expect(background.calls()).toBe(1);
  const activity=(await w.root.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename='oa_runtime' AND xact_start IS NOT NULL AND xact_start<clock_timestamp()-interval '5 seconds'")).rows[0];expect(activity.n).toBe(0);
  const pendingModel=(await w.root.query("SELECT count(*)::int n FROM quota_ledger WHERE run_id=$1 AND dispatch_state IN ('PREPARED','DISPATCHING')",[w.runId])).rows[0];expect(pendingModel.n).toBe(0);
  expect(await background.job).toBe(true);expect(background.elapsed()).toBeGreaterThanOrEqual(35000);expect(background.calls()).toBe(1);
  const received=await w.row(),queued=await runState(w);expect(received).toMatchObject({id:initialRequest.id,state:'RESPONSE_RECEIVED',enterprise_cost:'UNKNOWN'});expect(received.resumed_at).toBeInstanceOf(Date);expect(queued).toMatchObject({status:'QUEUED',active_accounted_at:null,active_ms:waiting.active_ms});expect(Number(queued.retry_generation)).toBe(Number(waiting.retry_generation)+1);expect(await continuationCount(w,received.id)).toBe(1);
  await n.runtime.advance(w.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));
  const final=await runState(w);expect(final.status).toBe('PARTIAL');expect(final.last_error).toBe('FINAL_PARTIAL_EVIDENCE');expect(final.result).toContain(text);expect(final.result).toContain('上游核验尚未完成');expect(final.result).toContain('不能作为总体结论');expect(n.modelCalls()).toBe(2);expect(Number(final.model_turns)).toBe(2);expect(Number(final.tool_calls)).toBe(1);expect(background.calls()).toBe(1);
  const action=(await w.root.query('SELECT * FROM tool_actions WHERE run_id=$1',[w.runId])).rows[0];expect(w.store.openToolResult(w.ctx,action.logical_action_key,action.result)).toMatchObject({status:'OK',completeness:'UNKNOWN',verification:{state:'UNVERIFIED'},data:{requestId:received.id,text}});
  expect(await continuationCount(w,received.id)).toBe(1);expect(await w.ledger.recover(w.ctx,new AbortController().signal)).toBe(0);expect(await background.worker.once(w.ctx,new AbortController().signal)).toBe(false);expect(background.calls()).toBe(1);
 }finally{background.controller.abort();await background.job.catch(()=>{});}
},60000);

it.each(['cancel','disconnect'] as const)('actual runtime and SDK %s preserve uncertainty without asking again or continuing the model',async mode=>{
 const n=await nativeWorld(),{w}=n;await n.runtime.advance(w.ctx,w.runId);expect(n.modelCalls()).toBe(1);const background=syntheticWorker(w,mode);
 try{
  await bounded(background.entered);expect(background.calls()).toBe(1);
  if(mode==='cancel')expect(await new TaskStore(isolated.db).cancel(w.ctx,w.taskId)).toMatchObject({status:'CANCELLED',inFlightExternalActions:'MUST_RECONCILE'});else background.disconnect();
  expect(await bounded(background.job,5000)).toBe(true);const row=await w.row(),run=await runState(w);
  expect(row).toMatchObject({state:'UNKNOWN',enterprise_cost:'UNKNOWN',response_ref:null});expect(row.dispatch_started_at).toBeInstanceOf(Date);expect(run.status).toBe(mode==='cancel'?'CANCELLED':'WAITING_USER');
  if(mode==='cancel'){expect(row.remote_cancellation).toBe('UNCONFIRMED');expect(background.aborted()).toBe(true);}
  expect(await continuationCount(w,row.id)).toBe(0);await w.ledger.recover(w.ctx,new AbortController().signal);expect(await background.worker.once(w.ctx,new AbortController().signal)).toBe(false);
  await n.runtime.advance(w.ctx,w.runId);expect(n.modelCalls()).toBe(1);expect(background.calls()).toBe(1);expect((await w.row()).state).toBe('UNKNOWN');
 }finally{background.controller.abort();await background.job.catch(()=>{});}
},60000);
