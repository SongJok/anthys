import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {registerCompanyCodeCapabilities,companyCodeBindingHash} from '../../packages/company/src/code.js';
import {registerCompanyLogCapabilities,companyLogsBindingHash} from '../../packages/company/src/logs.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from '../../packages/company/src/data.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import '../support/isolation.js';
import {companyFixture,syntheticRepo,syntheticCommit,syntheticPath} from '../support/company-mcp.js';
import {companyLogsFixture,syntheticLogQuery} from '../support/company-logs-mcp.js';
import {companyDataFixture,syntheticDataQuery} from '../support/company-data-mcp.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault),tasks=new TaskStore(appDb),closers:(()=>Promise<void>)[]=[];
afterAll(async()=>{for(const close of closers)await close();await db.close();await appDb.close();await root.end();});
const signal=()=>new AbortController().signal,readName=toolName('company.code.read','1.0.0'),logName=toolName('company.logs.query','1.0.0'),dataName=toolName('company.data.query','1.0.0');
const readArgs={repo:syntheticRepo,commit:syntheticCommit,path:syntheticPath,startLine:2,endLine:2};
async function start(ctx:{tenantId:string;actorId:string},goal:string){
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-upstream-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,conversationId:'synthetic-upstream-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:goal},createAt:Date.now(),senderId:ctx.actorId,chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-upstream',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,lease=(await store.acquire(ctx,runId,'synthetic-upstream'))!;
 return {taskId:task.taskId,runId,lease};
}
async function tenant(label:string){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,$2,'ACTIVE')",[ctx.tenantId,label]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,$3,'ACTIVE')",[ctx.tenantId,ctx.actorId,label]);return ctx;
}
async function freshCode(){
 const ctx=await tenant('synthetic upstream code'),{taskId,runId,lease}=await start(ctx,'Read the exact payment rate source'),fixture=await companyFixture(root,ctx,runId);closers.push(()=>fixture.close());
 const gateway=new Gateway(store);registerCompanyCodeCapabilities(gateway,fixture.chat);
 for(const id of ['company.code.search','company.code.read']){await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,'READ','READY')",[ctx.tenantId,randomUUID(),id,companyCodeBindingHash(id,fixture.chat.connectorId,fixture.chat.connectionBinding)]);await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,id,fixture.resource]);}
 return {ctx,taskId,runId,lease,fixture,gateway,name:readName,args:readArgs,capability:'company.code.read'};
}
async function freshLogs(){
 const ctx=await tenant('synthetic upstream logs'),{taskId,runId,lease}=await start(ctx,'Query exact authorized production logs'),fixture=await companyLogsFixture(root,ctx,runId);closers.push(()=>fixture.close());
 const gateway=new Gateway(store);registerCompanyLogCapabilities(gateway,fixture.adapter);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.logs.query','1.0.0','{}',$3,'READ','READY')",[ctx.tenantId,randomUUID(),companyLogsBindingHash(fixture.adapter.connectorId,fixture.adapter.connectionBinding)]);await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.logs.query','logs:payments-api@PRODUCTION','PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId]);
 return {ctx,taskId,runId,lease,fixture,gateway,name:logName,args:syntheticLogQuery,capability:'company.logs.query'};
}
async function freshData(){
 const ctx=await tenant('synthetic upstream data'),{taskId,runId,lease}=await start(ctx,'Query the certified payments success-rate template'),fixture=await companyDataFixture(root,ctx,runId);closers.push(()=>fixture.close());
 const gateway=new Gateway(store);registerCompanyDataCapabilities(gateway,fixture.adapter);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.data.query','1.0.0','{}',$3,'READ','READY')",[ctx.tenantId,randomUUID(),companyDataBindingHash(fixture.adapter.connectorId,fixture.adapter.connectionBinding,fixture.adapter.toolName,fixture.adapter.inputSchemaHash,fixture.adapter.templates.registryHash)]);await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,fixture.resource]);
 return {ctx,taskId,runId,lease,fixture,gateway,name:dataName,args:syntheticDataQuery,capability:'company.data.query'};
}
const fresh={code:freshCode,logs:freshLogs,data:freshData};
async function actions(runId:string){return (await root.query('SELECT capability_id,state,retry_safety FROM tool_actions WHERE run_id=$1',[runId])).rows;}
it('T027 component: an upstream missing-scope refusal asks for exactly the scopes the upstream named, on code, log and data',async()=>{
 for(const kind of ['code','logs','data'] as const){
  const f=await fresh[kind]();f.fixture.modes.upstreamError={kind:'MISSING_SCOPES',requiredScopes:['scope.payments.read','scope.payments.write']};
  const result=await f.gateway.execute(f.ctx,f.lease,f.name,f.args,signal());
  expect(result.status,kind).toBe('NEEDS_AUTH');
  expect(result.remediation,kind).toEqual({kind:'UPSTREAM_MISSING_SCOPES',requiredScopes:['scope.payments.read','scope.payments.write']});
  expect(result.data,kind).toBeUndefined();
  expect(result.completeness,kind).toBe('UNKNOWN');
  const rows=await actions(f.runId);
  expect(rows,kind).toHaveLength(1);
  expect(rows[0],kind).toMatchObject({capability_id:f.capability,state:'PREPARED',retry_safety:'CERTIFIED_READ'});
 }
});
it('T026 component: an upstream resource denial and an unavailable application stay refusals and never request a scope',async()=>{
 for(const [kind,status,remediation] of [['RESOURCE_ACCESS_DENIED','DENIED','UPSTREAM_RESOURCE_ACCESS_DENIED'],['APPLICATION_UNAVAILABLE','PERMANENT_ERROR','UPSTREAM_APPLICATION_UNAVAILABLE']] as const){
  for(const target of ['code','logs','data'] as const){
   const f=await fresh[target]();f.fixture.modes.upstreamError={kind};
   const result=await f.gateway.execute(f.ctx,f.lease,f.name,f.args,signal());
   expect(result.status,kind+'/'+target).toBe(status);
   expect(result.remediation,kind+'/'+target).toEqual({kind:remediation});
   expect(result.remediation?.requiredScopes,kind+'/'+target).toBeUndefined();
   expect(result.data,kind+'/'+target).toBeUndefined();
  }
 }
});
it('T027 component: a refusal that cannot be attributed to this call is never presented as a permission problem',async()=>{
 for(const target of ['code','logs','data'] as const){
  for(const mode of ['prose','foreign'] as const){
   const f=await fresh[target]();f.fixture.modes.upstreamError=mode==='prose'?{kind:'MISSING_SCOPES',body:'SYNTHETIC_PROVIDER_DENIED_PRIVATE_SENTINEL'}:{kind:'MISSING_SCOPES',requiredScopes:['scope.payments.read'],foreignScope:true};
   const result=await f.gateway.execute(f.ctx,f.lease,f.name,f.args,signal());
   expect(result.status,target+'/'+mode).toBe('DENIED');
   expect(result.remediation,target+'/'+mode).toEqual({kind:'UPSTREAM_ERROR_UNKNOWN'});
   expect(result.remediation?.requiredScopes,target+'/'+mode).toBeUndefined();
   expect(result.data,target+'/'+mode).toBeUndefined();
  }
 }
});
it('T027 component: a missing-scope refusal pauses the run for the user instead of retrying the upstream',async()=>{
 const f=await freshCode();f.fixture.modes.upstreamError={kind:'MISSING_SCOPES',requiredScopes:['scope.payments.read']};await store.release(f.ctx,f.lease);let models=0;
 const model=new GlmProvider({apiKey:'synthetic-upstream-model',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,_init)=>{models++;const delta=models===1?{role:'assistant',tool_calls:[{index:0,id:'upstream-read',type:'function',function:{name:readName,arguments:JSON.stringify(readArgs)}}]}:{role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[],outcome:'COMPLETE'})};return new Response('data: '+JSON.stringify({id:'synthetic-upstream-'+models,choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:models<2?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
 await new AgentRuntime(store,model,f.gateway).advance(f.ctx,f.runId);
 expect(models).toBe(1);
 expect(await tasks.get(f.ctx,f.taskId)).toMatchObject({runs:[{status:'WAITING_AUTH',last_error:'UPSTREAM_MISSING_SCOPES',result:null}]});
 expect(f.fixture.counts().reads).toBe(0);
 expect(f.fixture.counts().attempts).toBeGreaterThan(0);
 expect((await root.query('SELECT count(*)::int n FROM deliveries WHERE source_run_id=$1',[f.runId])).rows[0].n).toBe(0);
});
