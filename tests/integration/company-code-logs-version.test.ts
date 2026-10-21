import '../support/isolation.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName,canonical} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import {configureCompanyCode,companyConfigurationSchema} from '../../packages/company/src/configuration.js';
import {configureCompanyLogs,companyLogConfigurationSchema} from '../../packages/company/src/log-configuration.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import {companyLogsContractHash} from '../../packages/company/src/log-contracts.js';
import {companyCodeBindingHash} from '../../packages/company/src/code.js';
import {companyLogsBindingHash} from '../../packages/company/src/logs.js';
import {companyFixture,syntheticRepo,syntheticCommit,syntheticPath} from '../support/company-mcp.js';
import {companyLogsFixture,syntheticLogQuery} from '../support/company-logs-mcp.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,12);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await root.end();});
const readName=toolName('company.code.read','1.0.0'),logName=toolName('company.logs.query','1.0.0');
const readArgs={repo:syntheticRepo,commit:syntheticCommit,path:syntheticPath,startLine:1,endLine:2};
const sourceV2='export const sourceVersion = "v2";\nexport const timeoutMs = 2000;';
const warning='代码与部署／日志版本尚未核实对齐；这些证据仅支持候选解释，不能据此确认根因。';

async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},store=new RuntimeStore(db,vault);
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic T076','ACTIVE')",[ctx.tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic T076','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-t076-robot',appOrigin:'http://localhost:52330'},id=randomUUID();
 const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,senderId:ctx.actorId,conversationId:'synthetic-t076-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'Compare code v2 with production logs reporting v1; identify only candidate explanations until deployed version is verified'},createAt:Date.now(),chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-t076',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string;
 const code=await companyFixture(root,ctx,runId,{text:sourceV2}),logs=await companyLogsFixture(root,ctx,runId),gateway=new Gateway(store),dir=await mkdtemp(join(tmpdir(),'oa-t076-'));
 const connections:{close:()=>Promise<void>}[]=[];
 try{
  await logs.changeSource({rows:[{id:'synthetic-log-v1',timestamp:'2026-10-18T00:01:00.000Z',level:'ERROR',message:'serviceVersion=v1; timeout after 1000ms; deployment correlation not independently verified'}]});
  const token='synthetic-t076-token-01234567890123456789',tokenFile=join(dir,'token');await writeFile(tokenFile,token,{mode:0o600});
  const codeConfig=companyConfigurationSchema.parse({schemaVersion:1,connectorId:code.chat.connectorId,transport:'STREAMABLE_HTTP',server:{name:'synthetic-company-scoped-proxy',version:'1.0.0'},endpoint:'https://code.example/mcp',allowedOrigin:'https://code.example',contractHash:companyContractHash,reviewed:true,readOnlyReviewRef:'SYNTHETIC_T076_READ_ONLY_REVIEW',actorResourceReviewRef:'SYNTHETIC_T076_ACTOR_RESOURCE_REVIEW',auth:{mode:'API_KEY',tokenFile},timeoutMs:1000,maxConcurrent:2});
  const logConfig=companyLogConfigurationSchema.parse({schemaVersion:1,connectorId:logs.adapter.connectorId,transport:'STREAMABLE_HTTP',server:{name:'synthetic-log-proxy',version:'1.0.0'},endpoint:'https://logs.example/mcp',allowedOrigin:'https://logs.example',contractHash:companyLogsContractHash,reviewed:true,readOnlyReviewRef:'SYNTHETIC_T076_READ_ONLY_REVIEW',actorResourceReviewRef:'SYNTHETIC_T076_ACTOR_RESOURCE_REVIEW',redactionPolicyReviewRef:'SYNTHETIC_T076_FIELDS_EGRESS_REVIEW',auth:{mode:'API_KEY',tokenFile},timeoutMs:1000,maxConcurrent:2});
  const codePath=join(dir,'code.json'),logPath=join(dir,'logs.json');await writeFile(codePath,JSON.stringify(codeConfig),{mode:0o600});await writeFile(logPath,JSON.stringify(logConfig),{mode:0o600});
  const codeBinding=hash(canonical({config:codeConfig,credentialHash:hash(token)})),logBinding=hash(canonical({config:logConfig,credentialHash:hash(token)})),codeMethods:string[]=[];
  // The real HTTP SDK client forwards to the existing independent SDK server
  // fixture, whose CHECK/READ handler enforces its own PG authority.
  const codeFetcher:typeof fetch=async(input,init)=>{
   expect(String(input)).toBe(codeConfig.endpoint);expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);expect(init?.redirect).toBe('error');
   const body=JSON.parse(init!.body as string);codeMethods.push(body.method);
   if(body.method==='notifications/initialized')return new Response(null,{status:202});
   const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:codeConfig.server}:body.method==='tools/list'?await code.client.listTools(body.params):body.method==='tools/call'?await code.client.callTool(body.params):null;
   if(result===null)throw Error('T076_UNEXPECTED_CODE_HTTP_METHOD');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
  };
  const c=await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:codePath},codeFetcher,[{id:'company.code.read',version:'1.0.0',bindingHash:companyCodeBindingHash('company.code.read',codeConfig.connectorId,codeBinding)}]);connections.push(c);expect(c.enabled).toBe(true);
  const l=await configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:logPath},logs.httpFetcher(token),[{id:'company.logs.query',version:'1.0.0',bindingHash:companyLogsBindingHash(logConfig.connectorId,logBinding)}]);connections.push(l);expect(l.enabled).toBe(true);
  await root.query('UPDATE company_log_scopes SET connection_binding=$1 WHERE id=$2',[logBinding,logs.scope.id]);logs.scope.version=2;await logs.changeSource({version:2});
  for(const [capability,bindingHash,resource] of [
   ['company.code.read',companyCodeBindingHash('company.code.read',codeConfig.connectorId,codeBinding),code.resource],
   ['company.code.search',companyCodeBindingHash('company.code.search',codeConfig.connectorId,codeBinding),code.resource],
   ['company.logs.query',companyLogsBindingHash(logConfig.connectorId,logBinding),'logs:payments-api@PRODUCTION']
  ]){
   await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,'READ','READY')",[ctx.tenantId,randomUUID(),capability,bindingHash]);
   await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,capability,resource]);
  }
  let models=0,queryId='';
  const model=new GlmProvider({apiKey:'synthetic-t076-model',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
   models++;const body=JSON.parse(init!.body as string) as {messages:ProviderMessage[];tools:{function:{name:string}}[]};
   expect(body.tools.map(t=>t.function.name).sort()).toEqual([readName,toolName('company.code.search','1.0.0'),logName].sort());
   let delta:Record<string,unknown>;
   if(models===1)delta={role:'assistant',tool_calls:[{index:0,id:'t076-code',type:'function',function:{name:readName,arguments:JSON.stringify(readArgs)}},{index:1,id:'t076-logs',type:'function',function:{name:logName,arguments:JSON.stringify(syntheticLogQuery)}}]};
   else{
    const codeResult=JSON.parse(body.messages.find(m=>m.tool_call_id==='t076-code')!.content!),logResult=JSON.parse(body.messages.find(m=>m.tool_call_id==='t076-logs')!.content!);
    expect(codeResult).toMatchObject({status:'OK',data:{fragment:{snippet:sourceV2,commit:syntheticCommit,path:syntheticPath}}});
    expect(logResult).toMatchObject({status:'OK',data:{deploymentVersionVerification:'UNVERIFIED',rows:[{message:expect.stringContaining('serviceVersion=v1')}]}});queryId=logResult.data.queryId;
    // No narrative can manufacture alignment or a definite root cause; both
    // values must be exact, currently authorized source-backed facts.
    delta={role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:'t076-code'},pointer:'/fragment',expected:codeResult.data.fragment,coverage:'COMPLETE'},{kind:'VALUE',ref:{kind:'TOOL_CALL',id:'t076-logs'},pointer:'/rows',expected:logResult.data.rows,coverage:'COMPLETE'}],outcome:'PARTIAL'})};
   }
   return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:models===1?'tool_calls':'stop'}],usage:{prompt_tokens:40,completion_tokens:10,total_tokens:50}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const runtime=new AgentRuntime(store,model,gateway),state=async()=>(await new TaskStore(db).get(ctx,task.taskId))!.runs[0];
  return {ctx,store,gateway,binding,taskId:task.taskId,runId,code,logs,runtime,state,models:()=>models,queryId:()=>queryId,codeMethods,close:async()=>{for(const connection of connections)await connection.close();await code.close();await logs.close();await rm(dir,{recursive:true,force:true});}};
 }catch(error){for(const connection of connections)await connection.close();await code.close();await logs.close();await rm(dir,{recursive:true,force:true});throw error;}
}

