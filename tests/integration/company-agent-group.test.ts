import type {AgentRequestClaim,AgentRequestRow} from '../../packages/company/src/agent-requests.js';
import {signedGroupMentionRuntime} from '../support/group-mention-runtime.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {readFileSync} from 'node:fs';
import {canonical} from '../../packages/gateway/src/index.js';
import '../support/isolation.js';
import {startSyntheticAgentHttps,type SyntheticAgentHttps} from '../support/company-agent-https.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {registerGroupCompanyAgent} from '../../packages/company/src/agent-group-capability.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {CompanyAgentWorker} from '../../packages/company/src/agent-worker.js';
import {connectCompanyAgent} from '../../packages/company/src/agent-connection.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {signedGroupReadFixture} from '../support/signed-group-read-fixture.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {GroupAudience,groupAudienceBindingHash} from '../../packages/groups/src/audience.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {syntheticCompanyAgentGroupSender} from '../support/company-agent-group-delivery.js';

const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),signal=()=>new AbortController().signal;
const message='SYNTHETIC exact group enterprise calculation question',text='SYNTHETIC calculation: one unit at an unverified rule; actual price UNKNOWN.';
const endpoint='https://synthetic-group-agent.invalid/mcp',schema={type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false};
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>;
const worlds:Awaited<ReturnType<typeof groupCaseWorld>>[]=[];
const signedCleanup:(()=>Promise<void>)[]=[];
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();},60000);
afterAll(async()=>{for(const close of signedCleanup.reverse())await close();for(const w of worlds)await w.f.close();await isolated?.close();},60000);
async function world(options:{signed?:boolean;wrongMembership?:boolean;wrongDirectory?:boolean;https?:SyntheticAgentHttps;dynamic?:boolean;formal?:boolean}={}){
 isolated.db.formalProfileHash=null;
 const w=await groupCaseWorld(isolated.root,isolated.db,isolated.appDb,vault);worlds.push(w);await w.approve();await w.save();
 let accepted=(await w.f.ingress.acceptTrustedCallback(w.f.callback(message)))!,runId=(await isolated.root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id as string;
 let signed:Awaited<ReturnType<typeof signedGroupReadFixture>>|undefined;
 if(options.signed){
  const identity=(await isolated.root.query('SELECT id,authorization_version FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[w.f.ctx.tenantId,w.f.ctx.actorId])).rows[0],epoch=Number((await isolated.root.query('SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[w.f.ctx.tenantId,w.f.ctx.actorId])).rows[0].auth_epoch);
  signed=await signedGroupReadFixture({cli:w.f.fixture,configureSource:false,scopeId:w.f.scopeId,scopeVersion:1,expiresAt:Date.now()+180000,delegation:{tenantId:w.f.ctx.tenantId,ownerId:w.f.ctx.actorId,identityId:identity.id,taskId:accepted.taskId,runId,authEpoch:epoch,authorizationVersion:Number(identity.authorization_version),capabilityBindingId:'dws.group.audience.v1',audience:{kind:'PRIVATE_USER',id:w.f.ctx.actorId},subject:{corpId:w.f.corpId,userId:w.f.ownerExternal}}});
  const activeSigned=signed;signedCleanup.push(()=>activeSigned.close());
  const callerFile=join(signed.root,'caller-private.pem'),runnerFile=join(signed.root,'runner-public.pem'),path=join(signed.root,'signed-client.json');
  await writeFile(callerFile,signed.caller.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(runnerFile,signed.signer.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  await writeFile(path,JSON.stringify({schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_GROUP_ENTERPRISE_NATIVE_REQUEST_ONLY',socketPath:signed.socketPath,callerKeyId:signed.policy.callerKeyId,callerPrivateKeyFile:callerFile,runnerKeyId:signed.policy.runnerKeyId,runnerPublicKeyFile:runnerFile,bindingHash:signed.service.bindingHash,policyHash:signed.policy.policyHash,timeoutMs:3000,maxOutputBytes:128000,binaryHash:signed.scope.binaryHash,schemaHash:w.f.fixture.runner.config.schemaHash,groupMembersSchemaHash:signed.scope.membersSchemaHash,groupInfoSchemaHash:signed.scope.infoSchemaHash,groupScopes:[signed.scope]}),{mode:0o600});
  const dws=await configureDws(isolated.db,vault,{DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:path}),audience=new GroupAudience(isolated.db,vault,dws,'robot-1');expect(dws.runner?.transport).toBe('SIGNED_GROUP');
  // An installed audience is immutable. Build the signed runtime at startup;
  // never weaken configureGroupAudience to replace an existing authority.
  const store=new RuntimeStore(isolated.db,vault);store.configureGroupAudience(audience);w.f.store=store;w.f.gateway=new Gateway(store);
  signedCleanup.push(()=>audience.close());await isolated.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='dws.group.audience'",[w.f.ctx.tenantId,groupAudienceBindingHash(dws)]);
 }
 let dynamic:Awaited<ReturnType<typeof signedGroupMentionRuntime>>|undefined;
 if(options.dynamic){dynamic=await signedGroupMentionRuntime(isolated,w,vault);const current=dynamic;signedCleanup.push(()=>current.close());const audience=new GroupAudience(isolated.db,vault,dynamic.identities,'robot-1'),store=new RuntimeStore(isolated.db,vault);store.configureGroupAudience(audience);w.f.store=store;w.f.gateway=new Gateway(store);signedCleanup.push(()=>audience.close());}
 const initialLease=(await w.f.store.acquire(w.f.ctx,runId,randomUUID()))!;if(options.dynamic)initialLease.groupAudience=await w.f.store.groupAudiences!.issue(w.f.ctx,initialLease,c=>w.f.store.guard(c,initialLease),signal());expect(await w.f.gateway.prepareAudience(w.f.ctx,initialLease,signal())).toBe(true);const audienceRow=(await isolated.root.query('SELECT proof_ref FROM run_group_audiences WHERE id=$1',[initialLease.groupAudience!.id])).rows[0],reviewedAudience=JSON.parse(vault.open(audienceRow.proof_ref,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:group-audience:${initialLease.groupAudience!.id}`));await w.f.store.release(w.f.ctx,initialLease);
 const governance=(await isolated.db.scope(w.f.ctx,c=>c.query('SELECT public.oa_group_contract_runtime($1) value',[w.f.conversationId]))).rows[0].value;
 const connectionEndpoint=options.https?.endpoint??endpoint;
 const token=options.https?.token??randomBytes(32).toString('hex');let service=registerGroupCompanyAgent(w.f.gateway,vault,{
  schemaVersion:1,kind:'ENTERPRISE_AGENT_GROUP_MENTION_PILOT',id:randomUUID(),tenantId:w.f.ctx.tenantId,actorId:w.f.ctx.actorId,
  connection:{connectorId:'synthetic-group-'+randomUUID(),endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(connectionEndpoint),credentialHash:hash(token),server:options.https?.server??{name:'synthetic-group-agent',version:'1'},toolName:'chat',inputSchemaHash:agentChatInputSchemaHash(schema)},
  validFrom:new Date(Date.now()-10000).toISOString(),validUntil:new Date(Date.now()+120000).toISOString(),approvalReference:'SYNTHETIC exact group pilot approval',
  scope:{id:randomUUID(),topics:['DATA'],questionHashes:[hash(message)],readOnlyReviewRef:'SYNTHETIC readonly review',actorResourceReviewRef:'SYNTHETIC actor resource review',resourceReviewRef:'SYNTHETIC resource review',modelEgressAllowed:true,classification:'INTERNAL'},
  group:{conversationId:w.f.conversationId,mode:'MENTION_ONLY',scopeId:w.f.scopeId,scopeVersion:1,contractId:governance.id,contractVersion:governance.version,contractHash:governance.hash,membershipHash:options.wrongMembership?hash('SYNTHETIC_UNAPPROVED_MEMBERSHIP'):reviewedAudience.membershipHash,directoryHash:options.wrongDirectory?hash('SYNTHETIC_UNAPPROVED_DIRECTORY'):reviewedAudience.directoryHash,audienceReviewRef:'SYNTHETIC_EXACT_AUDIENCE_REVIEW',sharingReviewRef:'SYNTHETIC_EXACT_SHARED_RESOURCE_REVIEW'},
  budget:{id:randomUUID(),approvalReference:'SYNTHETIC exact budget approval',expiresAt:new Date(Date.now()+110000).toISOString(),waitBudgetMs:90000,maxDispatched:1,maxUnresolved:1,enterpriseCost:'UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE'}
 });
 await isolated.root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.agent.ask','1.0.0','{}',$3,'READ','READY')",[w.f.ctx.tenantId,randomUUID(),service.bindingHash]);
 for(const kind of ['PRIVATE_USER','GROUP'])await isolated.root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,membership_version,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.agent.ask',$4,$5,$6,$7,'INTERNAL',clock_timestamp()+interval '5 minutes')",[w.f.ctx.tenantId,randomUUID(),w.f.ctx.actorId,service.resource,kind,kind==='GROUP'?w.f.conversationId:w.f.ctx.actorId,kind==='GROUP'?1:null]);
 let formal:ReturnType<typeof formalProfileFingerprint>|undefined;
 if(options.formal){
  if(!dynamic)throw Error('SYNTHETIC_DYNAMIC_POLICY_REQUIRED');const sourceHash=hash('SYNTHETIC CLOSED TRIAL '+randomUUID()),budgetPolicy=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));
  await isolated.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,closed_at,close_reason) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-old-group-pilot-dm',clock_timestamp()-interval '1 hour','CLOSED',clock_timestamp(),'SYNTHETIC PERMANENT CLOSURE')",[w.f.ctx.tenantId,w.f.ctx.actorId,sourceHash,hash(JSON.stringify(budgetPolicy)),w.f.corpId,w.f.ownerExternal,w.f.binding.robotCode]);
  const p=service.policy;if(p.kind!=='ENTERPRISE_AGENT_GROUP_MENTION_PILOT')throw Error('SYNTHETIC GROUP POLICY REQUIRED');
  formal=formalProfileFingerprint({schemaVersion:2,kind:'FORMAL_GROUP_MENTION_ENTERPRISE',authorizationId:randomUUID(),...w.f.ctx,sourceTrialProfileHash:sourceHash,corpId:w.f.corpId,externalUserId:w.f.ownerExternal,robotCode:w.f.binding.robotCode,conversationId:w.f.conversationId,validFrom:p.validFrom,validUntil:new Date(Date.parse(p.budget.expiresAt)-1000).toISOString(),budgetPolicyHash:hash(JSON.stringify(budgetPolicy)),approvalReference:'SYNTHETIC_NEW_GROUP_FORMAL_APPROVAL',modelAllowed:true,modelApprovalReference:'SYNTHETIC_NEW_GROUP_MODEL_APPROVAL',entrypoints:['INGRESS','WORKER','NOTIFIER','API'],inputPolicy:{attachments:false,controls:false},capabilities:[{id:'company.agent.ask',version:'1.0.0',bindingHash:service.bindingHash},{id:'dws.group.audience',version:'1.0.0',bindingHash:groupAudienceBindingHash(dynamic.identities)}],group:{mode:'MENTION_ONLY',contractId:p.group.contractId,contractVersion:p.group.contractVersion,contractHash:p.group.contractHash,scopeId:p.group.scopeId,scopeVersion:p.group.scopeVersion,membershipHash:p.group.membershipHash,directoryHash:p.group.directoryHash,enterprisePolicyHash:hash(canonical(p)),enterpriseResource:service.resource,questionHash:hash(message),audienceReviewReference:p.group.audienceReviewRef,sharingReviewReference:p.group.sharingReviewRef,allowStop:true}});
  expect((await isolated.root.query('SELECT public.oa_formal_authorize($1,$2,$3) state',[formal.serialized,sourceHash,formal.profile.approvalReference])).rows[0].state.allowed).not.toBe(false);isolated.db.formalProfileHash=formal.hash;
  const audience=new GroupAudience(isolated.db,vault,dynamic.identities,'robot-1'),store=new RuntimeStore(isolated.db,vault);store.configureGroupAudience(audience);w.f.store=store;w.f.gateway=new Gateway(store);signedCleanup.push(()=>audience.close());service=registerGroupCompanyAgent(w.f.gateway,vault,p);
  let event;for(let attempt=0;attempt<100;attempt++){const r=(await isolated.db.scope(w.f.ctx,c=>c.query("SELECT public.oa_formal_state('INGRESS') state,floor(extract(epoch FROM clock_timestamp())*1000)::text ms"))).rows[0];if(Number(r.ms)>=Number(r.state.admissionCutoffMs)){event=w.f.callback(message,{createAt:Number(r.ms)});break;}}
  if(!event)throw Error('SYNTHETIC_FORMAL_EVENT_CLOCK_NOT_READY');accepted=(await w.f.ingress.acceptTrustedCallback(event))!;expect(accepted).not.toBeNull();runId=(await isolated.root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id;
 }
 let modelCalls=0;const name=toolName('company.agent.ask','1.0.0'),callId='synthetic-group-call';
 const provider=new GlmProvider({apiKey:'synthetic-group-only',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  modelCalls++;const input=JSON.parse(init!.body as string);expect(input.tools.map((t:{function:{name:string}})=>t.function.name)).toEqual([name]);
  const delta=modelCalls===1?{role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name,arguments:JSON.stringify({message})}}]}:{role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'QUOTE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/text',quote:text,coverage:'OBSERVED'}],outcome:'PARTIAL'})};
  expect(modelCalls).toBeLessThanOrEqual(2);return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:modelCalls===1?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:20,total_tokens:50}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const runtime=new AgentRuntime(w.f.store,provider,w.f.gateway),methods:string[]=[];
 let beforeCall:(()=>Promise<void>)|undefined,beforeList:(()=>Promise<void>)|undefined;
 const fetcher:typeof fetch=async(_url,init)=>{const r=JSON.parse(init!.body as string);methods.push(r.method);if(r.method==='notifications/initialized')return new Response(null,{status:202});
  if(r.method==='tools/list')await beforeList?.();if(r.method==='tools/call'){expect(r.params.arguments).toEqual({message});await beforeCall?.();}
  const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-group-agent',version:'1'}}:r.method==='tools/list'?{tools:[{name:'chat',inputSchema:schema}]}:r.method==='tools/call'?{content:[{type:'text',text}]}:null;
  if(!result)throw Error('UNEXPECTED_SYNTHETIC_MCP_METHOD');return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result}),{headers:{'content-type':'application/json'}});
 };
 let beforeObserve:((claim:AgentRequestClaim,row:AgentRequestRow)=>Promise<void>)|undefined;
 const worker=new CompanyAgentWorker(service.requests,(row,abort)=>options.https?connectCompanyAgent(service.policy.connection,{signal:abort,absoluteDeadlineMs:row.deadline.getTime()},{AIDER_AI_DD_CHAT_MCP:connectionEndpoint,AIDER_AI_DD_MCP_TOKEN:token}):connectCompanyAgent(service.policy.connection,{signal:abort,absoluteDeadlineMs:row.deadline.getTime()},{AIDER_AI_DD_CHAT_MCP:connectionEndpoint,AIDER_AI_DD_MCP_TOKEN:token},fetcher),async(ctx,claim,row,abort)=>{await beforeObserve?.(claim,row);await service.observe(ctx,claim,row,abort);});
 const row=async()=>(await isolated.root.query('SELECT * FROM company_agent_requests WHERE run_id=$1',[runId])).rows[0];
 const state=async()=>(await isolated.root.query('SELECT * FROM runs WHERE id=$1',[runId])).rows[0];
 const changeMembers=()=>w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.ownerOpen,w.f.otherOpen,'unreviewed-arrival'])});
 const pause=()=>w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,state:'PAUSED',expectedVersion:1},randomUUID());
 return {...w,signed,dynamic,formal,service,runtime,worker,runId,taskId:accepted.taskId,row,state,methods,changeMembers,pause,modelCalls:()=>modelCalls,setBeforeObserve:(f:(claim:AgentRequestClaim,row:AgentRequestRow)=>Promise<void>)=>{beforeObserve=f;},setBeforeCall:(f:()=>Promise<void>)=>{beforeCall=f;},setBeforeList:(f:()=>Promise<void>)=>{beforeList=f;}};
}
it('actual mention, audience, native model stream, durable MCP wait and one group reply retain UNKNOWN and unverified rules',async()=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);expect((await w.state()).status).toBe('WAITING_EXTERNAL');expect((await w.row()).state).toBe('QUEUED');expect(w.modelCalls()).toBe(1);
 expect(await w.worker.once(w.f.ctx,signal())).toBe(true);expect((await w.row()).state).toBe('RESPONSE_RECEIVED');const queued=await w.state();expect(queued.status).toBe('QUEUED');
 await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));const final=await w.state();expect(final.status).toBe('PARTIAL');expect(final.result).toContain(text);expect(final.result).toContain('上游核验尚未完成');expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);expect(w.modelCalls()).toBe(2);expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);
 const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result}),sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a));
 const delivery=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;expect(await sender.process(w.f.ctx,delivery,signal())).toBe('APPLIED_UNVERIFIED');expect(await sender.process(w.f.ctx,delivery,signal())).toBe('NOT_CLAIMED');expect(physical.replyCount()).toBe(1);expect(physical.requests).toHaveLength(1);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);
},60000);
it.each(['before-dispatch','after-response'] as const)('a roster change %s suppresses enterprise use or retained response without an automatic repeat',async phase=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);if(phase==='before-dispatch')w.setBeforeList(w.changeMembers);else w.setBeforeCall(w.changeMembers);
 await w.worker.once(w.f.ctx,signal());const row=await w.row();expect(row.state).toBe(phase==='before-dispatch'?'NOT_SENT':'UNKNOWN');expect(row.response_ref).toBeNull();expect(row.resumed_at).toBeNull();expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(phase==='before-dispatch'?0:1);expect(w.modelCalls()).toBe(1);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);
},60000);
it('a paused contract during an enterprise wait aborts locally, preserves unknown cost and prevents continuation',async()=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);w.setBeforeCall(async()=>{await w.pause();await new Promise(resolve=>setTimeout(resolve,250));});await w.worker.once(w.f.ctx,signal());
 const row=await w.row();expect(row.state).toBe('UNKNOWN');expect(row.enterprise_cost).toBe('UNKNOWN');expect(row.response_ref).toBeNull();expect(row.resumed_at).toBeNull();expect(w.modelCalls()).toBe(1);expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);
},60000);
it('a group shared grant removal denies the queued background claim even when the private grant remains',async()=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);await isolated.root.query("UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND capability_id='company.agent.ask' AND audience_kind='GROUP'",[w.f.ctx.tenantId]);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect(w.methods).toEqual([]);expect(w.modelCalls()).toBe(1);
},60000);
it('the synchronous guard waits for the contract before taking the service-owner row lock',async()=>{
 const w=await world(),lease=(await w.f.store.acquire(w.f.ctx,w.runId,'synthetic-contract-lock-order'))!,contract=await isolated.root.connect(),identity=await isolated.root.connect();let pending:Promise<unknown>|undefined;
 try{
  await contract.query('BEGIN');await contract.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${w.f.ctx.tenantId}:group-contract:${w.f.conversationId}`]);
  pending=w.f.store.guarded(w.f.ctx,lease,async()=>true);void pending.catch(()=>{});
  let waiting=false;for(let i=0;i<100;i++){waiting=!!(await identity.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 1")).rowCount;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);
  await identity.query('BEGIN');await expect(identity.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT',[w.f.ctx.tenantId,w.f.ctx.actorId])).resolves.toMatchObject({rowCount:1});await identity.query('ROLLBACK');
  await contract.query('ROLLBACK');expect(await pending).toBe(true);
 }finally{await identity.query('ROLLBACK');await contract.query('ROLLBACK');await pending?.catch(()=>{});identity.release();contract.release();await w.f.store.release(w.f.ctx,lease);}
},60000);
it('only the exact durable request claim can observe the background group roster',async()=>{
 const w=await world({signed:true});await w.runtime.advance(w.f.ctx,w.runId);const calls=w.signed!.groupCalls.length,claim=(await w.service.requests.claim(w.f.ctx,'synthetic-original-claim',signal()))!,row=await w.row();
 await expect(w.service.observe(w.f.ctx,{...claim,fence:claim.fence+1},row,signal())).rejects.toThrow('AGENT_GROUP_AUDIENCE_CHANGED');
 await expect(w.service.observe(w.f.ctx,{...claim,workerId:'different-worker'},row,signal())).rejects.toThrow('AGENT_GROUP_AUDIENCE_CHANGED');
 await expect(w.service.observe(w.f.ctx,{...claim,id:randomUUID()},row,signal())).rejects.toThrow('AGENT_GROUP_AUDIENCE_CHANGED');
 expect(w.methods).toEqual([]);expect((await w.row()).dispatch_started_at).toBeNull();expect(w.signed!.groupCalls).toHaveLength(calls);expect(w.signed!.legacyCalls).toEqual([]);
},60000);
it('actual signed Unix socket roster reads authorize WAITING_EXTERNAL with a live request claim and no model lease',async()=>{
 const w=await world({signed:true});await w.runtime.advance(w.f.ctx,w.runId);const observed:unknown[]=[];w.signed!.afterRead(async()=>{
  const r=await w.state();if(r.status==='WAITING_EXTERNAL'){const q=await w.row();expect(r.lease_owner).toBeNull();expect(r.lease_until).toBeNull();expect(q.worker_id).toBeTypeOf('string');expect(Number(q.fence)).toBeGreaterThan(0);expect(q.lease_until.getTime()).toBeGreaterThan(Date.now());observed.push({status:r.status,state:q.state});}
 });
 await w.worker.once(w.f.ctx,signal());expect(observed).toHaveLength(2);expect((await w.row()).state).toBe('RESPONSE_RECEIVED');expect(w.signed!.legacyCalls).toEqual([]);expect(w.signed!.groupCalls.length).toBeGreaterThanOrEqual(3);expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);
 const r=await w.state();await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(r.retry_generation));const final=await w.state();expect(final.status).toBe('PARTIAL');expect(final.result).toContain(text);expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);expect(w.modelCalls()).toBe(2);
 const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result}),sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a)),id=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;expect(await sender.process(w.f.ctx,id,signal())).toBe('APPLIED_UNVERIFIED');expect(await sender.process(w.f.ctx,id,signal())).toBe('NOT_CLAIMED');expect(physical.replyCount()).toBe(1);
},60000);
it('copying the approved group adapter ID, binding and callbacks never certifies another adapter',async()=>{
 const w=await world(),lease=(await w.f.store.acquire(w.f.ctx,w.runId,'synthetic-copy-denied'))!,copy=new Gateway(w.f.store);copy.register({...w.service.capability});
 expect(await w.f.gateway.prepareAudience(w.f.ctx,lease,signal())).toBe(true);expect(await copy.tools(w.f.ctx,lease)).toEqual([]);expect(await copy.execute(w.f.ctx,lease,toolName('company.agent.ask','1.0.0'),{message},signal())).toMatchObject({status:'DENIED',remediation:{kind:'GROUP_RESOURCE_SHARING_UNCERTIFIED'}});expect(w.methods).toEqual([]);expect(await w.row()).toBeUndefined();await w.f.store.release(w.f.ctx,lease);
},60000);
it.each(['membership','directory'] as const)('a different independently reviewed %s snapshot denies the initial enterprise group question',async kind=>{
 const w=await world({wrongMembership:kind==='membership',wrongDirectory:kind==='directory'}),lease=(await w.f.store.acquire(w.f.ctx,w.runId,'synthetic-audience-review-denied'))!;
 expect(await w.f.gateway.tools(w.f.ctx,lease)).toEqual([]);expect(await w.f.gateway.execute(w.f.ctx,lease,toolName('company.agent.ask','1.0.0'),{message},signal())).toMatchObject({status:'DENIED'});expect(await w.row()).toBeUndefined();expect(w.methods).toEqual([]);expect(w.modelCalls()).toBe(0);await w.f.store.release(w.f.ctx,lease);
},60000);
it('cancellation after dispatch clears response and never resumes or repeats the group enterprise question',async()=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);w.setBeforeCall(async()=>{await new TaskStore(isolated.db).cancel(w.f.ctx,w.taskId);await new Promise(resolve=>setTimeout(resolve,1100));});await w.worker.once(w.f.ctx,signal());
 const row=await w.row();expect(row.state).toBe('UNKNOWN');expect(row.response_ref).toBeNull();expect(row.resumed_at).toBeNull();expect(row.remote_cancellation).toBe('UNCONFIRMED');expect(w.modelCalls()).toBe(1);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);
},60000);
it('a new unreviewed member after finalization prevents any physical enterprise result send',async()=>{
 const w=await world();await w.runtime.advance(w.f.ctx,w.runId);await w.worker.once(w.f.ctx,signal());await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number((await w.state()).retry_generation));const final=await w.state();expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);
 await w.changeMembers();const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result}),sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a));const id=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;
 expect(await sender.process(w.f.ctx,id,signal())).toBe('SUPPRESSED');expect(physical.replyCount()).toBe(0);expect(physical.requests).toHaveLength(0);expect((await isolated.root.query('SELECT state FROM deliveries WHERE id=$1',[id])).rows[0].state).toBe('SUPPRESSED');expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);
},60000);

