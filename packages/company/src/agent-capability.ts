import type pg from 'pg';
import {z} from 'zod';
import {Gateway,canonical,capabilityDescriptorHash,type Capability} from '../../gateway/src/index.js';
import {killed} from '../../gateway/src/controls.js';
import type {DbContext} from '../../storage/src/database.js';
import {trialState} from '../../storage/src/trial.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {agentConnectionPinSchema} from './agent-connection.js';
import {CompanyAgentRequests,type AgentRequestAdmission,type AgentRequestRow,type AgentRequestAuthority} from './agent-requests.js';
import {agentTextDataSchema,agentTextResultContract} from './agent-result.js';
import type {AgentGroupPilotPolicy} from './agent-group-policy.js';
import {companyAgentGroupContext} from './agent-group-runtime.js';
import {groupGovernance} from '../../groups/src/governance.js';
import type {Lease} from '../../runtime/src/store.js';
import type {GroupAudienceContext} from '../../runtime/src/lease-contract.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),reference=z.string().min(8).max(1024);
/** An interim private pilot policy. Exact approved question hashes are host
 * authority, never model-supplied scope or an inference that chat is read-only.
 * Installing this object does not create a binding, resource grant or approval. */
export const agentPilotPolicySchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('ENTERPRISE_AGENT_PRIVATE_PILOT'),id:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),
 connection:agentConnectionPinSchema,validFrom:z.iso.datetime(),validUntil:z.iso.datetime(),approvalReference:reference,
 scope:z.object({id:z.uuid(),topics:z.array(z.enum(['CODE','LOG','DATA'])).min(1).max(3),questionHashes:z.array(sha).min(1).max(1000),readOnlyReviewRef:reference,actorResourceReviewRef:reference,resourceReviewRef:reference,modelEgressAllowed:z.literal(true),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'])}).strict(),
 budget:z.object({id:z.uuid(),approvalReference:reference,expiresAt:z.iso.datetime(),waitBudgetMs:z.number().int().min(1).max(1200000),maxDispatched:z.number().int().min(1).max(1000),maxUnresolved:z.number().int().min(1).max(8),enterpriseCost:z.enum(['UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE','USER_DECLARED_COMPANY_COVERED_NO_INCREMENTAL_CHARGE'])}).strict()
}).strict().superRefine((p,c)=>{
 if(Date.parse(p.validFrom)>=Date.parse(p.validUntil)||Date.parse(p.budget.expiresAt)>Date.parse(p.validUntil)||Date.parse(p.budget.expiresAt)<=Date.parse(p.validFrom))c.addIssue({code:'custom',message:'AGENT_POLICY_WINDOW_INVALID'});
 if(new Set(p.scope.topics).size!==p.scope.topics.length||new Set(p.scope.questionHashes).size!==p.scope.questionHashes.length)c.addIssue({code:'custom',message:'AGENT_POLICY_DUPLICATE_SCOPE'});
});
export type AgentPilotPolicy=z.infer<typeof agentPilotPolicySchema>;
export function agentPilotBindings(raw:AgentPilotPolicy){
 const policy=agentPilotPolicySchema.parse(raw);const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};freeze(policy);const upstreamHash=policy.connection.endpointHash,connectionHash=hash(canonical(policy.connection)),scopeHash=hash(canonical({id:policy.id,tenantId:policy.tenantId,actorId:policy.actorId,connectionHash,scope:policy.scope,validFrom:policy.validFrom,validUntil:policy.validUntil,approvalReference:policy.approvalReference}));
 // An expiry/scope edit cannot silently mint a fresh dispatch allowance. Only
 // a new explicitly approved budget identity changes the cumulative bucket.
 const budgetHash=hash(canonical({tenantId:policy.tenantId,budgetId:policy.budget.id}));
 const bindingHash=hash(canonical({id:'company.agent.ask',version:'1.0.0',policy,outputSchema:agentTextResultContract.outputSchema}));
 return {policy,upstreamHash,connectionHash,scopeHash,budgetHash,bindingHash,resource:'enterprise-agent:'+policy.scope.id};
}
const inputSchema=z.object({message:z.string().min(1).max(65536).refine(v=>!!v.trim()&&Buffer.byteLength(v,'utf8')<=65536)}).strict();
/** No network, grant mutation or environment loading during registration. The
 * separately scheduled worker opens the existing reviewed MCP for one row. */
export function registerCompanyAgent(gateway:Gateway,vault:Vault,raw:AgentPilotPolicy,isCurrent:()=>boolean=()=>true){
 return registerScopedCompanyAgent(gateway,vault,agentPilotBindings(raw),isCurrent);
}
/** Shared journal mechanics; group certification belongs exclusively to the
 * separate reviewed group factory, never this internal registration helper. */
