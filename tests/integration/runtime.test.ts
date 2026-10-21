import {syntheticResultContract} from '../support/capability-result-contract.js';
import {finalFromMessages} from '../support/final-answer.js';
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
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import type {ModelProvider} from '../../packages/provider-glm/src/client.js';
import type {ProviderMessage,CompleteTurn} from '../../packages/provider-glm/src/sse.js';
import {seed,ids} from '../../scripts/seed.js';
loadEnvFile();const db=new Database(secret('RUNTIME_DATABASE_URL')??secret('RUNTIME_DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const ctx={tenantId:ids.tenantA,actorId:ids.bob},appDb=new Database(secret('DATABASE_URL')!),tasks=new TaskStore(appDb),vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),store=new RuntimeStore(db,vault);
const turn=(message:ProviderMessage):CompleteTurn=>({message,usage:null,requestId:'synthetic',finishReason:message.tool_calls?.length?'tool_calls':'stop'});
const calls=(...ids:string[]):ProviderMessage=>({role:'assistant',content:null,reasoning_content:'opaque exact original 协议',tool_calls:ids.map((id,index)=>({id:`call-${index}-${randomUUID()}`,type:'function',function:{name:toolName(id,'1.0.0'),arguments:'{}'}}))});
const fresh=()=>tasks.create(ctx,'synthetic agent goal',randomUUID());
const cap=(id:string,effect:()=>Promise<import('../../packages/contracts/src/index.js').ToolResult>)=>({...syntheticResultContract,id,version:'1.0.0',description:'synthetic test capability',risk:'READ' as const,provider:'CORE' as const,state:'READY' as const,bindingHash:'synthetic',schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},resource:(_args:unknown,lease:import('../../packages/runtime/src/store.js').Lease)=>lease.taskId,execute:effect});
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();await appDb.close();await admin.end();});
it('T012 native multi-tool messages close every call ID including failed result',async()=>{
 const job=await fresh(),gateway=new Gateway(store);gateway.register(cap('synthetic.one',async()=>({status:'OK',data:1,evidenceIds:[],completeness:'COMPLETE'})));gateway.register(cap('synthetic.two',async()=>({status:'DENIED',evidenceIds:[],completeness:'UNKNOWN'})));
 const first=calls('synthetic.one','synthetic.two'),seen:ProviderMessage[][]=[];
 const model:ModelProvider={complete:async messages=>{seen.push(structuredClone(messages));return seen.length===1?turn(first):turn({role:'assistant',content:finalFromMessages(messages)});}};
 await new AgentRuntime(store,model,gateway).advance(ctx,job.runId);
 expect(seen).toHaveLength(2);const tools=seen[1]!.filter(m=>m.role==='tool');expect(tools.map(m=>m.tool_call_id)).toEqual(first.tool_calls!.map(c=>c.id));expect(tools.map(m=>JSON.parse(m.content!)['status'])).toEqual(['OK','DENIED']);expect((await tasks.get(ctx,job.taskId))?.runs[0]).toMatchObject({status:'PARTIAL',last_error:'FINAL_PARTIAL_EVIDENCE'});
});
it('T013 encrypted provider journal restores reasoning exactly and excludes app role',async()=>{
 const job=await fresh(),lease=(await store.acquire(ctx,job.runId,'original'))!,message=calls('synthetic.one');await store.append(ctx,lease,message);
 const newStore=new RuntimeStore(db,vault);expect(await newStore.history(ctx,lease)).toEqual([message]);
 const raw=await db.scope(ctx,c=>c.query('SELECT ciphertext_ref FROM provider_journals WHERE run_id=$1',[job.runId]));expect(JSON.stringify(raw.rows)).not.toContain('opaque exact');
 await expect(appDb.scope(ctx,c=>c.query('SELECT * FROM provider_journals'))).rejects.toMatchObject({code:'42501'});await store.release(ctx,lease);
});
it('T016 successful tool result survives later model disconnect without repeating effects',async()=>{
 const job=await fresh(),gateway=new Gateway(store);let effects=0,modelCalls=0;
 gateway.register(cap('synthetic.effect',async()=>{effects++;return {status:'OK',data:'persisted',evidenceIds:[],completeness:'COMPLETE'};}));
 const model:ModelProvider={complete:async messages=>{modelCalls++;if(modelCalls===1)return turn(calls('synthetic.effect'));if(modelCalls===2)throw Error('stream disconnected');return turn({role:'assistant',content:finalFromMessages(messages)});}};
 const runtime=new AgentRuntime(store,model,gateway);await runtime.advance(ctx,job.runId);expect(effects).toBe(1);expect((await tasks.get(ctx,job.taskId))?.runs[0].status).toBe('RETRY_SCHEDULED');
 await admin.query("UPDATE runs SET retry_due_at=now()+interval '1 hour' WHERE id=$1",[job.runId]);await new AgentRuntime(store,model,gateway).advance(ctx,job.runId);expect(modelCalls).toBe(2);await new RetryDispatcher(db).dispatch(ctx);expect((await tasks.get(ctx,job.taskId))?.runs[0].status).toBe('RETRY_SCHEDULED');await admin.query("UPDATE runs SET retry_due_at=now()-interval '1 second' WHERE id=$1",[job.runId]);await new RetryDispatcher(db).dispatch(ctx);expect((await tasks.get(ctx,job.taskId))?.runs[0].status).toBe('QUEUED');await new AgentRuntime(store,model,gateway).advance(ctx,job.runId,undefined,undefined,0);expect(modelCalls).toBe(2);
 await new AgentRuntime(store,model,gateway).advance(ctx,job.runId,undefined,undefined,1);expect(effects).toBe(1);expect((await tasks.get(ctx,job.taskId))?.status).toBe('COMPLETED');
});
it('T017 expired opaque journal is dropped rather than fabricated preserved reasoning',async()=>{
 const job=await fresh(),lease=(await store.acquire(ctx,job.runId,'ttl'))!;await store.append(ctx,lease,calls('synthetic.one'));
 await admin.query("UPDATE provider_journals SET expires_at=now()-interval '1 second' WHERE run_id=$1",[job.runId]);await expect(store.history(ctx,lease)).rejects.toThrow('JOURNAL_EXPIRED');const rebuilt=await new Gateway(store).rebuildContext(ctx,lease,'JOURNAL_EXPIRED');expect(rebuilt.messages).toHaveLength(2);expect(JSON.stringify(rebuilt.messages)).not.toContain('opaque exact original');expect(rebuilt.messages.every(m=>m.reasoning_content===undefined)).toBe(true);expect((await db.scope(ctx,c=>c.query('SELECT id FROM provider_journals WHERE run_id=$1 AND session_no=1',[job.runId]))).rowCount).toBe(0);expect(await store.history(ctx,lease)).toEqual(rebuilt.messages);await store.release(ctx,lease);
});
it('T018 three identical tool requests without new information stop progress',async()=>{
 const job=await fresh(),gateway=new Gateway(store);let effects=0;
 gateway.register(cap('synthetic.empty',async()=>{effects++;return {status:'EMPTY',evidenceIds:[],completeness:'COMPLETE'};}));
 await new AgentRuntime(store,{complete:async()=>turn(calls('synthetic.empty'))},gateway).advance(ctx,job.runId);
 expect((await tasks.get(ctx,job.taskId))?.runs[0]).toMatchObject({status:'PARTIAL',last_error:'NO_PROGRESS_GUARD'});expect(effects).toBe(1);
});
it('T022 persistent cancellation blocks the next tool even when a model turn is in flight',async()=>{
 const job=await fresh(),gateway=new Gateway(store);let effects=0;gateway.register(cap('synthetic.cancel',async()=>{effects++;return {status:'OK',evidenceIds:[],completeness:'COMPLETE'};}));
 const model:ModelProvider={complete:async()=>{await tasks.cancel(ctx,job.taskId);return turn(calls('synthetic.cancel'));}};
 await new AgentRuntime(store,model,gateway).advance(ctx,job.runId);expect(effects).toBe(0);expect((await tasks.get(ctx,job.taskId))?.runs[0].status).toBe('CANCELLED');
});
it('T059 a reclaimed lease fences out the old worker from commits and new tools',async()=>{
 const job=await fresh(),old=(await store.acquire(ctx,job.runId,'old'))!;await admin.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.runId]);
 const current=(await store.acquire(ctx,job.runId,'new'))!;expect(current.fence).toBeGreaterThan(old.fence);await expect(store.append(ctx,old,{role:'assistant',content:'stale'})).rejects.toThrow('LEASE_OR_AUTH_LOST');let effects=0;const gateway=new Gateway(store);gateway.register(cap('synthetic.fence',async()=>{effects++;return {status:'OK',evidenceIds:[],completeness:'COMPLETE'};}));await expect(gateway.execute(ctx,old,toolName('synthetic.fence','1.0.0'),{},new AbortController().signal)).rejects.toThrow('LEASE_OR_AUTH_LOST');expect(effects).toBe(0);await store.release(ctx,current);
});
it('T117 unknown approved write is never automatically repeated',async()=>{
 const job=await fresh(),gateway=new Gateway(store);let lease=(await store.acquire(ctx,job.runId,'unknown-write'))!;let effects=0;
 gateway.register({...cap('synthetic.write',async()=>{effects++;throw Error('side effect applied, response lost');}),risk:'SHARED_WRITE',approvalPreview:()=>({synthetic:true}),operationAudience:(_args,lease)=>lease.audience});
 const name=toolName('synthetic.write','1.0.0');expect((await gateway.execute(ctx,lease,name,{},new AbortController().signal)).status).toBe('NEEDS_APPROVAL');expect(effects).toBe(0);
 const action=await db.scope(ctx,c=>c.query('SELECT id,args_hash FROM tool_actions WHERE run_id=$1',[job.runId]));
 lease=await approveViaApi(admin,appDb,store,ctx,action.rows[0].id as string);
 expect((await gateway.execute(ctx,lease,name,{},new AbortController().signal)).status).toBe('UNKNOWN');expect(effects).toBe(1);
 expect((await gateway.execute(ctx,lease,name,{},new AbortController().signal)).status).toBe('UNKNOWN');expect(effects).toBe(1);expect((await db.scope(ctx,c=>c.query('SELECT state FROM tool_actions WHERE run_id=$1',[job.runId]))).rows[0].state).toBe('UNKNOWN');await store.release(ctx,lease);
});
