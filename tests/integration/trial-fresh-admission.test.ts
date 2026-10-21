import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {trialState} from '../../packages/storage/src/trial.js';

const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),connections:Database[]=[];
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
afterAll(async()=>{await Promise.all(connections.map(db=>db.close()));await admin.end();});
async function world(armed=true,ttlMs=600000){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corp='SYNTHETIC-FRESH-'+ctx.tenantId,robot='synthetic-fresh-robot',conversation='synthetic-fresh-dm',attestation=hash(randomUUID());
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC FRESH TRIAL','ACTIVE')",[ctx.tenantId,corp]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const db=new Database(secret('RUNTIME_DATABASE_URL')!);connections.push(db);db.trialProfileHash=armed?attestation:null;
 if(armed)await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,clock_timestamp()+$8*interval '1 millisecond')",[ctx.tenantId,ctx.actorId,attestation,hash('synthetic-budget'),corp,robot,conversation,ttlMs]);
 const cutoff=armed?Number((await admin.query('SELECT ceil(extract(epoch FROM created_at)*1000)::text ms FROM one_shot_trials WHERE tenant_id=$1',[ctx.tenantId])).rows[0].ms):Date.now();
 const ingress=new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,corpId:corp,robotCode:robot});
 const event=(patch:Record<string,unknown>={},id=randomUUID()):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corp,senderCorpId:corp,senderStaffId:'owner',conversationId:conversation,conversationType:'1',robotCode:robot,msgtype:'text',text:{content:'Explain hello.'},createAt:Math.max(Date.now(),cutoff),senderId:'synthetic-owner',chatbotUserId:'synthetic-bot',...patch})});
 const state=async()=>(await admin.query('SELECT state,msg_id,task_id,run_id,close_reason FROM one_shot_trials WHERE tenant_id=$1',[ctx.tenantId])).rows[0];
 const counts=async()=>(await admin.query('SELECT (SELECT count(*) FROM tasks WHERE tenant_id=$1)::int tasks,(SELECT count(*) FROM runs WHERE tenant_id=$1)::int runs,(SELECT count(*) FROM event_inbox WHERE tenant_id=$1)::int inbox,(SELECT count(*) FROM outbox WHERE tenant_id=$1)::int outbox',[ctx.tenantId])).rows[0];
 return {ctx,corp,robot,conversation,attestation,db,ingress,event,state,counts,cutoff};
}
it('unseen pre-arming ordinary DM replay cannot bind ARMED or create business records',async()=>{
 const w=await world(),before=await w.state();
 expect(await w.ingress.acceptTrustedCallback(w.event({createAt:w.cutoff-1}))).toBeNull();
 expect(await w.state()).toEqual(before);expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER])('trial timestamp %s is rejected without consuming the slot',async createAt=>{
 const w=await world();expect(await w.ingress.acceptTrustedCallback(w.event({createAt}))).toBeNull();expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});
});
it.each([null,undefined])('missing/non-number trial timestamp %s has no admission side effects',async createAt=>{
 const w=await world();await expect(w.ingress.acceptTrustedCallback(w.event({createAt}))).rejects.toThrow();expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});
});
it('runtime cannot bypass the timestamp authority via the old eight-parameter SQL grant',async()=>{
 const w=await world();expect((await w.db.scope(w.ctx,c=>c.query("SELECT has_function_privilege(current_user,'public.oa_trial_admit(text,text,text,text,text,boolean,uuid,uuid)','EXECUTE') allowed"))).rows[0].allowed).toBe(false);
 await expect(w.db.scope(w.ctx,c=>c.query('SELECT public.oa_trial_admit($1,$2,$3,$4,$5,true,$6,$7)',[w.corp,'owner',w.robot,w.conversation,randomUUID(),randomUUID(),randomUUID()]))).rejects.toMatchObject({code:'42501'});
 expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});
});
it('all internal admission, legacy evaluator and close helpers deny every application role',async()=>{
 const helpers=['public.oa_trial_admit(text,text,text,text,text,boolean,uuid,uuid)','public.oa_trial_admit_fresh(text,text,text,text,text,boolean,uuid,uuid,bigint)','public.oa_trial_check_schema68(uuid,boolean,text)','public.oa_trial_close(uuid,text)','public.oa_trial_admission_binding_valid(uuid)','public.oa_trial_admission_binding_guard()'];
 for(const role of ['oa_runtime','oa_app','oa_queue'])for(const signature of helpers)expect((await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed,role+':'+signature).toBe(false);
});
it('direct public SQL admission cannot omit or backdate the provider creation time',async()=>{
 const w=await world();
 for(const stamp of [null,0,w.cutoff-1,Date.now()+60000]){
  const result=await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,true,$6,$7,$8,$9,false,false) state',[w.corp,'owner',w.robot,w.conversation,randomUUID(),randomUUID(),randomUUID(),stamp,'DM'])).rows[0].state);
  expect(result).toMatchObject({restricted:true,allowed:false});expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});
 }
 expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});
});
it('fresh callback records exact provider time and immutable cutoff alongside the sole task/run',async()=>{
 const w=await world(),e=w.event(),first=await w.ingress.acceptTrustedCallback(e);expect(first?.duplicate).toBe(false);
 const slot=await w.state(),proof=(await admin.query('SELECT * FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0];
 expect(proof).toMatchObject({owner_id:w.ctx.actorId,profile_hash:w.attestation,msg_id:e.headers.messageId,task_id:first!.taskId,run_id:slot.run_id,event_created_ms:String(JSON.parse(e.data).createAt),admission_cutoff_ms:String(w.cutoff)});expect(BigInt(proof.admitted_txid)).toBeGreaterThan(0n);
 expect(await w.ingress.acceptTrustedCallback(e)).toEqual({taskId:first!.taskId,duplicate:true});
 expect((await admin.query('SELECT count(*)::int n FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(1);
 await expect(admin.query('UPDATE one_shot_trial_admissions SET event_created_ms=event_created_ms+1 WHERE tenant_id=$1',[w.ctx.tenantId])).rejects.toThrow('TRIAL_ADMISSION_IMMUTABLE');
 await expect(admin.query('DELETE FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rejects.toThrow('TRIAL_ADMISSION_IMMUTABLE');
 await expect(w.db.scope(w.ctx,c=>c.query('UPDATE one_shot_trial_admissions SET msg_id=$1',[randomUUID()]))).rejects.toMatchObject({code:'42501'});
 const outsider={...w.ctx,actorId:randomUUID()};expect((await w.db.scope(outsider,c=>c.query('SELECT * FROM one_shot_trial_admissions'))).rowCount).toBe(0);
});
it('deferred proof constraint rejects mismatched task/run/inbox at COMMIT, preserving the old rows',async()=>{
 const w=await world(false),a=(await w.ingress.acceptTrustedCallback(w.event()))!,b=(await w.ingress.acceptTrustedCallback(w.event()))!,runB=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[b.taskId])).rows[0].id;
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,clock_timestamp()+interval '10 minutes')",[w.ctx.tenantId,w.ctx.actorId,w.attestation,hash('synthetic-budget'),w.corp,w.robot,w.conversation]);
 const c=await admin.connect();try{
  await c.query('BEGIN');await c.query("UPDATE one_shot_trials SET state='BOUND',msg_id=$2,task_id=$3,run_id=$4,bound_at=clock_timestamp() WHERE tenant_id=$1",[w.ctx.tenantId,randomUUID(),a.taskId,runB]);
  await c.query("INSERT INTO one_shot_trial_admissions(tenant_id,owner_id,profile_hash,msg_id,task_id,run_id,event_created_ms,admission_cutoff_ms) SELECT tenant_id,owner_id,profile_hash,msg_id,task_id,run_id,ceil(extract(epoch FROM created_at)*1000)::bigint,ceil(extract(epoch FROM created_at)*1000)::bigint FROM one_shot_trials WHERE tenant_id=$1",[w.ctx.tenantId]);
  await expect(c.query('COMMIT')).rejects.toThrow('TRIAL_ADMISSION_BINDING_MISMATCH');
 }finally{await c.query('ROLLBACK');c.release();}
 expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});expect((await w.counts()).tasks).toBe(2);expect((await admin.query('SELECT count(*)::int n FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
});
it('reserved setup marker remains inert and default mode remains unrestricted by trial freshness',async()=>{
 const w=await world();expect(await w.ingress.acceptTrustedCallback(w.event({text:{content:'OA_BIND_DM_V1 '+'a'.repeat(32)}}))).toBeNull();expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});
 const normal=await world(false);expect((await normal.ingress.acceptTrustedCallback(normal.event({createAt:1})))?.taskId).toBeTruthy();expect((await normal.ingress.acceptTrustedCallback(normal.event()))?.taskId).toBeTruthy();expect((await normal.counts()).tasks).toBe(2);
});
it('waiting on authority past the immutable deadline cannot write a proof or bind a task',async()=>{
 const w=await world(true,160),lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT tenant_id FROM one_shot_trials WHERE tenant_id=$1 FOR UPDATE',[w.ctx.tenantId]);
 try{const pending=w.ingress.acceptTrustedCallback(w.event());await lock.query('SELECT pg_sleep(0.2)');await lock.query('COMMIT');expect(await pending).toBeNull();}finally{await lock.query('ROLLBACK');lock.release();}
 expect(await w.state()).toMatchObject({state:'CLOSED',close_reason:'TRIAL_DEADLINE'});expect(await w.counts()).toEqual({tasks:0,runs:0,inbox:0,outbox:0});expect((await admin.query('SELECT count(*)::int n FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
});
it('legacy BOUND without provider-time proof is denied instead of fabricating admission evidence',async()=>{
 const w=await world(false),event=w.event(),accepted=(await w.ingress.acceptTrustedCallback(event))!,run=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id;
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,msg_id,task_id,run_id,bound_at) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,clock_timestamp()+interval '10 minutes','BOUND',$8,$9,$10,clock_timestamp())",[w.ctx.tenantId,w.ctx.actorId,w.attestation,hash('synthetic-budget'),w.corp,w.robot,w.conversation,event.headers.messageId,accepted.taskId,run]);
 w.db.trialProfileHash=w.attestation;expect(await new RuntimeStore(w.db,vault).acquire(w.ctx,run,'synthetic-no-proof')).toBeNull();expect(await w.state()).toMatchObject({state:'CLOSED',close_reason:'TRIAL_EVENT_PROOF_REQUIRED'});expect((await w.db.scope(w.ctx,c=>trialState(c,run))).allowed).toBe(false);
});
it('public SQL cannot wrap an existing task/run in fresh-message proof and resume old work',async()=>{
 const w=await world(false),old=(await w.ingress.acceptTrustedCallback(w.event()))!,run=(await admin.query('SELECT id FROM runs WHERE task_id=$1',[old.taskId])).rows[0].id;
 const original=(await admin.query('SELECT to_jsonb(r) row FROM runs r WHERE id=$1',[run])).rows;
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,clock_timestamp()+interval '10 minutes')",[w.ctx.tenantId,w.ctx.actorId,w.attestation,hash('synthetic-budget'),w.corp,w.robot,w.conversation]);w.db.trialProfileHash=w.attestation;
 const admitted=await w.db.scope(w.ctx,async c=>(await c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,true,$6,$7,$8,\'DM\',false,false) state',[w.corp,'owner',w.robot,w.conversation,randomUUID(),old.taskId,run,Date.now()+1])).rows[0].state);
 const observation={admitted:admitted.allowed,runExecutable:(await w.db.scope(w.ctx,c=>trialState(c,run))).allowed,slotState:(await w.state()).state};
 expect(observation).toEqual({admitted:false,runExecutable:false,slotState:'ARMED'});expect((await admin.query('SELECT to_jsonb(r) row FROM runs r WHERE id=$1',[run])).rows).toEqual(original);
 expect((await admin.query('SELECT count(*)::int n FROM one_shot_trial_admissions WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
});
it.each([
 ['group','GROUP',false,false],['attachment','DM',true,false],['control','DM',false,true],
 ['missing channel',null,false,false],['missing attachments','DM',null,false],['missing controls','DM',false,null]
] as const)('SQL authority rejects contradictory %s even when eligible=true',async(_label,channel,attachments,controls)=>{
 const w=await world();let observed:unknown;
 // Observe the real function result, then deliberately roll back so its deferred
 // task/run FKs do not hide an improper allowed=true result from the old code.
 await expect(w.db.scope(w.ctx,async c=>{
  observed=(await c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11) state',[w.corp,'owner',w.robot,w.conversation,randomUUID(),randomUUID(),randomUUID(),Math.max(Date.now(),w.cutoff),channel,attachments,controls])).rows[0].state;
  throw Error('SYNTHETIC_ROLLBACK_SQL_ADMISSION_PROBE');
 })).rejects.toThrow('SYNTHETIC_ROLLBACK_SQL_ADMISSION_PROBE');
 expect(observed).toMatchObject({restricted:true,allowed:false});expect(await w.state()).toMatchObject({state:'ARMED',task_id:null});
});
