import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {insertTask} from '../../packages/tasks/src/store.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupCaseWorld} from '../support/group-cases.js';
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),question='SYNTHETIC approved one group calculation';
let d:Awaited<ReturnType<typeof groupReminderDatabase>>;
const worlds:Awaited<ReturnType<typeof groupCaseWorld>>[]=[];
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();},60000);
afterAll(async()=>{for(const w of worlds)await w.f.close();await d?.close();},60000);
async function world(){
 d.db.formalProfileHash=null;
 const w=await groupCaseWorld(d.root,d.db,d.appDb,vault);worlds.push(w);await w.approve();await w.save();
 const trialHash=hash('SYNTHETIC CLOSED SOURCE '+randomUUID()),policy=modelBudgetPolicySchema.parse(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8'))),resource='enterprise-agent:'+randomUUID(),binding=hash('SYNTHETIC EXACT ENTERPRISE BINDING');
 await d.root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.agent.ask','1.0.0','{}',$3,'READ','READY')",[w.f.ctx.tenantId,randomUUID(),binding]);
 for(const kind of ['PRIVATE_USER','GROUP'])await d.root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,membership_version,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.agent.ask',$4,$5,$6,$7,'INTERNAL',clock_timestamp()+interval '5 minutes')",[w.f.ctx.tenantId,randomUUID(),w.f.ctx.actorId,resource,kind,kind==='GROUP'?w.f.conversationId:w.f.ctx.actorId,kind==='GROUP'?1:null]);
 // All contract/resource setup predates the tombstone. This is deliberately
 // not evidence for a production installer in an already CLOSED tenant.
 await d.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state,closed_at,close_reason) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-old-closed-dm',clock_timestamp()-interval '1 hour','CLOSED',clock_timestamp(),'SYNTHETIC PERMANENT TOMBSTONE')",[w.f.ctx.tenantId,w.f.ctx.actorId,trialHash,hash(JSON.stringify(policy)),w.f.corpId,w.f.ownerExternal,w.f.binding.robotCode]);
 const profile=formalProfileFingerprint({schemaVersion:2,kind:'FORMAL_GROUP_MENTION_ENTERPRISE',authorizationId:randomUUID(),...w.f.ctx,sourceTrialProfileHash:trialHash,corpId:w.f.corpId,externalUserId:w.f.ownerExternal,robotCode:w.f.binding.robotCode,conversationId:w.f.conversationId,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+120000).toISOString(),budgetPolicyHash:hash(JSON.stringify(policy)),approvalReference:'SYNTHETIC_NEW_GROUP_APPROVAL',modelAllowed:true,modelApprovalReference:'SYNTHETIC_NEW_MODEL_APPROVAL',entrypoints:['INGRESS','WORKER','NOTIFIER','API'],inputPolicy:{attachments:false,controls:false},capabilities:[{id:'company.agent.ask',version:'1.0.0',bindingHash:binding},{id:'dws.group.audience',version:'1.0.0',bindingHash:(await d.root.query("SELECT schema_hash FROM capability_bindings WHERE tenant_id=$1 AND logical_id='dws.group.audience'",[w.f.ctx.tenantId])).rows[0].schema_hash}],group:{mode:'MENTION_ONLY',contractId:w.document.id,contractVersion:1,contractHash:hash(JSON.stringify(w.document)),scopeId:w.f.scopeId,scopeVersion:1,membershipHash:hash('SYNTHETIC REVIEWED MEMBERS'),directoryHash:hash('SYNTHETIC REVIEWED DIRECTORY'),enterprisePolicyHash:hash('SYNTHETIC PRIVATE MANIFEST'),enterpriseResource:resource,questionHash:hash(question),audienceReviewReference:'SYNTHETIC_AUDIENCE_REVIEW',sharingReviewReference:'SYNTHETIC_SHARING_REVIEW',allowStop:true}});
 // Use the exact stored canonical contract hash rather than claiming JSON order.
 if(profile.profile.schemaVersion!==2)throw Error('SYNTHETIC GROUP PROFILE REQUIRED');
 const contract=(await d.root.query('SELECT document_hash FROM group_contracts WHERE tenant_id=$1 AND id=$2',[w.f.ctx.tenantId,w.document.id])).rows[0].document_hash;
 const frozen=formalProfileFingerprint({...profile.profile,group:{...profile.profile.group,contractHash:contract}});
 const tombstone=async()=>(await d.root.query('SELECT to_jsonb(t) value FROM one_shot_trials t WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows;
 const authorize=async()=>{const r=await d.root.query('SELECT public.oa_formal_authorize($1,$2,$3) state',[frozen.serialized,trialHash,frozen.profile.approvalReference]);d.db.formalProfileHash=frozen.hash;return r.rows[0].state;};
 const fresh=async(text=question,patch:Record<string,unknown>={})=>{for(let i=0;i<100;i++){const r=(await d.db.scope(w.f.ctx,c=>c.query("SELECT public.oa_formal_state('INGRESS') state,floor(extract(epoch FROM clock_timestamp())*1000)::text ms"))).rows[0];if(Number(r.ms)>=Number(r.state.admissionCutoffMs))return w.f.callback(text,{createAt:Number(r.ms),...patch});}throw Error('SYNTHETIC EVENT CLOCK NOT READY');};
 const counts=async()=>(await d.root.query('SELECT (SELECT count(*) FROM formal_admissions WHERE tenant_id=$1)::int admissions,(SELECT count(*) FROM tasks WHERE tenant_id=$1)::int tasks,(SELECT count(*) FROM outbox WHERE tenant_id=$1)::int outbox',[w.f.ctx.tenantId])).rows[0];
 return {...w,profile:frozen,trialHash,tombstone,authorize,fresh,counts};
}
it('a separately authorized exact group question creates one hash-bound native task while preserving CLOSED and deduplicating',async()=>{
 const w=await world(),before=await w.tombstone();expect(await w.authorize()).toMatchObject({state:'AUTHORIZED',replayed:false});expect(await w.authorize()).toMatchObject({replayed:true});
 const event=await w.fresh(),accepted=(await w.f.ingress.acceptTrustedCallback(event))!;expect(accepted).not.toBeNull();
 const r=(await d.root.query('SELECT r.budget,a.channel,a.input_hash,a.control_kind,a.task_id,a.run_id FROM formal_admissions a JOIN runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id WHERE a.task_id=$1',[accepted.taskId])).rows[0];expect(r).toMatchObject({budget:{maxTurns:4},channel:'GROUP',input_hash:hash(question),control_kind:'NONE',task_id:accepted.taskId});
 expect(await w.f.ingress.acceptTrustedCallback(event)).toEqual({...accepted,duplicate:true});const counts=await w.counts();expect(await w.f.ingress.acceptTrustedCallback(await w.fresh())).toBeNull();expect(await w.counts()).toEqual(counts);expect(await w.tombstone()).toEqual(before);
},60000);
it('the still callable old signature cannot use a group v2 approval for the old DM and its private old body is inaccessible',async()=>{
 const w=await world();await w.authorize();const before=await w.counts(),event=JSON.parse((await w.fresh()).data),args=[w.f.corpId,w.f.ownerExternal,w.f.binding.robotCode,'synthetic-old-closed-dm',randomUUID(),false,randomUUID(),randomUUID(),event.createAt,'DM',false,false];
 const result=await d.db.scope(w.f.ctx,c=>c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) state',args));expect(result.rows[0].state).toMatchObject({allowed:false,reason:'FORMAL_GROUP_HASH_BOUND_ENTRY_REQUIRED'});
 await expect(d.db.scope(w.f.ctx,c=>c.query('SELECT public.oa_lifecycle_admit_v71($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',args))).rejects.toThrow('permission denied');
 expect(await w.f.ingress.acceptTrustedCallback(await w.fresh(question,{conversationType:'1',conversationId:'synthetic-old-closed-dm'}))).toBeNull();expect(await w.counts()).toEqual(before);
},60000);
it('wrong question, group, participant, attachments, general controls and stale or future timestamps create no admission or task',async()=>{
 const w=await world();await w.authorize();const before=await w.counts();
 for(const event of [await w.fresh('SYNTHETIC DIFFERENT QUESTION'),await w.fresh(question,{conversationId:'synthetic-other-group'}),await w.fresh(question,{senderStaffId:w.f.otherExternal}),await w.fresh('记住：SYNTHETIC'),await w.fresh(question,{createAt:1}),await w.fresh(question,{createAt:Date.now()+60000}),await w.fresh(question,{msgtype:'file',content:{downloadCode:'SYNTHETIC',fileName:'synthetic.txt'}})])expect(await w.f.ingress.acceptTrustedCallback(event)).toBeNull();
 expect(await w.counts()).toEqual(before);
},60000);
it('a valid hash claim alone cannot commit an admission without its actual task run inbox binding',async()=>{
 const w=await world();await w.authorize();const before=await w.counts(),e=JSON.parse((await w.fresh()).data);
 await expect(d.db.scope(w.f.ctx,c=>c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[w.f.corpId,w.f.ownerExternal,w.f.binding.robotCode,w.f.conversationId,randomUUID(),false,randomUUID(),randomUUID(),e.createAt,'GROUP',false,false,hash(question),'NONE']))).rejects.toThrow('FORMAL_GROUP_ADMISSION_BINDING_MISMATCH');expect(await w.counts()).toEqual(before);
},60000);
it('an actual stop remains zero-model and cancels only the admitted task in this group',async()=>{
 const w=await world(),before=await w.tombstone();await w.authorize();const task=(await w.f.ingress.acceptTrustedCallback(await w.fresh()))!;expect(task).not.toBeNull();const stop=(await w.f.ingress.acceptTrustedCallback(await w.fresh('停止 '+task.taskId)))!;expect(stop).not.toBeNull();
 expect((await d.root.query('SELECT status FROM tasks WHERE id=$1',[task.taskId])).rows[0].status).toBe('CANCELLED');expect((await d.root.query('SELECT r.budget,t.control_kind FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE t.id=$1',[stop.taskId])).rows[0]).toMatchObject({budget:{maxTurns:0,maxTools:0},control_kind:'STOP'});expect(w.f.requests).toHaveLength(0);expect(await w.tombstone()).toEqual(before);
},60000);
it('revocation denies the next actual callback without changing the CLOSED tombstone',async()=>{
 const w=await world();await w.authorize();const before=await w.counts(),closed=await w.tombstone();await d.root.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[w.profile.profile.authorizationId,w.profile.hash,'SYNTHETIC STOP','SYNTHETIC_NEW_REVOKE_REVIEW']);expect(await w.f.ingress.acceptTrustedCallback(await w.fresh())).toBeNull();expect(await w.counts()).toEqual(before);expect(await w.tombstone()).toEqual(closed);
},60000);
it('missing current group sharing grant fails authorization atomically',async()=>{
 const w=await world(),before=await w.tombstone();await d.root.query("UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND capability_id='company.agent.ask' AND audience_kind='GROUP'",[w.f.ctx.tenantId]);await expect(w.authorize()).rejects.toThrow('FORMAL_GROUP_CURRENT_READ_BINDINGS_AND_DUAL_GRANTS_REQUIRED');expect((await d.root.query('SELECT id FROM formal_authorizations WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toHaveLength(0);expect(await w.tombstone()).toEqual(before);
},60000);

it.each(['different-goal','excess-model-turns'] as const)('a real task run and inbox cannot commit a %s against the approved receipt',async mode=>{
 const w=await world();await w.authorize();const before=await w.counts(),event=await w.fresh(),e=JSON.parse(event.data),taskId=randomUUID(),runId=randomUUID(),eventId=randomUUID();
 await expect(d.db.scope(w.f.ctx,async c=>{
  expect((await c.query('SELECT public.oa_lifecycle_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) state',[w.f.corpId,w.f.ownerExternal,w.f.binding.robotCode,w.f.conversationId,e.msgId,false,taskId,runId,e.createAt,'GROUP',false,false,hash(question),'NONE'])).rows[0].state.allowed).toBe(true);
  await c.query("INSERT INTO event_inbox(tenant_id,id,owner_id,source,event_key,payload_cipher_ref,state) VALUES($1,$2,$3,'DINGTALK',$4,$5,'RECEIVED')",[w.f.ctx.tenantId,eventId,w.f.ctx.actorId,`${e.robotCode}:${e.conversationId}:${e.msgId}`,JSON.stringify(vault.seal(event.data,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:inbox:${eventId}`))]);
  const conversation=(await c.query("SELECT public.oa_join_verified_conversation($1,'GROUP') id",[w.f.conversationId])).rows[0].id;
  await insertTask(c,w.f.ctx,mode==='different-goal'?'SYNTHETIC UNAPPROVED GOAL':question,{kind:'GROUP',targetId:w.f.conversationId,classificationCeiling:'INTERNAL'},eventId,conversation,{taskId,runId});
  if(mode==='different-goal')await c.query("UPDATE runs SET budget=jsonb_set(budget,'{maxTurns}','4') WHERE id=$1",[runId]);
 })).rejects.toThrow('FORMAL_GROUP_ADMISSION_BINDING_MISMATCH');expect(await w.counts()).toEqual(before);
},60000);
