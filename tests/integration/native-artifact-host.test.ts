import {finishNativeDraft} from '../support/native-artifact-world.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {vi} from 'vitest';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore,type FileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import {Personas} from '../../packages/personas/src/service.js';
import {RunPersonas} from '../../packages/personas/src/runtime.js';
import {PrivatePreferences} from '../../packages/memory/src/service.js';
import {RuntimePreferences} from '../../packages/memory/src/runtime.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {NativeArtifactHost} from '../../packages/artifacts/src/native-host.js';
import {registerNativeArtifacts} from '../../packages/artifacts/src/runtime.js';
import {nativeArtifactDraftNotice,nativeArtifactReceiptSchema,type NativeArtifactInput} from '../../packages/artifacts/src/native-contracts.js';
import {createServer} from '../../apps/api/src/server.js';
import {config} from '../../packages/config/src/index.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,api:Awaited<ReturnType<typeof createServer>>,directory:string,files:EncryptedFileStore,service:TaskResultArtifacts,store:RuntimeStore,gateway:Gateway;
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),origin='http://127.0.0.1:52339',signal=()=>new AbortController().signal;
const name=toolName('artifacts.create','1.0.0');
beforeAll(async()=>{
 isolated=await groupReminderDatabase();await isolated.install();expect(await isolated.db.ready()).toBe(true);
 directory=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-native-artifact-')));files=new EncryptedFileStore(join(directory,'files'),vault);store=new RuntimeStore(isolated.db,vault);gateway=new Gateway(store);
 expect(registerNativeArtifacts(gateway,vault,files,{},'DEFAULT')).toBe(true);service=new TaskResultArtifacts(isolated.db,vault,files,gateway);
 api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:randomBytes(32).toString('hex'),finalReader:gateway,artifacts:service});await api.app.listen({host:'127.0.0.1',port:52339});
},60000);
afterAll(async()=>{await api?.app.close();await isolated?.close();if(directory)await rm(directory,{recursive:true,force:true});});
const world=()=>artifactWorld({isolated,store,gateway,sessions:api.sessions},origin,{finalize:false});
const input=(format:NativeArtifactInput['format']='txt'):NativeArtifactInput=>({format,source:{mode:'TOOL_DRAFT',document:{title:'SYNTHETIC draft',paragraphs:format==='csv'?[]:['SYNTHETIC unverified source content'],table:{columns:[{name:'Value',type:'decimal'}],rows:[['900719925474099312345.000000000000000000001']]}}}});
async function make(w:Awaited<ReturnType<typeof world>>,format:NativeArtifactInput['format']='txt'){
 const artifact=await finishNativeDraft({store,gateway},w,input(format));
 const finished=(await isolated.root.query('SELECT status,result FROM runs WHERE id=$1',[w.runId])).rows[0];expect(finished.status).toBe('PARTIAL');
 const native=(await isolated.root.query('SELECT * FROM artifacts WHERE id=$1',[artifact.id])).rows[0];
 expect(await isolated.db.scope(w.ctx,c=>new NativeArtifactHost(gateway,vault,files).sourceAllowed(c,w.ctx,native,signal())),'native source proof current after finalization').toBe(true);
 expect(await gateway.finalResultAllowed(w.ctx,w.runId,finished.result as string),'final native tool result remains current').toBe(true);return artifact;
}
it('a real native Gateway action renders all eight private formats and actual API delivers session-bound bytes without a fabricated session or a repeated source call',async()=>{
 for(const format of ['md','txt','csv','json','html','xlsx','docx','pdf'] as const){
  const w=await world();expect(w.lease).not.toHaveProperty('sessionId');expect((await gateway.tools(w.ctx,w.lease)).some(t=>t.function.name===name)).toBe(true);
  const artifact=await make(w,format),response=await w.request(`/api/v1/tasks/${w.taskId}/artifacts`);expect(response.status).toBe(200);expect((await response.json()).data.items).toContainEqual(artifact);
  const ticket=await w.ticket(artifact.id),download=await w.request(`/api/v1/artifacts/${artifact.id}/download`,{ticket:ticket.ticket});expect(download.status).toBe(200);expect((await download.arrayBuffer()).byteLength).toBe(artifact.byteSize);
  expect((await w.request(`/api/v1/artifacts/${artifact.id}/download`,{ticket:ticket.ticket})).status).toBe(403);expect((await w.request(`/api/v1/tasks/${w.taskId}/artifacts`,{session:w.other})).status).toBe(404);expect(w.calls()).toBe(1);
  const row=(await isolated.root.query('SELECT * FROM artifacts WHERE id=$1',[artifact.id])).rows[0];expect(row.source_mode).toBe('TOOL_DRAFT');expect(row.source_verification).toBe('UNVERIFIED');expect(row.native_action_id).toBeTruthy();expect(JSON.stringify(row.source_proof)).not.toContain(w.value);
  if(format==='csv'){const text=(await files.get(row.storage_key as string)).toString();expect(text).toContain(nativeArtifactDraftNotice+' Value');expect(text).toContain(w.value);}
 }
},60000);
it.each(['grant','source','cancel','session'] as const)('a native draft rechecks actual %s before API bytes and never queries the upstream again',async mode=>{
 const w=await world(),artifact=await make(w),ticket=await w.ticket(artifact.id);
 if(mode==='grant')await isolated.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE actor_id=$1',[w.ctx.actorId]);
 if(mode==='source')await isolated.root.query("UPDATE outbox SET payload_ref=payload_ref||'{\"value\":\"SYNTHETIC_CHANGED\"}'::jsonb WHERE id=$1",[w.sourceId]);
 if(mode==='cancel')await new TaskStore(isolated.db).cancel(w.ctx,w.taskId);
 if(mode==='session')await api.sessions.revoke(w.principal);
 const response=await w.request(`/api/v1/artifacts/${artifact.id}/download`,{ticket:ticket.ticket});expect([401,403,404,409]).toContain(response.status);expect(await response.text()).not.toContain(w.value);expect(w.calls()).toBe(1);
 if(mode==='cancel'){const row=(await isolated.root.query('SELECT state,source_proof FROM artifacts WHERE id=$1',[artifact.id])).rows[0];expect(row).toEqual({state:'REVOKED',source_proof:null});}
});
it('T102 an actual native download link forwarded to another logged-in owner is refused and revoking the original grant also refuses its already-issued ticket',async()=>{
 const w=await world(),artifact=await make(w),ticket=await w.ticket(artifact.id),path=`/api/v1/artifacts/${artifact.id}/download`;
 const forwarded=await w.request(path,{ticket:ticket.ticket,session:w.other});expect(forwarded.status).toBe(404);expect(await forwarded.text()).not.toContain(w.value);
 await isolated.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE actor_id=$1',[w.ctx.actorId]);
 const original=await w.request(path,{ticket:ticket.ticket});expect([403,404,409]).toContain(original.status);expect(await original.text()).not.toContain(w.value);expect(w.calls()).toBe(1);
});
it('cancellation during actual file read blocks final release and synchronously clears the additional proof copy before bounded unlink',async()=>{
 const w=await world(),artifact=await make(w),ticket=await w.ticket(artifact.id);
 const interrupted:FileStore={put:(...a)=>files.put(...a),remove:(...a)=>files.remove(...a),get:async key=>{const bytes=await files.get(key);await new TaskStore(isolated.db).cancel(w.ctx,w.taskId);return bytes;}};
 await expect(new TaskResultArtifacts(isolated.db,vault,interrupted,gateway).download(w.principal,artifact.id,ticket.ticket,signal())).rejects.toThrow();
 expect((await isolated.root.query('SELECT state,source_proof FROM artifacts WHERE id=$1',[artifact.id])).rows[0]).toEqual({state:'REVOKED',source_proof:null});expect(await service.maintain(w.ctx)).toMatchObject({removed:1});expect(w.calls()).toBe(1);
});
it('a cancelled native proof cannot be restored or its tombstone reopened through the actual runtime role',async()=>{
 const w=await world(),artifact=await make(w),proof=(await isolated.root.query('SELECT source_proof FROM artifacts WHERE id=$1',[artifact.id])).rows[0].source_proof;
 await new TaskStore(isolated.db).cancel(w.ctx,w.taskId);
 await expect(isolated.db.scope(w.ctx,c=>c.query('UPDATE artifacts SET source_proof=$2 WHERE id=$1',[artifact.id,JSON.stringify(proof)]))).rejects.toThrow('ARTIFACT_PROOF_IMMUTABLE');
 await expect(isolated.db.scope(w.ctx,c=>c.query("UPDATE artifacts SET state='PREPARING',source_proof=$2 WHERE id=$1",[artifact.id,JSON.stringify(proof)]))).rejects.toThrow('ARTIFACT_PROOF_IMMUTABLE');
 expect((await isolated.root.query('SELECT state,source_proof FROM artifacts WHERE id=$1',[artifact.id])).rows[0]).toEqual({state:'REVOKED',source_proof:null});
});
it('a real group mention and observed audience never discover or execute the private native draft capability',async()=>{
 const f=await groupRuntimeFixture(isolated.root,isolated.db,vault);
 try{
  expect(registerNativeArtifacts(f.gateway,vault,files,{},'DEFAULT')).toBe(true);
  const lease=(await f.store.acquire(f.ctx,f.runId,randomUUID()))!;expect(lease).toBeTruthy();
  expect(await f.gateway.prepareAudience(f.ctx,lease,signal())).toBe(true);
  expect((await f.gateway.tools(f.ctx,lease)).some(t=>t.function.name===name)).toBe(false);
  expect((await f.gateway.execute(f.ctx,lease,name,input(),signal())).status).toBe('DENIED');
  expect((await isolated.root.query('SELECT count(*) n FROM artifacts WHERE run_id=$1',[f.runId])).rows[0].n).toBe('0');
  expect((await isolated.root.query('SELECT count(*) n FROM deliveries WHERE source_run_id=$1',[f.runId])).rows[0].n).toBe('0');
 }finally{await f.close();}
},30000);
it('a repeated exact Gateway request returns its existing artifact with no second render or source query',async()=>{
 const w=await world(),args=input(),first=await gateway.execute(w.ctx,w.lease,name,args,signal()),second=await gateway.execute(w.ctx,w.lease,name,args,signal());expect(first.status,JSON.stringify(first)).toBe('OK');expect(second).toEqual(first);expect((await isolated.root.query('SELECT count(*) n FROM artifacts WHERE run_id=$1',[w.runId])).rows[0].n).toBe('1');expect(w.calls()).toBe(1);
});
it('a lost READY commit acknowledgment remains UNKNOWN with one actual file, no replayed render, and no automatic cleanup of the possible publication',async()=>{
 const w=await world(),query=pg.Client.prototype.query,ready=new WeakSet<pg.Client>();let lost=0,puts=0;
 const put=files.put.bind(files),fileSpy=vi.spyOn(files,'put').mockImplementation(async(...a)=>{puts++;await put(...a);});
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation((function(this:pg.Client,...args:unknown[]){
  if(typeof args[0]==='string'&&args[0].startsWith("UPDATE artifacts SET state='READY'"))ready.add(this);
  const result=Reflect.apply(query,this,args);
  if(args[0]==='COMMIT'&&ready.delete(this))return Promise.resolve(result).then(()=>{lost++;throw Error('SYNTHETIC_NATIVE_READY_ACK_LOST');});return result;
 }) as typeof pg.Client.prototype.query);
 try{
  const result=await gateway.execute(w.ctx,w.lease,name,input(),signal());expect(result,JSON.stringify(result)).toMatchObject({status:'UNKNOWN'});expect(lost).toBe(1);
  const replay=await gateway.execute(w.ctx,w.lease,name,input(),signal());expect(replay.status,JSON.stringify(replay)).toBe('UNKNOWN');expect(puts).toBe(1);expect(w.calls()).toBe(1);
  const row=(await isolated.root.query('SELECT state,source_proof,storage_key FROM artifacts WHERE run_id=$1',[w.runId])).rows[0];expect(row.state).toBe('READY');expect(row.source_proof).toBeTruthy();expect((await files.get(row.storage_key as string)).length).toBeGreaterThan(0);
  await store.pause(w.ctx,w.lease,'WAITING_USER','RECONCILIATION_REQUIRED');expect(await service.maintain(w.ctx)).toMatchObject({removed:0});
  expect((await isolated.root.query('SELECT state FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[w.runId,'artifacts.create'])).rows[0].state).toBe('UNKNOWN');expect((await files.get(row.storage_key as string)).length).toBeGreaterThan(0);
 }finally{spy.mockRestore();fileSpy.mockRestore();}
});
it('an actual abort after the physical local write publishes no READY artifact, clears the proof, and cannot retry the uncertain action',async()=>{
 const w=await world(),controller=new AbortController(),put=files.put.bind(files);let puts=0;const spy=vi.spyOn(files,'put').mockImplementation(async(...a)=>{puts++;await put(...a);controller.abort();});
 try{
  const result=await gateway.execute(w.ctx,w.lease,name,input(),controller.signal);expect(result.status,JSON.stringify(result)).toBe('UNKNOWN');
  const row=(await isolated.root.query('SELECT state,source_proof,storage_key FROM artifacts WHERE run_id=$1',[w.runId])).rows[0];expect(row).toMatchObject({state:'FAILED',source_proof:null});await expect(files.get(row.storage_key as string)).rejects.toMatchObject({code:'ENOENT'});
  expect((await gateway.execute(w.ctx,w.lease,name,input(),signal())).status).toBe('UNKNOWN');expect(puts).toBe(1);
 }finally{spy.mockRestore();}
});
it('a pre-cancelled invocation and missing reviewed Unicode fonts cannot produce READY bytes or a successful source fact',async()=>{
 const w=await world(),controller=new AbortController();controller.abort();expect((await gateway.execute(w.ctx,w.lease,name,input(),controller.signal)).status).toBe('DENIED');
 expect((await isolated.root.query('SELECT count(*) n FROM artifacts WHERE run_id=$1',[w.runId])).rows[0].n).toBe('0');
 const args=input('pdf');args.source.document.paragraphs=['合成未核验草稿'];const failed=await gateway.execute(w.ctx,w.lease,name,args,signal());expect(failed.status,JSON.stringify(failed)).toBe('PERMANENT_ERROR');
 expect((await isolated.root.query('SELECT state,source_proof FROM artifacts WHERE run_id=$1',[w.runId])).rows).toEqual([{state:'FAILED',source_proof:null}]);expect((await isolated.root.query("SELECT state FROM tool_actions WHERE run_id=$1 AND capability_id='artifacts.create'",[w.runId])).rows[0].state).toBe('FAILED');
});
it('trial and formal startup modes do not inherit the private draft capability or create any artifact/session',()=>{
 for(const mode of ['TRIAL','FORMAL'] as const){const reader=new Gateway(store);expect(registerNativeArtifacts(reader,vault,files,{},mode)).toBe(false);expect(reader.describeContract('artifacts.create','1.0.0')).toBeNull();}
});
it.each(['memory','persona'] as const)('the actual native model loop binds private context and %s erasure clears the new proof copy in the same transaction',async kind=>{
 const w=await world(),personas=new Personas(isolated.db,vault),memory=new PrivatePreferences(isolated.db,vault),canary='SYNTHETIC_NATIVE_PRIVATE_CONTEXT_'+randomUUID();
 await personas.patch(w.ctx,{kind:'USER',id:w.ctx.actorId},{tone:'DIRECT'},'"0"',randomUUID(),w.principal);
 const saved=await memory.save(w.ctx,{kind:'PREFERENCE',title:'SYNTHETIC preference',content:canary,sensitivity:'CONFIDENTIAL',allowModel:true},randomUUID(),w.principal);
 const runtimeStore=new RuntimeStore(isolated.db,vault);runtimeStore.configurePersonas(new RunPersonas(isolated.db,vault,new RuntimePreferences(memory,{schemaVersion:1,id:'SYNTHETIC_NATIVE_ARTIFACT_MEMORY',environment:'SYNTHETIC_TEST',approved:true,approvalReference:'SYNTHETIC_LOCAL_MEMORY_CONTEXT_ONLY',validUntil:'2099-01-01T00:00:00Z',allowedClassifications:['CONFIDENTIAL'],maxItems:10,maxBytes:12000})));
 const reader=new Gateway(runtimeStore);registerNativeArtifacts(reader,vault,files,{},'DEFAULT');const task=await new TaskStore(isolated.db).create(w.ctx,'SYNTHETIC create a private text draft',randomUUID());let turns=0;
 const provider=new GlmProvider({apiKey:'SYNTHETIC_NATIVE_MODEL_ONLY',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  turns++;const request=JSON.parse(init!.body as string) as {messages:ProviderMessage[];tools:{function:{name:string}}[]};expect(request.tools.some(t=>t.function.name===name)).toBe(true);expect(JSON.stringify(request.messages)).toContain(canary);
  const args=input();args.source.document.paragraphs=[canary];
  const last=request.messages.filter(m=>m.role==='tool').at(-1),receipt=last?nativeArtifactReceiptSchema.parse(JSON.parse(last.content!).data):null;
  const delta=turns===1?{role:'assistant',tool_calls:[{index:0,id:'SYNTHETIC_NATIVE_MODEL_CALL',type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:'SYNTHETIC_NATIVE_MODEL_CALL'},pointer:'/artifact/fileName',expected:receipt!.artifact.fileName,coverage:'OBSERVED'}],outcome:'PARTIAL'})};
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:turns===1?'tool_calls':'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 await new AgentRuntime(runtimeStore,provider,reader).advance(w.ctx,task.runId);expect(turns).toBe(2);
 const run=(await isolated.root.query('SELECT status,result,persona_snapshot_id FROM runs WHERE id=$1',[task.runId])).rows[0];expect(run).toMatchObject({status:'PARTIAL'});expect(run.persona_snapshot_id).toBeTruthy();expect(await reader.finalResultAllowed(w.ctx,task.runId,run.result as string)).toBe(true);
 const service=new TaskResultArtifacts(isolated.db,vault,files,reader),items=(await service.list(w.principal,task.taskId)).items;expect(items).toHaveLength(1);expect(items[0]!.source).toMatchObject({mode:'TOOL_DRAFT',classification:'CONFIDENTIAL',verification:'UNVERIFIED'});
 const before=(await isolated.root.query('SELECT source_proof,storage_key FROM artifacts WHERE id=$1',[items[0]!.id])).rows[0];expect(before.source_proof).toBeTruthy();expect((await files.get(before.storage_key as string)).toString()).toContain(canary);
 if(kind==='memory')await memory.forget(w.ctx,saved.memoryId,randomUUID(),w.principal);else await personas.erasePrivate(w.ctx,randomUUID(),w.principal);
 expect((await isolated.root.query('SELECT state,source_proof FROM artifacts WHERE id=$1',[items[0]!.id])).rows[0]).toEqual({state:'REVOKED',source_proof:null});expect(await reader.finalResultAllowed(w.ctx,task.runId,run.result as string)).toBe(false);
 await isolated.root.query("UPDATE users SET status='DEPARTED' WHERE id=$1",[w.ctx.actorId]);if(kind==='memory'){await expect(memory.repairKnownErasure(w.ctx,saved.memoryId)).rejects.toThrow('MEMORY_SCOPE_DENIED');await memory.maintain(w.ctx);}else await personas.repairPrivateErasure(w.ctx);
 expect(await service.maintain(w.ctx)).toMatchObject({removed:1});await expect(files.get(before.storage_key as string)).rejects.toMatchObject({code:'ENOENT'});
 expect((await isolated.root.query("SELECT has_function_privilege('oa_app','public.oa_native_artifact_erasure()','EXECUTE') app,has_function_privilege('oa_runtime','public.oa_native_artifact_erasure()','EXECUTE') runtime")).rows[0]).toEqual({app:false,runtime:false});
},60000);
