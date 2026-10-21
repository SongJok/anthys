import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,readdir,readFile,mkdir,realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,fork} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {Database} from '../../packages/storage/src/database.js';
import {trialProfileSchema} from '../../packages/config/src/one-shot-trial.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {ModelBudget} from '../../packages/runtime/src/model-budget.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {ProviderError,glmRequestBody,type ModelProvider} from '../../packages/provider-glm/src/client.js';
import {z} from 'zod';
import {trialSupervisorReceiptSchema,trialRemainingMs,type TrialService,type TrialFixture,type TrialSupervisorReceipt} from '../../packages/runtime/src/trial-supervision.js';
const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
afterAll(async()=>{await admin.end();});
async function profileFixture(ttlMs=2500,exhaustedBudget=false){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='SYNTHETIC-SUPERVISION-'+ctx.tenantId,robotCode='synthetic-supervised',base=await realpath(await mkdtemp(join(tmpdir(),'oa-trial-supervision-')));
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC SUPERVISION','ACTIVE')",[ctx.tenantId,corpId]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const policy=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')));
 policy.pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_NOT_PROVIDER_VERIFIED',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};if(exhaustedBudget)policy.limits.task.money='0';
 const budgetPath=join(base,'budget.json');await writeFile(budgetPath,JSON.stringify(policy),{mode:0o600});
 const profile=trialProfileSchema.parse({schemaVersion:1,...ctx,corpId,externalUserId:'owner',robotCode,conversationId:'synthetic-supervised-dm',deadline:new Date(Date.now()+ttlMs).toISOString(),budgetPolicyHash:hash(JSON.stringify(policy)),approvalReference:'SYNTHETIC_NO_REAL_RUNTIME_APPROVAL'}),profilePath=join(base,'profile.json'),scope=join(base,'scopes.json');
 await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});await writeFile(scope,JSON.stringify([ctx]),{mode:0o600});const bindings=join(base,'bindings.json');await writeFile(bindings,JSON.stringify([{tenantId:ctx.tenantId,corpId}]),{mode:0o600});
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,$8)",[ctx.tenantId,ctx.actorId,hash(JSON.stringify(profile)),profile.budgetPolicyHash,corpId,robotCode,profile.conversationId,profile.deadline]);
 const names=['PATH','HOME','TMPDIR','APP_ENV','OA_TEST_ISOLATED','APP_ORIGIN','DATABASE_URL','RUNTIME_DATABASE_URL','QUEUE_DATABASE_URL','APP_MASTER_KEY_FILE','SESSION_SECRET_FILE','BUDGET_POLICY_FILE','NODE_OPTIONS'];
 const env={...Object.fromEntries(names.flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]])),BUDGET_POLICY_FILE:budgetPath,ONE_SHOT_TRIAL_PROFILE_FILE:profilePath,WORKER_SCOPE_FILE:scope,TENANT_BINDINGS_FILE:bindings,DINGTALK_CORP_ID:corpId,DINGTALK_ROBOT_CODE:robotCode};
 return {ctx,profile,profilePath,policy,env,base,close:()=>rm(base,{recursive:true,force:true})};
}
it('direct TRIAL worker startup without owned supervision cannot survive its fixed DB deadline',async()=>{
 const f=await profileFixture(),child=spawn(process.execPath,['--import','tsx','apps/worker/src/main.ts'],{env:f.env,stdio:['ignore','pipe','pipe']});let out='',err='',closed=false;child.stdout.on('data',b=>{out+=String(b);});child.stderr.on('data',b=>{err+=String(b);});const exit=new Promise<void>(resolve=>child.once('close',()=>{closed=true;resolve();}));
 try{
  await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(f.profile.deadline)-Date.now()+200)))]);
  console.log(JSON.stringify({probe:'UNSUPERVISED_TRIAL_WORKER',workerRunningObserved:out.includes('Worker running'),closedByDeadline:closed,supervisionRequiredObserved:err.includes('TRIAL_SUPERVISION_REQUIRED')}));
  expect(closed).toBe(true);expect(err).toContain('TRIAL_SUPERVISION_REQUIRED');
 }finally{if(!closed)child.kill('SIGTERM');const force=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},1000);await exit;clearTimeout(force);await f.close();}
},10000);
function launch(f:Awaited<ReturnType<typeof profileFixture>>,services:{service:TrialService;fixture?:TrialFixture}[],extraEnv:NodeJS.ProcessEnv={}){
 const began=performance.now(),stages:Record<string,unknown>[]=[];let readyObserved=false;
 const parent=fork(new URL('../support/trial-supervisor-parent.ts',import.meta.url),[],{env:{...f.env,...extraEnv},execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
 let closed=false,failure='PARENT_CLOSED',resolveReady!:(v:{guardianPid:number;ownedPids:number[]})=>void,rejectReady!:(e:Error)=>void,resolveFinished!:(v:TrialSupervisorReceipt)=>void,rejectFinished!:(e:Error)=>void;
 const ready=new Promise<{guardianPid:number;ownedPids:number[]}>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;}),finished=new Promise<TrialSupervisorReceipt>((resolve,reject)=>{resolveFinished=resolve;rejectFinished=reject;});void ready.catch(()=>{});void finished.catch(()=>{});
 const exit=new Promise<void>(resolve=>parent.once('close',(code,signal)=>{closed=true;const diagnostic={probe:'SUPERVISOR_PARENT_CLOSE',code,signal,elapsedMs:Math.round(performance.now()-began),readyObserved,failure,stages};console.log(JSON.stringify(diagnostic));rejectReady(Error(JSON.stringify(diagnostic)));rejectFinished(Error(JSON.stringify(diagnostic)));resolve();}));
 parent.on('message',(raw:unknown)=>{
  const readyValue=z.object({kind:z.literal('READY'),guardianPid:z.number().int().positive(),ownedPids:z.array(z.number().int().positive())}).strict().safeParse(raw);
  if(readyValue.success){readyObserved=true;resolveReady(readyValue.data);return;}
  if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='EVENT'&&'event'in raw&&raw.event&&typeof raw.event==='object'&&stages.length<32){const event=raw.event as Record<string,unknown>;stages.push(Object.fromEntries(['kind','stage','code','service','reason'].flatMap(key=>typeof event[key]==='string'&&/^[A-Z_a-z]+$/.test(event[key])?[[key,event[key]]]:[])));}
  if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='EVENT'&&'event'in raw&&raw.event&&typeof raw.event==='object'&&'kind'in raw.event&&raw.event.kind==='FAILED')failure='GUARDIAN_STARTUP_'+('stage'in raw.event?String(raw.event.stage):'UNKNOWN');
  if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='FINISHED'&&'receipt'in raw){resolveFinished(trialSupervisorReceiptSchema.parse(raw.receipt));}
 });
 parent.send({profilePath:f.profilePath,profileHash:hash(JSON.stringify(f.profile)),runtimeDirectory:f.base,services});
 const stop=async()=>{if(!closed){parent.kill('SIGCONT');if(parent.connected)parent.send({kind:'STOP'},()=>{});const force=setTimeout(()=>{if(!closed)parent.kill('SIGKILL');},1000);await exit;clearTimeout(force);}};
 return {parent,ready,finished,exit,stop};
}
function pidAlive(pid:number){try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}}
async function receipt(f:Awaited<ReturnType<typeof profileFixture>>){let value:TrialSupervisorReceipt|undefined;await vi.waitFor(async()=>{const files=(await readdir(f.base)).filter(n=>n.endsWith('.receipt.json'));expect(files).toHaveLength(1);value=trialSupervisorReceiptSchema.parse(JSON.parse(await readFile(join(f.base,files[0]!),'utf8')));},{timeout:2500});return value!;}
it('owned native worker closes by original DB deadline including bounded force-kill; same-slot restart cannot extend it',async()=>{
 const f=await profileFixture(5000),controller=launch(f,[{service:'worker',fixture:'native-worker'}]);
 try{
  const ready=await controller.ready;expect(ready.ownedPids).toHaveLength(1);const result=await controller.finished;await controller.exit;
  expect(result).toMatchObject({reason:'TRIAL_DEADLINE',databaseClosed:true,ownedGroupsClosed:true,deadlineAt:Date.parse(f.profile.deadline)});expect(Date.parse(result.endedAt)).toBeLessThanOrEqual(Date.parse(f.profile.deadline));
  for(const pid of [...ready.ownedPids,ready.guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
  const before=(await admin.query('SELECT state,deadline,created_at,profile_hash FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows;
  const restart=launch(f,[{service:'worker',fixture:'idle'}]);try{await expect(restart.ready).rejects.toThrow();await restart.exit;}finally{await restart.stop();}
  expect((await admin.query('SELECT state,deadline,created_at,profile_hash FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows).toEqual(before);
 }finally{await controller.stop();await f.close();}
},15000);
it('independent guardian kills busy service and real grandchild after launcher SIGKILL',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'grandchild'},{service:'notifier',fixture:'busy'},{service:'ingress',fixture:'idle'}]);
 try{
  const ready=await controller.ready,grandchild=Number(await readFile(join(f.base,'worker.grandchild.pid'),'utf8'));expect(pidAlive(grandchild)).toBe(true);controller.parent.kill('SIGKILL');await controller.exit;
  const result=await receipt(f);expect(result).toMatchObject({reason:'TRIAL_PARENT_LOST',databaseClosed:true,ownedGroupsClosed:true});
  for(const pid of [...ready.ownedPids,ready.guardianPid,grandchild])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
  expect((await admin.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].state).toBe('CLOSED');
 }finally{await controller.stop();await f.close();}
},12000);
it('SIGSTOP of launcher cannot suspend guardian deadline or keep owned services alive',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'idle'}]);
 try{const ready=await controller.ready;expect(Date.parse(f.profile.deadline)-Date.now()).toBeGreaterThan(1800);controller.parent.kill('SIGSTOP');await controller.exit;expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.profile.deadline));const result=await receipt(f);expect(result).toMatchObject({reason:'TRIAL_PARENT_UNRESPONSIVE',databaseClosed:true,ownedGroupsClosed:true});for(const pid of [...ready.ownedPids,ready.guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));}
 finally{await controller.stop();await f.close();}
},12000);
it('near-deadline SIGSTOP still terminates the launcher under the original deadline',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'idle'}]);
 try{
  const ready=await controller.ready,deadline=Date.parse(f.profile.deadline);expect(deadline-Date.now()).toBeGreaterThan(1800);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now()-800)));const remaining=deadline-Date.now();expect(remaining).toBeGreaterThan(600);expect(remaining).toBeLessThanOrEqual(900);
  expect(controller.parent.kill('SIGSTOP')).toBe(true);await controller.exit;expect(Date.now()).toBeLessThanOrEqual(deadline);expect(controller.parent.signalCode).toBe('SIGKILL');
  const result=await receipt(f);expect(result).toMatchObject({reason:'TRIAL_DEADLINE',databaseClosed:true,ownedGroupsClosed:true,deadlineAt:deadline});expect(Date.parse(result.endedAt)).toBeLessThanOrEqual(deadline);
  for(const pid of [...ready.ownedPids,ready.guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
 }finally{await controller.stop();await f.close();}
},12000);
it('a closed receipt retains the independent deadline while launcher final output is suspended',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'idle'}],{OA_TRIAL_TEST_PAUSE_AFTER_STOPPED:'true'});
 try{
  const ready=await controller.ready,deadline=Date.parse(f.profile.deadline);expect(deadline-Date.now()).toBeGreaterThan(1800);controller.parent.send({kind:'STOP'});
  const result=await receipt(f);expect(result).toMatchObject({reason:'TRIAL_OPERATOR_STOP',databaseClosed:true,ownedGroupsClosed:true,deadlineAt:deadline});expect(pidAlive(controller.parent.pid!)).toBe(true);
  await vi.waitFor(async()=>expect(await readFile(join(f.base,'pause-after-stopped'),'utf8')).toBe('1'));
  await controller.exit;expect(Date.now()).toBeLessThanOrEqual(deadline);expect(controller.parent.signalCode).toBe('SIGKILL');
  for(const pid of [...ready.ownedPids,ready.guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
 }finally{await controller.stop();await f.close();}
},12000);
it('guardian shutdown cleanup cannot postpone its independent parent deadline',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'idle'}]);let guardianPid:number|undefined;
 try{
  const ready=await controller.ready,deadline=Date.parse(f.profile.deadline);guardianPid=ready.guardianPid;expect(deadline-Date.now()).toBeGreaterThan(1800);
  expect(controller.parent.kill('SIGSTOP')).toBe(true);expect(process.kill(guardianPid,'SIGSTOP')).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now()-250)));const remaining=deadline-Date.now();expect(remaining).toBeGreaterThan(150);expect(remaining).toBeLessThanOrEqual(350);expect(process.kill(guardianPid,'SIGCONT')).toBe(true);
  await controller.exit;expect(Date.now()).toBeLessThanOrEqual(deadline);expect(controller.parent.signalCode).toBe('SIGKILL');
  for(const pid of [...ready.ownedPids,guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
  const row=(await admin.query('SELECT state,deadline FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0];expect(['ARMED','CLOSED']).toContain(row.state);expect(row.deadline.toISOString()).toBe(f.profile.deadline);
  console.log(JSON.stringify({probe:'GUARDIAN_CLEANUP_DEADLINE',originalDeadline:deadline,parentKilled:true,ownedGroupsPhysicallyClosed:true,databaseState:row.state,databaseClosureClaimed:false}));
 }finally{if(guardianPid)try{process.kill(guardianPid,'SIGCONT');}catch{/* already exited */}await controller.stop();await f.close();}
},12000);
it('guardian SIGKILL makes launcher kill every registered group and close the same slot',async()=>{
 const f=await profileFixture(6000),controller=launch(f,[{service:'worker',fixture:'busy'}]);
 try{const ready=await controller.ready;process.kill(ready.guardianPid,'SIGKILL');const result=await controller.finished;await controller.exit;expect(result).toMatchObject({reason:'TRIAL_GUARDIAN_LOST',databaseClosed:true,ownedGroupsClosed:true});for(const pid of ready.ownedPids)await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));}
 finally{await controller.stop();await f.close();}
},12000);
it('backward wall-clock fault in both control processes cannot add time to the original monotonic deadline',async()=>{
 const f=await profileFixture(4000),controller=launch(f,[{service:'worker',fixture:'idle'}],{OA_TRIAL_TEST_WALL_SHIFT_MS:'-3600000'});
 try{await controller.ready;const result=await controller.finished;await controller.exit;expect(result).toMatchObject({reason:'TRIAL_DEADLINE',databaseClosed:true,ownedGroupsClosed:true,deadlineAt:Date.parse(f.profile.deadline)});expect(Date.parse(result.endedAt)).toBeLessThanOrEqual(Date.parse(f.profile.deadline));}
 finally{await controller.stop();await f.close();}
},10000);
it('wall-clock jumps only shorten a shared monotonic budget and never mint a restart duration',()=>{
 const bound={deadlineAt:10000,monoDeadlineNs:5000000000n};expect(trialRemainingMs(bound,-1000000,4500000000n)).toBe(500);expect(trialRemainingMs(bound,12000,4500000000n)).toBe(0);expect(trialRemainingMs(bound,0,6000000000n)).toBe(0);
});
it('same ARMED profile cannot start two guardians by choosing different runtime directories',async()=>{
 const f=await profileFixture(6000),left=join(f.base,'left'),right=join(f.base,'right');await mkdir(left,{mode:0o700});await mkdir(right,{mode:0o700});
 const a=launch({...f,base:left},[{service:'worker',fixture:'idle'}]),b=launch({...f,base:right},[{service:'worker',fixture:'idle'}]);
 try{const outcomes=await Promise.allSettled([a.ready,b.ready]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);}
 finally{await Promise.all([a.stop(),b.stop()]);await f.close();}
},12000);
it('database execution claim is atomic, owner-RLS isolated and immutable without rewriting the trial tombstone',async()=>{
 const f=await profileFixture(6000),db=new Database(secret('RUNTIME_DATABASE_URL')!);db.trialProfileHash=hash(JSON.stringify(f.profile));
 try{
  const before=(await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[f.ctx.tenantId])).rows;
  const outcomes=await Promise.all(Array.from({length:8},()=>db.scope(f.ctx,async c=>(await c.query('SELECT public.oa_trial_claim_execution($1,$2) state',[db.trialProfileHash,randomUUID().replaceAll('-','')])).rows[0].state as {claimed:boolean})));
  expect(outcomes.filter(o=>o.claimed)).toHaveLength(1);expect((await admin.query('SELECT count(*)::int n FROM one_shot_trial_executions WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT to_jsonb(s) row FROM one_shot_trials s WHERE tenant_id=$1',[f.ctx.tenantId])).rows).toEqual(before);
  expect((await db.scope({...f.ctx,actorId:randomUUID()},c=>c.query('SELECT * FROM one_shot_trial_executions'))).rows).toEqual([]);
  await expect(db.scope(f.ctx,c=>c.query('DELETE FROM one_shot_trial_executions WHERE tenant_id=$1',[f.ctx.tenantId]))).rejects.toMatchObject({code:'42501'});
  await expect(admin.query('DELETE FROM one_shot_trial_executions WHERE tenant_id=$1',[f.ctx.tenantId])).rejects.toThrow('TRIAL_EXECUTION_CLAIM_IMMUTABLE');
  await expect(admin.query('UPDATE one_shot_trial_executions SET execution_token=$2 WHERE tenant_id=$1',[f.ctx.tenantId,'a'.repeat(32)])).rejects.toThrow('TRIAL_EXECUTION_CLAIM_IMMUTABLE');
  for(const role of ['oa_app','oa_queue'])expect((await admin.query("SELECT has_function_privilege($1,'public.oa_trial_claim_execution(text,text)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
 }finally{await db.close();await f.close();}
});
it('actual CLI exits by original deadline when guardian dies near expiry and fallback DB handshake stalls',async()=>{
 let blackholeConnections=0;const f=await profileFixture(4000),sockets=new Set<net.Socket>(),server=net.createServer(socket=>{blackholeConnections++;sockets.add(socket);socket.on('data',()=>{});socket.once('close',()=>sockets.delete(socket));});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(64702,'127.0.0.1',resolve);});
 const child=fork(new URL('../../scripts/trial-runtime.ts',import.meta.url),['run','--profile',f.profilePath,'--expected-profile-hash',hash(JSON.stringify(f.profile)),'--review-ref',f.profile.approvalReference,'--runtime-dir',f.base],{env:{...f.env,OA_TRIAL_TEST_CLI_FIXTURE:'idle',OA_TRIAL_TEST_PARENT_BLACKHOLE_PORT:'64702'},execArgv:['--import','tsx'],stdio:['ignore','pipe','ignore','ipc']});
 const began=performance.now();let output='',closed=false,exitAt=0;child.stdout!.on('data',b=>{output+=String(b);});const exit=new Promise<void>(resolve=>child.once('close',(code,signal)=>{closed=true;exitAt=Date.now();const stages=output.split('\n').filter(Boolean).flatMap(line=>{try{const value=JSON.parse(line) as Record<string,unknown>;return [Object.fromEntries(['kind','stage','code','service','reason'].flatMap(key=>typeof value[key]==='string'&&/^[A-Z_a-z]+$/.test(value[key])?[[key,value[key]]]:[]))];}catch{return [];}}).slice(0,32);console.log(JSON.stringify({probe:'ACTUAL_CLI_CLOSE',code,signal,elapsedMs:Math.round(performance.now()-began),readyObserved:output.includes('TRIAL_SERVICES_READY'),stages}));resolve();}));
 try{
  await vi.waitFor(()=>expect(output).toContain('TRIAL_SERVICES_READY'),{timeout:2500});
  const events=output.split('\n').filter(Boolean).map(s=>JSON.parse(s) as Record<string,unknown>),guardian=events.find(e=>e.kind==='READY')!.guardianPid as number,pids=events.filter(e=>e.kind==='REGISTER').map(e=>e.pid as number);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(f.profile.deadline)-Date.now()-700)));process.kill(guardian,'SIGKILL');await exit;
  expect(exitAt).toBeLessThanOrEqual(Date.parse(f.profile.deadline));expect(child.exitCode===78||child.signalCode==='SIGKILL').toBe(true);expect(blackholeConnections).toBeGreaterThan(0);
  for(const pid of pids)await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
  const stopped=output.split('\n').filter(Boolean).map(s=>JSON.parse(s) as {kind:string;receipt?:TrialSupervisorReceipt}).find(e=>e.kind==='TRIAL_STOPPED');if(stopped)expect(stopped.receipt?.databaseClosed).toBe(false);expect((await admin.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0].state).toBe('ARMED');
  console.log(JSON.stringify({probe:'ACTUAL_CLI_FALLBACK_DB_STALL',exitAt,deadlineAt:Date.parse(f.profile.deadline),acceptedConnections:blackholeConnections,receiptPresent:!!stopped,databaseClosed:stopped?.receipt?.databaseClosed??null,ownedServicePidsClosed:pids.every(pid=>!pidAlive(pid))}));
 }finally{if(!closed){child.kill('SIGKILL');await exit;}for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
},10000);
it.each(['delivered','unknown','budget'] as const)('real runtime %s closes its slot and the independent guardian stops all three fixture service groups',async outcome=>{
 const f=await profileFixture(8000,outcome==='budget'),controller=launch(f,[{service:'ingress',fixture:'idle'},{service:'worker',fixture:'idle'},{service:'notifier',fixture:'idle'}]),db=new Database(secret('RUNTIME_DATABASE_URL')!);db.trialProfileHash=hash(JSON.stringify(f.profile));
 const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),store=new RuntimeStore(db,vault,new ModelBudget(f.policy)),gateway=new Gateway(store),ingress=new DingTalkIngress(db,vault,{tenantId:f.ctx.tenantId,corpId:f.profile.corpId,robotCode:f.profile.robotCode},store);let calls=0,sends=0;
 const provider:ModelProvider={describeRequest:(messages,tools,limits)=>glmRequestBody(messages,tools,'high',limits),complete:async()=>{calls++;if(outcome==='unknown')throw new ProviderError('SYNTHETIC_UNKNOWN',false,null,'UNKNOWN');return {message:{role:'assistant',content:JSON.stringify(calls===1?{schemaVersion:1,mode:'CONVERSATION',text:'Hello is a greeting.',claims:[],outcome:'COMPLETE'}:{schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]})},finishReason:'stop',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},requestId:null};}};
 try{
  const ready=await controller.ready,id=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:f.profile.corpId,senderCorpId:f.profile.corpId,senderStaffId:'owner',robotCode:f.profile.robotCode,conversationId:f.profile.conversationId,conversationType:'1',msgtype:'text',text:{content:'Explain hello.'},createAt:Date.now()+1,senderId:'owner-id',chatbotUserId:'robot-id',sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic-supervised',sessionWebhookExpiredTime:Date.now()+60000})};
  const accepted=await ingress.acceptTrustedCallback(event);expect(accepted?.taskId).toBeTruthy();const run=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[accepted!.taskId])).rows[0].id as string;await new AgentRuntime(store,provider,gateway).advance(f.ctx,run);
  if(outcome==='delivered'){
   const delivery=new DeliveryGateway(db,vault,{sendReply:async()=>{sends++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{throw Error('PROACTIVE_FORBIDDEN');}},{corpId:f.profile.corpId,robotCode:f.profile.robotCode,appOrigin:'http://localhost:64700'},Date.now,(...args)=>gateway.finalSourcesAllowed(...args));
   const pending=await delivery.pending(f.ctx);expect(pending).toHaveLength(1);expect(await delivery.process(f.ctx,pending[0]!,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
  }
  const result=await controller.finished;await controller.exit;expect(result).toMatchObject({reason:'TRIAL_CLOSED',databaseClosed:true,ownedGroupsClosed:true});expect(Date.parse(result.endedAt)).toBeLessThan(Date.parse(f.profile.deadline));expect(ready.ownedPids).toHaveLength(3);for(const pid of [...ready.ownedPids,ready.guardianPid])await vi.waitFor(()=>expect(pidAlive(pid)).toBe(false));
  expect((await admin.query('SELECT state,close_reason FROM one_shot_trials WHERE tenant_id=$1',[f.ctx.tenantId])).rows[0]).toEqual({state:'CLOSED',close_reason:outcome==='delivered'?'TRIAL_DELIVERED':outcome==='unknown'?'TRIAL_MODEL_UNKNOWN':'TRIAL_RUN_STOPPED'});expect(calls).toBe(outcome==='delivered'?2:outcome==='unknown'?1:0);expect(sends).toBe(outcome==='delivered'?1:0);
  const ledger=(await admin.query('SELECT dispatch_state,reservation FROM quota_ledger WHERE tenant_id=$1',[f.ctx.tenantId])).rows;if(outcome==='unknown'){expect(ledger).toHaveLength(1);expect(ledger[0].dispatch_state).toBe('UNKNOWN');expect(Number(ledger[0].reservation)).toBeGreaterThan(0);}else if(outcome==='budget')expect(ledger).toEqual([]);
 }finally{await controller.stop();await db.close();await f.close();}
},15000);
