import '../support/isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {config,secret} from '../../packages/config/src/index.js';
import {RuntimeStore,LeaseLost} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,canonical,toolName,capabilityDescriptorHash,type Capability} from '../../packages/gateway/src/index.js';
import {PermissionCenter,installPermissionManifest} from '../../packages/gateway/src/permissions.js';
import {PermissionAdministration} from '../../packages/gateway/src/permission-administration.js';
import {createServer} from '../../apps/api/src/server.js';
import {syntheticResultContract} from '../support/capability-result-contract.js';
import {dataResultContract} from '../../packages/contracts/src/result-contract.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,8),appDb=new Database(secret('DATABASE_URL')!,8);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const store=new RuntimeStore(db,vault),apis:Awaited<ReturnType<typeof createServer>>[]=[];
afterAll(async()=>{for(const api of apis)await api.app.close();await db.close();await appDb.close();await root.end();});
async function fresh(risk:Capability['risk']='READ'){
 const tenant=randomUUID(),admin={tenantId:tenant,actorId:randomUUID()},employee={tenantId:tenant,actorId:randomUUID()},groupAdmin={tenantId:tenant,actorId:randomUUID()},other={tenantId:tenant,actorId:randomUUID()};
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic grant management','ACTIVE')",[tenant,'synthetic-admin-'+tenant]);
 for(const person of [admin,employee,groupAdmin,other])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic actor','ACTIVE')",[tenant,person.actorId,'synthetic-'+person.actorId]);
 const roleId=randomUUID(),authorityId=randomUUID();
 await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'TENANT_ADMIN')",[tenant,roleId]);
 await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'TENANT',$1::uuid::text),($1,$5,$3,$6,'GROUP','synthetic-group')",[tenant,authorityId,roleId,admin.actorId,randomUUID(),groupAdmin.actorId]);
 const id='synthetic.managed.'+randomUUID(),resource='fixture:'+randomUUID(),bindingHash=hash(randomUUID()),jsonSchema={type:'object',properties:{},additionalProperties:false};
 const gateway=new Gateway(store);let effects=0;
 const capability:Capability={...syntheticResultContract,id,version:'1.0.0',description:'Synthetic reviewed resource',provider:'MCP',risk,state:'READY',bindingHash,schema:z.object({}).strict(),jsonSchema,resource:()=>resource,allowResource:async(_a,{principal})=>principal.tenantId===tenant&&principal.actorId===employee.actorId,approvalPreview:()=>({synthetic:true}),operationAudience:(_a,l)=>l.audience,execute:async()=>{effects++;return {status:'OK',data:{value:7},evidenceIds:[],completeness:'COMPLETE'};}};
 gateway.register(capability);
 const bindingId=randomUUID();await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0',$4,$5,$6,'READY')",[tenant,bindingId,id,JSON.stringify({token:'SYNTHETIC_NEVER_IN_API'}),bindingHash,risk]);
 const manifest={schemaVersion:'1.0' as const,capabilityId:id,capabilityVersion:'1.0.0',manifestVersion:1,bindingHash,inputSchemaHash:hash(canonical(jsonSchema)),description:'Synthetic local permission only',provider:'MCP' as const,risk,authMode:'CORE' as const,applicationRef:'synthetic-app',requiredScopes:['Synthetic.Read'],resourcePreconditions:['exact_owner_resource'],officialDocRefs:['S12'],reviewReference:'synthetic-review'};
 const install=async(doc:typeof manifest)=>{const c=await root.connect();try{await c.query('BEGIN');await installPermissionManifest(c,tenant,doc);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};await install(manifest);
 const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),finalReader:gateway});apis.push(api);
 const login=async(person=admin)=>{const token=await api.sessions.create(person);return {p:(await api.sessions.authenticate(token.cookie))!,cookie:'oa_session='+token.cookie,csrf:token.csrf};};
 const a=await login(admin),e=await login(employee),g=await login(groupAdmin),o=await login(other);
 const metadata=(name:string,v:string)=>gateway.describeCapability(name,v),administration=new PermissionAdministration(appDb,metadata),center=new PermissionCenter(appDb,metadata);
 const definition={capabilityId:id,capabilityVersion:'1.0.0',bindingHash,inputSchemaHash:manifest.inputSchemaHash,resourceId:resource,classificationCeiling:'INTERNAL' as const,expiresAt:new Date(Date.now()+3600000).toISOString(),reviewReference:'synthetic-review'};
 const create=(requestId=randomUUID(),grant=definition,targetUserId=employee.actorId)=>administration.create(a.p,{targetUserId,grant},requestId);
 const lease=async()=>{const task=await new TaskStore(appDb).create(employee,'synthetic managed authorization',randomUUID());return (await store.acquire(employee,task.runId,randomUUID()))!;};
 return {tenant,admin,employee,groupAdmin,other,a,e,g,o,roleId,authorityId,id,resource,bindingId,bindingHash,manifest,install,api,login,administration,center,definition,capability,gateway,create,lease,effects:()=>effects};
}

