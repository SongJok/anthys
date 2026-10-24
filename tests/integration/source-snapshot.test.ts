import {groupReminderDatabase} from '../support/group-reminder-database.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName,type Capability} from '../../packages/gateway/src/index.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {artifactWorld} from '../support/artifact-world.js';
import {syntheticResultContract} from '../support/capability-result-contract.js';

const signal=()=>new AbortController().signal;
const current='SYNTHETIC_CURRENT_ACTION';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,store:RuntimeStore,gateway:Gateway,sessions:Sessions;
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');

beforeAll(async()=>{
 isolated=await groupReminderDatabase();await isolated.install();expect(await isolated.db.ready()).toBe(true);
 store=new RuntimeStore(isolated.db,vault);gateway=new Gateway(store);sessions=new Sessions(isolated.db,randomBytes(32).toString('hex'));
},60000);
afterAll(async()=>{await isolated?.close();});

const world=async()=>artifactWorld({isolated,store,gateway,sessions},'http://127.0.0.1:64799',{finalize:false});
type World=Awaited<ReturnType<typeof world>>;
const snapshot=(w:World,key:string,abort?:AbortSignal)=>isolated.db.scope(w.ctx,c=>gateway.snapshotToolSources(w.ctx,w.lease,c,key,abort??signal()));

/** A second real source action of the same run. It is produced by the real
 * Gateway so the row carries the production provenance the snapshot verifies. */
async function secondAction(w:World,provider:'MCP'|'CORE',options:{protectResult?:boolean;classify?:string}={}){
 const capId='synthetic.snapshot.'+randomUUID(),bindingHash=hash(capId);
 const cap:Capability={...syntheticResultContract,id:capId,version:'1.0.0',description:'Synthetic secondary snapshot source',risk:'READ',provider,authModes:provider==='CORE'?['CORE']:['SERVICE'],bindingHash,state:'READY',protectResult:options.protectResult??true,schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},resource:()=>w.taskId,allowResource:async()=>true,execute:async()=>({status:'OK',data:{marker:'SYNTHETIC_SECONDARY_SOURCE'},evidenceIds:[],completeness:'COMPLETE'}),...(options.classify?{classifyResult:(()=>options.classify as unknown as 'PUBLIC')}:{})};
 gateway.register(cap);
 if(provider!=='CORE'){
  await isolated.root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,'READ','READY')",[w.ctx.tenantId,randomUUID(),capId,bindingHash]);
  await isolated.root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',clock_timestamp()+interval '1 hour')",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,capId,w.taskId]);
 }
 await store.renew(w.ctx,w.lease);
 const result=await gateway.execute(w.ctx,w.lease,toolName(capId,'1.0.0'),{},signal());
 expect(result.status,JSON.stringify(result)).toBe('OK');
 const row=(await isolated.root.query('SELECT id,logical_action_key,state FROM tool_actions WHERE run_id=$1 AND logical_action_key LIKE $2',[w.runId,`${w.runId}:${capId}:%`])).rows[0];
 expect(row.state).toBe('VERIFIED');
 return {capId,row};
}

/** An action row the runtime never wrote, used to model a ledger that the
 * snapshot must refuse instead of reading as a source. */
async function insertRow(w:World,values:{state:string;capabilityId:string;inputRef?:unknown;result?:unknown;policyVersion?:string}){
 const id=randomUUID();
 await isolated.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version,capability_id,binding_hash,risk,resource_id,input_ref,execution_auth_epoch,execution_policy_version,execution_audience,result) VALUES($1,$2,$3,$4,$5,'SYNTHETIC-ARGS-HASH',$6,'MCP','1.0.0',$7,'SYNTHETIC-BINDING-HASH','READ',$8,$9,1,$10,'{}'::jsonb,$11)",[w.ctx.tenantId,id,w.ctx.actorId,w.runId,`${w.runId}:synthetic.injected.${id}`,values.state,values.capabilityId,w.taskId,JSON.stringify(values.inputRef??{}),values.policyVersion??'SYNTHETIC-POLICY',JSON.stringify(values.result??{})]);
 return id;
}

it('a real snapshot returns the current session, the verified evidence and the highest source classification',async()=>{
 const w=await world(),second=await secondAction(w,'MCP');
 const result=await snapshot(w,second.row.logical_action_key);
 expect(result.sessionNo).toBe(1);
 expect(result.evidence).toHaveLength(1);
 expect(result.evidence[0]).toMatchObject({state:'VERIFIED'});
 expect(result.evidence[0]!.fact.capabilityId).toBe(w.capId);
 expect(result.evidence[0]!.fact.argsHash).toBeTruthy();
 expect(result.classification).toBe('RESTRICTED');
},30000);

