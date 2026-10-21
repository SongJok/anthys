import './isolation.js';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {CompanyAgentRequests,agentRequestAdmissionSchema} from '../../packages/company/src/agent-requests.js';
import {CompanyAgentWorker} from '../../packages/company/src/agent-worker.js';
import {connectCompanyAgent} from '../../packages/company/src/agent-connection.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';

const mode=z.enum(['in-flight','stored-before-resume']).parse(process.argv[2]);
const payloadSchema=z.object({ctx:z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict(),admission:agentRequestAdmissionSchema,databaseName:z.string().regex(/^open_aider_test_group_reminder_[a-f0-9]{32}$/),keyHex:z.string().regex(/^[a-f0-9]{64}$/),grantId:z.uuid()}).strict();
const endpoint='https://synthetic-process-agent.invalid/mcp',text='SYNTHETIC process response; original durable request only.';
const schema={type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}};
const controller=new AbortController();let db:Database|undefined,job:Promise<boolean>|undefined,closing:Promise<void>|undefined,calls=0;
// A test-only process liveness handle, unrelated to production worker leases.
const keepAlive=setInterval(()=>{},1000);
const send=(phase:'READY'|'CALL_STARTED'|'RESPONSE_DURABLE'|'ERROR',requestId?:string)=>process.send?.({phase,calls,...(requestId?{requestId}:{})});
const close=()=>closing??=(async()=>{controller.abort();await job?.catch(()=>{});await db?.close();clearInterval(keepAlive);if(process.connected)process.disconnect();})();
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
process.once('disconnect',()=>{void close().catch(()=>{process.exitCode=1;});});
if(!process.send||!process.connected)throw Error('SYNTHETIC_CHILD_IPC_REQUIRED');
process.once('message',raw=>{void (async()=>{
 const payload=payloadSchema.parse(raw);
 // isolation.js has already checked the inherited original /open_aider_test
 // environment. Derive this one connection URL, never alter process.env or
 // accept a caller-supplied URL, role, endpoint or provider credential.
 const original=secret('RUNTIME_DATABASE_URL');if(!original)throw Error('SYNTHETIC_RUNTIME_DATABASE_REQUIRED');const url=new URL(original);
 if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='53331'||url.pathname!=='/open_aider_test'||url.username!=='oa_runtime'||url.search||url.hash)throw Error('SYNTHETIC_RUNTIME_DATABASE_REJECTED');
 url.pathname='/'+payload.databaseName;db=new Database(url.href,4,3000);
 const vault=new Vault(new Map([['1',Buffer.from(payload.keyHex,'hex')]]),'1'),store=new RuntimeStore(db,vault);
 if(payload.admission.inputSchemaHash!==agentChatInputSchemaHash(schema))throw Error('SYNTHETIC_SCHEMA_MISMATCH');
 const requests=new CompanyAgentRequests(store,vault,async(c,ctx,row,signal)=>{
  signal.throwIfAborted();if(ctx.tenantId!==payload.ctx.tenantId||ctx.actorId!==payload.ctx.actorId||row.scope_hash!==payload.admission.scopeHash||row.connection_hash!==payload.admission.connectionHash||row.budget_hash!==payload.admission.budgetHash||row.upstream_hash!==payload.admission.upstreamHash)return false;
  return !!(await c.query("SELECT id FROM resource_grants WHERE id=$1 AND actor_id=$2 AND capability_id='company.agent.ask' AND resource_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[payload.grantId,ctx.actorId,'enterprise:'+payload.admission.connectorId])).rowCount;
 });
 if(mode==='stored-before-resume')requests.resume=async(_ctx,id,signal)=>{
  // Instance-only failure point: worker already awaited the real complete()
  // commit. No transaction is kept open while awaiting the parent SIGKILL.
  send('RESPONSE_DURABLE',id);
  return new Promise<boolean>(resolve=>{if(signal.aborted)resolve(false);else signal.addEventListener('abort',()=>resolve(false),{once:true});});
 };
 const token='SYNTHETIC_PROCESS_TOKEN_WITH_NO_ENTERPRISE_AUTHORITY';
 const worker=new CompanyAgentWorker(requests,async(row,signal)=>{
  const fetcher:typeof fetch=async(input,init)=>{
   if(String(input)!==endpoint||init?.method!=='POST'||init.redirect!=='error'||new Headers(init.headers).get('authorization')!=='Bearer '+token)throw Error('SYNTHETIC_FETCH_TARGET_REJECTED');
   const request=JSON.parse(init.body as string) as {id?:number|string;method:string;params?:{protocolVersion?:string;name?:string;arguments?:unknown}};
   if(request.method==='notifications/initialized'||request.method==='notifications/cancelled')return new Response(null,{status:202});
   if(request.method==='tools/call'){
    calls++;if(request.params?.name!=='chat'||JSON.stringify(request.params.arguments)!==JSON.stringify({message:'SYNTHETIC exact question'}))throw Error('SYNTHETIC_CALL_ARGUMENTS_REJECTED');send('CALL_STARTED',row.id);
    if(mode==='in-flight')return new Promise<Response>((_resolve,reject)=>{const abort=()=>reject(Error('SYNTHETIC_LOCAL_ABORT'));if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text}]}}),{headers:{'content-type':'application/json'}});
   }
   const result=request.method==='initialize'?{protocolVersion:request.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-process-agent',version:'1'}}:request.method==='tools/list'?{tools:[{name:'chat',inputSchema:schema}]}:null;
   if(!result)throw Error('SYNTHETIC_SDK_METHOD_REJECTED');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
  };
  return connectCompanyAgent({connectorId:payload.admission.connectorId,endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(endpoint),credentialHash:hash(token),server:{name:'synthetic-process-agent',version:'1'},toolName:'chat',inputSchemaHash:payload.admission.inputSchemaHash},{signal,absoluteDeadlineMs:row.deadline.getTime()},{AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token},fetcher);
 });
 job=worker.once(payload.ctx,controller.signal,'synthetic-process-worker');await job;
 if(!controller.signal.aborted)throw Error('SYNTHETIC_CHILD_BOUNDARY_NOT_HELD');
})().catch(async()=>{send('ERROR');process.exitCode=1;await close().catch(()=>{});});});
send('READY');
