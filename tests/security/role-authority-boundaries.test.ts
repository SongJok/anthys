import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore,LeaseLost} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName,type Capability} from '../../packages/gateway/src/index.js';
import {approvalFixture} from '../support/approval.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),runtime=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),store=new RuntimeStore(runtime,new Vault(new Map([['1',randomBytes(32)]]),'1'));
const apps:Array<{close:()=>Promise<void>}>=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
afterAll(async()=>{await runtime.close();await appDb.close();await root.end();});
async function fresh(kind:string,positive:boolean){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic typed role scopes','ACTIVE')",[ctx.tenantId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic role requester','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const tasks=new TaskStore(appDb),task=await tasks.create(ctx,'synthetic typed scope action',randomUUID()),otherTask=await tasks.create(ctx,'synthetic unrelated scope',randomUUID()),lease=(await store.acquire(ctx,task.runId,'typed-scope-fixture'))!,resource=kind==='TASK'&&!positive?otherTask.taskId:task.taskId,groupId=randomUUID(),capabilityId='synthetic.role.scope.'+randomUUID(),gateway=new Gateway(store);
 // Deliberate, valid identifiers in different namespaces. An existing user
 // with the task UUID must not turn that user's role into task authority.
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic colliding user','ACTIVE')",[ctx.tenantId,resource]);
 const destination=kind==='GROUP'&&positive?{kind:'GROUP',targetId:groupId,classificationCeiling:'INTERNAL',membershipVersion:1}:lease.audience;
 const cap:Capability={...syntheticResultContract,id:capabilityId,version:'1.0.0',description:'Synthetic real PostgreSQL scoped write',provider:'CORE',risk:'SHARED_WRITE',state:'READY',bindingHash:hash(capabilityId),schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},resource:()=>resource,approvalPreview:()=>({operation:'Synthetic isolated scope write'}),operationAudience:()=>destination,
  execute:async(_a,{principal,actionKey})=>{const receipt=randomUUID();await runtime.scope(principal,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_TYPED_ROLE_WRITE',$4,'{}',$5,now())",[principal.tenantId,receipt,principal.actorId,task.runId,actionKey]));return {status:'OK',data:{receipt},evidenceIds:[receipt],completeness:'COMPLETE'};},
  verify:async(result,_a,{principal})=>{const receipt=(result.data as {receipt:string}).receipt,q=await runtime.scope(principal,c=>c.query("SELECT id FROM outbox WHERE id=$1 AND owner_id=$2 AND kind='SYNTHETIC_TYPED_ROLE_WRITE'",[receipt,principal.actorId]));return {...result,verification:{state:q.rowCount?'VERIFIED':'MISMATCH',method:'SYNTHETIC_POSTGRES_READ_BACK'}};}
 };gateway.register(cap);
 if(resource!==task.taskId)await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,capabilityId,resource]);
 if(kind==='GROUP'&&positive)await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,membership_version,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'GROUP',$6,1,'INTERNAL',clock_timestamp()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,capabilityId,resource,groupId]);
 expect((await gateway.execute(ctx,lease,toolName(capabilityId,'1.0.0'),{},AbortSignal.timeout(5000))).status).toBe('NEEDS_APPROVAL');const action=(await root.query('SELECT id FROM tool_actions WHERE run_id=$1',[task.runId])).rows[0].id as string,api=await approvalFixture(root,appDb,store,ctx,action);apps.push(api.app);
 const scopeId=kind==='TENANT'?ctx.tenantId:kind==='CAPABILITY'?capabilityId:kind==='CONNECTOR'?'CORE':kind==='GROUP'&&positive?groupId:kind==='USER'&&positive?ctx.actorId:kind==='TASK'&&positive?task.taskId:resource;
 await root.query('UPDATE role_bindings SET scope_kind=$2,scope_id=$3 WHERE id=$1',[api.authorityId,kind,scopeId]);api.reviewer=await api.sessions.create({tenantId:ctx.tenantId,actorId:api.approverId});
 api.preview=id=>api.app.inject({method:'GET',url:'/api/v1/approvals/'+id,headers:api.headers(api.reviewer)});api.decide=(id,data,decision='APPROVE')=>api.app.inject({method:'POST',url:'/api/v1/approvals/'+id+'/decision',headers:api.headers(api.reviewer),payload:{nonce:data.nonce,argsHash:data.argsHash,version:data.version,decision}});
 return {ctx,task,lease,gateway,capabilityId,resource,api,action,scopeId,writeCount:async()=>Number((await root.query("SELECT count(*) FROM outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND kind='SYNTHETIC_TYPED_ROLE_WRITE'",[ctx.tenantId,task.runId])).rows[0].count)};
}
it.each(['GROUP','USER','TASK'])('T030 component: %s authority cannot become authority over a coincident resource identifier',async kind=>{
 const f=await fresh(kind,false),request=await f.api.request();
 // If the boundary is broken, follow the actual API decision and Gateway
 // dispatch before asserting, so the regression records a physical effect.
 if(request.statusCode===200){const id=request.json().data.id as string,preview=await f.api.preview(id);if(preview.statusCode===200){const decision=await f.api.decide(id,preview.json().data);if(decision.statusCode===200){const lease=(await store.acquire(f.ctx,f.task.runId,'typed-negative-dispatch'))!;await f.gateway.execute(f.ctx,lease,toolName(f.capabilityId,'1.0.0'),{},AbortSignal.timeout(5000));}}}
 expect.soft(request.statusCode).toBe(409);expect.soft(await f.writeCount()).toBe(0);
});
it.each(['RESOURCE','TASK','USER','GROUP','CAPABILITY','CONNECTOR','TENANT'])('typed %s authority permits only its actual action context and a verified write',async kind=>{
 const f=await fresh(kind,true),request=await f.api.request();expect.soft(request.statusCode,request.body).toBe(200);
 if(request.statusCode===200){const id=request.json().data.id as string,preview=await f.api.preview(id);expect(preview.statusCode,preview.body).toBe(200);const decision=await f.api.decide(id,preview.json().data);expect(decision.statusCode,decision.body).toBe(200);const lease=(await store.acquire(f.ctx,f.task.runId,'typed-positive-dispatch'))!,result=await f.gateway.execute(f.ctx,lease,toolName(f.capabilityId,'1.0.0'),{},AbortSignal.timeout(5000));expect(result).toMatchObject({status:'OK',verification:{state:'VERIFIED'}});}
 expect.soft(await f.writeCount()).toBe(1);
});
it('a newly assigned role invalidates the recipient old session and lease at the database boundary',async()=>{
 const f=await fresh('RESOURCE',true),session=await f.api.sessions.create(f.ctx);expect(await f.api.sessions.authenticate(session.cookie)).not.toBeNull();await store.guarded(f.ctx,f.lease,async c=>{expect((await c.query('SELECT 1')).rowCount).toBe(1);});
 await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'TENANT_ADMIN')",[f.ctx.tenantId,randomUUID()]);await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='TENANT_ADMIN'),$3,'TENANT',$1::uuid::text)",[f.ctx.tenantId,randomUUID(),f.ctx.actorId]);
 expect.soft(await f.api.sessions.authenticate(session.cookie)).toBeNull();await expect(store.guarded(f.ctx,f.lease,async()=>true)).rejects.toBeInstanceOf(LeaseLost);const next=await f.api.sessions.create(f.ctx);expect((await f.api.sessions.authenticate(next.cookie))?.roles).toContain('TENANT_ADMIN');
});