it('a core source without its own classifier is INTERNAL instead of the external default',async()=>{
 const w=await world(),second=await secondAction(w,'CORE',{protectResult:false});
 const worldKey=(await isolated.root.query('SELECT logical_action_key FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[w.runId,w.capId])).rows[0].logical_action_key;
 const result=await snapshot(w,worldKey);
 expect(result.evidence).toHaveLength(1);
 expect(result.evidence[0]!.fact.capabilityId).toBe(second.capId);
 expect(result.classification).toBe('INTERNAL');
},30000);

it('a source capability that classifies its own result is classified by that classifier',async()=>{
 const w=await world(),second=await secondAction(w,'CORE',{protectResult:false,classify:'CONFIDENTIAL'});
 const worldKey=(await isolated.root.query('SELECT logical_action_key FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[w.runId,w.capId])).rows[0].logical_action_key;
 const result=await snapshot(w,worldKey);
 expect(result.evidence).toHaveLength(1);
 expect(result.evidence[0]!.fact.capabilityId).toBe(second.capId);
 expect(result.classification).toBe('CONFIDENTIAL');
},30000);

it('an unrecognised source classification degrades to RESTRICTED instead of an empty level',async()=>{
 const w=await world(),second=await secondAction(w,'CORE',{protectResult:false,classify:'SYNTHETIC-UNKNOWN'});
 const worldKey=(await isolated.root.query('SELECT logical_action_key FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[w.runId,w.capId])).rows[0].logical_action_key;
 const result=await snapshot(w,worldKey);
 expect(result.evidence[0]!.fact.capabilityId).toBe(second.capId);
 expect(result.classification).toBe('RESTRICTED');
},30000);

it('a run whose provider session advanced without a checkpoint has no provable source scope',async()=>{
 const w=await world();
 await isolated.root.query('UPDATE runs SET provider_session_no=2 WHERE id=$1',[w.runId]);
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_CONTEXT_CHANGED');
},30000);

it('a revoked source grant stops the snapshot before any evidence is captured',async()=>{
 const w=await world();
 await isolated.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE actor_id=$1',[w.ctx.actorId]);
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_CONTEXT_CHANGED');
},30000);

it('more than sixty-four source actions in one run is refused instead of silently truncated',async()=>{
 const w=await world();
 await isolated.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version,capability_id,binding_hash,risk,resource_id,input_ref,execution_auth_epoch,execution_policy_version,execution_audience,result) SELECT $1,gen_random_uuid(),$2,$3,$4||i,'SYNTHETIC-ARGS-HASH','FAILED','MCP','1.0.0','synthetic.limit.'||i,'SYNTHETIC-BINDING-HASH','READ',$5,'{}'::jsonb,1,'SYNTHETIC-POLICY','{}'::jsonb,'{}'::jsonb FROM generate_series(1,65) i",[w.ctx.tenantId,w.ctx.actorId,w.runId,`${w.runId}:synthetic.limit.`,w.taskId]);
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_SNAPSHOT_LIMIT');
},30000);

it('an unresolved source action stops the snapshot instead of being skipped',async()=>{
 const w=await world();
 await insertRow(w,{state:'UNKNOWN',capabilityId:w.capId});
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_ACTION_UNRESOLVED');
},30000);

it('a source capability that is no longer registered stops the snapshot',async()=>{
 const w=await world();
 await insertRow(w,{state:'VERIFIED',capabilityId:'synthetic.unregistered.'+randomUUID()});
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_CAPABILITY_CHANGED');
},30000);

it('a source action whose recorded execution authority no longer matches stops the snapshot',async()=>{
 const w=await world(),second=await secondAction(w,'MCP');
 await isolated.root.query("UPDATE tool_actions SET execution_policy_version='SYNTHETIC-STALE-POLICY' WHERE logical_action_key=$1",[second.row.logical_action_key]);
 await expect(snapshot(w,current)).rejects.toThrow('SOURCE_AUTHORITY_CHANGED');
},30000);

it('an aborted snapshot returns no evidence at all',async()=>{
 const w=await world(),controller=new AbortController();
 controller.abort();
 await expect(snapshot(w,current,controller.signal)).rejects.toThrow();
},30000);