it('actual loopback HTTPS reaches the durable group wait, source verification and one protected synthetic delivery',async()=>{
 const fixture=await startSyntheticAgentHttps({text,delayMs:3100});
 try{
  const w=await world({signed:true,https:fixture});
  await w.runtime.advance(w.f.ctx,w.runId);
  const waiting=await w.state();expect(waiting.status).toBe('WAITING_EXTERNAL');expect(waiting.lease_owner).toBeNull();expect(waiting.lease_until).toBeNull();expect(w.modelCalls()).toBe(1);
  const started=performance.now();expect(await w.worker.once(w.f.ctx,signal())).toBe(true);expect(performance.now()-started).toBeGreaterThanOrEqual(3000);
  const request=await w.row();expect(request.state).toBe('RESPONSE_RECEIVED');expect(request.dispatch_started_at).not.toBeNull();expect(request.resumed_at).not.toBeNull();expect(fixture.callCount()).toBe(1);
  const queued=await w.state();expect(queued.status).toBe('QUEUED');
  await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));
  const final=await w.state();expect(final.status).toBe('PARTIAL');expect(final.result).toContain(text);expect(final.result).toContain('上游核验尚未完成');expect(final.result).toContain('UNKNOWN');expect(w.modelCalls()).toBe(2);
  expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);expect(w.signed!.legacyCalls).toEqual([]);
  const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result}),sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a));
  const id=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;
  expect(await sender.process(w.f.ctx,id,signal())).toBe('APPLIED_UNVERIFIED');expect(await sender.process(w.f.ctx,id,signal())).toBe('NOT_CLAIMED');expect(physical.replyCount()).toBe(1);
  expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect(fixture.methods.filter(m=>m==='tools/call')).toHaveLength(1);
 }finally{await fixture.close();}
},60000);

