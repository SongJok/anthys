import '../support/isolation.js';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {config,secret} from '../../packages/config/src/index.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {CompanyAgentWorker} from '../../packages/company/src/agent-worker.js';
import {connectCompanyAgent} from '../../packages/company/src/agent-connection.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {createServer} from '../../apps/api/src/server.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {companyAgentWorld} from '../support/company-agent-world.js';
import {artifactWorld} from '../support/artifact-world.js';

// This fixture uses the real local API/PG/SDK. Only the upstream HTTP transport
// is synthetic; it never delegates to global fetch or reads provider env keys.
const origin='http://localhost:64702',endpoint='https://synthetic-enterprise.invalid/mcp';
const toolSchema={type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}};
const isolated=await groupReminderDatabase(),vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
let directory:string|undefined,app:Awaited<ReturnType<typeof createServer>>['app']|undefined,closing:Promise<void>|undefined;
const controllers:AbortController[]=[],workers:Promise<unknown>[]=[],worlds:Awaited<ReturnType<typeof companyAgentWorld>>[]=[],proofs=new Map<string,{calls:number}>(),workerErrors=new Set<string>();
const close=()=>closing??=(async()=>{
 for(const controller of controllers)controller.abort();
 await Promise.allSettled(workers);await app?.close();await isolated.close();
 if(directory)await rm(directory,{recursive:true,force:true});
})();
try{
 await isolated.install();directory=await realpath(await mkdtemp(join(tmpdir(),'oa-company-agent-browser-')));
 const store=new RuntimeStore(isolated.db,vault),gateway=new Gateway(store),artifacts=new TaskResultArtifacts(isolated.db,vault,new EncryptedFileStore(join(directory,'files'),vault),gateway);
 for(let index=0;index<2;index++){
  const w=await companyAgentWorld(isolated,vault);w.admission.inputSchemaHash=agentChatInputSchemaHash(toolSchema);
  w.admission.waitBudgetMs=120000;w.admission.budgetExpiresAt=new Date(Date.now()+5*60*1000).toISOString();
  worlds.push(w);proofs.set(w.ctx.actorId,{calls:0});
 }
 const companyRequests={list:async(ctx:Parameters<Awaited<ReturnType<typeof companyAgentWorld>>['ledger']['list']>[0],taskId:string)=>{
  const w=worlds.find(item=>item.ctx.tenantId===ctx.tenantId&&item.ctx.actorId===ctx.actorId);
  return w?w.ledger.list(ctx,taskId):null;
 }};
 const api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:secret('SESSION_SECRET')!,companyRequests,finalReader:gateway,artifacts,webRoot:resolve('dist/web')});app=api.app;
 // Fixture-only, authenticated local proof endpoint. It observes real durable
 // rows and physical synthetic tools/call count; it cannot create/replay work.
 app.get('/api/v1/browser-company-agent-proof',async(req,reply)=>{
  reply.header('cache-control','private, no-store');const w=worlds.find(item=>item.ctx.tenantId===req.principal?.tenantId&&item.ctx.actorId===req.principal.actorId);
  if(!w)return reply.code(404).send({error:{code:'NOT_FOUND'}});
  const row=await w.row(),proof=proofs.get(w.ctx.actorId)!;
  return {data:{calls:proof.calls,state:row?.state,remoteCancellation:row?.remote_cancellation,enterpriseCost:row?.enterprise_cost,workerFailed:workerErrors.has(w.ctx.actorId)}};
 });
 const fixtures:Record<string,unknown>={};
 for(const [index,project] of ['desktop','mobile'].entries()){
  const w=worlds[index]!,owner=await api.sessions.create(w.ctx),ordinary=await new TaskStore(isolated.db).create(w.ctx,'SYNTHETIC ordinary local task','ordinary-'+randomUUID());
  assert.equal((await w.enqueue()).status,'DEFERRED');const controller=new AbortController();controllers.push(controller);
  const token=randomBytes(32).toString('hex'),proof=proofs.get(w.ctx.actorId)!;
  const fetcher:typeof fetch=async(input,init)=>{
   assert.equal(String(input),endpoint);assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);
   if(init?.method==='DELETE')return new Response(null,{status:204});
   assert.equal(init?.method,'POST');assert.equal(typeof init.body,'string');
   const request=JSON.parse(init.body as string) as {id?:number|string;method:string;params?:{protocolVersion?:string;arguments?:unknown}};
   if(request.method==='notifications/initialized'||request.method==='notifications/cancelled')return new Response(null,{status:202});
   if(request.method==='tools/call'){
    proof.calls++;
    assert.deepEqual(request.params?.arguments,{message:'SYNTHETIC exact question'});
    // Local cancellation releases this fixture transport; this does not prove
    // a real enterprise service has stopped remote computation.
    return new Promise<Response>((_resolve,reject)=>{
     const aborted=()=>reject(new Error('SYNTHETIC_LOCAL_ABORT'));
     if(init.signal?.aborted)aborted();else init.signal?.addEventListener('abort',aborted,{once:true});
    });
   }
   const result=request.method==='initialize'?{protocolVersion:request.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-browser-agent',version:'1'}}:request.method==='tools/list'?{tools:[{name:'chat',inputSchema:toolSchema}]}:null;
   assert.ok(result,'Unexpected synthetic SDK method');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
  };
  const worker=new CompanyAgentWorker(w.ledger,(row,signal)=>connectCompanyAgent({connectorId:w.admission.connectorId,endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(endpoint),credentialHash:hash(token),server:{name:'synthetic-browser-agent',version:'1'},toolName:'chat',inputSchemaHash:w.admission.inputSchemaHash},{signal,absoluteDeadlineMs:row.deadline.getTime()},{AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token},fetcher));
  workers.push(worker.once(w.ctx,controller.signal,'browser-'+project).catch(()=>{workerErrors.add(w.ctx.actorId);controller.abort();}));
  const artifact=await artifactWorld({isolated,store,gateway,sessions:api.sessions},origin);
  fixtures[project]={ownerCookie:owner.cookie,taskId:w.taskId,runId:w.runId,ordinaryTaskId:ordinary.taskId,artifactCookie:artifact.owner.cookie,artifactTaskId:artifact.taskId,isolatedDatabase:isolated.name};
 }
 await writeFile('.data/test-environment/browser-company-agent.json',JSON.stringify(fixtures),{mode:0o600});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
 await app.listen({host:'127.0.0.1',port:64702});
}catch(error){await close();throw error;}