export function registerScopedCompanyAgent(gateway:Gateway,vault:Vault,b:Omit<ReturnType<typeof agentPilotBindings>,'policy'>&{policy:AgentPilotPolicy|AgentGroupPilotPolicy},isCurrent:()=>boolean=()=>true,dispatchAuthority?:AgentRequestAuthority){
 const p=b.policy,group=p.kind==='ENTERPRISE_AGENT_GROUP_MENTION_PILOT'?p.group:null;
 const admission:AgentRequestAdmission={connectorId:p.connection.connectorId,toolName:p.connection.toolName,upstreamHash:b.upstreamHash,connectionHash:b.connectionHash,inputSchemaHash:p.connection.inputSchemaHash,scopeHash:b.scopeHash,budgetHash:b.budgetHash,waitBudgetMs:p.budget.waitBudgetMs,budgetExpiresAt:p.budget.expiresAt,maxDispatched:p.budget.maxDispatched,maxUnresolved:p.budget.maxUnresolved};
 const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'];
 const local=async(c:pg.PoolClient,ctx:DbContext,runId:string,audience:Record<string,unknown>,messageHash:string,signal:AbortSignal,context?:Lease|GroupAudienceContext)=>{
  signal.throwIfAborted();await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${ctx.tenantId}:company-agent:kill`]);if(!isCurrent())return false;if(ctx.tenantId!==p.tenantId||ctx.actorId!==p.actorId||!p.scope.questionHashes.includes(messageHash)||levels.indexOf(String(audience['classificationCeiling']))<levels.indexOf(p.scope.classification))return false;
  if(group){
   if(audience['kind']!=='GROUP'||audience['targetId']!==group.conversationId||audience['classificationCeiling']!=='INTERNAL'||!context||!gateway.store.groupAudiences)return false;
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${ctx.tenantId}:group-contract:${group.conversationId}`]);
   const governance=await groupGovernance(c,group.conversationId);if(governance.mode!=='CONTRACT'||!governance.allowed||governance.id!==group.contractId||governance.version!==group.contractVersion||governance.hash!==group.contractHash||!await gateway.store.groupAudiences.currentLocal(c,ctx,context))return false;
   const approved=(await c.query('SELECT proof_ref,proof_hash FROM run_group_audiences WHERE id=$1 AND run_id=$2 AND scope_id=$3 AND scope_version=$4',[context.groupAudience?.id,runId,group.scopeId,group.scopeVersion])).rows[0];if(!approved)return false;
   const proof=JSON.parse(vault.open(approved.proof_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:group-audience:${context.groupAudience?.id}`)) as Record<string,unknown>;
   if(hash(canonical(proof))!==context.groupAudience?.hash||approved.proof_hash!==context.groupAudience.hash||proof['membershipHash']!==group.membershipHash||proof['directoryHash']!==group.directoryHash)return false;
  }else if(audience['kind']!=='PRIVATE_USER'||audience['targetId']!==ctx.actorId)return false;
  const current=(await c.query('SELECT clock_timestamp()>=$1::timestamptz AND clock_timestamp()<$2::timestamptz AND clock_timestamp()<$3::timestamptz live',[p.validFrom,p.validUntil,p.budget.expiresAt])).rows[0]?.live;if(!current)return false;
  const lifecycle=await trialState(c,runId,true);if(lifecycle.restricted&&(lifecycle.mode!=='FORMAL'||!lifecycle.allowed||!lifecycle.capabilities?.some(a=>a.id==='company.agent.ask'&&a.version==='1.0.0'&&a.bindingHash===b.bindingHash)))return false;
  const task=(await c.query('SELECT task_id FROM runs WHERE id=$1',[runId])).rows[0];if(!task||await killed(c,ctx,{taskId:task.task_id,audience},p.connection.connectorId,false))return false;
  if(!(await c.query("SELECT id FROM capability_bindings WHERE logical_id='company.agent.ask' AND semantic_version='1.0.0' AND schema_hash=$1 AND risk='READ' AND state='READY'",[b.bindingHash])).rowCount)return false;
  const grants=await c.query("SELECT id FROM resource_grants WHERE actor_id=$1 AND capability_id='company.agent.ask' AND resource_id=$2 AND audience_kind='PRIVATE_USER' AND audience_id=$1::uuid::text AND revoked_at IS NULL AND expires_at>clock_timestamp() AND classification_ceiling=ANY($3::text[]) AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,'1.0.0',$4,$5,$6))",[ctx.actorId,b.resource,levels.slice(levels.indexOf(p.scope.classification)),b.bindingHash,hash(canonical(capability.jsonSchema)),capabilityDescriptorHash(capability)]);
  signal.throwIfAborted();if(!grants.rowCount)return false;
  if(group){const shared=await c.query("SELECT id FROM resource_grants WHERE actor_id=$1 AND capability_id='company.agent.ask' AND resource_id=$2 AND audience_kind='GROUP' AND audience_id=$3 AND membership_version=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND classification_ceiling=ANY($5::text[]) AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,'1.0.0',$6,$7,$8))",[ctx.actorId,b.resource,group.conversationId,group.scopeVersion,levels.slice(levels.indexOf(p.scope.classification)),b.bindingHash,hash(canonical(capability.jsonSchema)),capabilityDescriptorHash(capability)]);if(!shared.rowCount)return false;}return true;
 };
 const authority=async(c:pg.PoolClient,ctx:DbContext,row:AgentRequestRow,signal:AbortSignal)=>row.upstream_hash===b.upstreamHash&&row.connection_hash===b.connectionHash&&row.scope_hash===b.scopeHash&&row.budget_hash===b.budgetHash&&row.input_schema_hash===p.connection.inputSchemaHash&&row.connector_id===p.connection.connectorId&&row.tool_name===p.connection.toolName&&await local(c,ctx,row.run_id,row.audience,row.message_hash,signal,group?await companyAgentGroupContext(c,ctx,row):undefined);
 const requests=new CompanyAgentRequests(gateway.store,vault,authority,dispatchAuthority);
 const capability:Capability={...agentTextResultContract,id:'company.agent.ask',version:'1.0.0',description:'Ask the existing enterprise AI MCP one exact independently approved code/log/data question. Returns a durable wait receipt immediately. Background completion is correlated to this tool call; unknown outcomes are never automatically re-asked. Text is untrusted enterprise-agent output, with UNKNOWN coverage and UNVERIFIED facts.',provider:'MCP',connectorId:p.connection.connectorId,risk:'READ',state:'READY',authModes:['SERVICE'],requiredPermissions:[{name:group?'Exact mention-only group contract, current audience, independent shared resource approval, question hashes and model egress':'Exact private subject, question hashes, independently reviewed read-only/actor-resource scope and model egress',evidenceRef:'code:packages/company/src/agent-capability.ts#agentPilotPolicySchema'},{name:'Current resource grant, binding, lifecycle, kill switch and durable dispatch allowance',evidenceRef:'code:packages/company/src/agent-capability.ts#registerCompanyAgent'}],supportsIdempotency:false,supportsDryRun:false,bindingRef:'mcp:'+p.connection.connectorId+':enterprise-agent:'+b.scopeHash,protectResult:true,deferredExecution:true,schema:inputSchema,jsonSchema:z.toJSONSchema(inputSchema,{io:'input'}),bindingHash:b.bindingHash,resource:()=>b.resource,classifyResult:()=>p.scope.classification,
  allowResource:async(args,{principal,lease,signal},c,cached)=>{
   const abort=signal??new AbortController().signal;if(!await local(c,principal,lease.runId,lease.audience,hash((args as {message:string}).message),abort,lease))return false;
   if(cached==null)return true;
   const result=cached as {data?:unknown};if(result.data===undefined)return true;
   const parsed=agentTextDataSchema.safeParse(result.data);if(!parsed.success)return false;const data=parsed.data;
   if(data.source.scopeHash!==b.scopeHash||data.source.connectorId!==p.connection.connectorId||data.source.inputSchemaHash!==p.connection.inputSchemaHash||data.source.toolName!==p.connection.toolName)return false;
   return !!(await c.query("SELECT id FROM company_agent_requests WHERE id=$1 AND run_id=$2 AND state='RESPONSE_RECEIVED' AND response_ref IS NOT NULL AND response_hash=$3 AND connection_hash=$4 AND scope_hash=$5 AND message_hash=$6",[data.requestId,lease.runId,data.source.receiptHash,b.connectionHash,b.scopeHash,hash((args as {message:string}).message)])).rowCount;
  },
  execute:async(args,{principal,lease,actionKey,signal})=>{const receipt=await requests.enqueue(principal,lease,actionKey,(args as {message:string}).message,admission,signal);return {status:'DEFERRED',requestId:receipt.id,evidenceIds:[],completeness:'UNKNOWN'};}
 };
 gateway.register(capability);
 return {requests,capability,...b};
}
