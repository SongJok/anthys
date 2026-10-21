import '../support/isolation.js';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {Vault} from '../../packages/storage/src/crypto.js';
import {CompanyAgentWorker} from '../../packages/company/src/agent-worker.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {companyAgentWorld} from '../support/company-agent-world.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';

const key=randomBytes(32),vault=new Vault(new Map([['1',key]]),'1');
const schema={type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}};
const childProof=z.object({phase:z.enum(['READY','CALL_STARTED','RESPONSE_DURABLE','ERROR']),calls:z.number().int().min(0).max(1),requestId:z.uuid().optional()}).strict();
type Proof=z.infer<typeof childProof>;
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>;
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();},60000);
afterAll(async()=>{await isolated?.close();},60000);
async function bounded<T>(promise:Promise<T>,milliseconds=10000){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('SYNTHETIC_CHILD_STAGE_TIMEOUT')),milliseconds);})]);}finally{if(timer)clearTimeout(timer);}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function startChild(mode:'in-flight'|'stored-before-resume'){
 const child=fork(new URL('../support/company-agent-process-child.ts',import.meta.url),[mode],{execPath:process.execPath,execArgv:['--import','tsx'],env:process.env,stdio:['ignore','ignore','pipe','ipc']});
 const phases={READY:deferred<Proof>(),CALL_STARTED:deferred<Proof>(),RESPONSE_DURABLE:deferred<Proof>()};let fail!:(error:Error)=>void,stderrBytes=0;
 const failed=new Promise<never>((_resolve,reject)=>{fail=reject;});void failed.catch(()=>{});
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>{resolve({code,signal});fail(Error('SYNTHETIC_CHILD_EXITED'));}));
 child.once('error',()=>fail(Error('SYNTHETIC_CHILD_PROCESS_ERROR')));
 // Never include stderr/raw IPC/configuration/key/body in test failures/reports.
 child.stderr?.on('data',(bytes:Buffer)=>{stderrBytes+=bytes.length;if(stderrBytes>65536){fail(Error('SYNTHETIC_CHILD_STDERR_LIMIT'));child.kill('SIGKILL');}});
 child.on('message',raw=>{const parsed=childProof.safeParse(raw);if(!parsed.success||parsed.data.phase==='ERROR'){fail(Error('SYNTHETIC_CHILD_PROTOCOL_ERROR'));return;}phases[parsed.data.phase].resolve(parsed.data);});
 const wait=(phase:keyof typeof phases)=>bounded(Promise.race([phases[phase].promise,failed]));
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(exited);};
 return {child,exited,wait,stop};
}
async function fresh(){const w=await companyAgentWorld(isolated,vault);w.admission.inputSchemaHash=agentChatInputSchemaHash(schema);w.admission.waitBudgetMs=120000;w.admission.budgetExpiresAt=new Date(Date.now()+180000).toISOString();w.admission.maxDispatched=1;expect((await w.enqueue()).status).toBe('DEFERRED');return w;}
async function launch(w:Awaited<ReturnType<typeof fresh>>,mode:'in-flight'|'stored-before-resume'){
 const process=startChild(mode);try{expect(await process.wait('READY')).toEqual({phase:'READY',calls:0});
  // IPC only: never argv/env/logs. Original inherited DB env remains the guarded
  // 64711/anthys_test target; child derives its own nonce DB connection.
  await new Promise<void>((resolve,reject)=>process.child.send({ctx:w.ctx,admission:w.admission,databaseName:isolated.name,keyHex:key.toString('hex'),grantId:w.grantId},error=>error?reject(Error('SYNTHETIC_CHILD_IPC_SEND_FAILED')):resolve()));return process;
 }catch(error){await process.stop();throw error;}
}
async function resumedOutbox(w:Awaited<ReturnType<typeof fresh>>,id:string){return Number((await w.root.query('SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND dedup_key=$2',[w.ctx.tenantId,'company-agent-resume:'+id])).rows[0].n);}
async function assertNoRestartOpen(w:Awaited<ReturnType<typeof fresh>>){let opens=0;const restarted=new CompanyAgentWorker(w.ledger,async()=>{opens++;throw Error('SYNTHETIC_RESTART_OPEN_FORBIDDEN');});expect(await restarted.once(w.ctx,new AbortController().signal)).toBe(false);expect(opens).toBe(0);}