it('one installed dynamic mention policy accepts a later fresh run and verifies actual execution wait and historical result over native HTTPS',async()=>{
 const https=await startSyntheticAgentHttps({text});try{
  const w=await world({dynamic:true,https});
  const next=(await w.f.ingress.acceptTrustedCallback(w.f.callback(message)))!,nextRun=(await isolated.root.query('SELECT id FROM runs WHERE task_id=$1',[next.taskId])).rows[0].id as string;
  const lease=(await w.f.store.acquire(w.f.ctx,nextRun,randomUUID()))!;expect(await w.f.gateway.prepareAudience(w.f.ctx,lease,signal())).toBe(true);await w.f.store.release(w.f.ctx,lease);
  await w.runtime.advance(w.f.ctx,w.runId);expect((await w.state()).status).toBe('WAITING_EXTERNAL');expect(await w.worker.once(w.f.ctx,signal())).toBe(true);const queued=await w.state();await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));const final=await w.state();expect(final.status).toBe('PARTIAL');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);
  const observations=w.dynamic!.observations;expect(new Set(observations.map(o=>o.requester.runId)).size).toBeGreaterThanOrEqual(2);expect(new Set(observations.map(o=>o.origin.phase))).toEqual(new Set(['EXECUTION','WAITING_EXTERNAL','RESULT_VERIFICATION']));expect(https.callCount()).toBe(1);expect(final.result).toContain('上游核验尚未完成');
  const stored=(await isolated.root.query('SELECT id,plan_ref FROM run_finalizations WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1',[w.runId])).rows[0],historical=JSON.parse(vault.open(stored.plan_ref,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:final:${stored.id}`)).lease;
  const before=observations.length;await expect(w.dynamic!.identities.readGroupAudience(w.f.ctx,{conversationId:w.f.conversationId,authorizationVersion:w.dynamic!.policy.principal.authorizationVersion,requestNonce:randomUUID()},w.dynamic!.policy.profile,signal(),{lease:{...historical,workerId:randomUUID()},scopeId:w.f.scopeId,scopeVersion:1})).rejects.toThrow('GROUP_RESULT_ORIGIN_UNVERIFIED');expect(observations).toHaveLength(before);
 }finally{await https.close();}
},120000);
it('a new CLOSED-bound formal group question traverses signed dynamic roster native HTTPS model continuation and one protected reply',async()=>{
 const https=await startSyntheticAgentHttps({text});try{
  const w=await world({dynamic:true,formal:true,https}),closed=(await isolated.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows;
  await w.runtime.advance(w.f.ctx,w.runId);expect((await w.state()).status).toBe('WAITING_EXTERNAL');expect(await w.worker.once(w.f.ctx,signal())).toBe(true);const reply=await w.row();expect(reply.state,JSON.stringify({reason:reply.reason_code,localCancelled:reply.local_cancellation_requested_at!==null,methods:https.methods,callCount:https.callCount()})).toBe('RESPONSE_RECEIVED');const queued=await w.state();await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));const final=await w.state();expect(final.status).toBe('PARTIAL');expect(w.modelCalls()).toBe(2);expect(https.callCount()).toBe(1);expect(final.result).toContain('上游核验尚未完成');expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);
  const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result}),sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,(...a)=>w.f.gateway.finalSourcesAllowed(...a)),delivery=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;
  expect(await sender.process(w.f.ctx,delivery,signal())).toBe('APPLIED_UNVERIFIED');expect(await sender.process(w.f.ctx,delivery,signal())).toBe('NOT_CLAIMED');expect(physical.replyCount()).toBe(1);expect((await isolated.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toEqual(closed);expect(w.dynamic!.observations.some(o=>o.origin.phase==='WAITING_EXTERNAL')).toBe(true);
 }finally{await https.close();isolated.db.formalProfileHash=null;}
},180000);

it.each([false,true])('a bounded post-response formal roster observation serializes renewal and retains cancellation=%s',async cancelled=>{
 const https=await startSyntheticAgentHttps({text});try{
  const w=await world({dynamic:true,formal:true,https});
  const reader=w.dynamic!.identities.runner!,read=reader.readGroupMentionAudience!.bind(reader),renew=w.service.requests.renew.bind(w.service.requests);
  const renewals:{allowed?:boolean;sqlstate?:string}[]=[],parent=new AbortController();let held=false,renewedDuringObservation=false;
  w.service.requests.renew=async(...args)=>{try{const allowed=await renew(...args);renewals.push({allowed});return allowed;}catch(error){renewals.push({sqlstate:typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:'NON_SQL_FAILURE'});throw error;}};
  reader.readGroupMentionAudience=async(...args)=>{const result=await read(...args);if(args[5].delegation.origin.phase==='WAITING_EXTERNAL'&&(await w.row()).state==='DISPATCHING'){held=true;const count=renewals.length;if(cancelled)parent.abort();await new Promise(resolve=>setTimeout(resolve,2200));renewedDuringObservation=renewals.length!==count;}return result;};
  await w.runtime.advance(w.f.ctx,w.runId);expect((await w.state()).status).toBe('WAITING_EXTERNAL');expect(await w.worker.once(w.f.ctx,parent.signal)).toBe(true);
  const request=await w.row();expect(held).toBe(true);expect(renewedDuringObservation).toBe(false);
  const diagnostic=JSON.stringify({state:request.state,reason:request.reason_code,localCancelled:request.local_cancellation_requested_at!==null,renewals,methods:https.methods});
  expect(request.state,diagnostic).toBe(cancelled?'UNKNOWN':'RESPONSE_RECEIVED');expect(request.local_cancellation_requested_at!==null,diagnostic).toBe(cancelled);
  if(cancelled){expect(request.response_ref).toBeNull();expect(request.resumed_at).toBeNull();expect(request.enterprise_cost).toBe('UNKNOWN');expect(request.remote_cancellation).toBe('UNCONFIRMED');expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect(w.modelCalls()).toBe(1);expect(https.callCount()).toBe(1);expect((await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows).toEqual([]);return;}
  expect(renewals.every(r=>r.sqlstate===undefined&&r.allowed===true)).toBe(true);expect(https.callCount()).toBe(1);
  const queued=await w.state();expect(queued.status).toBe('QUEUED');await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));expect((await w.state()).status).toBe('PARTIAL');expect(w.modelCalls()).toBe(2);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);
 }finally{await https.close();isolated.db.formalProfileHash=null;}
},180000);

it('T033: an unreviewed member joining after the first permitted enterprise delivery check suppresses the exact CLOSED-bound group result',async()=>{
 const https=await startSyntheticAgentHttps({text});try{
  const w=await world({dynamic:true,formal:true,https}),closed=(await isolated.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows;
  await w.runtime.advance(w.f.ctx,w.runId);expect(await w.worker.once(w.f.ctx,signal())).toBe(true);
  const queued=await w.state();expect(queued.status).toBe('QUEUED');expect((await w.row()).state).toBe('RESPONSE_RECEIVED');
  await w.runtime.advance(w.f.ctx,w.runId,randomUUID(),undefined,Number(queued.retry_generation));
  const final=await w.state();expect(final.status).toBe('PARTIAL');expect(final.result).toContain(text);expect(final.result).toContain('UNKNOWN');
  expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(true);
  // These are the private and explicit shared enterprise grants used by the
  // actual source verifier, rather than source-free clarification authority.
  const grants=(await isolated.root.query("SELECT audience_kind,resource_id,classification_ceiling FROM resource_grants WHERE tenant_id=$1 AND actor_id=$2 AND capability_id='company.agent.ask' AND revoked_at IS NULL ORDER BY audience_kind",[w.f.ctx.tenantId,w.f.ctx.actorId])).rows;
  expect(grants).toEqual([{audience_kind:'GROUP',resource_id:w.service.resource,classification_ceiling:'INTERNAL'},{audience_kind:'PRIVATE_USER',resource_id:w.service.resource,classification_ceiling:'INTERNAL'}]);
  const physical=syntheticCompanyAgentGroupSender({robotCode:w.f.binding.robotCode,expectedReplyUrl:JSON.parse(w.f.event.data).sessionWebhook,expectedText:final.result});
  const externalOpen='open-synthetic-external-'+randomUUID();expect((await isolated.root.query('SELECT id FROM users WHERE open_dingtalk_id=$1',[externalOpen])).rowCount).toBe(0);
  let successfulChecks=0,deniedChecks=0,joined=false;
  const sender=new DeliveryGateway(isolated.db,vault,physical.sender,w.f.binding,Date.now,async(...args)=>{
   const allowed=await w.f.gateway.finalSourcesAllowed(...args);
   if(allowed){successfulChecks++;if(!joined){joined=true;await w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.ownerOpen,w.f.otherOpen,externalOpen]),info:groupInfoReply(3,1,'external-member-joined')});}}else deniedChecks++;
   return allowed;
  }),delivery=(await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows[0].id;
  expect(await sender.process(w.f.ctx,delivery,signal())).toBe('SUPPRESSED');expect(joined).toBe(true);expect(successfulChecks).toBe(1);expect(deniedChecks).toBeGreaterThanOrEqual(1);
  expect(physical.requests).toHaveLength(0);expect(physical.replyCount()).toBe(0);
  expect((await isolated.root.query('SELECT state,last_error FROM deliveries WHERE id=$1',[delivery])).rows[0]).toEqual({state:'SUPPRESSED',last_error:'AUTHORIZATION_OR_SOURCE_UNVERIFIED'});
  expect(await w.f.gateway.finalResultAllowed(w.f.ctx,w.runId,final.result)).toBe(false);
  expect(await sender.process(w.f.ctx,delivery,signal())).toBe('NOT_CLAIMED');expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect(https.callCount()).toBe(1);expect(w.modelCalls()).toBe(2);
  expect((await w.row()).enterprise_cost).toBe('UNKNOWN');expect((await isolated.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toEqual(closed);
 }finally{await https.close();isolated.db.formalProfileHash=null;}
},180000);

it('dynamic contract metadata keeps private delegation ACLs and wrong tenant actor scope and execution fences cannot invoke the runner',async()=>{
 const w=await world({dynamic:true}),ctx=w.f.ctx,policy=w.dynamic!.policy;
 await expect(isolated.db.scope(ctx,c=>c.query('SELECT id FROM group_contract_delegations'))).rejects.toThrow('permission denied');
 await expect(isolated.db.scope(ctx,c=>c.query('SELECT public.oa_group_delegation_live($1)',[policy.delegationId]))).rejects.toThrow('permission denied');
 for(const [principal,scope,version] of [[{tenantId:randomUUID(),actorId:ctx.actorId},w.f.scopeId,1],[{tenantId:ctx.tenantId,actorId:w.f.otherId},w.f.scopeId,1],[ctx,randomUUID(),1],[ctx,w.f.scopeId,2]] as const)await expect(isolated.db.scope(principal,c=>c.query('SELECT public.oa_group_mention_contract($1,$2,$3)',[w.f.conversationId,scope,version]))).rejects.toThrow('GROUP_MENTION_CURRENT_CONTRACT_REQUIRED');
 const lease=(await w.f.store.acquire(ctx,w.runId,randomUUID()))!,before=w.dynamic!.observations.length;
 for(const changed of [{...lease,workerId:randomUUID()},{...lease,fence:lease.fence+1}])await expect(w.dynamic!.identities.readGroupAudience(ctx,{conversationId:w.f.conversationId,authorizationVersion:policy.principal.authorizationVersion,requestNonce:randomUUID()},policy.profile,signal(),{lease:changed,scopeId:w.f.scopeId,scopeVersion:1})).rejects.toThrow('GROUP_SCOPE_UNVERIFIED');
 expect(w.dynamic!.observations).toHaveLength(before);expect(w.methods).toEqual([]);await w.f.store.release(ctx,lease);
},60000);
it.each(['before-dispatch','after-response'] as const)('a CLOSED-bound formal dynamic group roster change %s prevents query or continuation and any send',async phase=>{
 const w=await world({dynamic:true,formal:true});try{
  await w.runtime.advance(w.f.ctx,w.runId);if(phase==='before-dispatch')w.setBeforeList(w.changeMembers);else w.setBeforeCall(w.changeMembers);await w.worker.once(w.f.ctx,signal());const row=await w.row();expect(row.state).toBe(phase==='before-dispatch'?'NOT_SENT':'UNKNOWN');expect(row.response_ref).toBeNull();expect(row.resumed_at).toBeNull();expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(phase==='before-dispatch'?0:1);expect(w.modelCalls()).toBe(1);expect((await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows).toHaveLength(0);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);
 }finally{isolated.db.formalProfileHash=null;}
},120000);

it('only the exact actual background claim can use the CLOSED-bound dynamic mention observer without a model lease',async()=>{
 const w=await world({dynamic:true,formal:true});try{
  await w.runtime.advance(w.f.ctx,w.runId);expect((await w.state()).status).toBe('WAITING_EXTERNAL');expect((await w.row()).state).toBe('QUEUED');let observed=false;
  w.setBeforeObserve(async(claim,row)=>{
   if(observed)return; // This rejection matrix targets the pre-dispatch claim.
   const before=w.dynamic!.observations.length;
   for(const changed of [{...claim,fence:claim.fence+1},{...claim,workerId:randomUUID()},{...claim,id:randomUUID()}])await expect(w.service.observe(w.f.ctx,changed,row,signal())).rejects.toThrow('AGENT_GROUP_AUDIENCE_CHANGED');
   expect(w.dynamic!.observations).toHaveLength(before);expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(0);expect((await w.state()).lease_owner).toBeNull();observed=true;
  });
  expect(await w.worker.once(w.f.ctx,signal())).toBe(true);expect(observed).toBe(true);expect((await w.row()).state).toBe('RESPONSE_RECEIVED');expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);
 }finally{isolated.db.formalProfileHash=null;}
},120000);
it('an actual CLOSED-bound dynamic group cancellation after dispatch retains UNKNOWN and cannot resume or send',async()=>{
 const w=await world({dynamic:true,formal:true});try{
  await w.runtime.advance(w.f.ctx,w.runId);w.setBeforeCall(async()=>{await new TaskStore(isolated.db).cancel(w.f.ctx,w.taskId);await new Promise(resolve=>setTimeout(resolve,1100));});await w.worker.once(w.f.ctx,signal());const row=await w.row();expect(row.state).toBe('UNKNOWN');expect(row.enterprise_cost).toBe('UNKNOWN');expect(row.remote_cancellation).toBe('UNCONFIRMED');expect(row.response_ref).toBeNull();expect(row.resumed_at).toBeNull();expect(w.methods.filter(m=>m==='tools/call')).toHaveLength(1);expect(w.modelCalls()).toBe(1);expect(await w.worker.once(w.f.ctx,signal())).toBe(false);expect((await isolated.root.query('SELECT id FROM deliveries WHERE source_run_id=$1',[w.runId])).rows).toHaveLength(0);
 }finally{isolated.db.formalProfileHash=null;}
},120000);
