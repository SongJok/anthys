import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {groupReminderDatabase} from './group-reminder-database.js';
import {syntheticResultContract} from './capability-result-contract.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {CompanyAgentRequests,type AgentRequestClaim} from '../../packages/company/src/agent-requests.js';
const signal=()=>new AbortController().signal;
export async function companyAgentWorld(isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,vault:Vault,options:{tenantId?:string;connectorId?:string;maxUnresolved?:number;maxDispatched?:number;afterEnqueue?:()=>Promise<void>}={}){
 const ctx={tenantId:options.tenantId??randomUUID(),actorId:randomUUID()},root=isolated.root;
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC AGENT','ACTIVE') ON CONFLICT DO NOTHING",[ctx.tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const store=new RuntimeStore(isolated.db,vault),gateway=new Gateway(store),connectorId=options.connectorId??'synthetic.'+randomUUID(),resource='enterprise:'+connectorId,bindingHash=hash(resource),schema=z.object({message:z.string().min(1)}).strict(),scopeHash=hash(resource+ctx.actorId),budgetHash=hash(ctx.actorId+'approval');
 const admission={connectorId,toolName:'chat',upstreamHash:hash(connectorId),connectionHash:hash('synthetic-connection'),inputSchemaHash:hash('synthetic-input-schema'),scopeHash,budgetHash,waitBudgetMs:60000,budgetExpiresAt:new Date(Date.now()+120000).toISOString(),maxDispatched:options.maxDispatched??3,maxUnresolved:options.maxUnresolved??1};
 let enqueueError:unknown,authorityGate:()=>Promise<void>=async()=>{};
 const ledger=new CompanyAgentRequests(store,vault,async(c,actor,row,abort)=>{abort.throwIfAborted();const allowed=row.scope_hash===scopeHash&&row.connection_hash===admission.connectionHash&&!!(await c.query("SELECT id FROM resource_grants WHERE actor_id=$1 AND capability_id='company.agent.ask' AND resource_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[actor.actorId,resource])).rowCount;await authorityGate();return allowed;});
 gateway.register({...syntheticResultContract,id:'company.agent.ask',version:'1.0.0',description:'Synthetic durable enterprise chat',risk:'READ',provider:'MCP',connectorId,bindingHash,state:'READY',schema,jsonSchema:z.toJSONSchema(schema),protectResult:true,deferredExecution:true,resource:()=>resource,allowResource:async(_args,{principal},c,cached)=>{
  if(principal.tenantId!==ctx.tenantId||principal.actorId!==ctx.actorId||!(await c.query("SELECT id FROM resource_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[grantId])).rowCount)return false;
  if(cached==null)return true;
  const data=(cached as {data?:{requestId?:string;source?:{scopeHash?:string;receiptHash?:string}}}).data;
  if(!data?.requestId||data.source?.scopeHash!==scopeHash)return false;
  return !!(await c.query("SELECT id FROM company_agent_requests WHERE id=$1 AND state='RESPONSE_RECEIVED' AND response_hash=$2 AND response_ref IS NOT NULL AND scope_hash=$3 AND connection_hash=$4",[data.requestId,data.source.receiptHash,scopeHash,admission.connectionHash])).rowCount;
 },execute:async(args,context)=>{try{const pending=await ledger.enqueue(context.principal,context.lease,context.actionKey,(args as {message:string}).message,admission,context.signal);await options.afterEnqueue?.();return {status:'DEFERRED',requestId:pending.id,evidenceIds:[],completeness:'UNKNOWN'};}catch(error){enqueueError=error;throw error;}}});
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.agent.ask','1.0.0','{}',$3,'READ','READY') ON CONFLICT DO NOTHING",[ctx.tenantId,randomUUID(),bindingHash]);
 const grantId=randomUUID();await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.agent.ask',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',clock_timestamp()+interval '1 hour')",[ctx.tenantId,grantId,ctx.actorId,resource]);
 const task=await new TaskStore(isolated.db).create(ctx,'SYNTHETIC enterprise question','synthetic-'+randomUUID()),lease=(await store.acquire(ctx,task.runId,'synthetic-ledger'))!;
 const enqueue=async()=>{const result=await gateway.execute(ctx,lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal());if(enqueueError)throw enqueueError;return result;};
 const row=async()=>{const q=await root.query('SELECT * FROM company_agent_requests WHERE run_id=$1',[task.runId]);return q.rows[0];};
 const begin=async(claim:AgentRequestClaim)=>{const loaded=await ledger.load(ctx,claim,signal());await ledger.beforeDispatch(ctx,claim,{localRequestId:claim.id,toolName:'chat',inputSchemaHash:admission.inputSchemaHash,messageSha256:hash(loaded.message),messageBytes:Buffer.byteLength(loaded.message),absoluteDeadlineMs:loaded.row.deadline.getTime()},signal());return loaded;};
 const reply=(id:string)=>({status:'RESPONSE_RECEIVED' as const,localRequestId:id,text:'SYNTHETIC raw upstream response',textBlocks:['SYNTHETIC raw upstream response'],source:{protocol:'MCP' as const,toolName:'chat',inputSchemaHash:admission.inputSchemaHash,receivedAt:new Date().toISOString(),verification:'UNVERIFIED' as const,notice:'No enterprise facts verified.'}});
 return {ctx,root,store,gateway,ledger,admission,grantId,...task,lease,enqueue,row,begin,reply,setAuthorityGate:(gate:()=>Promise<void>)=>{authorityGate=gate;}};
}
