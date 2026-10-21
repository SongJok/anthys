import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,type Sealed} from '../../packages/storage/src/crypto.js';
import {PrivatePreferences} from '../../packages/memory/src/service.js';
import {RuntimePreferences} from '../../packages/memory/src/runtime.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {LeaseLost} from '../../packages/runtime/src/store.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {personaFixture} from '../support/personas.js';
import {personaNative} from '../support/persona-native.js';
import {memoryDialogueModel} from '../support/memory-dialogue-model.js';
import {captureSyntheticContent,restoreSyntheticContent,type ContentFragment} from '../support/content-restore.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,12),appDb=new Database(secret('DATABASE_URL')!);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const fixtures:Awaited<ReturnType<typeof personaFixture>>[]=[];
afterAll(async()=>{for(const f of fixtures)await f.close();await db.close();await appDb.close();await root.end();});

async function dialogue(kind:'MEMORY'|'USER_PERSONA') {
 const f=await personaFixture(root,db,appDb,vault);fixtures.push(f);
 const ctx=f.people.alice,memory=new PrivatePreferences(db,vault);
 const n=personaNative(f,db,vault,new RuntimePreferences(memory,{schemaVersion:1,id:'synthetic-dialogue-erasure',environment:'SYNTHETIC_TEST',approved:true,approvalReference:'synthetic-data-flow-only',validUntil:'2099-01-01T00:00:00Z',allowedClassifications:['CONFIDENTIAL'],maxItems:10,maxBytes:12000}));
 const canary='synthetic_dialogue_canary_'+randomUUID().replaceAll('-','');
 let memoryId:string|undefined;
 if(kind==='MEMORY')memoryId=(await memory.save(ctx,{kind:'PREFERENCE',title:'澄清删除数据流',content:canary,sensitivity:'CONFIDENTIAL',allowModel:true},randomUUID(),f.sessions.alice.source)).memoryId;
 else await f.patch('alice',f.scope('alice'),{address:canary});
 const accepted=(await n.ingress.acceptTrustedCallback(n.event('请按我的表达偏好拟一段邀请，先确认缺失信息')))!;
 const runId=(await root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id as string;
 const model=memoryDialogueModel(),runtime=new AgentRuntime(n.store,model.provider,n.gateway);
 await runtime.advance(ctx,runId);
 const waiting=(await root.query('SELECT status,last_error,clarification_review_id FROM runs WHERE id=$1',[runId])).rows[0];
 expect(waiting).toMatchObject({status:'WAITING_USER',last_error:'CLARIFICATION_REQUESTED'});
 expect(model.requests).toHaveLength(2);
 const reply=(await n.ingress.acceptTrustedCallback(n.event('补充 '+waiting.clarification_review_id.replaceAll('-','').slice(0,8)+'：'+canary+'的内部技术交流')))!;
 expect(reply.taskId).toBe(accepted.taskId);
 const saved=(await root.query('SELECT * FROM run_user_messages WHERE run_id=$1',[runId])).rows[0];
 expect(saved.content_state).toBe('SEALED');expect(saved.source_event_id).toBeTruthy();
 expect(vault.open(saved.message_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:reply:${saved.id}`)).toContain(canary);
 const lease=(await n.store.acquire(ctx,runId,'synthetic-dialogue-checkpoint',1))!;
 expect(lease).not.toBeNull();expect(await n.gateway.preparePersonas(ctx,lease,new AbortController().signal)).toBe(true);
 const rebuilt=await n.gateway.rebuildContext(ctx,lease,'CONTEXT_LIMIT',await n.store.history(ctx,lease));
 expect(rebuilt.blocked).toBe(false);expect(JSON.stringify(rebuilt.messages)).toContain('SAVED_AUTHENTICATED_CLARIFICATION_DATA');expect(JSON.stringify(rebuilt.messages)).toContain(canary);
 // The active implementation keeps context in checkpoint/journal tables.
 // A NULL parent field is explicitly not counted as canary erasure evidence.
 expect((await root.query('SELECT context_ref FROM runs WHERE id=$1',[runId])).rows[0].context_ref).toBeNull();
 const erase=()=>memoryId?memory.forget(ctx,memoryId,randomUUID(),f.sessions.alice.source):f.service.erasePrivate(ctx,randomUUID(),f.sessions.alice.source);
 const repair=()=>memoryId?memory.maintain(ctx):f.service.repairPrivateErasure(ctx);
 return {f,n,ctx,canary,taskId:accepted.taskId,runId,lease,model,runtime,replyEventId:saved.source_event_id as string,erase,repair};
}

it.each(['MEMORY','USER_PERSONA'] as const)('%s erasure rejects individually restored real clarification/review/checkpoint/native-reply records before reuse or delivery',async kind=>{
 const s=await dialogue(kind);
 await s.n.store.release(s.ctx,s.lease);
 await s.runtime.advance(s.ctx,s.runId,undefined,undefined,1);
 const result=(await root.query('SELECT result,status FROM runs WHERE id=$1',[s.runId])).rows[0];
 expect(result.status).toBe('SUCCEEDED');expect(result.result).toContain(s.canary);expect(s.model.requests).toHaveLength(4);
 const fragment:ContentFragment=[];
 for(const table of ['run_user_messages','run_narrative_reviews','context_checkpoints','deliveries'] as const) {
  const part=await captureSyntheticContent(root,table,s.ctx.tenantId);expect(part.rows.length,table).toBeGreaterThan(0);fragment.push(part);
 }
 fragment.push(await captureSyntheticContent(root,'event_inbox',s.ctx.tenantId,[s.replyEventId]));
 expect(fragment.find(p=>p.table==='run_narrative_reviews')!.rows).toHaveLength(2);
 for(const row of fragment.find(p=>p.table==='run_narrative_reviews')!.rows) {
  const proof=JSON.parse(vault.open(row.review_ref as Sealed,`${s.ctx.tenantId}:${s.ctx.actorId}:narrative:${row.id}`));
  expect(proof.requestId).toBe(row.request_id);expect(proof.dialogueHash).toBe(row.dialogue_hash);
  // This proof stores hashes and decisions, not the proposal/question text.
  expect(JSON.stringify(proof)).not.toContain(s.canary);
 }
 const calls=s.model.requests.length;
 try {
  await s.erase();
  for(const part of fragment)for(const row of part.rows) {
   await restoreSyntheticContent(root,[{table:part.table,rows:[row]}]);
   expect(await s.n.store.acquire(s.ctx,s.runId,'erased-dialogue-must-not-resume')).toBeNull();
   expect(await s.n.gateway.finalResultAllowed(s.ctx,s.runId,result.result as string)).toBe(false);
   await s.runtime.advance(s.ctx,s.runId);
   if(part.table==='deliveries') {
    let sends=0;
    const delivery=new DeliveryGateway(db,vault,{sendReply:async()=>{sends++;return {state:'APPLIED_UNVERIFIED'};},sendProactive:async()=>{sends++;return {state:'APPLIED_UNVERIFIED'};}},s.n.binding,Date.now,(...a)=>s.n.gateway.finalSourcesAllowed(...a));
    expect(await delivery.process(s.ctx,row.id as string,new AbortController().signal)).toBe(row.state==='PENDING'?'SUPPRESSED':'NOT_CLAIMED');expect(sends).toBe(0);
   }
   await s.repair();
   const after=(await root.query(`SELECT * FROM ${part.table} WHERE tenant_id=$1 AND id=$2`,[s.ctx.tenantId,row.id])).rows[0];
   if(part.table==='context_checkpoints')expect(after).toBeUndefined();
   else if(part.table==='run_user_messages')expect(after).toMatchObject({message_ref:null,content_state:'LEGACY_UNAVAILABLE'});
   else if(part.table==='run_narrative_reviews')expect(after.review_ref).toEqual({});
   else if(part.table==='event_inbox')expect(after.payload_cipher_ref).toBe('{}');
   else if(part.table==='deliveries')expect(after.content_ref).toBe('{}');
  }
  expect(s.model.requests).toHaveLength(calls);
  expect((await root.query('SELECT id FROM tool_actions WHERE run_id=$1',[s.runId])).rowCount).toBe(0);
 } finally {await s.repair();}
});

it.each(['MEMORY','USER_PERSONA'] as const)('%s retained erasure veto blocks a precisely restored live parent and synthetic legacy context body even with old task metadata',async kind=>{
 const s=await dialogue(kind);
 const tasks=await captureSyntheticContent(root,'tasks',s.ctx.tenantId,[s.taskId]);
 const runs=await captureSyntheticContent(root,'runs',s.ctx.tenantId,[s.runId]);
 const journal=(await root.query('SELECT seq,ciphertext_ref FROM provider_journals WHERE run_id=$1 ORDER BY seq LIMIT 1',[s.runId])).rows[0];
 expect(vault.open(JSON.parse(journal.ciphertext_ref as string) as Sealed,`${s.ctx.tenantId}:${s.ctx.actorId}:${s.runId}:${journal.seq}`)).toContain(s.canary);
 expect(await s.n.store.guarded(s.ctx,s.lease,async()=>true)).toBe(true);
 // No current writer produces context_ref. A trusted synthetic restoration
 // fault copies an actual private journal body into this legacy storage field.
 const restored={...runs.rows[0]!,context_ref:journal.ciphertext_ref};
 const calls=s.model.requests.length;
 try {
  await s.erase();await restoreSyntheticContent(root,[tasks,{table:'runs',rows:[restored]}]);
  expect((await root.query('SELECT status,lease_until>clock_timestamp() live,context_ref FROM runs WHERE id=$1',[s.runId])).rows[0]).toMatchObject({status:'RUNNING',live:true,context_ref:journal.ciphertext_ref});
  expect((await root.query('SELECT status,cancel_requested_at FROM tasks WHERE id=$1',[s.taskId])).rows[0]).toEqual({status:'ACTIVE',cancel_requested_at:null});
  let bodyReads=0;
  await expect(s.n.store.guarded(s.ctx,s.lease,c=>{bodyReads++;return c.query('SELECT context_ref FROM runs WHERE id=$1',[s.runId]);})).rejects.toBeInstanceOf(LeaseLost);
  expect(bodyReads).toBe(0);
  await expect(s.n.store.history(s.ctx,s.lease)).rejects.toBeInstanceOf(LeaseLost);
  expect(await s.n.store.acquire(s.ctx,s.runId,'legacy-content-must-not-resume')).toBeNull();
  await s.repair();
  expect((await root.query('SELECT status,context_ref,result,lease_owner,lease_until FROM runs WHERE id=$1',[s.runId])).rows[0]).toEqual({status:'CANCELLED',context_ref:null,result:null,lease_owner:null,lease_until:null});
  expect((await root.query('SELECT status,cancel_requested_at IS NOT NULL cancelled FROM tasks WHERE id=$1',[s.taskId])).rows[0]).toEqual({status:'CANCELLED',cancelled:true});
  expect(s.model.requests).toHaveLength(calls);
 } finally {await s.repair();await s.n.store.release(s.ctx,s.lease);}
});