it('legacy untyped authority cannot infer a group from a resource while the persisted action permits its exact group',async()=>{
 const f=await fresh('GROUP',true),values=await runtime.scope(f.ctx,async c=>(await c.query("SELECT public.oa_control_authority_for($1,'ACTION_APPROVER',$2,$3,'CORE') legacy,public.oa_control_action_authority($1,'ACTION_APPROVER',$4) typed",[f.api.approverId,f.capabilityId,f.scopeId,f.action])).rows[0]);expect(values.legacy).toBeNull();expect(values.typed.id).toBe(f.api.authorityId);const foreign={tenantId:randomUUID(),actorId:randomUUID()};expect((await runtime.scope(foreign,c=>c.query("SELECT public.oa_control_action_authority($1,'ACTION_APPROVER',$2) value",[f.api.approverId,f.action]))).rows[0].value).toBeNull();
});
it('one group authority cannot approve an action spanning another execution group',async()=>{
 const f=await fresh('GROUP',true);await root.query('UPDATE tool_actions SET execution_audience=$2 WHERE id=$1',[f.action,JSON.stringify({kind:'GROUP',targetId:randomUUID(),classificationCeiling:'INTERNAL',membershipVersion:1})]);expect((await runtime.scope(f.ctx,c=>c.query("SELECT public.oa_control_action_authority($1,'ACTION_APPROVER',$2) value",[f.api.approverId,f.action]))).rows[0].value).toBeNull();expect((await f.api.request()).statusCode).toBe(409);expect(await f.writeCount()).toBe(0);
});
it('a duplicate role insertion that changes no row preserves current sessions and auth epoch',async()=>{
 const f=await fresh('RESOURCE',true),before=(await root.query('SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[f.ctx.tenantId,f.api.approverId])).rows[0].auth_epoch;expect(await f.api.sessions.authenticate(f.api.reviewer.cookie)).not.toBeNull();const result=await root.query('INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) SELECT tenant_id,id,role_id,subject_id,scope_kind,scope_id FROM role_bindings WHERE id=$1 ON CONFLICT DO NOTHING',[f.api.authorityId]);expect(result.rowCount).toBe(0);expect((await root.query('SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[f.ctx.tenantId,f.api.approverId])).rows[0].auth_epoch).toBe(before);expect(await f.api.sessions.authenticate(f.api.reviewer.cookie)).not.toBeNull();
});
it('moving a role invalidates both former and new recipient sessions plus the new recipient in-flight lease',async()=>{
 const f=await fresh('RESOURCE',true),owner=await f.api.sessions.create(f.ctx),before=(await root.query('SELECT version FROM role_bindings WHERE id=$1',[f.api.authorityId])).rows[0].version;expect(await f.api.sessions.authenticate(owner.cookie)).not.toBeNull();expect(await f.api.sessions.authenticate(f.api.reviewer.cookie)).not.toBeNull();await root.query('UPDATE role_bindings SET subject_id=$2 WHERE id=$1',[f.api.authorityId,f.ctx.actorId]);expect(await f.api.sessions.authenticate(owner.cookie)).toBeNull();expect(await f.api.sessions.authenticate(f.api.reviewer.cookie)).toBeNull();await expect(store.guarded(f.ctx,f.lease,async()=>true)).rejects.toBeInstanceOf(LeaseLost);expect(Number((await root.query('SELECT version FROM role_bindings WHERE id=$1',[f.api.authorityId])).rows[0].version)).toBe(Number(before)+1);
});
