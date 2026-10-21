import '../support/isolation.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type pg from 'pg';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore,type FileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {createServer} from '../../apps/api/src/server.js';
import {config,secret} from '../../packages/config/src/index.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,api:Awaited<ReturnType<typeof createServer>>,directory:string,files:EncryptedFileStore,service:TaskResultArtifacts,store:RuntimeStore,gateway:Gateway;
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),origin='http://127.0.0.1:64702',signingKey=randomBytes(32).toString('hex');
const signal=()=>new AbortController().signal;
beforeAll(async()=>{
 isolated=await groupReminderDatabase();await isolated.install();expect(await isolated.db.ready()).toBe(true);
 directory=await realpath(await mkdtemp(join(tmpdir(),'oa-task-artifact-')));files=new EncryptedFileStore(join(directory,'files'),vault);store=new RuntimeStore(isolated.db,vault);gateway=new Gateway(store);service=new TaskResultArtifacts(isolated.db,vault,files,gateway);
 api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:signingKey,finalReader:gateway,artifacts:service});await api.app.listen({host:'127.0.0.1',port:64702});
});
afterAll(async()=>{await api?.app.close();await isolated?.close();if(directory)await rm(directory,{recursive:true,force:true});});
const world=()=>artifactWorld({isolated,store,gateway,sessions:api.sessions},origin);
it('real HTTP and PostgreSQL preserve exact results in six formats with durable idempotency, private storage and single-use session-bound downloads',async()=>{
 const w=await world();
 for(const format of ['txt','md','csv','json','html','xlsx']){
  const key=randomUUID(),response=await w.create(format,key);expect(response.status).toBe(201);const receipt=(await response.json()).data;expect(receipt.replayed).toBe(false);expect(receipt.artifact.source.verification).toBe('UNVERIFIED');
  const replay=await w.create(format,key);expect(replay.status).toBe(200);expect((await replay.json()).data).toEqual({...receipt,replayed:true});
  const id=receipt.artifact.id,t=await w.ticket(id),download=await w.request(`/api/v1/artifacts/${id}/download`,{ticket:t.ticket});expect(download.status).toBe(200);expect(download.headers.get('cache-control')).toContain('no-store');expect(download.headers.get('content-disposition')).toContain('attachment');
  const bytes=Buffer.from(await download.arrayBuffer());expect(bytes.length).toBe(receipt.artifact.byteSize);expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.artifact.sha256);if(format!=='xlsx')expect(bytes.toString().replace(/\\\./g,'.')).toContain(w.value);
  expect((await w.request(`/api/v1/artifacts/${id}/download`,{ticket:t.ticket})).status).toBe(403);
  const storage=(await isolated.root.query('SELECT storage_key FROM artifacts WHERE id=$1',[id])).rows[0].storage_key;expect((await readFile(join(files.root,storage),'utf8'))).not.toContain(w.value);
 }
 expect(w.calls()).toBe(1);const list=await w.request(`/api/v1/tasks/${w.taskId}/artifacts`);expect((await list.json()).data.items).toHaveLength(6);
});
it('same concurrent create is rendered once; changed intent, forged fields, cross-owner reads and CSRF-less writes are rejected',async()=>{
 const w=await world(),key=randomUUID(),responses=await Promise.all(Array.from({length:8},()=>w.create('txt',key)));expect(responses.every(r=>[200,201,409].includes(r.status))).toBe(true);
 expect((await isolated.root.query('SELECT count(*)::int n FROM artifacts WHERE task_id=$1',[w.taskId])).rows[0].n).toBe(1);
 const item=(await (await w.request(`/api/v1/tasks/${w.taskId}/artifacts`)).json()).data.items[0];expect(item).toBeTruthy();
 expect((await w.create('json',key)).status).toBe(409);expect((await w.request(`/api/v1/tasks/${w.taskId}/artifacts`,{method:'POST',body:{runId:w.runId,format:'txt',result:'forged'},key:randomUUID()})).status).toBe(400);
 expect((await w.request(`/api/v1/tasks/${w.taskId}/artifacts`,{session:w.other})).status).toBe(404);
 expect((await w.request(`/api/v1/artifacts/${item.id}/download-ticket`,{method:'POST',body:{},session:w.other})).status).toBe(404);
 expect((await w.request(`/api/v1/tasks/${w.taskId}/artifacts`,{method:'POST',body:{runId:w.runId,format:'txt'},key:randomUUID(),csrf:false})).status).toBe(403);
 const t=await w.ticket(item.id),second=await api.sessions.create(w.ctx);expect((await w.request(`/api/v1/artifacts/${item.id}/download`,{ticket:t.ticket,session:second})).status).toBe(403);expect((await w.request(`/api/v1/artifacts/${item.id}/download`,{ticket:t.ticket})).status).toBe(200);
});
it.each(['grant','source','cancel','session','expiry'] as const)('rechecks %s changes after ticket issue and never re-queries the business source',async mode=>{
 const w=await world(),r=await w.create(),item=(await r.json()).data.artifact,t=await w.ticket(item.id);
 if(mode==='grant')await isolated.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE actor_id=$1',[w.ctx.actorId]);
 if(mode==='source')await isolated.root.query("UPDATE outbox SET payload_ref=payload_ref||'{\"value\":\"changed\"}'::jsonb WHERE id=$1",[w.sourceId]);
 if(mode==='cancel')await new TaskStore(isolated.db).cancel(w.ctx,w.taskId);
 if(mode==='session')await api.sessions.revoke(w.principal);
 if(mode==='expiry')await isolated.root.query("UPDATE artifact_download_tickets SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE artifact_id=$1",[item.id]);
 const download=await w.request(`/api/v1/artifacts/${item.id}/download`,{ticket:t.ticket});expect([401,403,404,409]).toContain(download.status);expect((await download.text())).not.toContain(w.value);expect(w.calls()).toBe(1);
});
it('missing reviewed Unicode fonts fail both document formats honestly, without a READY artifact or download ticket',async()=>{
 const w=await world();for(const format of ['docx','pdf']){const r=await w.create(format);expect(r.status).toBe(422);expect((await r.json()).error.code).toMatch(/FONT/);}
 expect((await (await w.request(`/api/v1/tasks/${w.taskId}/artifacts`)).json()).data.items).toEqual([]);expect((await isolated.root.query('SELECT state FROM artifacts WHERE task_id=$1',[w.taskId])).rows.every(r=>r.state==='FAILED')).toBe(true);
});
it('source cancellation during file read prevents final byte release; bounded maintenance removes the sealed copy',async()=>{
 const w=await world(),item=(await (await w.create()).json()).data.artifact,t=await w.ticket(item.id);
 const interrupted:FileStore={put:(...args)=>files.put(...args),remove:(...args)=>files.remove(...args),get:async key=>{const bytes=await files.get(key);await new TaskStore(isolated.db).cancel(w.ctx,w.taskId);return bytes;}};
 await expect(new TaskResultArtifacts(isolated.db,vault,interrupted,gateway).download(w.principal,item.id,t.ticket,signal())).rejects.toThrow('ARTIFACT_ACCESS_DENIED');
 expect(await service.maintain(w.ctx)).toMatchObject({removed:1});const row=(await isolated.root.query('SELECT state,file_removed_at,storage_key FROM artifacts WHERE id=$1',[item.id])).rows[0];expect(row.state).toBe('REVOKED');expect(row.file_removed_at).toBeTruthy();await expect(files.get(row.storage_key)).rejects.toMatchObject({code:'ENOENT'});
});
it('a cancellation committed during the last external source check blocks final bytes, and no long source check holds the task lock',async()=>{
 const w=await world(),item=(await (await w.create()).json()).data.artifact,t=await w.ticket(item.id);let checks=0;
 w.setSourceGate(async()=>{checks++;if(checks===2)expect(await new TaskStore(isolated.db).cancel(w.ctx,w.taskId)).toBeTruthy();});
 await expect(service.download(w.principal,item.id,t.ticket,signal())).rejects.toThrow('ARTIFACT_ACCESS_DENIED');expect(checks).toBe(2);expect(w.calls()).toBe(1);
});
it('concurrent ticket requests respect the persisted limit; cancellation during source verification rolls ticket issue back',async()=>{
 const w=await world(),item=(await (await w.create()).json()).data.artifact;
 const issued=await Promise.all(Array.from({length:16},()=>w.request(`/api/v1/artifacts/${item.id}/download-ticket`,{method:'POST',body:{}})));expect(issued.filter(r=>r.status===200)).toHaveLength(10);expect(issued.filter(r=>r.status===429)).toHaveLength(6);
 expect((await isolated.root.query('SELECT count(*)::int n FROM artifact_download_tickets WHERE artifact_id=$1',[item.id])).rows[0].n).toBe(10);
 const other=await world(),artifact=(await (await other.create()).json()).data.artifact,controller=new AbortController();other.setSourceGate(async()=>{controller.abort();});
 await expect(service.ticket(other.principal,artifact.id,controller.signal)).rejects.toThrow('ARTIFACT_CANCELLED');expect((await isolated.root.query('SELECT count(*)::int n FROM artifact_download_tickets WHERE artifact_id=$1',[artifact.id])).rows[0].n).toBe(0);
});
it('an unresolved PostgreSQL publication cannot have its file unlinked by failure cleanup before its READY commit is known',async()=>{
 const w=await world(),publisher=await isolated.root.connect(),url=new URL(secret('RUNTIME_DATABASE_URL')!);url.pathname='/'+isolated.name;
 let published=false,lost=false,notifyHeld!:()=>void,removes=0;const held=new Promise<void>(r=>{notifyHeld=r;});
 class LostReplyDatabase extends Database{
  override async scope<T>(ctx:DbContext,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
   const result=await super.scope(ctx,c=>fn(new Proxy(c,{get:(target,key)=>{
    if(key!=='query')return Reflect.get(target,key,target);
    return async(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].startsWith("UPDATE artifacts SET state='READY'")){published=true;return Reflect.apply(publisher.query,publisher,args);}return Reflect.apply(target.query,target,args);};
   }})));
   if(published&&!lost){lost=true;notifyHeld();throw Error('SYNTHETIC_COMMIT_RESPONSE_LOST');}return result;
  }
 }
 const db=new LostReplyDatabase(url.href,4),tracked:FileStore={put:(...args)=>files.put(...args),get:(...args)=>files.get(...args),remove:async key=>{removes++;return files.remove(key);}};
 await publisher.query('BEGIN');let committed=false;
 try{
  const operation=new TaskResultArtifacts(db,vault,tracked,gateway).create(w.principal,w.taskId,{runId:w.runId,format:'txt'},randomUUID(),signal()).then(v=>({value:v,error:null}),e=>({value:null,error:e as Error}));
  await Promise.race([held,operation.then(result=>{throw result.error??Error('PUBLICATION_HOLD_NOT_REACHED');})]);
  await vi.waitFor(async()=>expect(Number((await isolated.root.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2",[isolated.name,"UPDATE artifacts SET state='FAILED'%"])).rows[0].n)).toBe(1));
  expect(removes).toBe(0);expect((await isolated.root.query('SELECT state FROM artifacts WHERE task_id=$1',[w.taskId])).rows[0].state).toBe('PREPARING');
  await publisher.query('COMMIT');committed=true;expect((await operation).error?.message).toBe('ARTIFACT_GENERATION_FAILED');expect(removes).toBe(0);
  const row=(await isolated.root.query('SELECT state,storage_key FROM artifacts WHERE task_id=$1',[w.taskId])).rows[0];expect(row.state).toBe('READY');expect((await files.get(row.storage_key)).length).toBeGreaterThan(0);
 }finally{if(!committed)await publisher.query('ROLLBACK');publisher.release();await db.close();}
});
