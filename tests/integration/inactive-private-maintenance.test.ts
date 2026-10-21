import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {PrivatePreferences} from '../../packages/memory/src/service.js';
import {RuntimePreferences} from '../../packages/memory/src/runtime.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {personaFixture} from '../support/personas.js';
import {personaNative} from '../support/persona-native.js';
import {memoryModel} from '../support/memory-model.js';
import {captureMemory,restoreMemoryFragment} from '../support/memory-restore.js';
import {captureSyntheticContent,restoreSyntheticContent,type ContentFragment} from '../support/content-restore.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,12),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const fixtures:Awaited<ReturnType<typeof personaFixture>>[]=[];
afterAll(async()=>{for(const f of fixtures)await f.close();await db.close();await appDb.close();await root.end();});
const input=(content:string)=>({kind:'PREFERENCE' as const,title:'合成维护偏好',content,sensitivity:'CONFIDENTIAL' as const,allowModel:true});
type Mode='ACTIVE'|'DEPARTED'|'TENANT_SUSPENDED';
async function fresh(kind:'MEMORY'|'USER_PERSONA'){
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);const ctx=f.people.alice,memory=new PrivatePreferences(db,vault),n=personaNative(f,db,vault,new RuntimePreferences(memory,{schemaVersion:1,id:'synthetic-inactive-cleanup',environment:'SYNTHETIC_TEST',approved:true,approvalReference:'SYNTHETIC_OFFLINE_ONLY',validUntil:'2099-01-01T00:00:00Z',allowedClassifications:['CONFIDENTIAL'],maxItems:10,maxBytes:12000})),canary='SYNTHETIC_INACTIVE_PRIVATE_'+randomUUID();
 await f.patch('admin',f.global,{address:canary});let memoryId:string|undefined;
 if(kind==='MEMORY')memoryId=(await memory.save(ctx,input(canary),randomUUID(),f.sessions.alice.source)).memoryId;else await f.patch('alice',f.scope('alice'),{address:canary});
 const task=(await n.ingress.acceptTrustedCallback(n.event('请给出一般回答并使用已保存的表达偏好')))! ,runId=(await root.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId])).rows[0].id as string,model=memoryModel();await new AgentRuntime(n.store,model.provider,n.gateway).advance(ctx,runId);expect(model.requests).toHaveLength(2);expect(JSON.stringify(model.requests[0])).toContain(canary);expect((await root.query('SELECT status FROM runs WHERE id=$1',[runId])).rows[0].status).toBe('SUCCEEDED');
 const fragments:ContentFragment=[];for(const table of ['tasks','runs','provider_journals','run_persona_snapshots','run_finalizations','run_narrative_reviews','deliveries','outbox'] as const){const part=await captureSyntheticContent(root,table,ctx.tenantId);expect(part.rows.length,table).toBeGreaterThan(0);fragments.push(part);}
 const firstJournal=fragments.find(p=>p.table==='provider_journals')!.rows.find(r=>r.seq===1)!;expect(vault.open(JSON.parse(firstJournal.ciphertext_ref as string),`${ctx.tenantId}:${ctx.actorId}:${runId}:1`)).toContain(canary);
 const ledger=(await root.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE run_id=$1 ORDER BY id',[runId])).rows;
 const independent=await new TaskStore(db).create(ctx,canary,randomUUID()),keep=(await memory.save(ctx,input(canary+'-independent'),randomUUID(),f.sessions.alice.source)).memoryId;
 const shared=(await root.query("SELECT to_jsonb(r) row FROM persona_revisions r WHERE tenant_id=$1 AND scope_kind='GLOBAL'",[ctx.tenantId])).rows;
 const setMode=async(mode:Mode)=>{if(mode==='DEPARTED')await root.query("UPDATE users SET status='DEPARTED' WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,ctx.actorId]);if(mode==='TENANT_SUSPENDED')await root.query("UPDATE tenants SET status='SUSPENDED' WHERE tenant_id=$1",[ctx.tenantId]);};
 const repair=()=>kind==='MEMORY'?memory.maintain(ctx):f.service.repairPrivateErasure(ctx);
 return {f,ctx,memory,n,canary,memoryId,taskId:task.taskId,runId,model,fragments,ledger,independent,keep,shared,setMode,repair};
}
async function assertScrubbed(s:Awaited<ReturnType<typeof fresh>>){
 expect((await root.query('SELECT status,result,context_ref FROM runs WHERE id=$1',[s.runId])).rows[0]).toEqual({status:'CANCELLED',result:null,context_ref:null});
 expect((await root.query('SELECT id FROM provider_journals WHERE run_id=$1',[s.runId])).rows).toEqual([]);expect((await root.query('SELECT proof_ref FROM run_persona_snapshots WHERE run_id=$1',[s.runId])).rows[0].proof_ref).toEqual({});expect((await root.query('SELECT content_ref FROM deliveries WHERE source_run_id=$1',[s.runId])).rows.every(r=>r.content_ref==='{}')).toBe(true);
 expect((await root.query('SELECT input_ref FROM memory_requests WHERE memory_id=$1',[s.keep])).rows[0].input_ref).not.toBeNull();expect((await root.query('SELECT status,goal FROM tasks WHERE id=$1',[s.independent.taskId])).rows[0]).toEqual({status:'OPEN',goal:s.canary});expect((await root.query("SELECT to_jsonb(r) row FROM persona_revisions r WHERE tenant_id=$1 AND scope_kind='GLOBAL'",[s.ctx.tenantId])).rows).toEqual(s.shared);expect((await root.query('SELECT to_jsonb(q) row FROM quota_ledger q WHERE run_id=$1 ORDER BY id',[s.runId])).rows).toEqual(s.ledger);
 expect(await s.n.store.acquire(s.ctx,s.runId,'MUST_NOT_RESTART')).toBeNull();let sends=0;const sender=new DeliveryGateway(db,vault,{sendReply:async()=>{sends++;throw Error('NO_SEND_ALLOWED');},sendProactive:async()=>{sends++;throw Error('NO_SEND_ALLOWED');}},s.n.binding,Date.now,(...a)=>s.n.gateway.finalSourcesAllowed(...a));for(const row of s.fragments.find(p=>p.table==='deliveries')!.rows)await sender.process(s.ctx,row.id as string,new AbortController().signal);expect(sends).toBe(0);expect(s.model.requests).toHaveLength(2);
}
it.each([['MEMORY','ACTIVE'],['MEMORY','DEPARTED'],['MEMORY','TENANT_SUSPENDED'],['USER_PERSONA','ACTIVE'],['USER_PERSONA','DEPARTED'],['USER_PERSONA','TENANT_SUSPENDED']] as const)('%s known-erasure repair cleans restored private bodies for %s without regranting private reads',async(kind,mode)=>{
 const s=await fresh(kind),memoryBefore=s.memoryId?await captureMemory(root,s.memoryId):null,personaBefore:ContentFragment=[];
 if(kind==='USER_PERSONA')for(const table of ['personas','persona_revisions','persona_change_requests'] as const)personaBefore.push(await captureSyntheticContent(root,table,s.ctx.tenantId));
 if(s.memoryId)await s.memory.forget(s.ctx,s.memoryId,randomUUID(),s.f.sessions.alice.source);else await s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source);
 if(memoryBefore)await restoreMemoryFragment(root,memoryBefore);if(personaBefore.length)await restoreSyntheticContent(root,personaBefore);await restoreSyntheticContent(root,s.fragments);await s.setMode(mode);
 expect((await root.query('SELECT id FROM provider_journals WHERE run_id=$1',[s.runId])).rowCount).toBeGreaterThan(0);
 await s.repair();await assertScrubbed(s);
 if(s.memoryId){expect((await root.query('SELECT id FROM memory_revisions WHERE memory_id=$1',[s.memoryId])).rows).toEqual([]);expect((await root.query('SELECT id FROM memory_search_index WHERE memory_id=$1',[s.memoryId])).rows).toEqual([]);}else expect((await root.query("SELECT settings_ref,privacy_erased_at FROM persona_revisions WHERE tenant_id=$1 AND scope_kind='USER' AND scope_id=$2 AND version_no=1",[s.ctx.tenantId,s.ctx.actorId])).rows[0]).toMatchObject({settings_ref:{}});
 if(mode!=='ACTIVE')for(const table of ['memory_revisions','memory_requests','memory_deletions','persona_revisions','persona_privacy_erasures'])expect((await db.scope(s.ctx,c=>c.query(`SELECT * FROM ${table}`))).rows).toEqual([]);
 const again=await s.repair();if(kind==='MEMORY')expect(again).toMatchObject({expired:0,repaired:0,more:false});else expect(again).toEqual({status:'CLEAN'});
});
it.each(['ACTIVE','DEPARTED','TENANT_SUSPENDED'] as const)('policy expiry for %s purges the actual native dependency graph and records one immutable deletion',async mode=>{
 const s=await fresh('MEMORY');
 // Explicit metadata time fault after actual source use: the body/hash remain
 // unchanged; policy expiry is real PostgreSQL time, never a host fake clock.
 await root.query("UPDATE memory_revisions SET valid_from=clock_timestamp()-interval '2 days',valid_to=clock_timestamp()-interval '1 second' WHERE memory_id=$1",[s.memoryId]);await s.setMode(mode);
 const batch=await Promise.all([s.memory.maintain(s.ctx,1),s.memory.maintain(s.ctx,1)]);expect(batch.reduce((n,r)=>n+r.expired,0)).toBe(1);await assertScrubbed(s);expect((await root.query('SELECT deleted_version,external_bounds FROM memory_deletions WHERE memory_id=$1',[s.memoryId])).rows).toEqual([expect.objectContaining({deleted_version:'2',external_bounds:expect.objectContaining({cause:'POLICY_EXPIRY'})})]);
});
it('restoring an earlier revision cannot lower the authoritative memory deletion version during repair',async()=>{
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);const memory=new PrivatePreferences(db,vault),ctx=f.people.alice,first=await memory.save(ctx,input('SYNTHETIC_VERSION_ONE'),randomUUID(),f.sessions.alice.source),old=await captureMemory(root,first.memoryId);await memory.save(ctx,input('SYNTHETIC_VERSION_TWO'),randomUUID(),f.sessions.alice.source,{id:first.memoryId,etag:first.etag!});const erased=await memory.forget(ctx,first.memoryId,randomUUID(),f.sessions.alice.source);expect(erased.version).toBe(3);await restoreMemoryFragment(root,old);await memory.maintain(ctx);expect((await root.query('SELECT state,version FROM memory_items WHERE id=$1',[first.memoryId])).rows[0]).toEqual({state:'DELETED',version:'3'});
});
it('maintenance is namespace/owner bound and exposes no internal purge or dirty helper to runtime/app roles',async()=>{
 const s=await fresh('MEMORY'),old=await captureMemory(root,s.memoryId!);await s.memory.forget(s.ctx,s.memoryId!,randomUUID(),s.f.sessions.alice.source);await restoreMemoryFragment(root,old);await restoreSyntheticContent(root,s.fragments);await s.setMode('DEPARTED');
 const before=(await captureSyntheticContent(root,'provider_journals',s.ctx.tenantId)).rows;
 for(const ctx of [s.f.people.bob,s.f.people.admin,{tenantId:randomUUID(),actorId:s.ctx.actorId}]){
  expect(await s.memory.maintain(ctx)).toMatchObject({expired:0,repaired:0,more:false});expect((await captureSyntheticContent(root,'provider_journals',s.ctx.tenantId)).rows).toEqual(before);
  await expect(db.scope(ctx,c=>c.query('SELECT public.oa_repair_private_memory($1)',[s.memoryId]))).rejects.toMatchObject({code:'42501'});
 }
 for(const fn of ['oa_purge_private_memory_content','oa_private_memory_dirty'])await expect(db.scope(s.ctx,c=>c.query(`SELECT public.${fn}($1)`,[s.memoryId]))).rejects.toMatchObject({code:'42501'});
 await expect(appDb.scope(s.ctx,c=>c.query('SELECT public.oa_maintain_private_preferences(1,NULL,NULL)'))).rejects.toMatchObject({code:'42501'});
 await expect(db.scope(s.ctx,c=>c.query('SELECT public.oa_erase_private_memory_content($1)',[s.keep]))).rejects.toMatchObject({code:'42501'});
 await expect(s.memory.forget(s.ctx,s.keep,randomUUID(),s.f.sessions.alice.source)).rejects.toMatchObject({code:'MEMORY_SESSION_INVALID'});await expect(s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source)).rejects.toMatchObject({code:'PERSONA_SCOPE_DENIED'});
 await s.memory.maintain(s.ctx);await assertScrubbed(s);
});
it('inactive persona repair preserves later private settings and shared defaults while clearing only the retained cutoff graph',async()=>{
 const s=await fresh('USER_PERSONA'),old=await captureSyntheticContent(root,'persona_revisions',s.ctx.tenantId),oldRequests=await captureSyntheticContent(root,'persona_change_requests',s.ctx.tenantId),erased=await s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source),later=await s.f.patch('alice',s.f.scope('alice'),{address:'SYNTHETIC_LATER_PRIVATE_SETTING'},erased.etag),laterRow=(await root.query("SELECT to_jsonb(r) row FROM persona_revisions r WHERE tenant_id=$1 AND scope_id=$2 AND version_no=$3",[s.ctx.tenantId,s.ctx.actorId,later.version])).rows[0];
 await restoreSyntheticContent(root,[old,oldRequests,...s.fragments]);await s.setMode('DEPARTED');expect(await s.f.service.repairPrivateErasure(s.ctx)).toMatchObject({status:'REPAIRED'});await assertScrubbed(s);
 expect((await root.query("SELECT to_jsonb(r) row FROM persona_revisions r WHERE tenant_id=$1 AND scope_id=$2 AND version_no=$3",[s.ctx.tenantId,s.ctx.actorId,later.version])).rows[0]).toEqual(laterRow);expect((await root.query("SELECT version FROM personas WHERE tenant_id=$1 AND scope_kind='USER' AND scope_id=$2",[s.ctx.tenantId,s.ctx.actorId])).rows[0].version).toBe(String(later.version));
});
it('bounded concurrent inactive expiry batches leave future/other-owner content intact and record each deletion once',async()=>{
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);const memory=new PrivatePreferences(db,vault),ctx=f.people.alice,due:string[]=[];for(let i=0;i<3;i++)due.push((await memory.save(ctx,input('SYNTHETIC_DUE_'+i),randomUUID(),f.sessions.alice.source)).memoryId);const keep=(await memory.save(ctx,input('SYNTHETIC_FUTURE'),randomUUID(),f.sessions.alice.source)).memoryId,other=(await memory.save(f.people.bob,input('SYNTHETIC_OTHER_DUE'),randomUUID(),f.sessions.bob.source)).memoryId;
 await root.query("UPDATE memory_revisions SET valid_from=clock_timestamp()-interval '2 days',valid_to=clock_timestamp()-interval '1 second' WHERE memory_id=ANY($1::uuid[])",[[...due,other]]);await root.query("UPDATE tenants SET status='SUSPENDED' WHERE tenant_id=$1",[ctx.tenantId]);
 for(const bad of [0,101,1.5])await expect(memory.maintain(ctx,bad)).rejects.toMatchObject({code:'MEMORY_MAINTENANCE_LIMIT_INVALID'});
 await expect(db.scope(ctx,c=>c.query('SELECT public.oa_maintain_private_preferences(0,NULL,NULL)'))).rejects.toMatchObject({code:'22023'});
 const batches=await Promise.all([memory.maintain(ctx,1),memory.maintain(ctx,1)]);expect(batches.every(b=>b.more&&b.expired===1)).toBe(true);expect(await memory.maintain(ctx,1)).toMatchObject({expired:1,more:false});expect(await memory.maintain(ctx,1)).toMatchObject({expired:0,repaired:0,more:false});expect((await root.query('SELECT memory_id FROM memory_deletions WHERE tenant_id=$1',[ctx.tenantId])).rows.map(r=>r.memory_id).sort()).toEqual(due.sort());expect((await root.query('SELECT memory_id FROM memory_revisions WHERE memory_id=ANY($1::uuid[])',[[keep,other]])).rowCount).toBe(2);expect((await root.query("SELECT id FROM memory_events WHERE tenant_id=$1 AND outcome='DELETED'",[ctx.tenantId])).rowCount).toBe(3);
});
it('a user-chosen key matching the old expiry-key pattern cannot prevent policy deletion or remove another preference',async()=>{
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);const memory=new PrivatePreferences(db,vault),ctx=f.people.alice,a=await memory.save(ctx,input('SYNTHETIC_EXPIRY_A'),randomUUID(),f.sessions.alice.source),key=`memory-expiry:${a.memoryId}:${JSON.parse(a.etag!)}`,b=await memory.save(ctx,input('SYNTHETIC_UNRELATED_KEY'),key,f.sessions.alice.source);await root.query("UPDATE memory_revisions SET valid_from=clock_timestamp()-interval '2 days',valid_to=clock_timestamp()-interval '1 second' WHERE memory_id=$1",[a.memoryId]);expect(await memory.maintain(ctx)).toMatchObject({expired:1,repaired:0});expect((await memory.search(ctx,{},f.sessions.alice.source)).items.map(r=>r.id)).toEqual([b.memoryId]);expect((await root.query('SELECT memory_id,input_ref FROM memory_requests WHERE tenant_id=$1 AND request_key=$2',[ctx.tenantId,key])).rows[0]).toMatchObject({memory_id:b.memoryId});expect((await root.query('SELECT input_ref FROM memory_requests WHERE tenant_id=$1 AND request_key=$2',[ctx.tenantId,key])).rows[0].input_ref).not.toBeNull();
});
async function waitChild(child:ChildProcess,text:string){let stdout='',stderr='';child.stdout!.on('data',b=>{stdout+=b.toString();});child.stderr!.on('data',b=>{stderr+=b.toString();});await vi.waitFor(()=>{expect(stderr).toBe('');expect(stdout).toContain(text);},{timeout:10000});}
it.each([['MEMORY','before-commit'],['MEMORY','after-commit'],['USER_PERSONA','before-commit'],['USER_PERSONA','after-commit']] as const)('SIGKILL %s %s inactive repair rolls back or commits atomically and retries once',async(kind,phase)=>{
 const s=await fresh(kind),journal=s.fragments.find(p=>p.table==='provider_journals')!;if(s.memoryId)await s.memory.forget(s.ctx,s.memoryId,randomUUID(),s.f.sessions.alice.source);else await s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source);await restoreSyntheticContent(root,[journal]);await s.setMode('DEPARTED');
 const child=spawn(process.execPath,['--import','tsx','tests/support/inactive-maintenance-process.ts',phase,kind,JSON.stringify(s.ctx)],{env:process.env,stdio:['ignore','pipe','pipe']}),exited=new Promise(r=>child.once('exit',r));
 try{await waitChild(child,phase==='before-commit'?'INACTIVE_MAINTENANCE_UNCOMMITTED':'INACTIVE_MAINTENANCE_COMMITTED');child.kill('SIGKILL');await exited;expect((await root.query('SELECT id FROM provider_journals WHERE run_id=$1',[s.runId])).rowCount).toBe(phase==='before-commit'?journal.rows.length:0);await s.repair();await assertScrubbed(s);const table=kind==='MEMORY'?'memory_erasure_repairs':'persona_privacy_repairs';expect((await root.query(`SELECT id FROM ${table} WHERE tenant_id=$1`,[s.ctx.tenantId])).rowCount).toBe(1);await s.repair();expect((await root.query(`SELECT id FROM ${table} WHERE tenant_id=$1`,[s.ctx.tenantId])).rowCount).toBe(1);}finally{child.kill('SIGKILL');await exited;}
});
it.each(['MEMORY','USER_PERSONA'] as const)('actual independent maintenance process repairs a departed %s owner with no provider credentials',async kind=>{
 const s=await fresh(kind);if(s.memoryId)await s.memory.forget(s.ctx,s.memoryId,randomUUID(),s.f.sessions.alice.source);else await s.f.service.erasePrivate(s.ctx,randomUUID(),s.f.sessions.alice.source);await restoreSyntheticContent(root,[s.fragments.find(p=>p.table==='provider_journals')!]);await s.setMode('DEPARTED');const dir=await mkdtemp(join(tmpdir(),'oa-inactive-maintenance-')),path=join(dir,'scopes.json');await writeFile(path,JSON.stringify([s.ctx]),{mode:0o600});
 const child=spawn(process.execPath,['--import','tsx','apps/maintenance/src/main.ts'],{env:{...process.env,WORKER_SCOPE_FILE:path},stdio:['ignore','pipe','pipe']}),exited=new Promise(r=>child.once('exit',r));
 try{await waitChild(child,kind==='MEMORY'?'"repaired":1':'PERSONA_PRIVACY_REPAIR');await assertScrubbed(s);child.kill('SIGTERM');await exited;}finally{child.kill('SIGKILL');await exited;await rm(dir,{recursive:true,force:true});}
});