it('20 concurrent administrator creates commit one grant, immutable receipt and chained owner audit event',async()=>{
 const f=await fresh(),key=randomUUID(),results=await Promise.all(Array.from({length:20},()=>f.create(key)));
 expect(results.filter(r=>!r.replayed)).toHaveLength(1);expect(new Set(results.map(r=>r.id)).size).toBe(1);
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(1);
 expect((await root.query('SELECT request_id FROM permission_admin_requests WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(1);
 const events=(await root.query('SELECT kind,previous_hash FROM permission_events WHERE tenant_id=$1',[f.tenant])).rows;
 expect(events).toEqual([{kind:'RESOURCE_GRANTED',previous_hash:null}]);expect(f.effects()).toBe(0);
 await expect(f.create(key,{...f.definition,resourceId:'fixture:changed'})).rejects.toMatchObject({code:'PERMISSION_REQUEST_CONFLICT',status:409});
 await expect(root.query('DELETE FROM permission_admin_requests WHERE tenant_id=$1',[f.tenant])).rejects.toMatchObject({code:'23514'});
});
it.each(['employee','wrongScope','forgedRole','foreignSession','expiredRole','inactiveTarget'])('administrator admission rejects %s without new grants or provider effects',async kind=>{
 const f=await fresh();let principal=f.a.p;
 if(kind==='employee')principal=f.e.p;if(kind==='wrongScope')principal=f.g.p;if(kind==='forgedRole')principal={...f.e.p,roles:['TENANT_ADMIN']};if(kind==='foreignSession')principal={...f.e.p,sessionId:f.a.p.sessionId};
 if(kind==='expiredRole')await root.query("UPDATE role_bindings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.authorityId]);
 if(kind==='inactiveTarget')await root.query("UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.employee.actorId]);
 const rejection=await f.administration.create(principal,{targetUserId:f.employee.actorId,grant:f.definition},randomUUID()).then(()=>null,error=>error as {status:number;code:string});
 expect(rejection).not.toBeNull();
 if(kind==='inactiveTarget')expect(rejection).toMatchObject({status:404,code:'PERMISSION_NOT_FOUND'});
 else if(kind==='foreignSession')expect(rejection).toMatchObject({status:401,code:'PERMISSION_SESSION_INVALID'});
 else if(kind==='expiredRole'){expect([401,403]).toContain(rejection?.status);expect(['PERMISSION_SESSION_INVALID','PERMISSION_ADMIN_DENIED']).toContain(rejection?.code);}
 else expect(rejection).toMatchObject({status:403,code:'PERMISSION_ADMIN_DENIED'});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect(f.effects()).toBe(0);
});
it('cross-tenant targets and grants have the same not-found boundary and never mutate another tenant',async()=>{
 const a=await fresh(),b=await fresh(),saved=await b.create();
 await expect(a.administration.create(a.a.p,{targetUserId:b.employee.actorId,grant:a.definition},randomUUID())).rejects.toMatchObject({code:'PERMISSION_NOT_FOUND',status:404});
 await expect(a.administration.revoke(a.a.p,saved.id,{targetUserId:a.employee.actorId,version:1,reviewReference:'synthetic-review'},randomUUID())).rejects.toMatchObject({code:'PERMISSION_NOT_FOUND',status:404});
 expect((await root.query('SELECT version,revoked_at FROM resource_grants WHERE id=$1',[saved.id])).rows[0]).toMatchObject({version:'1',revoked_at:null});
 expect((await a.administration.resources(a.a.p)).items).toEqual([]);
});
it('renewal uses exact versions and request receipts; revocation invalidates the employee and explicit regrant starts a new revision',async()=>{
 const f=await fresh(),created=await f.create(),key=randomUUID(),input={targetUserId:f.employee.actorId,version:1,expiresAt:new Date(Date.now()+7200000).toISOString(),reviewReference:'synthetic-renew'};
 const renewed=await f.administration.renew(f.a.p,created.id,input,key);expect(renewed.version).toBe(2);
 expect((await f.administration.renew(f.a.p,created.id,input,key)).replayed).toBe(true);
 await expect(f.administration.renew(f.a.p,created.id,input,randomUUID())).rejects.toMatchObject({code:'PERMISSION_VERSION_CONFLICT'});
 const revokeKey=randomUUID(),revoke={targetUserId:f.employee.actorId,version:2,reviewReference:'synthetic-revoke'};
 const revoked=await f.administration.revoke(f.a.p,created.id,revoke,revokeKey);expect(revoked).toMatchObject({state:'REVOKED',version:3});
 expect(await f.api.sessions.authenticate(f.e.cookie.slice(11))).toBeNull();expect(await f.api.sessions.authenticate(f.o.cookie.slice(11))).not.toBeNull();
 await expect(f.administration.renew(f.a.p,created.id,{...input,version:3},randomUUID())).rejects.toMatchObject({code:'PERMISSION_GRANT_REVIEW_REQUIRED'});
 const regrant=await f.administration.regrant(f.a.p,created.id,{targetUserId:f.employee.actorId,version:3,grant:f.definition},randomUUID());expect(regrant).toMatchObject({version:4,state:'ACTIVE'});
 const oldReceipt=await f.administration.revoke(f.a.p,created.id,revoke,revokeKey);expect(oldReceipt).toMatchObject({replayed:true,state:'REVOKED',version:3,currentState:'ACTIVE',currentVersion:4});
 const events=(await root.query('SELECT kind,hash,previous_hash FROM permission_events WHERE tenant_id=$1 ORDER BY seq',[f.tenant])).rows;
 expect(events.map(r=>r.kind)).toEqual(['RESOURCE_GRANTED','RESOURCE_RENEWED','RESOURCE_WITHDRAWN','RESOURCE_REGRANTED']);for(let i=1;i<events.length;i++)expect(events[i].previous_hash).toBe(events[i-1].hash);
 expect(f.effects()).toBe(0);
});
it('a managed grant cannot authorize another registered capability version or changed manifest',async()=>{
 const f=await fresh();await f.create();const l=await f.lease(),name=toolName(f.id,'1.0.0');
 const v2={...f.capability,version:'2.0.0',bindingHash:hash('synthetic-v2')};f.gateway.register(v2);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'2.0.0','{}',$4,'READ','READY')",[f.tenant,randomUUID(),f.id,v2.bindingHash]);
 try{
  expect((await f.gateway.tools(f.employee,l)).map(t=>t.function.name)).toEqual([name]);
  expect((await f.gateway.execute(f.employee,l,toolName(f.id,'2.0.0'),{},AbortSignal.timeout(5000))).status).toBe('DENIED');expect(f.effects()).toBe(0);
  const call={id:'managed-call',type:'function' as const,function:{name,arguments:'{}'}};await store.append(f.employee,l,{role:'assistant',content:null,tool_calls:[call]});
  const read=await f.gateway.execute(f.employee,l,name,{},AbortSignal.timeout(5000));expect(read.status).toBe('OK');await store.append(f.employee,l,{role:'tool',tool_call_id:call.id,content:JSON.stringify(read)});
  const history=await store.history(f.employee,l);expect(await f.gateway.contextAllowed(f.employee,l,history)).toBe(true);
  await f.install({...f.manifest,manifestVersion:2});
  expect(await f.gateway.contextAllowed(f.employee,l,history)).toBe(false);expect((await f.gateway.tools(f.employee,l))).toEqual([]);
  expect((await f.gateway.execute(f.employee,l,name,{},AbortSignal.timeout(5000))).status).toBe('DENIED');expect(f.effects()).toBe(1);
  const diagnosis=await f.center.diagnose(f.e.p,(await f.administration.resources(f.a.p)).items[0]!.id,'1.0.0');expect(diagnosis).toMatchObject({localState:'BLOCKED',checks:{grant:'VERSION_UNCERTIFIED'},executionAuthority:false});
 }finally{await store.release(f.employee,l);}
});
it('local administration never replaces provider resource checks or write approval',async()=>{
 const read=await fresh();read.capability.allowResource=async()=>false;await read.create();const l=await read.lease();try{expect((await read.gateway.execute(read.employee,l,toolName(read.id,'1.0.0'),{},AbortSignal.timeout(5000))).status).toBe('DENIED');expect(read.effects()).toBe(0);}finally{await store.release(read.employee,l);}
 const write=await fresh('PERSONAL_WRITE');await write.create();const w=await write.lease();try{expect((await write.gateway.execute(write.employee,w,toolName(write.id,'1.0.0'),{},AbortSignal.timeout(5000))).status).toBe('NEEDS_APPROVAL');expect(write.effects()).toBe(0);}finally{await store.release(write.employee,w);}
});
it('HTTP management enforces login, CSRF, strict inputs, idempotency and metadata-only responses',async()=>{
 const f=await fresh(),path='/api/v1/permissions/admin/resources',headers={cookie:f.a.cookie,origin:config().APP_ORIGIN,'x-csrf-token':f.a.csrf,'idempotency-key':randomUUID()},body={targetUserId:f.employee.actorId,grant:f.definition};
 expect((await f.api.app.inject(path)).statusCode).toBe(401);
 expect((await f.api.app.inject({url:path,method:'POST',headers:{cookie:f.a.cookie},payload:body})).statusCode).toBe(403);
 expect((await f.api.app.inject({url:path,method:'POST',headers,payload:{...body,roles:['TENANT_ADMIN']}})).statusCode).toBe(400);
 expect((await f.api.app.inject({url:path,method:'POST',headers:{...headers,'idempotency-key':'bad'},payload:body})).statusCode).toBe(400);
 const saved=await f.api.app.inject({url:path,method:'POST',headers,payload:body});expect(saved.statusCode).toBe(200);expect(saved.json().data.platformPermissionsVerified).toBe(false);
 const list=await f.api.app.inject({url:path,headers});expect(list.headers['cache-control']).toBe('private, no-store');expect(list.json().data.items).toHaveLength(1);expect(list.payload).not.toContain('SYNTHETIC_NEVER_IN_API');expect(list.payload).not.toContain('provider_binding');
 expect((await f.api.app.inject({url:path,headers:{cookie:f.e.cookie}})).statusCode).toBe(403);
 const id=saved.json().data.id as string;
 const renew=await f.api.app.inject({url:path+'/'+id+'/renew',method:'POST',headers:{...headers,'idempotency-key':randomUUID()},payload:{targetUserId:f.employee.actorId,version:1,expiresAt:new Date(Date.now()+7200000).toISOString(),reviewReference:'synthetic-http-renew'}});
 expect(renew.statusCode).toBe(200);expect(renew.json().data.version).toBe(2);
 const revoke=await f.api.app.inject({url:path+'/'+id+'/revoke',method:'POST',headers:{...headers,'idempotency-key':randomUUID()},payload:{targetUserId:f.employee.actorId,version:2,reviewReference:'synthetic-http-revoke'}});
 expect(revoke.statusCode).toBe(200);expect(revoke.json().data).toMatchObject({state:'REVOKED',version:3});
 const regrant=await f.api.app.inject({url:path+'/'+id+'/regrant',method:'POST',headers:{...headers,'idempotency-key':randomUUID()},payload:{...body,version:3}});
 expect(regrant.statusCode).toBe(200);expect(regrant.json().data).toMatchObject({state:'ACTIVE',version:4});expect(f.effects()).toBe(0);
});
it('self-target revocation commits its own epoch change and clears the stale session cookie',async()=>{
 const f=await fresh(),created=await f.create(randomUUID(),f.definition,f.admin.actorId);
 const response=await f.api.app.inject({method:'POST',url:'/api/v1/permissions/admin/resources/'+created.id+'/revoke',headers:{cookie:f.a.cookie,origin:config().APP_ORIGIN,'x-csrf-token':f.a.csrf,'idempotency-key':randomUUID()},payload:{targetUserId:f.admin.actorId,version:1,reviewReference:'synthetic-self-revoke'}});
 expect(response.statusCode).toBe(200);expect(response.json().data.reauthenticationRequired).toBe(true);expect(response.headers['set-cookie']).toContain('oa_session=;');expect(await f.api.sessions.authenticate(f.a.cookie.slice(11))).toBeNull();
});
it.each(['sessionExpiry','roleRevoked','administratorDeparted','tenantSuspended'] as const)('a real policy lock wait cannot preserve admission after %s',async kind=>{
 const f=await fresh(),blocker=await root.connect();let pending:ReturnType<typeof f.create>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.tenant+':'+f.employee.actorId+':permissions']);
  pending=f.create();void pending.catch(()=>{});
  await vi.waitFor(async()=>expect((await root.query("SELECT pid FROM pg_stat_activity WHERE usename='oa_app' AND wait_event_type='Lock' AND query LIKE '%oa_permission_admin_mutate%' AND state='active'")).rowCount).toBeGreaterThan(0));
  if(kind==='sessionExpiry')await root.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.a.p.sessionId]);
  if(kind==='roleRevoked')await root.query('UPDATE role_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[f.authorityId]);
  if(kind==='administratorDeparted')await root.query("UPDATE users SET status='DEPARTED',auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND id=$2",[f.tenant,f.admin.actorId]);
  if(kind==='tenantSuspended')await root.query("UPDATE tenants SET status='SUSPENDED' WHERE tenant_id=$1",[f.tenant]);
  await blocker.query('COMMIT');
  const rejection=await pending.then(()=>null,error=>error as {code:string;status:number});
  expect(rejection).not.toBeNull();expect([401,403]).toContain(rejection?.status);expect(['PERMISSION_SESSION_INVALID','PERMISSION_ADMIN_DENIED']).toContain(rejection?.code);
  expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{});}
});
it('direct app/runtime table writes and partial managed bindings remain prohibited',async()=>{
 for(const role of ['oa_app','oa_runtime'])for(const table of ['resource_grants','permission_admin_requests'])for(const privilege of ['INSERT','UPDATE','DELETE'])expect((await root.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,table,privilege])).rows[0].allowed).toBe(false);
 const f=await fresh();await f.create();await expect(root.query('UPDATE resource_grants SET managed_binding_hash=NULL WHERE tenant_id=$1',[f.tenant])).rejects.toMatchObject({code:'23514'});
 expect((await root.query("SELECT has_function_privilege('oa_runtime','public.oa_permission_admin_mutate(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});
it('resource references preserve the512-character bound in both HTTP and the actual PostgreSQL mutation',async()=>{
 const f=await fresh(),allowed='fixture:'+ 'a'.repeat(504);expect(allowed).toHaveLength(512);
 expect((await f.create(randomUUID(),{...f.definition,resourceId:allowed})).state).toBe('ACTIVE');
 const bad={...f.definition,resourceId:allowed+'a'};
 const response=await f.api.app.inject({url:'/api/v1/permissions/admin/resources',method:'POST',headers:{cookie:f.a.cookie,origin:config().APP_ORIGIN,'x-csrf-token':f.a.csrf,'idempotency-key':randomUUID()},payload:{targetUserId:f.employee.actorId,grant:bad}});
 expect(response.statusCode).toBe(400);
 await expect(appDb.scope(f.a.p,c=>c.query('SELECT public.oa_permission_admin_mutate($1,$2,$3,$4,$5,$6,$7,$8) value',['CREATE',f.employee.actorId,null,null,JSON.stringify(bad),randomUUID(),f.a.p.sessionId,JSON.stringify(f.gateway.describeCapability(f.id,'1.0.0'))]))).rejects.toMatchObject({code:'22023',message:'PERMISSION_ADMIN_INPUT_INVALID'});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(1);expect(f.effects()).toBe(0);
});
it.each(['risk','provider','inputSchema','bindingState','authModes','outputContract','verificationSupport','bindingReference','requiredPermissions'] as const)('managed review rejects current %s drift before tool discovery or execution',async kind=>{
 const f=await fresh(),created=await f.create(),l=await f.lease();
 try{
  expect((await f.gateway.tools(f.employee,l))).toHaveLength(1);
  if(kind==='risk'){f.capability.risk='PERSONAL_WRITE';await root.query("UPDATE capability_bindings SET risk='PERSONAL_WRITE',version=version+1 WHERE id=$1",[f.bindingId]);}
  if(kind==='provider')f.capability.provider='DWS';
  if(kind==='inputSchema')f.capability.jsonSchema={type:'object',properties:{changed:{type:'string'}}};
  if(kind==='bindingState')await root.query("UPDATE capability_bindings SET state='DISABLED',version=version+1 WHERE id=$1",[f.bindingId]);
  if(kind==='authModes')f.capability.authModes=['SERVICE'];
  if(kind==='outputContract')Object.assign(f.capability,dataResultContract(z.object({value:z.number()}).strict()));
  if(kind==='verificationSupport')f.capability.verify=async result=>result;
  if(kind==='bindingReference')f.capability.bindingRef='synthetic:changed-binding';
  if(kind==='requiredPermissions')f.capability.requiredPermissions=[{name:'Changed synthetic requirement',evidenceRef:'synthetic:review'}];
  const usable=await appDb.scope(f.employee,c=>c.query('SELECT public.oa_resource_grant_usable($1,$2,$3,$4,$5) usable',[created.id,f.capability.version,f.capability.bindingHash,hash(canonical(f.capability.jsonSchema)),capabilityDescriptorHash(f.capability)]));
  expect(usable.rows[0].usable).toBe(false);expect(await f.gateway.tools(f.employee,l)).toEqual([]);
  expect((await f.gateway.execute(f.employee,l,toolName(f.id,'1.0.0'),{},AbortSignal.timeout(5000))).status).toBe('DENIED');expect(f.effects()).toBe(0);
 }finally{await store.release(f.employee,l);}
});
it('stale binding/schema declarations cannot create a local grant or change the reviewed registry state',async()=>{
 const f=await fresh();for(const grant of [{...f.definition,bindingHash:'0'.repeat(64)},{...f.definition,inputSchemaHash:'0'.repeat(64)},{...f.definition,capabilityVersion:'2.0.0'}])
  await expect(f.administration.create(f.a.p,{targetUserId:f.employee.actorId,grant},randomUUID())).rejects.toMatchObject({status:403});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);
 expect((await root.query('SELECT state,schema_hash FROM capability_bindings WHERE id=$1',[f.bindingId])).rows[0]).toEqual({state:'READY',schema_hash:f.bindingHash});expect(f.effects()).toBe(0);
});
it('administrator renewal racing the employee own withdrawal has one winner and no lost version update',async()=>{
 const f=await fresh(),created=await f.create(),input={targetUserId:f.employee.actorId,version:1,expiresAt:new Date(Date.now()+7200000).toISOString(),reviewReference:'synthetic-race'};
 const results=await Promise.allSettled([f.administration.renew(f.a.p,created.id,input,randomUUID()),f.center.withdraw(f.e.p,'RESOURCE',created.id,1)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 for(const result of results)if(result.status==='rejected')expect(result.reason).toMatchObject({code:'PERMISSION_VERSION_CONFLICT'});
 expect((await root.query('SELECT version FROM resource_grants WHERE id=$1',[created.id])).rows[0].version).toBe('2');
 expect((await root.query('SELECT id FROM permission_events WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(2);expect(f.effects()).toBe(0);
});
it('a manifest authentication mode absent from the actual registered descriptor cannot grant policy',async()=>{
 const f=await fresh();f.capability.authModes=['SERVICE'];
 await expect(f.create()).rejects.toMatchObject({code:'PERMISSION_MANIFEST_REVIEW_REQUIRED',status:403});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect(f.effects()).toBe(0);
});
it('administrator revocation fences an already active employee lease before further provider work',async()=>{
 const f=await fresh(),grant=await f.create(),l=await f.lease();
 try{
  expect((await f.gateway.execute(f.employee,l,toolName(f.id,'1.0.0'),{},AbortSignal.timeout(5000))).status).toBe('OK');expect(f.effects()).toBe(1);
  await f.administration.revoke(f.a.p,grant.id,{targetUserId:f.employee.actorId,version:1,reviewReference:'synthetic-active-revoke'},randomUUID());
  await expect(f.gateway.execute(f.employee,l,toolName(f.id,'1.0.0'),{},AbortSignal.timeout(5000))).rejects.toBeInstanceOf(LeaseLost);
  expect(f.effects()).toBe(1);
 }finally{await store.release(f.employee,l);}
});
it('old tenant/owner contexts cannot read managed grants and the new protocol flag never leaks across transactions',async()=>{
 const f=await fresh(),managed=await f.create(),legacy=randomUUID();
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,'fixture:legacy','PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour')",[f.tenant,legacy,f.employee.actorId,f.id]);
 expect((await appDb.scope(f.employee,c=>c.query('SELECT id FROM resource_grants ORDER BY id'))).rows.map(r=>r.id).sort()).toEqual([managed.id,legacy].sort());
 const old=await appDb.pool.connect();
 try{
  await old.query('BEGIN');
  expect((await old.query("SELECT coalesce(current_setting('app.managed_grant_protocol',true),'') protocol")).rows[0].protocol).toBe('');
  await old.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[f.tenant,f.employee.actorId]);
  expect((await old.query('SELECT id FROM resource_grants')).rows.map(r=>r.id)).toEqual([legacy]);
  await old.query('COMMIT');
 }finally{await old.query('ROLLBACK');old.release();}
 expect((await appDb.scope(f.other,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[managed.id]))).rowCount).toBe(0);
 expect((await appDb.scope(f.employee,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[managed.id]))).rowCount).toBe(1);
});
it('administrator metadata pagination includes every tenant grant once and exact-ID lookup is not limited to the first page',async()=>{
 const f=await fresh(),managed=await f.create();
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) SELECT $1,gen_random_uuid(),$2,$3,'fixture:page-'||n::text,'PRIVATE_USER',$2::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour' FROM generate_series(1,52) n",[f.tenant,f.employee.actorId,f.id]);
 const first=await f.administration.resources(f.a.p,{targetUserId:f.employee.actorId});expect(first.items).toHaveLength(50);expect(first.nextCursor).not.toBeNull();
 const second=await f.administration.resources(f.a.p,{targetUserId:f.employee.actorId,cursor:first.nextCursor!});expect(second.items).toHaveLength(3);expect(second.nextCursor).toBeNull();
 const ids=[...first.items,...second.items].map(r=>r.id);expect(new Set(ids).size).toBe(53);expect(ids).toContain(managed.id);
 const last=second.items.at(-1)!;expect((await f.administration.resources(f.a.p,{targetUserId:f.employee.actorId,id:last.id})).items.map(r=>r.id)).toEqual([last.id]);
 expect((await f.administration.resources(f.a.p,{targetUserId:f.other.actorId})).items).toEqual([]);expect(f.effects()).toBe(0);
});
it.each(['trial','formal'] as const)('a declared %s profile never grants tenant policy administration',async mode=>{
 const f=await fresh();
 try{
  if(mode==='trial')appDb.trialProfileHash='a'.repeat(64);else appDb.formalProfileHash='b'.repeat(64);
  await expect(f.create()).rejects.toMatchObject({code:'PERMISSION_ADMIN_LIFECYCLE_BLOCKED',status:403});
  await expect(f.administration.resources(f.a.p)).rejects.toMatchObject({code:'PERMISSION_ADMIN_LIFECYCLE_BLOCKED',status:403});
 }finally{appDb.trialProfileHash=null;appDb.formalProfileHash=null;}
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect(f.effects()).toBe(0);
});
it('a shared trial tombstone cannot be bypassed by an undeclared default database context',async()=>{
 const f=await fresh();
 await root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,$6,'synthetic-robot','synthetic-dm',clock_timestamp()+interval '1 minute')",[f.tenant,f.admin.actorId,'c'.repeat(64),'d'.repeat(64),'synthetic-admin-'+f.tenant,'synthetic-'+f.admin.actorId]);
 const before=(await root.query('SELECT to_jsonb(t) state FROM one_shot_trials t WHERE tenant_id=$1',[f.tenant])).rows[0].state;
 await expect(f.create()).rejects.toMatchObject({code:'PERMISSION_ADMIN_LIFECYCLE_BLOCKED',status:403});
 expect((await root.query('SELECT to_jsonb(t) state FROM one_shot_trials t WHERE tenant_id=$1',[f.tenant])).rows[0].state).toEqual(before);
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect(f.effects()).toBe(0);
});
it('missing runtime registration and legacy renewal require fresh review rather than inference from database metadata',async()=>{
 const f=await fresh(),unconfigured=new PermissionAdministration(appDb);
 await expect(unconfigured.create(f.a.p,{targetUserId:f.employee.actorId,grant:f.definition},randomUUID())).rejects.toMatchObject({code:'PERMISSION_MANIFEST_REVIEW_REQUIRED',status:403});
 await expect(f.administration.renew(f.a.p,randomUUID(),{targetUserId:f.employee.actorId,version:1,expiresAt:f.definition.expiresAt,reviewReference:'synthetic-missing'},randomUUID())).rejects.toMatchObject({code:'PERMISSION_NOT_FOUND',status:404});
 const id=randomUUID();await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour')",[f.tenant,id,f.employee.actorId,f.id,f.resource]);
 await expect(f.administration.renew(f.a.p,id,{targetUserId:f.employee.actorId,version:1,expiresAt:new Date(Date.now()+7200000).toISOString(),reviewReference:'synthetic-legacy'},randomUUID())).rejects.toMatchObject({code:'PERMISSION_MANIFEST_REVIEW_REQUIRED',status:403});
 expect((await root.query('SELECT version,managed_manifest_id FROM resource_grants WHERE id=$1',[id])).rows[0]).toEqual({version:'1',managed_manifest_id:null});
 expect((await f.administration.regrant(f.a.p,id,{targetUserId:f.employee.actorId,version:1,grant:f.definition},randomUUID())).version).toBe(2);
 expect((await root.query('SELECT managed_descriptor_hash FROM resource_grants WHERE id=$1',[id])).rows[0].managed_descriptor_hash).toBe(capabilityDescriptorHash(f.capability));expect(f.effects()).toBe(0);
});
it('past expiry is a bounded invalid request, not a successful grant or a prompt to add permissions',async()=>{
 const f=await fresh();
 await expect(f.create(randomUUID(),{...f.definition,expiresAt:'2020-01-01T00:00:00Z'})).rejects.toMatchObject({code:'PERMISSION_GRANT_EXPIRY_INVALID',status:400});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect(f.effects()).toBe(0);
});
it('a wrong runtime database role is unavailable and never writes policy through a privileged fallback',async()=>{
 const f=await fresh(),wrong=new PermissionAdministration(db,(id,v)=>f.gateway.describeCapability(id,v));
 await expect(wrong.resources(f.a.p)).rejects.toMatchObject({code:'PERMISSION_SERVICE_UNAVAILABLE',status:503});
 await expect(wrong.create(f.a.p,{targetUserId:f.employee.actorId,grant:f.definition},randomUUID())).rejects.toMatchObject({code:'PERMISSION_SERVICE_UNAVAILABLE',status:503});
 expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);
});
it('invalid legacy metadata fails closed without returning database values or private driver details',async()=>{
 const f=await fresh(),id=randomUUID();
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,'fixture:invalid-metadata','PRIVATE_USER',$3::uuid::text,'INTERNAL','infinity')",[f.tenant,id,f.employee.actorId,f.id]);
 try{
  const response=await f.api.app.inject({url:'/api/v1/permissions/admin/resources',headers:{cookie:f.a.cookie}});
  expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('PERMISSION_SERVICE_UNAVAILABLE');expect(response.payload).not.toContain('infinity');expect(response.payload).not.toContain('SYNTHETIC_NEVER_IN_API');
 }finally{await root.query("UPDATE resource_grants SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[id]);}
});
it('a real policy lock timeout rolls back cleanly and an explicit same-key retry after release commits once',async()=>{
 const f=await fresh(),key=randomUUID(),blocker=await root.connect();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.tenant+':'+f.employee.actorId+':permissions']);
  await expect(f.create(key)).rejects.toMatchObject({code:'PERMISSION_BUSY',status:409});
  expect((await root.query('SELECT request_id FROM permission_admin_requests WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);expect((await root.query('SELECT id FROM resource_grants WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(0);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 expect((await f.create(key)).replayed).toBe(false);expect((await f.create(key)).replayed).toBe(true);
 expect((await root.query('SELECT id FROM permission_events WHERE tenant_id=$1',[f.tenant])).rowCount).toBe(1);expect(f.effects()).toBe(0);
});
it('actual backend termination after grant/audit writes and before COMMIT leaves no partial policy or receipt',async()=>{
 const f=await fresh(),key=randomUUID(),name='oa_admin_fault_'+randomUUID().replaceAll('-','');let pending:ReturnType<typeof f.create>|undefined;
 await root.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.tenant}'::uuid AND NEW.request_id='${key}'::uuid THEN PERFORM pg_sleep(10);END IF;RETURN NEW;END $$`);
 await root.query(`CREATE TRIGGER ${name} AFTER INSERT ON permission_admin_requests FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
 try{
  pending=f.create(key);void pending.catch(()=>{});let pid:number|undefined;
  await vi.waitFor(async()=>{const rows=(await root.query("SELECT pid FROM pg_stat_activity WHERE usename='oa_app' AND wait_event='PgSleep' AND query LIKE '%oa_permission_admin_mutate%' AND state='active'")).rows;expect(rows).toHaveLength(1);pid=rows[0].pid as number;});
  expect((await root.query('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0].terminated).toBe(true);
  await expect(pending).rejects.toMatchObject({code:'PERMISSION_SERVICE_UNAVAILABLE',status:503});
  for(const table of ['resource_grants','permission_events','permission_admin_requests'])expect((await root.query('SELECT count(*)::int n FROM '+table+' WHERE tenant_id=$1',[f.tenant])).rows[0].n).toBe(0);
 }finally{await pending?.catch(()=>{});await root.query(`DROP TRIGGER IF EXISTS ${name} ON permission_admin_requests`);await root.query(`DROP FUNCTION public.${name}()`);}
 const recovered=await f.create(key);expect(recovered).toMatchObject({version:1,replayed:false});expect((await f.create(key)).replayed).toBe(true);expect(f.effects()).toBe(0);
});
it('an actual idle backend failure is recorded without leaking driver details and a fresh connection preserves tenant isolation',async()=>{
 const f=await fresh(),isolated=new Database(secret('DATABASE_URL')!,1),log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const grant=await f.create();expect((await isolated.scope(f.employee,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[grant.id]))).rowCount).toBe(1);
  const before=(await isolated.scope(f.employee,c=>c.query('SELECT pg_backend_pid() pid'))).rows[0].pid as number;
  const observed=new Promise<void>(resolve=>isolated.pool.once('error',()=>resolve()));
  expect((await root.query('SELECT pg_terminate_backend($1) terminated',[before])).rows[0].terminated).toBe(true);
  await observed;expect(isolated.idleConnectionFailures).toBe(1);
  expect(log.mock.calls).toContainEqual([JSON.stringify({kind:'DATABASE_IDLE_CONNECTION_FAILED',count:1})]);
  expect(JSON.stringify(log.mock.calls)).not.toContain('SYNTHETIC_NEVER_IN_API');expect(JSON.stringify(log.mock.calls)).not.toContain(f.employee.actorId);
  const next=(await isolated.scope(f.other,c=>c.query("SELECT pg_backend_pid() pid,current_setting('app.actor_id') actor"))).rows[0];
  expect(next.pid).not.toBe(before);expect(next.actor).toBe(f.other.actorId);
  expect((await isolated.scope(f.other,c=>c.query('SELECT id FROM resource_grants WHERE actor_id=$1',[f.employee.actorId]))).rowCount).toBe(0);
 }finally{log.mockRestore();await isolated.close();}
});
