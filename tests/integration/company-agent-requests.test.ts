import {configureCompanyAgent} from '../../packages/company/src/agent-configuration.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerCompanyAgent,agentPilotBindings,type AgentPilotPolicy} from '../../packages/company/src/agent-capability.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
import {companyAgentWorld} from '../support/company-agent-world.js';
import {createServer} from '../../apps/api/src/server.js';
import {config} from '../../packages/config/src/index.js';
import {CompanyAgentProgressFlow,createEnterpriseProgressTransport} from '../../apps/web/src/company-agent-progress-flow.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {toolName} from '../../packages/gateway/src/index.js';
import {CompanyAgentRequests} from '../../packages/company/src/agent-requests.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,api:Awaited<ReturnType<typeof createServer>>;
const origin='http://127.0.0.1:52339';
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),signal=()=>new AbortController().signal;
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();expect(await isolated.db.ready()).toBe(true);const readOnly=new CompanyAgentRequests(new RuntimeStore(isolated.db,vault),vault,async()=>false);api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:randomBytes(32).toString('hex'),companyRequests:readOnly});await api.app.listen({host:'127.0.0.1',port:52339});});
afterAll(async()=>{await api?.app.close();await isolated?.close();});
const world=(options?:Parameters<typeof companyAgentWorld>[2])=>companyAgentWorld(isolated,vault,options);
it('real Gateway atomically defers to an encrypted-input PostgreSQL request and releases active run time',async()=>{
 const w=await world(),result=await w.enqueue();expect(result.status).toBe('DEFERRED');const row=await w.row();expect(row).toMatchObject({state:'QUEUED',enterprise_cost:'NOT_DISPATCHED',dispatch_started_at:null,response_ref:null});expect(JSON.stringify(row)).not.toContain('SYNTHETIC exact question');
 const run=(await w.root.query('SELECT status,lease_owner,active_accounted_at FROM runs WHERE id=$1',[w.runId])).rows[0];expect(run).toEqual({status:'WAITING_EXTERNAL',lease_owner:null,active_accounted_at:null});
 const claims=await Promise.all(Array.from({length:8},(_,i)=>w.ledger.claim(w.ctx,'worker-'+i,signal())));expect(claims.filter(Boolean)).toHaveLength(1);const claim=claims.find(Boolean)!;expect((await w.ledger.load(w.ctx,claim,signal())).message).toBe('SYNTHETIC exact question');await w.begin(claim);expect(await w.row()).toMatchObject({state:'DISPATCHING',enterprise_cost:'UNKNOWN'});
 expect(await w.ledger.complete(w.ctx,claim,w.reply(claim.id),signal())).toBe(true);expect(await w.row()).toMatchObject({state:'RESPONSE_RECEIVED',enterprise_cost:'UNKNOWN'});expect(JSON.stringify((await w.row()).response_ref)).not.toContain('SYNTHETIC raw upstream response');expect(await w.ledger.response(w.ctx,claim.id,signal())).toMatchObject({status:'RESPONSE_RECEIVED',source:{verification:'UNVERIFIED'}});
});
it('a dispatched worker crash becomes durable UNKNOWN and cannot be claimed or automatically refunded',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'worker-original',signal()))!;await w.begin(claim);await w.root.query("UPDATE company_agent_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.id]);expect(await w.ledger.recover(w.ctx,signal())).toBe(1);expect(await w.row()).toMatchObject({state:'UNKNOWN',reason_code:'WORKER_LEASE_LOST',enterprise_cost:'UNKNOWN',response_ref:null});
 const restarted=new CompanyAgentRequests(w.store,vault,async()=>true);expect(await restarted.claim(w.ctx,'worker-restarted',signal())).toBeNull();expect(await restarted.complete(w.ctx,claim,w.reply(claim.id),signal())).toBe(false);expect((await w.ledger.list(w.ctx,w.taskId))!.items[0]).toMatchObject({state:'UNKNOWN',automaticRetry:false,cost:{enterprise:'UNKNOWN'}});
});
it('a queued worker crash can be reclaimed with a new fence because no dispatch attempt was committed',async()=>{
 const w=await world();await w.enqueue();const first=(await w.ledger.claim(w.ctx,'first',signal()))!;await w.root.query("UPDATE company_agent_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);await w.ledger.recover(w.ctx,signal());const second=(await w.ledger.claim(w.ctx,'second',signal()))!;expect(second.fence).toBeGreaterThan(first.fence);await expect(w.begin(first)).rejects.toThrow('CLAIM_UNAVAILABLE');await w.begin(second);expect((await w.row()).state).toBe('DISPATCHING');
});
it.each([false,true])('task cancellation clears retained bodies and keeps dispatched=%s uncertainty without restarting',async dispatched=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'cancel-worker',signal()))!;if(dispatched){await w.begin(claim);await w.ledger.complete(w.ctx,claim,w.reply(claim.id),signal());}
 expect(await new TaskStore(isolated.db).cancel(w.ctx,w.taskId)).toMatchObject({inFlightExternalActions:'MUST_RECONCILE'});expect(await w.row()).toMatchObject({state:dispatched?'UNKNOWN':'CANCELLED',response_ref:null,response_hash:null,enterprise_cost:dispatched?'UNKNOWN':'NOT_DISPATCHED',remote_cancellation:dispatched?'UNCONFIRMED':'NOT_REQUESTED'});expect(await w.ledger.response(w.ctx,claim.id,signal())).toBeNull();expect(await w.ledger.claim(w.ctx,'after-cancel',signal())).toBeNull();
});
it('grant revocation prevents dispatch and denies an already returned body without an enterprise CHECK',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'revoke-worker',signal()))!;await w.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE id=$1',[w.grantId]);await expect(w.begin(claim)).rejects.toThrow('CLAIM_UNAVAILABLE');expect((await w.row()).dispatch_started_at).toBeNull();await w.ledger.recover(w.ctx,signal());
 const q=await world();await q.enqueue();const other=(await q.ledger.claim(q.ctx,'received-worker',signal()))!;await q.begin(other);await q.ledger.complete(q.ctx,other,q.reply(other.id),signal());await q.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE id=$1',[q.grantId]);expect(await q.ledger.response(q.ctx,other.id,signal())).toBeNull();expect(await q.ledger.recover(q.ctx,signal())).toBe(1);expect((await q.row()).response_ref).toBeNull();
});
it('owner and tenant isolation cover status and encrypted input, including a forged worker claim',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'owner-worker',signal()))!,foreign={tenantId:w.ctx.tenantId,actorId:randomUUID()};expect(await w.ledger.list(foreign,w.taskId)).toBeNull();await expect(w.ledger.load(foreign,claim,signal())).rejects.toThrow('CLAIM_UNAVAILABLE');expect(await w.ledger.claim({tenantId:randomUUID(),actorId:w.ctx.actorId},'cross-tenant',signal())).toBeNull();expect((await w.row()).state).toBe('QUEUED');
});
it('pre-dispatch SDK refusal is NOT_SENT; refusal after a committed attempt stays UNKNOWN',async()=>{
 for(const dispatched of [false,true]){const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'refused-worker',signal()))!;if(dispatched)await w.begin(claim);await w.ledger.complete(w.ctx,claim,{status:'NOT_SENT',localRequestId:claim.id,reason:'CONTROL_TIMEOUT'},signal());expect(await w.row()).toMatchObject({state:dispatched?'UNKNOWN':'NOT_SENT',enterprise_cost:dispatched?'UNKNOWN':'NOT_DISPATCHED'});expect(await w.ledger.claim(w.ctx,'no-replay',signal())).toBeNull();}
});
it('a cancellation committed during the source check cannot return a cached retained response',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'late-read-worker',signal()))!;await w.begin(claim);await w.ledger.complete(w.ctx,claim,w.reply(claim.id),signal());let checks=0;
 w.setAuthorityGate(async()=>{if(++checks===1)expect(await new TaskStore(isolated.db).cancel(w.ctx,w.taskId)).toBeTruthy();});
 expect(await w.ledger.response(w.ctx,claim.id,signal())).toBeNull();expect(await w.row()).toMatchObject({state:'UNKNOWN',response_ref:null});
});
it('a stored reply resumes only its original action once, with truthful verification and one durable outbox record',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'resume-worker',signal()))!;await w.begin(claim);await w.ledger.complete(w.ctx,claim,w.reply(claim.id),signal());
 const outcomes=await Promise.all(Array.from({length:8},()=>w.ledger.resume(w.ctx,claim.id,signal())));expect(outcomes.filter(Boolean)).toHaveLength(1);
 const action=(await w.root.query('SELECT * FROM tool_actions WHERE run_id=$1',[w.runId])).rows[0];expect(action.state).toBe('VERIFIED');expect(w.store.openToolResult(w.ctx,action.logical_action_key,action.result)).toMatchObject({status:'OK',completeness:'UNKNOWN',verification:{state:'UNVERIFIED',method:'MCP_TEXT_RECEIPT_ONLY'},data:{requestId:claim.id,text:'SYNTHETIC raw upstream response'}});
 expect((await w.root.query("SELECT count(*)::int n FROM outbox WHERE dedup_key=$1",['company-agent-resume:'+claim.id])).rows[0].n).toBe(1);expect((await w.root.query('SELECT status,retry_generation FROM runs WHERE id=$1',[w.runId])).rows[0]).toMatchObject({status:'QUEUED',retry_generation:'1'});expect((await w.row()).resumed_at).toBeTruthy();expect(await w.ledger.recover(w.ctx,signal())).toBe(0);
});
it('restart recovery after storing a reply repairs continuation without another dispatch',async()=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'stored-worker',signal()))!;await w.begin(claim);await w.ledger.complete(w.ctx,claim,w.reply(claim.id),signal());
 expect(await w.ledger.recover(w.ctx,signal())).toBe(1);expect(await w.ledger.recover(w.ctx,signal())).toBe(0);expect((await w.row()).dispatch_started_at).toBeTruthy();expect((await w.root.query('SELECT tool_calls FROM runs WHERE id=$1',[w.runId])).rows[0].tool_calls).toBe(1);expect(await w.ledger.claim(w.ctx,'no-second-question',signal())).toBeNull();
});
it('connector concurrency includes other owners and retains historical UNKNOWN after local cancellation',async()=>{
 const first=await world({maxUnresolved:1});await first.enqueue();const a=(await first.ledger.claim(first.ctx,'first-owner',signal()))!;await first.begin(a);await first.ledger.complete(first.ctx,a,{status:'UNKNOWN',localRequestId:a.id,reason:'TRANSPORT_OR_PROTOCOL_ERROR',remoteCancellation:'UNCONFIRMED',localCancellationRequested:false},signal());await new TaskStore(isolated.db).cancel(first.ctx,first.taskId);
 const second=await world({tenantId:first.ctx.tenantId,connectorId:first.admission.connectorId,maxUnresolved:8});await second.enqueue();const b=(await second.ledger.claim(second.ctx,'second-owner',signal()))!;await expect(second.begin(b)).rejects.toThrow('DISPATCH_NOT_ALLOWED');expect((await second.row()).enterprise_cost).toBe('NOT_DISPATCHED');expect((await first.row()).enterprise_cost).toBe('UNKNOWN');
 expect(await second.ledger.list(second.ctx,first.taskId)).toBeNull();
});
it.each(['lease','deadline'] as const)('rechecks the %s after waiting for the actual PostgreSQL connector lock',async kind=>{
 const w=await world();await w.enqueue();const claim=(await w.ledger.claim(w.ctx,'fenced-worker',signal()))!,lock=await w.root.connect();
 try{
  await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${w.ctx.tenantId}:company-agent:${w.admission.upstreamHash}`]);
  const expiry=(await w.root.query(`UPDATE company_agent_requests SET ${kind==='lease'?'lease_until':'deadline'}=clock_timestamp()+interval '300 milliseconds' WHERE id=$1 RETURNING ${kind==='lease'?'lease_until':'deadline'} expires`,[claim.id])).rows[0].expires;
  const pending=expect(w.begin(claim)).rejects.toThrow(kind==='lease'?'DISPATCH_LEASE_LOST':'DISPATCH_NOT_ALLOWED');
  let waiting=false;for(let i=0;i<100;i++){const row=(await w.root.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT public.oa_company_agent_budget_available%') waiting")).rows[0];if(row.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,2));}expect(waiting).toBe(true);
  await w.root.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',[expiry]);await lock.query('COMMIT');await pending;expect(await w.row()).toMatchObject({state:'QUEUED',dispatch_started_at:null,enterprise_cost:'NOT_DISPATCHED'});
 }finally{await lock.query('ROLLBACK');lock.release();}
});
it('a reply failure after enqueue COMMIT preserves the original durable attempt rather than orphaning it',async()=>{
 const w=await world({afterEnqueue:async()=>{throw Error('SYNTHETIC_ENQUEUE_REPLY_LOST');}});
 // The fixture records the simulated callback error separately. Gateway itself
 // must recover the durable DEFERRED receipt without replacing EXECUTING.
 const result=await w.gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal());expect(result.status).toBe('DEFERRED');expect((await w.root.query('SELECT state,retry_safety FROM tool_actions WHERE run_id=$1',[w.runId])).rows[0]).toEqual({state:'EXECUTING',retry_safety:'UNKNOWN'});
 const claim=(await w.ledger.claim(w.ctx,'commit-recovery',signal()))!;expect((await w.ledger.load(w.ctx,claim,signal())).message).toBe('SYNTHETIC exact question');await w.begin(claim);expect((await w.row()).state).toBe('DISPATCHING');
});
it('actual HTTP status and task flags feed the production UI flow; polling cannot dispatch, and cancellation uses the existing CSRF API',async()=>{
 const w=await world();await w.enqueue();const owner=await api.sessions.create(w.ctx),request:typeof fetch=(input,init={})=>fetch(origin+String(input),{...init,headers:{...Object.fromEntries(new Headers(init.headers)),cookie:'oa_session='+owner.cookie,origin}});
 const path=`/api/v1/tasks/${w.taskId}/enterprise-requests`,status=await request(path);expect(status.status).toBe(200);expect(status.headers.get('cache-control')).toContain('no-store');const raw=await status.json();expect(raw.data.items).toHaveLength(1);expect(JSON.stringify(raw)).not.toContain('SYNTHETIC exact question');expect(JSON.stringify(raw)).not.toMatch(/response_ref|scope_hash|connection_hash|message_hash|worker_id/);
 const task=await(await request('/api/v1/tasks/'+w.taskId)).json();expect(task.data.runs[0]).toMatchObject({status:'WAITING_EXTERNAL',enterprise_request:true});
 const flow=new CompanyAgentProgressFlow(createEnterpriseProgressTransport(owner.csrf,request),{taskId:w.taskId,runId:w.runId});expect(await flow.read()).toMatchObject({ok:true});expect(flow.items[0]).toMatchObject({state:'QUEUED',automaticRetry:false,source:{verification:'UNVERIFIED'},cost:{enterprise:'NOT_DISPATCHED'}});for(let i=0;i<3;i++)expect(await flow.read()).toMatchObject({ok:true});
 expect((await w.row()).dispatch_started_at).toBeNull();expect((await w.root.query('SELECT tool_calls FROM runs WHERE id=$1',[w.runId])).rows[0].tool_calls).toBe(1);
 expect((await fetch(origin+path)).status).toBe(401);expect((await request(path+'?unexpected=1')).status).toBe(400);expect((await request(`/api/v1/tasks/${randomUUID()}/enterprise-requests`)).status).toBe(404);
 expect((await request(`/api/v1/tasks/${w.taskId}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(403);
 const stopped=await request(`/api/v1/tasks/${w.taskId}/cancel`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':owner.csrf},body:'{}'});expect(stopped.status).toBe(200);expect((await stopped.json()).data).toMatchObject({status:'CANCELLED',inFlightExternalActions:'MUST_RECONCILE'});expect(await flow.read()).toMatchObject({ok:true});expect(flow.items[0]?.state).toBe('CANCELLED');expect((await w.row()).dispatch_started_at).toBeNull();
});

async function productionWorld(){
 const w=await world(),policy:AgentPilotPolicy={schemaVersion:1,kind:'ENTERPRISE_AGENT_PRIVATE_PILOT',id:randomUUID(),tenantId:w.ctx.tenantId,actorId:w.ctx.actorId,connection:{connectorId:w.admission.connectorId,endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash('https://synthetic.invalid/mcp'),credentialHash:hash('SYNTHETIC NO REAL TOKEN'),server:{name:'synthetic-agent',version:'1'},toolName:'chat',inputSchemaHash:w.admission.inputSchemaHash},validFrom:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+300000).toISOString(),approvalReference:'SYNTHETIC_EXPLICIT_APPROVAL_ONLY',scope:{id:randomUUID(),topics:['CODE','LOG','DATA'],questionHashes:[hash('SYNTHETIC exact question')],readOnlyReviewRef:'SYNTHETIC_REVIEWED_READ_ONLY_QUESTION',actorResourceReviewRef:'SYNTHETIC_ACTOR_SCOPE_REVIEW',resourceReviewRef:'SYNTHETIC_BOUNDED_RESOURCE_WINDOW',modelEgressAllowed:true,classification:'RESTRICTED'},budget:{id:randomUUID(),approvalReference:'SYNTHETIC_REQUEST_ALLOWANCE_ONLY',expiresAt:new Date(Date.now()+120000).toISOString(),waitBudgetMs:60000,maxDispatched:2,maxUnresolved:1,enterpriseCost:'UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE'}};
 const gateway=new Gateway(w.store),service=registerCompanyAgent(gateway,vault,policy);
 await w.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='company.agent.ask'",[w.ctx.tenantId,service.bindingHash]);
 await w.root.query('UPDATE resource_grants SET resource_id=$2 WHERE id=$1',[w.grantId,service.resource]);
 return {...w,policy,gateway,service,dispatch:async()=>{const result=await gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal());expect(result.status).toBe('DEFERRED');const claim=(await service.requests.claim(w.ctx,'production-entry',signal()))!;const loaded=await service.requests.load(w.ctx,claim,signal());await service.requests.beforeDispatch(w.ctx,claim,{localRequestId:claim.id,toolName:policy.connection.toolName,inputSchemaHash:policy.connection.inputSchemaHash,messageSha256:hash(loaded.message),messageBytes:Buffer.byteLength(loaded.message),absoluteDeadlineMs:loaded.row.deadline.getTime()},signal());return claim;}};
}
it('production registration pins the exact private approved question and current source through durable continuation',async()=>{
 const w=await productionWorld(),claim=await w.dispatch();expect((await w.row()).scope_hash).toBe(w.service.scopeHash);await w.service.requests.complete(w.ctx,claim,w.reply(claim.id),signal());expect(await w.service.requests.resume(w.ctx,claim.id,signal())).toBe(true);
 const next=(await w.store.acquire(w.ctx,w.runId,'production-resume'))!;expect(next).toBeTruthy();
 const result=await w.gateway.execute(w.ctx,next,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal());expect(result).toMatchObject({status:'OK',verification:{state:'UNVERIFIED'},completeness:'UNKNOWN',data:{text:'SYNTHETIC raw upstream response'}});
 await w.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE id=$1',[w.grantId]);expect((await w.gateway.execute(w.ctx,next,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal())).status).toBe('DENIED');expect((await w.row()).dispatch_started_at).toBeTruthy();await w.store.release(w.ctx,next);
});
it('production policy refuses a model-invented question before enqueue and a current kill switch before dispatch',async()=>{
 const w=await productionWorld();expect((await w.gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC unapproved question'},signal())).status).toBe('DENIED');expect(await w.row()).toBeUndefined();
 const result=await w.gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal());expect(result.status).toBe('DEFERRED');const claim=(await w.service.requests.claim(w.ctx,'kill-before-dispatch',signal()))!;
 await w.root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'CONNECTOR',$4,'ALL',true,$5)",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,w.policy.connection.connectorId,hash('SYNTHETIC_STOP')]);
 await expect(w.service.requests.load(w.ctx,claim,signal())).rejects.toThrow('CLAIM_UNAVAILABLE');expect((await w.row()).dispatch_started_at).toBeNull();expect(await w.service.requests.renew(w.ctx,claim,signal())).toBe(false);expect(await w.service.requests.recover(w.ctx,signal())).toBe(0);await w.root.query("UPDATE company_agent_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.id]);expect(await w.service.requests.recover(w.ctx,signal())).toBe(1);expect((await w.row()).state).toBe('BLOCKED');
});
it('scope and expiry changes do not mint a new cumulative budget identity; source binding changes are explicit',async()=>{
 const w=await productionWorld(),old=agentPilotBindings(w.policy),changed=structuredClone(w.policy);changed.scope.questionHashes.push(hash('SYNTHETIC second approved question'));changed.validUntil=new Date(Date.parse(changed.validUntil)+1000).toISOString();const next=agentPilotBindings(changed);expect(next.budgetHash).toBe(old.budgetHash);expect(next.scopeHash).not.toBe(old.scopeHash);expect(next.bindingHash).not.toBe(old.bindingHash);
});

it('a connector alias cannot clear the same physical upstream UNKNOWN or reset its approved budget identity',async()=>{
 const w=await productionWorld(),first=await w.dispatch();await w.service.requests.complete(w.ctx,first,{status:'UNKNOWN',localRequestId:first.id,reason:'TRANSPORT_OR_PROTOCOL_ERROR',remoteCancellation:'UNCONFIRMED',localCancellationRequested:false},signal());
 const changed=structuredClone(w.policy);changed.id=randomUUID();changed.scope.id=randomUUID();changed.connection.connectorId='alias.'+randomUUID();changed.budget.maxUnresolved=8;
 const gateway=new Gateway(w.store),next=registerCompanyAgent(gateway,vault,changed);expect(next.budgetHash).toBe(w.service.budgetHash);expect(next.upstreamHash).toBe(w.service.upstreamHash);expect(next.connectionHash).not.toBe(w.service.connectionHash);
 await w.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='company.agent.ask'",[w.ctx.tenantId,next.bindingHash]);await w.root.query('UPDATE resource_grants SET resource_id=$2 WHERE id=$1',[w.grantId,next.resource]);
 const task=await new TaskStore(isolated.db).create(w.ctx,'SYNTHETIC second approved question','alias-'+randomUUID()),lease=(await w.store.acquire(w.ctx,task.runId,'alias-runtime'))!;
 expect((await gateway.execute(w.ctx,lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal())).status).toBe('DEFERRED');const claim=(await next.requests.claim(w.ctx,'alias-worker',signal()))!,loaded=await next.requests.load(w.ctx,claim,signal());
 await expect(next.requests.beforeDispatch(w.ctx,claim,{localRequestId:claim.id,toolName:changed.connection.toolName,inputSchemaHash:changed.connection.inputSchemaHash,messageSha256:hash(loaded.message),messageBytes:Buffer.byteLength(loaded.message),absoluteDeadlineMs:loaded.row.deadline.getTime()},signal())).rejects.toThrow('DISPATCH_NOT_ALLOWED');
 expect((await w.root.query('SELECT state,dispatch_started_at FROM company_agent_requests WHERE id=$1',[claim.id])).rows[0]).toEqual({state:'QUEUED',dispatch_started_at:null});expect((await w.row()).state).toBe('UNKNOWN');
});
it('returned policy handles cannot mutate the captured question or classification authority',async()=>{
 const w=await productionWorld();expect(Object.isFrozen(w.service.policy)).toBe(true);expect(Object.isFrozen(w.service.policy.scope.questionHashes)).toBe(true);expect(()=>w.service.policy.scope.questionHashes.push(hash('SYNTHETIC unapproved question'))).toThrow(TypeError);expect(()=>{w.service.policy.scope.classification='PUBLIC';}).toThrow(TypeError);
 w.policy.scope.questionHashes.push(hash('SYNTHETIC external caller mutation'));expect((await w.gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC external caller mutation'},signal())).status).toBe('DENIED');expect(await w.row()).toBeUndefined();
});
it('an already committing stop switch holds the actual dispatch barrier and is observed before a new attempt',async()=>{
 const w=await productionWorld();expect((await w.gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal())).status).toBe('DEFERRED');const claim=(await w.service.requests.claim(w.ctx,'barrier-worker',signal()))!,loaded=await w.service.requests.load(w.ctx,claim,signal()),writer=await w.root.connect();
 try{
  await writer.query('BEGIN');await writer.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'CONNECTOR',$4,'ALL',true,$5)",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,w.policy.connection.connectorId,hash('SYNTHETIC_BARRIER_STOP')]);
  const pending=expect(w.service.requests.beforeDispatch(w.ctx,claim,{localRequestId:claim.id,toolName:w.policy.connection.toolName,inputSchemaHash:w.policy.connection.inputSchemaHash,messageSha256:hash(loaded.message),messageBytes:Buffer.byteLength(loaded.message),absoluteDeadlineMs:loaded.row.deadline.getTime()},signal())).rejects.toThrow('DISPATCH_NOT_ALLOWED');
  let waiting=false;for(let i=0;i<100;i++){if((await w.root.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='oa_runtime' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock_shared%') waiting")).rows[0].waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,2));}expect(waiting).toBe(true);await writer.query('COMMIT');await pending;expect(await w.row()).toMatchObject({state:'QUEUED',dispatch_started_at:null,enterprise_cost:'NOT_DISPATCHED'});
 }finally{await writer.query('ROLLBACK');writer.release();}
});

it.each(['reply','policy-revoked'] as const)('production configured background poll stays nonblocking and %s cannot create a repeated question',async mode=>{
 const w=await productionWorld(),directory=await mkdtemp(join(tmpdir(),'oa-agent-configured-')),path=join(directory,'policy.json'),token=randomBytes(32).toString('hex'),endpoint='https://synthetic.invalid/mcp',schema={type:'object',properties:{message:{type:'string'}}};
 const policy=structuredClone(w.policy);policy.connection.inputSchemaHash=agentChatInputSchemaHash(schema);policy.connection.credentialHash=hash(token);
 await writeFile(path,JSON.stringify(policy),{mode:0o600});let calls=0,finish!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{finish=r;}),started=new Promise<void>(r=>{entered=r;});
 const fetcher:typeof fetch=async(input,init)=>{
  expect(String(input)).toBe(endpoint);expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');const request=JSON.parse(init?.body as string);
  if(request.method==='notifications/initialized'||request.method==='notifications/cancelled')return new Response(null,{status:202});
  if(request.method==='tools/call'){calls++;expect(request.params.arguments).toEqual({message:'SYNTHETIC exact question'});entered();await held;}
  const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:policy.connection.server}:request.method==='tools/list'?{tools:[{name:'chat',inputSchema:schema}]}:request.method==='tools/call'?{content:[{type:'text',text:'SYNTHETIC configured reply'}]}:null;expect(result).toBeTruthy();return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 };
 const gateway=new Gateway(w.store),service=configureCompanyAgent(gateway,vault,{COMPANY_AGENT_PILOT_POLICY_FILE:path,AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token},fetcher)!;
 try{
  expect(service).toBeTruthy();expect(calls).toBe(0);await w.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='company.agent.ask'",[w.ctx.tenantId,service.bindingHash]);
  expect((await gateway.execute(w.ctx,w.lease,toolName('company.agent.ask','1.0.0'),{message:'SYNTHETIC exact question'},signal())).status).toBe('DEFERRED');const begin=performance.now();await service.poll();expect(performance.now()-begin).toBeLessThan(2000);
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([started,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('SYNTHETIC_WORKER_NOT_STARTED')),5000);})]);}finally{clearTimeout(timer);}
  await Promise.all(Array.from({length:8},()=>service.poll()));expect(calls).toBe(1);
  if(mode==='policy-revoked')await rm(path);else finish();
  let terminal=false;for(let i=0;i<300;i++){const row=await w.row();if(row.state===(mode==='reply'?'RESPONSE_RECEIVED':'UNKNOWN')&&(mode!=='reply'||row.resumed_at)){terminal=true;break;}await new Promise(r=>setTimeout(r,10));}expect(terminal).toBe(true);expect(calls).toBe(1);
  const row=await w.row();expect(row.enterprise_cost).toBe('UNKNOWN');if(mode==='reply'){expect((await w.root.query('SELECT status FROM runs WHERE id=$1',[w.runId])).rows[0].status).toBe('QUEUED');}else{expect(row).toMatchObject({response_ref:null,remote_cancellation:'UNCONFIRMED'});}
  await service.poll();expect(calls).toBe(1);
 }finally{finish();await service.close();await rm(directory,{recursive:true,force:true});}
},15000);
