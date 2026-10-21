import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import type {AgentChatDispatchSummary,AgentChatResult} from './agent-chat.js';
import {agentTextResult} from './agent-result.js';
import {blocked} from '../../contracts/src/index.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const agentRequestAdmissionSchema=z.object({
 connectorId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),toolName:z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
 upstreamHash:sha,connectionHash:sha,inputSchemaHash:sha,scopeHash:sha,budgetHash:sha,
 waitBudgetMs:z.number().int().min(1).max(1200000),budgetExpiresAt:z.iso.datetime(),
 maxDispatched:z.number().int().min(1).max(1000),maxUnresolved:z.number().int().min(1).max(8)
}).strict();
export type AgentRequestAdmission=z.infer<typeof agentRequestAdmissionSchema>;
export type AgentRequestRow=Record<string,unknown>&{id:string;task_id:string;run_id:string;owner_id:string;action_id:string;action_key:string;execution_attempt_id:string;state:string;fence:string|number;worker_id:string|null;lease_until:Date|null;deadline:Date;dispatch_started_at:Date|null;upstream_hash:string;connection_hash:string;input_schema_hash:string;tool_name:string;connector_id:string;scope_hash:string;budget_hash:string;message_hash:string;message_bytes:number;provider_session_no:string|number;auth_epoch:string|number;policy_version:string;audience:Record<string,unknown>};
export type AgentRequestClaim={id:string;workerId:string;fence:number};
/** Only bounded local checks. Dispatch takes the existing permission mutation
 * barrier and current identity locks; runtime must not gain UPDATE on grants
 * merely to request a row lock. Never run an enterprise CHECK here. */
