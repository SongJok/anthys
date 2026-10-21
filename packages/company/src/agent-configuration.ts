import type {FormalProfile} from '../../config/src/formal-profile.js';
import {openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {canonical,type Gateway} from '../../gateway/src/index.js';
import {Vault,hash} from '../../storage/src/crypto.js';
import type {DbContext} from '../../storage/src/database.js';
import {agentPilotPolicySchema,agentPilotBindings,registerCompanyAgent} from './agent-capability.js';
import {agentGroupPilotPolicySchema,agentGroupPilotBindings} from './agent-group-policy.js';
import {registerGroupCompanyAgent} from './agent-group-capability.js';
import {connectCompanyAgent,companyAgentEndpoint} from './agent-connection.js';
import {AgentTransportError} from './agent-transport.js';
import {CompanyAgentWorker} from './agent-worker.js';
function readPrivatePolicy(path:string){
 let fd:number|undefined;
 try{
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);
  if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size<2||stat.size>262144)throw Error();
  const body=Buffer.alloc(stat.size+1);let count=0;
  while(count<body.length){const n=readSync(fd,body,count,body.length-count,null);if(!n)break;count+=n;}
  if(count!==stat.size)throw Error();
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(0,count))) as {kind?:unknown};const policy=raw.kind==='ENTERPRISE_AGENT_GROUP_MENTION_PILOT'?agentGroupPilotPolicySchema.parse(raw):agentPilotPolicySchema.parse(raw);
  return {policy,hash:hash(canonical(policy))};
 }catch{throw new AgentTransportError('AGENT_PRIVATE_POLICY_INVALID');}
 finally{if(fd!==undefined)closeSync(fd);}
}
/** Default is disconnected. Existing AIDER_AI_* values alone never opt in.
 * This private manifest carries reviewed pins/scope, not replacement endpoints
 * or token files. Startup registers a local capability; it makes zero HTTP calls. */
export function configureCompanyAgent(gateway:Gateway,vault:Vault,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch,approved?:readonly {id:string;version:string;bindingHash:string}[],formal?:FormalProfile){
 const path=env['COMPANY_AGENT_PILOT_POLICY_FILE'];if(!path||approved!==undefined&&!approved.some(a=>a.id==='company.agent.ask'&&a.version==='1.0.0'))return undefined;
 const reviewed=readPrivatePolicy(path),p=reviewed.policy;companyAgentEndpoint(p.connection,env);let closed=false;
 const current=()=>{
  try{return !closed&&readPrivatePolicy(path).hash===reviewed.hash&&hash(env[p.connection.endpointKey]??'')===p.connection.endpointHash&&hash(env['AIDER_AI_DD_MCP_TOKEN']??'')===p.connection.credentialHash;}catch{return false;}
 };
 if(!current())throw new AgentTransportError('AGENT_CONNECTION_CONFIGURATION_CHANGED');
 // Inspect the binding before registration so a narrower FORMAL profile does
 // not accidentally expose a different candidate to the model or source reader.
 const bindings=(p.kind==='ENTERPRISE_AGENT_GROUP_MENTION_PILOT'?agentGroupPilotBindings(p):agentPilotBindings(p)).bindingHash;
 if(approved!==undefined&&!approved.some(a=>a.id==='company.agent.ask'&&a.version==='1.0.0'&&a.bindingHash===bindings))return undefined;
 if(formal?.schemaVersion===2){
  const g=formal.group;
  if(p.kind!=='ENTERPRISE_AGENT_GROUP_MENTION_PILOT'||p.tenantId!==formal.tenantId||p.actorId!==formal.actorId||reviewed.hash!==g.enterprisePolicyHash
   ||p.group.conversationId!==formal.conversationId||p.group.contractId!==g.contractId||p.group.contractVersion!==g.contractVersion||p.group.contractHash!==g.contractHash
   ||p.group.scopeId!==g.scopeId||p.group.scopeVersion!==g.scopeVersion||p.group.membershipHash!==g.membershipHash||p.group.directoryHash!==g.directoryHash
   ||p.group.audienceReviewRef!==g.audienceReviewReference||p.group.sharingReviewRef!==g.sharingReviewReference
   ||p.scope.questionHashes.length!==1||p.scope.questionHashes[0]!==g.questionHash||'enterprise-agent:'+p.scope.id!==g.enterpriseResource
   ||Date.parse(p.validFrom)>Date.parse(formal.validFrom)||Date.parse(p.validUntil)<Date.parse(formal.validUntil)
   ||p.budget.maxDispatched!==1||p.budget.maxUnresolved!==1||Date.parse(p.budget.expiresAt)<Date.parse(formal.validUntil))throw new AgentTransportError('AGENT_FORMAL_GROUP_TARGET_MISMATCH');
 }
 const groupService=p.kind==='ENTERPRISE_AGENT_GROUP_MENTION_PILOT'?registerGroupCompanyAgent(gateway,vault,p,current):undefined;const service=groupService??registerCompanyAgent(gateway,vault,agentPilotPolicySchema.parse(p),current),controller=new AbortController();let active:Promise<boolean>|undefined;
 const worker=new CompanyAgentWorker(service.requests,async(row,signal)=>{
  if(!current()||row.upstream_hash!==service.upstreamHash||row.connection_hash!==service.connectionHash||row.scope_hash!==service.scopeHash||row.budget_hash!==service.budgetHash||row.connector_id!==p.connection.connectorId||row.input_schema_hash!==p.connection.inputSchemaHash||row.tool_name!==p.connection.toolName)throw new AgentTransportError('AGENT_REQUEST_CONFIGURATION_CHANGED');
  return connectCompanyAgent(p.connection,{signal,absoluteDeadlineMs:row.deadline.getTime()},env,fetcher);
 },groupService?.observe);
 const scope:DbContext={tenantId:p.tenantId,actorId:p.actorId};
 /** A poll cycle never awaits a 1–20 minute business wait. One independently
  * renewed worker runs per process; the durable connector limit covers peers. */
 const poll=async()=>{
  if(controller.signal.aborted||active)return;
  await service.requests.recover(scope,controller.signal);if(controller.signal.aborted||active)return;
  active=worker.once(scope,controller.signal);void active.catch(()=>{console.error('ENTERPRISE_REQUEST_WORKER_FAILED');}).finally(()=>{active=undefined;});
 };
 return {...service,scope,poll,close:async()=>{closed=true;controller.abort(new Error('SERVICE_SHUTDOWN'));await active?.catch(()=>{});}};
}
