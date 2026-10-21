import '../support/isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {config,secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {RunPersonas} from '../../packages/personas/src/runtime.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {createServer} from '../../apps/api/src/server.js';
import {personaFixture} from '../support/personas.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
import {groupInfoReply} from '../support/group-members.js';
import {personaContextExplanationSchema} from '../../packages/personas/src/explanation-schema.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,8),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const fixtures:Awaited<ReturnType<typeof personaFixture>>[]=[],apis:Awaited<ReturnType<typeof createServer>>[]=[],groups:Awaited<ReturnType<typeof groupRuntimeFixture>>[]=[];
afterAll(async()=>{for(const api of apis)await api.app.close();for(const group of groups)await group.close();for(const f of fixtures)await f.close();await db.close();await appDb.close();await root.end();});
async function fresh(configured=true){
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);const ctx=f.people.alice,store=new RuntimeStore(db,vault),personae=new RunPersonas(db,vault);if(configured)store.configurePersonas(personae);const gateway=new Gateway(store),tasks=new TaskStore(appDb);
 const task=await tasks.create(ctx,'解释本次任务保存的人设版本',randomUUID());
 const prepare=async()=>{const lease=await store.acquire(ctx,task.runId,'persona-explanation-test');expect(lease).not.toBeNull();expect(await gateway.preparePersonas(ctx,lease!,new AbortController().signal)).toBe(true);return lease!;};
 return {f,ctx,store,personae,gateway,tasks,task,prepare};
}
it('T037 component: API shows the actual frozen GLOBAL/USER versions after settings change and returns no style, memory, identity or hashes',async()=>{
 const s=await fresh(),first=await s.f.patch('alice',s.f.scope('alice'),{tone:'DIRECT',address:'PRIVATE_PROVENANCE_STYLE_CANARY'}),lease=await s.prepare();
 const frozen=await s.store.personaExplanation(s.ctx,s.task.runId);expect(frozen).toMatchObject({state:'BOUND',snapshotId:lease.personaSnapshot!.id,policyVersion:0,templateVersion:1,sources:[{kind:'GLOBAL',version:0},{kind:'USER',version:1}]});
 await s.f.patch('alice',s.f.scope('alice'),{tone:'FORMAL'},first.etag);await s.f.patch('admin',s.f.global,{name:'PRIVATE_NEW_GLOBAL_CANARY'});
 const later=await s.store.personaExplanation(s.ctx,s.task.runId);expect(later).toMatchObject({state:'BOUND',snapshotId:lease.personaSnapshot!.id,sources:[{kind:'GLOBAL',version:0},{kind:'USER',version:1}]});
 const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),finalReader:s.gateway,personas:s.f.service});apis.push(api);const session=await api.sessions.create(s.ctx),response=await api.app.inject({method:'GET',url:'/api/v1/tasks/'+s.task.taskId,headers:{cookie:'oa_session='+session.cookie}});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');const actual=response.json().data.runs[0].persona_context;expect(personaContextExplanationSchema.safeParse(actual).success).toBe(true);expect(actual).toMatchObject({state:'BOUND',snapshotId:lease.personaSnapshot!.id,sources:[{kind:'GLOBAL',version:0},{kind:'USER',version:1}]});expect(JSON.stringify(actual)).not.toMatch(/PRIVATE_|fields|revisionHash|proof|owner|tenant|scopeId|memory|address|DIRECT|FORMAL/);
 expect((await root.query('SELECT count(*)::int n FROM provider_journals WHERE run_id=$1',[s.task.runId])).rows[0].n).toBe(0);expect((await root.query('SELECT count(*)::int n FROM deliveries WHERE source_run_id=$1',[s.task.runId])).rows[0].n).toBe(0);
 const next=await s.tasks.create(s.ctx,'新任务使用新版本',randomUUID()),nextLease=await s.store.acquire(s.ctx,next.runId,'persona-explanation-next');expect(await s.gateway.preparePersonas(s.ctx,nextLease!,new AbortController().signal)).toBe(true);expect(await s.store.personaExplanation(s.ctx,next.runId)).toMatchObject({state:'BOUND',sources:[{kind:'GLOBAL',version:1},{kind:'USER',version:2}]});
 await api.sessions.revoke((await api.sessions.authenticate(session.cookie))!);const denied=await api.app.inject({method:'GET',url:'/api/v1/tasks/'+s.task.taskId,headers:{cookie:'oa_session='+session.cookie}});expect(denied.statusCode).toBe(401);expect(denied.body).not.toContain('snapshotId');
});
it('owner isolation denies another user and a tenant administrator, including the actual task API',async()=>{
 const s=await fresh();await s.prepare();for(const name of ['bob','admin'] as const)expect(await s.store.personaExplanation(s.f.people[name],s.task.runId)).toBeNull();
 const foreign=await fresh();expect(await s.store.personaExplanation(foreign.ctx,s.task.runId)).toBeNull();
 const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),finalReader:s.gateway});apis.push(api);const session=await api.sessions.create(s.f.people.admin),response=await api.app.inject({method:'GET',url:'/api/v1/tasks/'+s.task.taskId,headers:{cookie:'oa_session='+session.cookie}});expect(response.statusCode).toBe(404);expect(response.body).not.toContain('persona_context');
});
it('UNBOUND, BUILTIN_ONLY and explicit legacy state retain their distinct meaning and never adopt current preferences',async()=>{
 const s=await fresh(false);expect(await s.store.personaExplanation(s.ctx,s.task.runId)).toEqual({state:'UNBOUND'});await s.prepare();await s.f.patch('alice',s.f.scope('alice'),{tone:'DIRECT'});s.store.configurePersonas(s.personae);expect(await s.store.personaExplanation(s.ctx,s.task.runId)).toEqual({state:'BUILTIN_ONLY'});
 const old=await s.tasks.create(s.ctx,'显式旧记录的展示',randomUUID());await root.query("UPDATE runs SET persona_context_state='LEGACY_NONE' WHERE id=$1",[old.runId]);expect(await s.store.personaExplanation(s.ctx,old.runId)).toEqual({state:'LEGACY_NONE'});
});
it.each(['revoked','corrupt','expired','auth-epoch','policy','privacy-erased'] as const)('a %s bound context hides all versions and does not fall back to current settings',async mode=>{
 const s=await fresh();await s.f.patch('alice',s.f.scope('alice'),{address:'PRIVATE_REVOKED_PROVENANCE_CANARY'});const lease=await s.prepare();expect((await s.store.personaExplanation(s.ctx,s.task.runId))?.state).toBe('BOUND');
 if(mode==='revoked')await root.query('UPDATE run_persona_snapshots SET revoked_at=clock_timestamp() WHERE id=$1',[lease.personaSnapshot!.id]);
 if(mode==='corrupt')await root.query("UPDATE run_persona_snapshots SET proof_ref='{}' WHERE id=$1",[lease.personaSnapshot!.id]);
 if(mode==='expired')await root.query("UPDATE run_persona_snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[lease.personaSnapshot!.id]);
 if(mode==='auth-epoch')await root.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[s.ctx.actorId]);
 if(mode==='policy')await root.query("INSERT INTO persona_policies(tenant_id,id,fields,locked_fields,review_reference) VALUES($1,$2,'{\"tone\":\"FORMAL\"}','[\"tone\"]','synthetic explanation policy change')",[s.ctx.tenantId,randomUUID()]);
 if(mode==='privacy-erased')await s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source);
 expect(await s.store.personaExplanation(s.ctx,s.task.runId)).toEqual({state:'UNAVAILABLE'});
});
it('actual group audience and GROUP authority validate a group snapshot; changed membership hides the version summary',async()=>{
 const s=await groupRuntimeFixture(root,db,vault);groups.push(s);
 // Runtime GROUP authority comes from the owner-bound audience witness. Adding
 // a role after task creation would revoke this task through its auth epoch.
 s.store.configurePersonas(new RunPersonas(db,vault));const lease=await s.store.acquire(s.ctx,s.runId,'group-persona-explanation');expect(lease).not.toBeNull();expect(await s.gateway.prepareAudience(s.ctx,lease!,new AbortController().signal)).toBe(true);expect(await s.gateway.preparePersonas(s.ctx,lease!,new AbortController().signal)).toBe(true);expect(await s.store.personaExplanation(s.ctx,s.runId)).toMatchObject({state:'BOUND',sources:[{kind:'GLOBAL',version:0},{kind:'GROUP',version:0}]});await s.configure({info:groupInfoReply(2,1,'membership-changed-after-snapshot')});expect(await s.store.personaExplanation(s.ctx,s.runId)).toEqual({state:'UNAVAILABLE'});expect(s.requests).toHaveLength(0);
});