export type AgentRequestAuthority=(c:pg.PoolClient,ctx:DbContext,row:AgentRequestRow,signal:AbortSignal)=>Promise<boolean>;
export class AgentRequestError extends Error{constructor(readonly code:string){super(code);}}
const responseSchema=z.object({status:z.literal('RESPONSE_RECEIVED'),localRequestId:z.uuid(),text:z.string().min(1).max(262144),textBlocks:z.array(z.string()).min(1).max(64),source:z.object({protocol:z.literal('MCP'),toolName:z.string(),inputSchemaHash:sha,receivedAt:z.iso.datetime(),verification:z.literal('UNVERIFIED'),notice:z.string().max(1024)}).strict()}).strict();
export class CompanyAgentRequests {
 constructor(readonly store:RuntimeStore,private readonly vault:Vault,private readonly authority:AgentRequestAuthority,private readonly dispatchAuthority?:AgentRequestAuthority){}
 private async bounds(c:pg.PoolClient){await c.query("SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='1000ms'");}
 private async prelock(c:pg.PoolClient,ctx:DbContext,id:string){
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${ctx.tenantId}:company-agent:kill`]);
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.tenant_id',true)::uuid::text||':memory:'||current_setting('app.actor_id',true)::uuid::text,0))");
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`${ctx.tenantId}:${ctx.actorId}:permissions`]);
  const audience=(await c.query('SELECT audience FROM company_agent_requests WHERE id=$1',[id])).rows[0]?.audience;if(audience?.kind==='GROUP')await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.tenant_id',true)::uuid::text||':group-contract:'||$1,0))",[String(audience.targetId)]);
  const row=(await c.query('SELECT task_id,run_id FROM company_agent_requests WHERE id=$1',[id])).rows[0];if(!row)return;
  // Match cancellation's task -> run -> retained-body trigger order. Never
  // hold a request row while waiting for a task/run that may be cancelling it.
  await c.query('SELECT id FROM tasks WHERE id=$1 FOR SHARE',[row.task_id]);
  await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[row.run_id]);
 }
 private async current(c:pg.PoolClient,ctx:DbContext,row:AgentRequestRow,signal:AbortSignal,lock=false){
  signal.throwIfAborted();
  if(lock)await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[`${ctx.tenantId}:${ctx.actorId}:permissions`]);
  const q=await c.query(`SELECT r.id FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.owner_id JOIN tenants org ON org.tenant_id=r.tenant_id
   WHERE r.id=$1 AND r.task_id=$2 AND r.owner_id=$3 AND r.provider_session_no=$4 AND r.status IN ('RUNNING','WAITING_EXTERNAL')
   AND t.status='ACTIVE' AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp() AND t.auth_epoch=$5 AND u.auth_epoch=$5 AND u.status='ACTIVE' AND org.status='ACTIVE' AND org.policy_version=$6 AND t.audience=$7::jsonb
   AND public.oa_lifecycle_run_allowed(r.id) AND NOT public.oa_run_content_erased(r.id) ${lock?'FOR SHARE OF r,t,u,org':''}`,[row.run_id,row.task_id,ctx.actorId,row.provider_session_no,row.auth_epoch,row.policy_version,JSON.stringify(row.audience)]);
  if(!q.rowCount)return false;const allowed=await this.authority(c,ctx,row,signal);signal.throwIfAborted();return allowed;
 }
 async enqueue(ctx:DbContext,lease:Lease,actionKey:string,message:string,rawAdmission:AgentRequestAdmission,signal:AbortSignal){
  const admission=agentRequestAdmissionSchema.parse(rawAdmission);if(!message.trim()||Buffer.byteLength(message,'utf8')>65536)throw new AgentRequestError('AGENT_MESSAGE_INVALID');
  return this.store.guarded(ctx,lease,async c=>{
   await this.bounds(c);signal.throwIfAborted();
   const old=(await c.query('SELECT id,state FROM company_agent_requests WHERE action_key=$1 FOR UPDATE',[actionKey])).rows[0];if(old)return {id:old.id as string,state:old.state as string};
   const action=(await c.query("SELECT * FROM tool_actions WHERE run_id=$1 AND logical_action_key=$2 AND state='EXECUTING' AND retry_safety='UNKNOWN' FOR UPDATE",[lease.runId,actionKey])).rows[0];
   if(!action||action.owner_id!==ctx.actorId||action.execution_auth_epoch!==String(lease.authEpoch)&&Number(action.execution_auth_epoch)!==lease.authEpoch||action.capability_id!=='company.agent.ask')throw new AgentRequestError('AGENT_ACTION_NOT_ADMITTED');
   const input=this.store.openActionInput(ctx,actionKey,action.input_ref);if(JSON.stringify(input)!==JSON.stringify({message}))throw new AgentRequestError('AGENT_ACTION_INPUT_CHANGED');
   const run=(await c.query('SELECT provider_session_no FROM runs WHERE id=$1',[lease.runId])).rows[0],id=randomUUID();
   const inserted=await c.query(`INSERT INTO company_agent_requests(tenant_id,id,owner_id,task_id,run_id,action_id,action_key,execution_attempt_id,provider_session_no,connector_id,tool_name,connection_hash,input_schema_hash,scope_hash,budget_hash,message_hash,message_bytes,auth_epoch,policy_version,audience,group_audience_id,persona_snapshot_id,wait_budget_ms,deadline,budget_expires_at,max_dispatched,max_unresolved,state,upstream_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::int,least(clock_timestamp()+$23::int*interval '1 millisecond',$24::timestamptz,$25::timestamptz),$25,$26,$27,'QUEUED',$28) RETURNING *`,
    [ctx.tenantId,id,ctx.actorId,lease.taskId,lease.runId,action.id,actionKey,action.execution_attempt_id,run.provider_session_no,admission.connectorId,admission.toolName,admission.connectionHash,admission.inputSchemaHash,admission.scopeHash,admission.budgetHash,hash(message),Buffer.byteLength(message,'utf8'),lease.authEpoch,lease.policyVersion,JSON.stringify(lease.audience),lease.groupAudience?.id??null,lease.personaSnapshot?.id??null,admission.waitBudgetMs,lease.expiresAt,admission.budgetExpiresAt,admission.maxDispatched,admission.maxUnresolved,admission.upstreamHash]);
   const row=inserted.rows[0] as AgentRequestRow;if(row.deadline.getTime()<=Date.now()||!await this.current(c,ctx,row,signal))throw new AgentRequestError('AGENT_AUTHORITY_UNAVAILABLE');
   await c.query("UPDATE runs SET status='WAITING_EXTERNAL',lease_owner=NULL,lease_until=NULL,last_error='ENTERPRISE_REQUEST_PENDING',updated_at=clock_timestamp(),version=version+1 WHERE id=$1",[lease.runId]);
   return {id,state:'QUEUED'};
  });
 }
 async claim(ctx:DbContext,workerId:string,signal:AbortSignal):Promise<AgentRequestClaim|null>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId))throw new AgentRequestError('AGENT_WORKER_ID_INVALID');
  return this.store.db.scope(ctx,async c=>{await this.bounds(c);signal.throwIfAborted();const row=(await c.query("SELECT * FROM company_agent_requests WHERE state='QUEUED' AND dispatch_started_at IS NULL AND deadline>clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0] as AgentRequestRow|undefined;
   if(!row)return null;if(!await this.current(c,ctx,row,signal))return null;
   const q=await c.query("UPDATE company_agent_requests SET worker_id=$2,lease_until=clock_timestamp()+interval '30 seconds',fence=fence+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING fence",[row.id,workerId]);return {id:row.id,workerId,fence:Number(q.rows[0].fence)};
  });
 }
 private async owned(c:pg.PoolClient,claim:AgentRequestClaim,settlement=false){return (await c.query('SELECT * FROM company_agent_requests WHERE id=$1 AND worker_id=$2 AND fence=$3 AND (lease_until>clock_timestamp() OR $4::boolean) FOR UPDATE',[claim.id,claim.workerId,claim.fence,settlement])).rows[0] as AgentRequestRow|undefined;}
 async load(ctx:DbContext,claim:AgentRequestClaim,signal:AbortSignal){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);const row=await this.owned(c,claim);if(!row||row.state!=='QUEUED'||row.dispatch_started_at||!await this.current(c,ctx,row,signal))throw new AgentRequestError('AGENT_CLAIM_UNAVAILABLE');
  const action=(await c.query("SELECT input_ref FROM tool_actions WHERE id=$1 AND execution_attempt_id=$2 AND state='EXECUTING'",[row.action_id,row.execution_attempt_id])).rows[0];
  if(!action?.input_ref)throw new AgentRequestError('AGENT_INPUT_UNAVAILABLE');const input=z.object({message:z.string().min(1)}).strict().parse(this.store.openActionInput(ctx,row.action_key,action.input_ref));
  if(hash(input.message)!==row.message_hash||Buffer.byteLength(input.message,'utf8')!==row.message_bytes)throw new AgentRequestError('AGENT_INPUT_CHANGED');return {row,message:input.message};
 });}
 async beforeDispatch(ctx:DbContext,claim:AgentRequestClaim,summary:AgentChatDispatchSummary,signal:AbortSignal){await this.store.db.scope(ctx,async c=>{
  await this.bounds(c);await this.prelock(c,ctx,claim.id);const row=await this.owned(c,claim);
  if(!row||row.state!=='QUEUED'||row.dispatch_started_at||summary.localRequestId!==row.id||summary.messageSha256!==row.message_hash||summary.messageBytes!==row.message_bytes||summary.toolName!==row.tool_name||summary.inputSchemaHash!==row.input_schema_hash||summary.absoluteDeadlineMs>row.deadline.getTime())throw new AgentRequestError('AGENT_DISPATCH_CHANGED');
  if(!await this.current(c,ctx,row,signal,true)||this.dispatchAuthority&&!await this.dispatchAuthority(c,ctx,row,signal)||(await c.query('SELECT public.oa_company_agent_budget_available($1) allowed',[row.id])).rows[0]?.allowed!==true)throw new AgentRequestError('AGENT_DISPATCH_NOT_ALLOWED');
  signal.throwIfAborted();const dispatched=await c.query("UPDATE company_agent_requests SET state='DISPATCHING',dispatch_started_at=clock_timestamp(),enterprise_cost='UNKNOWN',updated_at=clock_timestamp() WHERE id=$1 AND worker_id=$2 AND fence=$3 AND state='QUEUED' AND dispatch_started_at IS NULL AND lease_until>clock_timestamp() AND deadline>clock_timestamp() AND budget_expires_at>clock_timestamp() RETURNING id",[row.id,claim.workerId,claim.fence]);if(dispatched.rowCount!==1)throw new AgentRequestError('AGENT_DISPATCH_LEASE_LOST');
 });}
 async renew(ctx:DbContext,claim:AgentRequestClaim,signal:AbortSignal){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);const row=await this.owned(c,claim);if(!row||!['QUEUED','DISPATCHING'].includes(row.state)||row.deadline.getTime()<=Date.now()||!await this.current(c,ctx,row,signal))return false;
  await c.query("UPDATE company_agent_requests SET lease_until=least(clock_timestamp()+interval '30 seconds',deadline),updated_at=clock_timestamp() WHERE id=$1",[row.id]);return true;
 });}
 async complete(ctx:DbContext,claim:AgentRequestClaim,result:AgentChatResult,signal:AbortSignal){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);await this.prelock(c,ctx,claim.id);
  // A deadline can expire the lease while the actual HTTP wait returns. Only
  // this unchanged worker/fence may settle; expired content is still discarded
  // below, and a recovered/reclaimed row never matches this ownership proof.
  const row=await this.owned(c,claim,true);if(!row||!['QUEUED','DISPATCHING'].includes(row.state))return false;
  const dispatched=!!row.dispatch_started_at,localCancelled=signal.aborted;
  let state=dispatched?'UNKNOWN':'NOT_SENT',reason='REQUEST_NOT_COMPLETED',response:string|null=null;
  if(dispatched&&result.status==='RESPONSE_RECEIVED'&&!localCancelled&&row.lease_until!==null&&row.lease_until.getTime()>Date.now()&&row.deadline.getTime()>Date.now()&&await this.current(c,ctx,row,signal,true)){
   const parsed=responseSchema.parse(result);if(parsed.localRequestId!==row.id||parsed.source.toolName!==row.tool_name||parsed.source.inputSchemaHash!==row.input_schema_hash||parsed.text!==parsed.textBlocks.join('\n')||Buffer.byteLength(JSON.stringify(parsed),'utf8')>524288)throw new AgentRequestError('AGENT_RESPONSE_CHANGED');
   response=JSON.stringify(parsed);state='RESPONSE_RECEIVED';reason='RESPONSE_RECEIVED_UNVERIFIED';
  }else if(result.status==='NOT_SENT')reason=dispatched?'DISPATCH_RECEIPT_UNCERTAIN':result.reason;else if(result.status==='UNKNOWN')reason=result.reason;else reason=localCancelled?'LOCAL_WAIT_CANCELLED':'AUTHORITY_OR_DEADLINE_CHANGED';
  await c.query(`UPDATE company_agent_requests SET state=$2,reason_code=$3,response_ref=$4,response_hash=$5,worker_id=NULL,lease_until=NULL,updated_at=clock_timestamp(),local_cancellation_requested_at=CASE WHEN $6 THEN coalesce(local_cancellation_requested_at,clock_timestamp()) ELSE local_cancellation_requested_at END,remote_cancellation=CASE WHEN $6 AND dispatch_started_at IS NOT NULL THEN 'UNCONFIRMED' ELSE remote_cancellation END WHERE id=$1`,[row.id,state,reason,response?JSON.stringify(this.vault.seal(response,`${ctx.tenantId}:${ctx.actorId}:company-agent:${row.id}`)):null,response?hash(response):null,localCancelled]);
  if(!response)await this.stopRun(c,ctx,row,state,reason);return true;
 });}
 private async stopRun(c:pg.PoolClient,ctx:DbContext,row:AgentRequestRow,state:string,reason:string){
  const result=blocked(state==='UNKNOWN'?'UNKNOWN':'PERMANENT_ERROR',reason);
  await c.query("UPDATE tool_actions SET state=$3,result=$4,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND execution_attempt_id=$2 AND state='EXECUTING'",[row.action_id,row.execution_attempt_id,state==='UNKNOWN'?'UNKNOWN':'FAILED',JSON.stringify(this.store.sealToolResult(ctx,row.action_key,result))]);
  await c.query("UPDATE runs SET status='WAITING_USER',last_error=$2,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND status='WAITING_EXTERNAL'",[row.run_id,state==='UNKNOWN'?'ENTERPRISE_REQUEST_UNKNOWN':reason]);
 }
 async resume(ctx:DbContext,id:string,signal:AbortSignal){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);await this.prelock(c,ctx,id);
  const row=(await c.query("SELECT * FROM company_agent_requests WHERE id=$1 AND state='RESPONSE_RECEIVED' AND resumed_at IS NULL FOR UPDATE",[id])).rows[0] as AgentRequestRow|undefined;
  if(!row||row.deadline.getTime()<=Date.now()||!await this.current(c,ctx,row,signal,true))return false;
  const raw=this.vault.open(row['response_ref'] as Sealed,`${ctx.tenantId}:${ctx.actorId}:company-agent:${row.id}`);if(hash(raw)!==row['response_hash'])throw new AgentRequestError('AGENT_RESPONSE_INTEGRITY');
  const reply=responseSchema.parse(JSON.parse(raw)),result=agentTextResult(row,reply);
  const updated=await c.query("UPDATE tool_actions SET state='VERIFIED',result=$3,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND execution_attempt_id=$2 AND state='EXECUTING' AND retry_safety='UNKNOWN' RETURNING id",[row.action_id,row.execution_attempt_id,JSON.stringify(this.store.sealToolResult(ctx,row.action_key,result))]);
  if(updated.rowCount!==1)throw new AgentRequestError('AGENT_CONTINUATION_ACTION_CHANGED');
  const run=(await c.query("UPDATE runs SET status='QUEUED',last_error=NULL,lease_owner=NULL,lease_until=NULL,retry_generation=retry_generation+1,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND status='WAITING_EXTERNAL' RETURNING retry_generation",[row.run_id])).rows[0];
  if(!run)throw new AgentRequestError('AGENT_CONTINUATION_RUN_CHANGED');
  await c.query('UPDATE company_agent_requests SET resumed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',[row.id]);
  await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'RUN',$4,$5,$6) ON CONFLICT DO NOTHING",[ctx.tenantId,randomUUID(),ctx.actorId,row.run_id,JSON.stringify({tenantId:ctx.tenantId,actorId:ctx.actorId,runId:row.run_id,generation:Number(run.retry_generation)}),`company-agent-resume:${row.id}`]);return true;
 });}
 async recover(ctx:DbContext,signal:AbortSignal){
  const recovered=await this.store.db.scope(ctx,async c=>{
   await this.bounds(c);const candidates=(await c.query("SELECT id FROM company_agent_requests WHERE resumed_at IS NULL AND state IN ('QUEUED','DISPATCHING','RESPONSE_RECEIVED') AND (lease_until IS NULL OR lease_until<=clock_timestamp() OR deadline<=clock_timestamp() OR state='RESPONSE_RECEIVED') ORDER BY updated_at,created_at,id LIMIT 20")).rows;let changed=0;const ready:string[]=[];
   for(const candidate of candidates){
    signal.throwIfAborted();await this.prelock(c,ctx,candidate.id as string);
    const row=(await c.query("SELECT * FROM company_agent_requests WHERE id=$1 AND resumed_at IS NULL AND state IN ('QUEUED','DISPATCHING','RESPONSE_RECEIVED') AND (lease_until IS NULL OR lease_until<=clock_timestamp() OR deadline<=clock_timestamp() OR state='RESPONSE_RECEIVED') FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0] as AgentRequestRow|undefined;if(!row)continue;
    const current=await this.current(c,ctx,row,signal),expired=row.deadline.getTime()<=Date.now(),lost=row.state==='DISPATCHING';
    if(current&&!expired&&!lost){if(row.state==='RESPONSE_RECEIVED')ready.push(row.id);else await c.query('UPDATE company_agent_requests SET worker_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1',[row.id]);continue;}
    const state=row.dispatch_started_at?'UNKNOWN':!current?'BLOCKED':'EXPIRED',reason=expired?'DEADLINE_EXCEEDED':lost?'WORKER_LEASE_LOST':'AUTHORITY_CHANGED';
    await c.query("UPDATE company_agent_requests SET state=$2,reason_code=$3,response_ref=NULL,response_hash=NULL,worker_id=NULL,lease_until=NULL,fence=fence+1,updated_at=clock_timestamp() WHERE id=$1",[row.id,state,reason]);await this.stopRun(c,ctx,row,state,reason);changed++;
   }return {changed,ready};
  });
  for(const id of recovered.ready)if(await this.resume(ctx,id,signal))recovered.changed++;
  return recovered.changed;
 }
 async list(ctx:DbContext,taskId:string){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);if(!(await c.query('SELECT id FROM tasks WHERE id=$1',[z.uuid().parse(taskId)])).rowCount)return null;
  const rows=(await c.query('SELECT * FROM company_agent_requests WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[taskId])).rows;
  const iso=(value:Date|null)=>value?.toISOString()??null;
  return {items:rows.map(r=>({id:r.id,taskId:r.task_id,runId:r.run_id,state:r.state,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),deadline:iso(r.deadline),dispatchStartedAt:iso(r.dispatch_started_at),localCancellationRequestedAt:iso(r.local_cancellation_requested_at),remoteCancellation:r.remote_cancellation,automaticRetry:false,source:{kind:'ENTERPRISE_AGENT_MCP',connectorId:r.connector_id,toolName:r.tool_name,verification:'UNVERIFIED'},cost:{enterprise:r.enterprise_cost},reasonCode:r.reason_code})),asOf:new Date().toISOString()};
 });}
 async response(ctx:DbContext,id:string,signal:AbortSignal){return this.store.db.scope(ctx,async c=>{
  await this.bounds(c);const observed=(await c.query("SELECT * FROM company_agent_requests WHERE id=$1 AND state='RESPONSE_RECEIVED'",[id])).rows[0] as AgentRequestRow|undefined;
  if(!observed||!await this.current(c,ctx,observed,signal))return null;
  await this.prelock(c,ctx,id);
  // A cancellation/erasure may have committed during the first authority check.
  // Reload the retained body after the barrier; never decrypt the old snapshot.
  const row=(await c.query("SELECT * FROM company_agent_requests WHERE id=$1 AND state='RESPONSE_RECEIVED' FOR SHARE",[id])).rows[0] as AgentRequestRow|undefined;
  if(!row||!await this.current(c,ctx,row,signal,true))return null;
  const raw=this.vault.open(row['response_ref'] as Sealed,`${ctx.tenantId}:${ctx.actorId}:company-agent:${id}`);if(hash(raw)!==row['response_hash'])throw new AgentRequestError('AGENT_RESPONSE_INTEGRITY');return responseSchema.parse(JSON.parse(raw));
 });}
}