it('actual SIGKILL during SDK call waits beyond the unchanged lease, recovers UNKNOWN without refund, and never reopens upstream',async()=>{
 const w=await fresh(),request=await w.row(),process=await launch(w,'in-flight');
 try{
  expect(await process.wait('CALL_STARTED')).toEqual({phase:'CALL_STARTED',calls:1,requestId:request.id});const dispatched=await w.row();expect(dispatched).toMatchObject({state:'DISPATCHING',enterprise_cost:'UNKNOWN'});expect(dispatched.dispatch_started_at).toBeInstanceOf(Date);
  expect(process.child.kill('SIGKILL')).toBe(true);expect(await bounded(process.exited)).toEqual({code:null,signal:'SIGKILL'});
  const killedAt=performance.now(),readyAt=killedAt+31000;while(performance.now()<readyAt)await delay(Math.max(1,Math.ceil(readyAt-performance.now())));
  expect(performance.now()-killedAt).toBeGreaterThanOrEqual(31000);
  const expired=(await w.root.query('SELECT lease_until<=clock_timestamp() expired FROM company_agent_requests WHERE id=$1',[request.id])).rows[0];expect(expired.expired).toBe(true);
  expect(await w.ledger.recover(w.ctx,new AbortController().signal)).toBe(1);const recovered=await w.row();expect(recovered).toMatchObject({id:request.id,state:'UNKNOWN',reason_code:'WORKER_LEASE_LOST',enterprise_cost:'UNKNOWN',response_ref:null});expect(recovered.dispatch_started_at).toEqual(dispatched.dispatch_started_at);
  // NOT_REFUNDED is a test assertion, never a fabricated database state/amount:
  // the same budget still has one persisted dispatch, and cost remains UNKNOWN.
  const consumed=(await w.root.query('SELECT count(*)::int n FROM company_agent_requests WHERE tenant_id=$1 AND budget_hash=$2 AND dispatch_started_at IS NOT NULL',[w.ctx.tenantId,w.admission.budgetHash])).rows[0];expect(consumed.n).toBe(1);expect(await resumedOutbox(w,request.id)).toBe(0);
  await assertNoRestartOpen(w);expect(await w.ledger.recover(w.ctx,new AbortController().signal)).toBe(0);expect((await w.row()).state).toBe('UNKNOWN');
 }finally{await process.stop();}
},60000);

it('actual SIGKILL after reply COMMIT but before resume recovers the original action and one continuation without opening MCP again',async()=>{
 const w=await fresh(),request=await w.row(),before=(await w.root.query('SELECT retry_generation FROM runs WHERE id=$1',[w.runId])).rows[0],process=await launch(w,'stored-before-resume');
 try{
  expect(await process.wait('CALL_STARTED')).toEqual({phase:'CALL_STARTED',calls:1,requestId:request.id});expect(await process.wait('RESPONSE_DURABLE')).toEqual({phase:'RESPONSE_DURABLE',calls:1,requestId:request.id});
  const durable=await w.row();expect(durable).toMatchObject({id:request.id,state:'RESPONSE_RECEIVED',resumed_at:null,enterprise_cost:'UNKNOWN'});expect(durable.response_ref).not.toBeNull();expect((await w.root.query('SELECT status FROM runs WHERE id=$1',[w.runId])).rows[0].status).toBe('WAITING_EXTERNAL');expect(await resumedOutbox(w,request.id)).toBe(0);
  expect(process.child.kill('SIGKILL')).toBe(true);expect(await bounded(process.exited)).toEqual({code:null,signal:'SIGKILL'});
  expect(await w.ledger.recover(w.ctx,new AbortController().signal)).toBe(1);const recovered=await w.row(),run=(await w.root.query('SELECT status,retry_generation FROM runs WHERE id=$1',[w.runId])).rows[0];expect(recovered).toMatchObject({id:request.id,state:'RESPONSE_RECEIVED'});expect(recovered.resumed_at).toBeInstanceOf(Date);expect(run.status).toBe('QUEUED');expect(Number(run.retry_generation)).toBe(Number(before.retry_generation)+1);
  const action=(await w.root.query('SELECT * FROM tool_actions WHERE id=$1',[durable.action_id])).rows[0];expect(action.id).toBe(request.action_id);expect(action.execution_attempt_id).toBe(request.execution_attempt_id);expect(action.state).toBe('VERIFIED');expect(w.store.openToolResult(w.ctx,action.logical_action_key,action.result)).toMatchObject({status:'OK',completeness:'UNKNOWN',verification:{state:'UNVERIFIED'},data:{requestId:request.id,text:'SYNTHETIC process response; original durable request only.'}});
  expect(await resumedOutbox(w,request.id)).toBe(1);expect(await w.ledger.recover(w.ctx,new AbortController().signal)).toBe(0);await assertNoRestartOpen(w);expect(await resumedOutbox(w,request.id)).toBe(1);expect(Number((await w.root.query('SELECT retry_generation FROM runs WHERE id=$1',[w.runId])).rows[0].retry_generation)).toBe(Number(before.retry_generation)+1);
 }finally{await process.stop();}
},60000);
