import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import {approveViaApi} from '../support/approval.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {z} from 'zod';
import pg from 'pg';
import {loadEnvFile,secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName,type Capability} from '../../packages/gateway/src/index.js';
import {ids,seed} from '../../scripts/seed.js';

loadEnvFile();
const db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const ctx={tenantId:ids.tenantA,actorId:ids.bob},store=new RuntimeStore(db,new Vault(new Map([['1',randomBytes(32)]]),'1'));
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();await appDb.close();await admin.end();});

/** A synthetic external provider that declares an idempotency key and persists
 * exactly one durable business object per key. The executor records every key
 * it actually receives, so the oracle can distinguish a gateway replay from a
 * second provider dispatch. */
async function setup(){
 const task=await new TaskStore(appDb).create(ctx,'synthetic T118 idempotent action',randomUUID()),lease=(await store.acquire(ctx,task.runId,randomUUID()))!,gateway=new Gateway(store);
 const id='synthetic.idempotent.'+randomUUID(),resource='synthetic-resource-'+randomUUID(),bindingHash=randomUUID(),keys:string[]=[],objects=new Map<string,string>();
 const capability:Capability={...syntheticResultContract,supportsIdempotency:true,approvalPreview:args=>({syntheticArguments:args}),operationAudience:(_args,l)=>l.audience,id,version:'1.0.0',risk:'SHARED_WRITE',provider:'MCP',state:'READY',description:'Synthetic external write that certifies its provider idempotency key',bindingHash,schema:z.object({value:z.number().int().nonnegative()}).strict(),jsonSchema:{type:'object',properties:{value:{type:'integer',minimum:0}},required:['value'],additionalProperties:false},resource:()=>resource,execute:async(args,{principal,lease,actionKey})=>{
  keys.push(actionKey);const value=(args as {value:number}).value;
  let receipt=objects.get(actionKey);
  if(!receipt){receipt=randomUUID();objects.set(actionKey,receipt);await store.db.scope(principal,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_T118_WRITE',$4,$5,$6,now())",[principal.tenantId,receipt,principal.actorId,lease.runId,JSON.stringify({receipt,value,providerKey:actionKey}),actionKey]));}
  return {status:'OK',data:{receipt,value,providerKey:actionKey},evidenceIds:[receipt],completeness:'COMPLETE'};
 },verify:async(result,args,{principal})=>{
  const data=result.data as {receipt:string;providerKey:string},q=await store.db.scope(principal,c=>c.query("SELECT dedup_key FROM outbox WHERE id=$1 AND kind='SYNTHETIC_T118_WRITE'",[data.receipt]));
  return {...result,verification:{state:q.rowCount&&q.rows[0].dedup_key===data.providerKey?'VERIFIED':'MISMATCH',method:'SYNTHETIC_PROVIDER_READ_BACK'}};
 }};
 gateway.register(capability);
 const bind=()=>admin.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,$5,'READY')",[ctx.tenantId,randomUUID(),id,bindingHash,'SHARED_WRITE']);
 const grant=()=>admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$6,'INTERNAL',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,id,resource,ctx.actorId]);
 const ledger=async()=>(await admin.query('SELECT id,logical_action_key,state,result FROM tool_actions WHERE run_id=$1 ORDER BY created_at,id',[task.runId])).rows;
 const external=async()=>(await admin.query("SELECT id,dedup_key,payload_ref FROM outbox WHERE aggregate_id=$1 AND kind='SYNTHETIC_T118_WRITE'",[task.runId])).rows;
 return {task,lease,gateway,name:toolName(id,'1.0.0'),bind,grant,ledger,external,keys,objects:()=>objects,executions:()=>keys.length};
}

it('T118 replaying the same approved action reuses one provider idempotency key and one external object',async()=>{
 const s=await setup();await s.bind();await s.grant();
 // The key is derived from the reviewed action scope, not from the request.
 const first=await s.gateway.execute(ctx,s.lease,s.name,{value:7},new AbortController().signal);
 expect(first.status).toBe('NEEDS_APPROVAL');expect(s.executions()).toBe(0);
 const [pending]=await s.ledger();
 expect(pending).toMatchObject({state:'APPROVAL_REQUIRED'});
 s.lease=await approveViaApi(admin,appDb,store,ctx,pending.id as string);
 const results=[];
 for(let round=0;round<6;round++)results.push(await s.gateway.execute(ctx,s.lease,s.name,{value:7},new AbortController().signal));
 // Every replay returns the recorded provider result; only one dispatch ran.
 expect(results.map(r=>r.status)).toEqual(Array(6).fill('OK'));
 const receipts=new Set(results.map(r=>((r as {data:{receipt:string}}).data.receipt)));
 expect(receipts.size).toBe(1);
 expect(s.executions()).toBe(1);
 expect(s.keys).toEqual([pending.logical_action_key]);
 expect(s.keys[0]!.split(':')[0]).toBe(s.task.runId);
 // Exactly one external business object and one verified ledger row exist.
 const external=await s.external();
 expect(external).toHaveLength(1);
 expect(external[0]).toMatchObject({dedup_key:pending.logical_action_key});
 expect(external[0]!.payload_ref).toMatchObject({providerKey:pending.logical_action_key,value:7});
 const ledger=await s.ledger();
 expect(ledger).toHaveLength(1);
 expect(ledger[0]).toMatchObject({state:'VERIFIED',logical_action_key:pending.logical_action_key});
 expect(ledger[0]!.result).toMatchObject({status:'OK',verification:{state:'VERIFIED',method:'SYNTHETIC_PROVIDER_READ_BACK'},data:{receipt:[...receipts][0],value:7,providerKey:pending.logical_action_key}});
 // Replays are not new tool usage; the single approval is consumed once.
 expect(Number((await admin.query('SELECT tool_calls FROM runs WHERE id=$1',[s.task.runId])).rows[0].tool_calls)).toBe(1);
 expect((await admin.query('SELECT state FROM approvals WHERE action_id=$1',[pending.id])).rows).toEqual([{state:'CONSUMED'}]);
 await store.release(ctx,s.lease);
},60000);

it('T118 a different argument set is a separate action and cannot reuse the prior approval or provider key',async()=>{
 const s=await setup();await s.bind();await s.grant();
 await s.gateway.execute(ctx,s.lease,s.name,{value:7},new AbortController().signal);
 const [pending]=await s.ledger();
 s.lease=await approveViaApi(admin,appDb,store,ctx,pending.id as string);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{value:7},new AbortController().signal)).status).toBe('OK');
 const other=await s.gateway.execute(ctx,s.lease,s.name,{value:8},new AbortController().signal);
 expect(other.status).toBe('NEEDS_APPROVAL');expect(s.executions()).toBe(1);expect(await s.external()).toHaveLength(1);
 const ledger=await s.ledger();
 expect(ledger).toHaveLength(2);
 expect(ledger.map(row=>row.state).sort()).toEqual(['APPROVAL_REQUIRED','VERIFIED']);
 expect(new Set(ledger.map(row=>row.logical_action_key)).size).toBe(2);
 await store.release(ctx,s.lease);
},60000);