it.each(['current','code-revoked','logs-revoked'] as const)('T076 combined native HTTP MCP and SSE code-v2/log-v1 evidence: %s',async mode=>{
 const w=await world();try{
  await w.runtime.advance(w.ctx,w.runId);
  const state=await w.state();expect(state).toMatchObject({status:'PARTIAL',result_classification:'CONFIDENTIAL'});
  const result=state.result as string;for(const part of ['v2','serviceVersion=v1',syntheticCommit,syntheticPath,w.queryId(),'UNVERIFIED',warning])expect(result).toContain(part);
  expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,result)).toBe(true);
  for(const methods of [w.codeMethods,w.logs.httpMethods])for(const method of ['initialize','tools/list','tools/call'])expect(methods).toContain(method);
  expect(w.code.counts()).toMatchObject({initialized:true,reads:1});expect(w.logs.counts()).toMatchObject({initialized:true,queries:1});
  const actions=(await root.query('SELECT capability_id,state,result FROM tool_actions WHERE run_id=$1 ORDER BY capability_id',[w.runId])).rows;
  expect(actions.map(a=>({capability:a.capability_id,state:a.state}))).toEqual([{capability:'company.code.read',state:'VERIFIED'},{capability:'company.logs.query',state:'VERIFIED'}]);
  expect(JSON.stringify(actions)).not.toContain('sourceVersion');expect(JSON.stringify(actions)).not.toContain('serviceVersion=v1');
  await w.runtime.advance(w.ctx,w.runId);expect(w.models()).toBe(2);expect(w.code.counts().reads).toBe(1);expect(w.logs.counts().queries).toBe(1);
  const deliveries=(await db.scope(w.ctx,c=>c.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId]))).rows;expect(deliveries).toHaveLength(1);
  if(mode==='code-revoked')await w.code.changeSource({authorized:false});if(mode==='logs-revoked')await w.logs.changeSource({authorized:false});
  let sends=0;const sender=new DeliveryGateway(db,vault,{sendReply:async(_target,text)=>{sends++;expect(text).toContain(warning);expect(text).toContain(w.queryId());return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('T076_PROACTIVE_FORBIDDEN');}},w.binding,Date.now,(...a)=>w.gateway.finalSourcesAllowed(...a));
  expect(await sender.process(w.ctx,deliveries[0].id,new AbortController().signal)).toBe(mode==='current'?'APPLIED_UNVERIFIED':'SUPPRESSED');expect(sends).toBe(mode==='current'?1:0);
  expect(await sender.process(w.ctx,deliveries[0].id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(mode==='current'?1:0);
  expect(await w.gateway.finalResultAllowed(w.ctx,w.runId,result)).toBe(mode==='current');
  expect(w.models()).toBe(2);expect(w.code.counts().reads).toBe(1);expect(w.logs.counts().queries).toBe(1);
 }finally{await w.close();}
},60000);
