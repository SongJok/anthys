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
loadEnvFile();const db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const ctx={tenantId:ids.tenantA,actorId:ids.bob},store=new RuntimeStore(db,new Vault(new Map([['1',randomBytes(32)]]),'1'));
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();await appDb.close();await admin.end();});
async function setup(risk:Capability['risk']='READ'){
 const task=await new TaskStore(appDb).create(ctx,'synthetic gateway regression',randomUUID()),lease=(await store.acquire(ctx,task.runId,randomUUID()))!,gateway=new Gateway(store);let effects=0;
 const id='synthetic.external.'+randomUUID(),resource='synthetic-resource-'+randomUUID(),bindingHash=randomUUID();
 const capability:Capability={...syntheticResultContract,approvalPreview:args=>({syntheticArguments:args}),operationAudience:(_args,lease)=>lease.audience,id,version:'1.0.0',risk,provider:'MCP',state:'READY',description:'Synthetic resource read/write fixture',bindingHash,schema:z.object({value:z.number().int().optional()}).strict(),jsonSchema:{type:'object',properties:{value:{type:'integer'}},additionalProperties:false},resource:()=>resource,execute:async()=>{effects++;return {status:'OK',data:{value:1},evidenceIds:[],completeness:'COMPLETE'};}};
 gateway.register(capability);
 const bind=()=>admin.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,$5,'READY')",[ctx.tenantId,randomUUID(),id,bindingHash,risk]);
 const grant=()=>admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$6,'INTERNAL',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,id,resource,ctx.actorId]);
 return {task,lease,gateway,id,resource,bindingHash,capability,bind,grant,effects:()=>effects,name:toolName(id,'1.0.0')};
}
it('T035/T078 discovery and execution deny missing binding/resource grant with zero provider calls',async()=>{
 const s=await setup();expect(await s.gateway.tools(ctx,s.lease)).toEqual([]);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);
 await s.bind();expect(await s.gateway.tools(ctx,s.lease)).toEqual([]);await s.grant();expect((await s.gateway.tools(ctx,s.lease)).map(t=>t.function.name)).toEqual([s.name]);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('OK');expect(s.effects()).toBe(1);
 await admin.query('UPDATE resource_grants SET revoked_at=now() WHERE capability_id=$1',[s.id]);expect(await s.gateway.tools(ctx,s.lease)).toEqual([]);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(1);await store.release(ctx,s.lease);
});
it('T080 schema drift immediately hides the capability and blocks even cached results',async()=>{
 const s=await setup();await s.bind();await s.grant();expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('OK');
 await admin.query("UPDATE capability_bindings SET schema_hash='changed-schema' WHERE logical_id=$1",[s.id]);expect(await s.gateway.tools(ctx,s.lease)).toEqual([]);expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(1);await store.release(ctx,s.lease);
});
it('T029/T030 hash changes and approver departure invalidate approval before any write',async()=>{
 const s=await setup('SHARED_WRITE');await s.bind();await s.grant();expect((await s.gateway.execute(ctx,s.lease,s.name,{value:1},new AbortController().signal)).status).toBe('NEEDS_APPROVAL');expect(s.effects()).toBe(0);
 const action=await db.scope(ctx,c=>c.query('SELECT id,args_hash FROM tool_actions WHERE run_id=$1',[s.task.runId]));
 const approver='00000000-0000-4000-8000-000000000095';
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'synthetic-approver','synthetic-approver','ACTIVE') ON CONFLICT(tenant_id,id) DO UPDATE SET status='ACTIVE'",[ctx.tenantId,approver]);
 s.lease=await approveViaApi(admin,appDb,store,ctx,action.rows[0].id as string,approver);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{value:2},new AbortController().signal)).status).toBe('NEEDS_APPROVAL');expect(s.effects()).toBe(0);
 await admin.query("UPDATE users SET status='DEPARTED' WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,approver]);expect((await s.gateway.execute(ctx,s.lease,s.name,{value:1},new AbortController().signal)).status).toBe('NEEDS_APPROVAL');expect(s.effects()).toBe(0);await store.release(ctx,s.lease);
});
it('invalid parameters, forbidden registry entries and missing names never reach adapters',async()=>{
 const s=await setup();await s.bind();await s.grant();
 expect((await s.gateway.execute(ctx,s.lease,'cap_unknown',{},new AbortController().signal)).status).toBe('DENIED');
 expect((await s.gateway.execute(ctx,s.lease,s.name,{value:'--token=bad'},new AbortController().signal)).status).toBe('PERMANENT_ERROR');
 expect(()=>s.gateway.register(s.capability)).toThrow('DUPLICATE_CAPABILITY');
 const forbidden={...s.capability,id:s.id+'.forbidden',risk:'FORBIDDEN' as const};s.gateway.register(forbidden);expect((await s.gateway.tools(ctx,s.lease)).map(t=>t.function.name)).not.toContain(toolName(forbidden.id,forbidden.version));expect(s.effects()).toBe(0);await store.release(ctx,s.lease);
});
it('T035 provider annotations cannot downgrade the reviewed registry risk',async()=>{
 const s=await setup('READ');await s.bind();await s.grant();
 await admin.query("UPDATE capability_bindings SET risk='SHARED_WRITE' WHERE logical_id=$1",[s.id]);
 expect(await s.gateway.tools(ctx,s.lease)).toEqual([]);
 expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);await store.release(ctx,s.lease);
});
it('T031 concurrent approved consumption permits only one external write and no self-approval',async()=>{
 const s=await setup('SHARED_WRITE');await s.bind();await s.grant();
 await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal);
 const action=await db.scope(ctx,c=>c.query('SELECT id,args_hash FROM tool_actions WHERE run_id=$1',[s.task.runId]));
 await expect(admin.query("INSERT INTO approvals(tenant_id,id,owner_id,action_id,approver_id,args_hash,state,expires_at,nonce_hash,approver_auth_epoch) VALUES($1,$2,$3,$4,$3,$5,'APPROVED',now()+interval '1 hour','synthetic',1)",[ctx.tenantId,randomUUID(),ctx.actorId,action.rows[0].id,action.rows[0].args_hash])).rejects.toMatchObject({code:'23514'});
 s.lease=await approveViaApi(admin,appDb,store,ctx,action.rows[0].id as string);
 const results=await Promise.all(Array.from({length:20},()=>s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)));expect(s.effects()).toBe(1);expect(results.every(r=>['OK','UNKNOWN'].includes(r.status))).toBe(true);
 const approval=await admin.query('SELECT state FROM approvals WHERE action_id=$1',[action.rows[0].id]);expect(approval.rows[0].state).toBe('CONSUMED');await store.release(ctx,s.lease);
});
it('a manually installed GROUP grant cannot certify resource sharing, including after budget reset',async()=>{
 const s=await setup();await s.bind();await s.grant();
 const audience={kind:'GROUP',targetId:'synthetic-group',membershipVersion:1,classificationCeiling:'INTERNAL'};await store.release(ctx,s.lease);await admin.query('UPDATE tasks SET audience=$2 WHERE id=$1',[s.task.taskId,JSON.stringify(audience)]);const groupLease=(await store.acquire(ctx,s.task.runId,randomUUID()))!;
 expect(await s.gateway.tools(ctx,groupLease)).toEqual([]);expect((await s.gateway.execute(ctx,groupLease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);
 await admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at,membership_version) VALUES($1,$2,$3,$4,$5,'GROUP','synthetic-group','INTERNAL',now()+interval '1 hour',1)",[ctx.tenantId,randomUUID(),ctx.actorId,s.id,s.resource]);
 // A grant alone proves neither a complete current audience nor every member's
 // resource ACL. Until those proofs exist GROUP business tools stay disabled.
 expect(await s.gateway.tools(ctx,groupLease)).toEqual([]);
 await admin.query('UPDATE runs SET tool_calls=24 WHERE id=$1',[s.task.runId]);expect((await s.gateway.execute(ctx,groupLease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);
 await admin.query('UPDATE runs SET tool_calls=0 WHERE id=$1',[s.task.runId]);expect((await s.gateway.execute(ctx,groupLease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);await store.release(ctx,groupLease);
});
it('a private resource grant still obeys the tool budget and resumes only when the test restores remaining budget',async()=>{
 const s=await setup();await s.bind();await s.grant();expect((await s.gateway.tools(ctx,s.lease)).map(t=>t.function.name)).toContain(s.name);
 await admin.query('UPDATE runs SET tool_calls=24 WHERE id=$1',[s.task.runId]);expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);
 await admin.query('UPDATE runs SET tool_calls=0 WHERE id=$1',[s.task.runId]);expect((await s.gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal)).status).toBe('OK');expect(s.effects()).toBe(1);await store.release(ctx,s.lease);
});
it('registry defaults, tool exposure cap and forbidden execution fail closed',async()=>{
 const s=await setup(),gateway=new Gateway(store);let calls=0;
 for(let i=0;i<26;i++)gateway.register({...s.capability,id:`synthetic.core-${i}`,provider:'CORE',resource:(_args,lease)=>lease.taskId,execute:async()=>{calls++;return {status:'OK',evidenceIds:[],completeness:'COMPLETE'};}});
 gateway.register({...s.capability,id:'synthetic.unverified',state:'UNVERIFIED'});
 gateway.register({...s.capability,id:'synthetic.forbidden',provider:'CORE',risk:'FORBIDDEN',resource:(_args,lease)=>lease.taskId});
 expect((await gateway.tools(ctx,s.lease)).length).toBe(24);
 expect((await gateway.execute(ctx,s.lease,toolName('synthetic.unverified','1.0.0'),{},new AbortController().signal)).status).toBe('DENIED');
 expect((await gateway.execute(ctx,s.lease,toolName('synthetic.forbidden','1.0.0'),{},new AbortController().signal)).status).toBe('DENIED');expect(calls).toBe(0);await store.release(ctx,s.lease);
});
it('read provider failure becomes a structured result and is retained without false success',async()=>{
 const s=await setup(),gateway=new Gateway(store);let calls=0;
 gateway.register({...s.capability,provider:'CORE',resource:(_args,lease)=>lease.taskId,execute:async()=>{calls++;throw Error('synthetic transport failure');}});
 const first=await gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal);expect(first.status).toBe('RETRYABLE_ERROR');
 const second=await gateway.execute(ctx,s.lease,s.name,{},new AbortController().signal);expect(second.status).toBe('RETRYABLE_ERROR');expect(calls).toBe(1);
 expect((await db.scope(ctx,c=>c.query('SELECT state FROM tool_actions WHERE run_id=$1',[s.task.runId]))).rows[0].state).toBe('FAILED');await store.release(ctx,s.lease);
});
it('a legacy PRIVATE_USER audience naming another recipient exposes neither CORE nor external tools',async()=>{
 const s=await setup();await s.bind();await s.grant();const other=randomUUID();await store.release(ctx,s.lease);await admin.query('UPDATE tasks SET audience=$2 WHERE id=$1',[s.task.taskId,JSON.stringify({kind:'PRIVATE_USER',targetId:other,classificationCeiling:'INTERNAL'})]);const lease=(await store.acquire(ctx,s.task.runId,'wrong-private-recipient'))!;try{s.gateway.register({...s.capability,id:s.id+'.core',provider:'CORE',resource:(_args,l)=>l.taskId});expect(await s.gateway.tools(ctx,lease)).toEqual([]);expect((await s.gateway.execute(ctx,lease,s.name,{},new AbortController().signal)).status).toBe('DENIED');expect(s.effects()).toBe(0);}finally{await store.release(ctx,lease);}
});
