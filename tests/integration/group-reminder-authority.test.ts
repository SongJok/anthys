import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {matchesRequiredSchema} from '../../packages/storage/src/schema.js';
import {GroupReminderAudience} from '../../packages/groups/src/reminder-audience.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Sessions,type Principal} from '../../packages/identity/src/sessions.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {groupReminderAuthorizationFingerprint} from '../../packages/config/src/group-reminder-authorization.js';
import {groupReminderDefinition} from '../../packages/groups/src/reminders.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,root:pg.Pool,db:Database,appDb:Database;
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let w:Awaited<ReturnType<typeof groupCaseWorld>>,owner:Principal;
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();({root,db,appDb}=isolated);w=await groupCaseWorld(root,db,appDb,vault);w.document.actions.allowed.push('case.remind');await w.approve();await w.save();const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),created=await sessions.create(w.f.ctx);owner=(await sessions.authenticate(created.cookie))!;});
afterAll(async()=>{await w?.f.close();await isolated?.close();});
/** The own disposable database has committed DDL before any credential reader
 * opens another connection. Only this test's new data is rolled back. The shared
 * synthetic database is not migrated and no protection or deadline is relaxed. */
it('T111 committed isolated PG authority and real synthetic audience preserve closed grants, idempotency and generation vetoes',async()=>{
 const c=await root.connect();
 const asWork=async<T>(ctx:{tenantId:string;actorId:string},fn:()=>Promise<T>)=>{
  await c.query('SAVEPOINT runtime_call');try{await c.query('SET LOCAL ROLE oa_runtime');await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.trial_profile_hash','',true),set_config('app.formal_profile_hash','',true)",[ctx.tenantId,ctx.actorId]);const result=await fn();await c.query('RESET ROLE');await c.query('RELEASE SAVEPOINT runtime_call');return result;}catch(e){await c.query('ROLLBACK TO SAVEPOINT runtime_call');await c.query('RESET ROLE');await c.query('RELEASE SAVEPOINT runtime_call');throw e;}
 };
 const as=(ctx:{tenantId:string;actorId:string},sql:string,args:unknown[]=[])=>asWork(ctx,()=>c.query(sql,args));
 await c.query('BEGIN');try{
  expect(matchesRequiredSchema((await c.query('SELECT name,hash FROM schema_migrations ORDER BY name')).rows)).toBe(true);
  await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
  expect((await c.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity) ok FROM pg_class WHERE relname LIKE 'group_reminder_%' AND relkind='r'")).rows[0].ok).toBe(true);
  expect((await c.query("SELECT has_function_privilege('oa_runtime','public.oa_group_reminder_authorize(text,text,text)','EXECUTE') runtime,has_function_privilege('oa_app','public.oa_group_reminder_admin_list(text,uuid,uuid,integer)','EXECUTE') app")).rows[0]).toEqual({runtime:false,app:false});
  const i=(await c.query('SELECT id,auth_epoch,authorization_version FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[w.f.ctx.tenantId,w.f.ctx.actorId])).rows[0],contract=(await c.query('SELECT document_hash FROM group_contracts WHERE tenant_id=$1 AND id=$2',[w.f.ctx.tenantId,w.document.id])).rows[0];
  const grant=groupReminderAuthorizationFingerprint({schemaVersion:1,approved:true,purpose:'SCHEDULED_CONTRACT',id:randomUUID(),tenantId:w.f.ctx.tenantId,groupId:w.f.conversationId,contractId:w.document.id,contractVersion:1,contractHash:contract.document_hash,delegationId:w.profile.document.id,serviceOwnerId:w.f.ctx.actorId,serviceIdentityId:i.id,scopeId:w.f.scopeId,ownerAuthEpoch:Number(i.auth_epoch),serviceAuthorizationVersion:Number(i.authorization_version),scopeVersion:1,validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),limits:{remindersPerCasePerDay:2,summariesPerGroupPerHour:6},reviewReference:'SYNTHETIC_SCHEDULED_CONTRACT_REVIEW',sourceReviewHash:hash('synthetic operator approval only'),allowMentionAll:false,allowDirectMessages:false,allowEscalation:false});
  expect((await c.query('SELECT public.oa_group_reminder_authorize($1,$2,$3) id',[grant.serialized,grant.hash,grant.document.reviewReference])).rows[0].id).toBe(grant.document.id);
  await expect(as(owner,'SELECT public.oa_group_reminder_admin_list($1,$2,NULL,20)',[w.f.conversationId,owner.sessionId])).rejects.toMatchObject({code:'P0001',message:'GROUP_REMINDER_ADMIN_REQUIRED'});
  const listed=(await as(w.principal,'SELECT public.oa_group_reminder_admin_list($1,$2,NULL,20) value',[w.f.conversationId,w.principal.sessionId])).rows[0].value;expect(listed.schedules).toEqual([]);expect(listed.authorizations).toHaveLength(1);
  const id=randomUUID(),key=randomUUID(),next=new Date(Math.ceil((Date.now()+1000)/1000)*1000).toISOString(),definition=groupReminderDefinition.parse({rule:{schemaVersion:1,tz:'UTC',kind:'ONCE',start:{kind:'UTC',at:next},misfire:{kind:'REMINDER_LATEST'}},limits:grant.document.limits,workHours:w.document.workHours,groupId:w.f.conversationId,contractId:w.document.id,contractVersion:1,contractHash:contract.document_hash,authorizationId:grant.document.id,serviceOwnerId:w.f.ctx.actorId}),text=canonical(definition),cipher=vault.seal(text,`${w.f.ctx.tenantId}:${w.f.ctx.actorId}:group-reminder:${id}`),intent=hash('synthetic real admin create');
  const create=()=>as(w.principal,'SELECT public.oa_group_reminder_admin_write($1,$2,\'CREATE\',$3,0,$4,1,$5,$6,$7,$8,$9) value',[w.f.conversationId,w.principal.sessionId,id,grant.document.id,key,intent,JSON.stringify(cipher),hash(text),next]);
  const stopId=randomUUID();await c.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'GROUP',$4,'WRITES',true,'synthetic-reminder-stop')",[w.principal.tenantId,stopId,w.principal.actorId,w.f.conversationId]);
  await expect(create()).rejects.toMatchObject({code:'P0001',message:'GROUP_REMINDER_STOPPED'});await c.query('UPDATE kill_switches SET enabled=false WHERE tenant_id=$1 AND id=$2',[w.principal.tenantId,stopId]);
  expect((await create()).rows[0].value).toEqual({id,replayed:false});expect((await create()).rows[0].value).toEqual({id,replayed:true});
  const occurrenceId=randomUUID();await as(w.f.ctx,"INSERT INTO group_reminder_occurrences(tenant_id,id,owner_id,schedule_id,revision,generation,scheduled_at,expires_at,state,fence,notification_id) VALUES($1,$2,$3,$4,1,1,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute','QUEUED',1,$5)",[w.f.ctx.tenantId,occurrenceId,w.f.ctx.actorId,id,randomUUID()]);
  const observed=(await as(w.f.ctx,"SELECT public.oa_group_reminder_observer($1,1,'PLAN') value",[occurrenceId])).rows[0].value;expect(observed).toMatchObject({groupId:w.f.conversationId,contractId:w.document.id,schedule:{id,revision:1,generation:1},occurrence:{id:occurrenceId,fence:1,phase:'PLAN'}});
  expect((await as(w.f.ctx,'SELECT public.oa_group_reminder_usage($1,1) value',[occurrenceId])).rows[0].value).toMatchObject({complete:true,includesAllUnresolved:true,notifications:[]});
  const audience=new GroupReminderAudience(w.f.dws,'robot-1'),origin={occurrenceId,fence:1,phase:'PLAN' as const};try{
   // A persisted but invented occurrence timestamp is not enough: it must be
   // an actual occurrence of the sealed rule and within its bounded send window.
   await expect(asWork(w.f.ctx,()=>audience.local(c,w.f.ctx,origin))).rejects.toMatchObject({code:'GROUP_REMINDER_ORIGIN_INVALID'});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(next)-Date.now())+20));
   await as(w.f.ctx,'UPDATE group_reminder_occurrences SET scheduled_at=$2 WHERE id=$1',[occurrenceId,next]);
   const actual=await asWork(w.f.ctx,()=>audience.observe(c,w.f.ctx,w.f.conversationId,origin,new AbortController().signal));
   expect(actual.members.map(m=>m.id).sort()).toEqual([w.f.ctx.actorId,w.principal.actorId].sort());expect(actual.observer.schedule.id).toBe(id);
  }finally{await audience.close();}

  await expect(as(w.f.ctx,"SELECT public.oa_group_reminder_observer($1,2,'PLAN')",[occurrenceId])).rejects.toMatchObject({code:'P0001'});
  expect((await as(w.principal,"SELECT public.oa_group_reminder_admin_write($1,$2,'PAUSE',$3,1,NULL,NULL,$4,$5,NULL,NULL,NULL) value",[w.f.conversationId,w.principal.sessionId,id,randomUUID(),hash('synthetic pause')])).rows[0].value).toEqual({id,replayed:false});
  const row=(await as(w.principal,'SELECT public.oa_group_reminder_admin_get($1,$2,$3) value',[w.f.conversationId,w.principal.sessionId,id])).rows[0].value;expect(row).toMatchObject({state:'PAUSED',revision:2,generation:2,next_due_at:null});
  await expect(as(w.f.ctx,"SELECT public.oa_group_reminder_observer($1,1,'PLAN')",[occurrenceId])).rejects.toMatchObject({code:'P0001'});
  await expect(as(w.principal,"SELECT public.oa_group_reminder_admin_write($1,$2,'RESUME',$3,1,NULL,NULL,$4,$5,NULL,NULL,$6)",[w.f.conversationId,w.principal.sessionId,id,randomUUID(),hash('stale revision'),new Date(Date.now()+60000).toISOString()])).rejects.toMatchObject({code:'P0001'});
  await as(w.principal,"SELECT public.oa_group_reminder_admin_write($1,$2,'CANCEL',$3,2,NULL,NULL,$4,$5,NULL,NULL,NULL)",[w.f.conversationId,w.principal.sessionId,id,randomUUID(),hash('synthetic cancel')]);
  expect((await as(w.principal,'SELECT public.oa_group_reminder_admin_get($1,$2,$3) value',[w.f.conversationId,w.principal.sessionId,id])).rows[0].value).toMatchObject({state:'CANCELLED',revision:3,generation:3});
 }finally{await c.query('ROLLBACK');c.release();}
 expect(matchesRequiredSchema((await root.query('SELECT name,hash FROM schema_migrations ORDER BY name')).rows)).toBe(true);expect(Number((await root.query('SELECT count(*) n FROM group_reminder_schedules WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows[0].n)).toBe(0);
});
