import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupReminderWorld} from '../support/group-reminder-world.js';
import {secret,config} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {createServer} from '../../apps/api/src/server.js';
import type {GroupReminderSchedule} from '../../packages/groups/src/reminder-model.js';
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,w:Awaited<ReturnType<typeof groupReminderWorld>>,api:Awaited<ReturnType<typeof createServer>>,memberCookie:string;
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),base='http://127.0.0.1:64702';
let schedule:GroupReminderSchedule;const rule=()=>({schemaVersion:1,tz:'UTC',kind:'ONCE',start:{kind:'UTC',at:new Date(Math.ceil((Date.now()+120000)/1000)*1000).toISOString()},misfire:{kind:'REMINDER_LATEST'}});
const path=()=>'/api/v1/groups/'+encodeURIComponent(w.f.conversationId)+'/reminder-schedules';
async function call(url:string,method='GET',body?:unknown,key?:string,cookie?:string){const response=await fetch(base+url,{method,headers:{cookie:'oa_session='+(cookie??w.session.cookie),...(method==='GET'?{}:{origin:config().APP_ORIGIN,'x-csrf-token':w.session.csrf,'content-type':'application/json',...(key?{'idempotency-key':key}:{})})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as {data?:{control?:Pick<GroupReminderSchedule,'id'|'groupId'|'authorizationId'|'revision'|'generation'|'state'|'nextDueAt'>;schedule:GroupReminderSchedule;replayed:boolean;items:GroupReminderSchedule[];authorizations:{id:string}[];preview:unknown};error?:{code:string}},cache:response.headers.get('cache-control')};}
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();w=await groupReminderWorld(d.root,d.db,d.appDb,vault);const sessions=new Sessions(d.appDb,secret('SESSION_SECRET')!);memberCookie=(await sessions.create(w.f.ctx)).cookie;api=await createServer({config:config(),db:d.appDb,sessionSecret:secret('SESSION_SECRET')!,groupReminders:w.reminders});await api.app.listen({host:'127.0.0.1',port:64702});});
afterAll(async()=>{await api?.app.close();await w?.f.close();await d?.close();});
// All phases use the same persisted schedule and real HTTP/PG/DWS, retaining the
// original per-test20s limit. No route handlers, membership or transport are mocked.
describe('T111 actual group reminder administration',{concurrent:false},()=>{
 it('enforces real session, administrator, CSRF, reviewed grant and tenant/group boundaries',async()=>{
  expect((await fetch(base+path())).status).toBe(401);expect((await call(path(),'GET',undefined,undefined,memberCookie)).status).toBe(403);
  expect((await call('/api/v1/groups/other-group/reminder-schedules')).status).toBe(404);
  const missingCsrf=await fetch(base+path(),{method:'POST',headers:{cookie:'oa_session='+w.session.cookie,'content-type':'application/json'},body:'{}'});expect(missingCsrf.status).toBe(403);
  const denied=await call(path(),'POST',{authorizationId:randomUUID(),contractVersion:1,rule:rule(),confirmGroupNotifications:true},randomUUID());expect(denied.status).toBe(403);expect(denied.body.error?.code).toBe('GROUP_REMINDER_AUTHORIZATION_REQUIRED');
  const stop=randomUUID();await d.root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'USER',$4,'WRITES',true,'synthetic-service-owner-stop')",[w.principal.tenantId,stop,w.principal.actorId,w.f.ctx.actorId]);try{const stopped=await call(path(),'POST',{authorizationId:w.grant.document.id,contractVersion:1,rule:rule(),confirmGroupNotifications:true},randomUUID());expect(stopped.status).toBe(403);expect(stopped.body.error?.code).toBe('GROUP_REMINDER_STOPPED');}finally{await d.root.query('UPDATE kill_switches SET enabled=false WHERE tenant_id=$1 AND id=$2',[w.principal.tenantId,stop]);}
  expect((await call('/api/v1/health/ready')).status).toBe(200);
 });
 it('previews, creates and concurrently replays one registered schedule with explicit current coverage',async()=>{
  const listed=await call(path());expect(listed.status).toBe(200);expect(listed.cache).toBe('private, no-store');expect(listed.body.data?.items).toEqual([]);expect(listed.body.data?.authorizations.map(x=>x.id)).toEqual([w.grant.document.id]);
  const body={authorizationId:w.grant.document.id,contractVersion:1,rule:rule(),confirmGroupNotifications:true},preview=await call(path()+'/preview','POST',{rule:body.rule});expect(preview.status).toBe(200);expect(preview.body.data?.preview).toBeTruthy();
  const key=randomUUID(),results=await Promise.all([call(path(),'POST',body,key),call(path(),'POST',body,key)]);expect(results.map(r=>r.status)).toEqual([201,201]);expect(new Set(results.map(r=>r.body.data?.schedule.id)).size).toBe(1);expect(results.filter(r=>r.body.data?.replayed)).toHaveLength(1);schedule=results[0]!.body.data!.schedule;
  const futureClock=vi.spyOn(w.reminders,'clock').mockReturnValue(Date.now()+180000);try{const old=await call(path(),'POST',body,key);expect(old.status).toBe(201);expect(old.body.data).toMatchObject({replayed:true,schedule:{id:schedule.id,revision:1}});}finally{futureClock.mockRestore();}
  expect(schedule).toMatchObject({state:'ACTIVE',revision:1,generation:1,workHours:w.document.workHours,limits:w.grant.document.limits,lastOccurrence:null});
  expect((await d.root.query('SELECT owner_id FROM group_reminder_schedules WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toEqual([{owner_id:w.f.ctx.actorId}]);
  expect((await d.root.query('SELECT actor_id,operation FROM group_reminder_requests WHERE tenant_id=$1',[w.f.ctx.tenantId])).rows).toEqual([{actor_id:w.principal.actorId,operation:'CREATE'}]);
  expect((await call(path(),'POST',{...body,rule:{...body.rule,count:1}},key)).status).toBe(409);
 });
 it('edits and pauses using current revisions while preserving replay semantics',async()=>{
  expect(schedule.revision).toBe(1);const editKey=randomUUID(),editBody={expectedRevision:1,rule:{...schedule.rule,count:1}},edit=await call(path()+'/'+schedule.id,'PATCH',editBody,editKey);expect(edit.status).toBe(200);schedule=edit.body.data!.schedule;expect(schedule.revision).toBe(2);const futureClock=vi.spyOn(w.reminders,'clock').mockReturnValue(Date.now()+180000);try{const replay=await call(path()+'/'+schedule.id,'PATCH',editBody,editKey);expect(replay.status).toBe(200);expect(replay.body.data).toMatchObject({replayed:true,schedule:{id:schedule.id,revision:2}});}finally{futureClock.mockRestore();}
  const key=randomUUID(),body={expectedRevision:2},paused=await call(path()+'/'+schedule.id+'/pause','POST',body,key);expect(paused.status).toBe(200);schedule={...schedule,...paused.body.data!.control};expect(paused.body.data!.schedule).toBeUndefined();expect(schedule).toMatchObject({state:'PAUSED',revision:3,generation:3,nextDueAt:null});
  const replay=await call(path()+'/'+schedule.id+'/pause','POST',body,key);expect(replay.status).toBe(200);expect(replay.body.data).toMatchObject({replayed:true,control:{id:schedule.id,revision:3,state:'PAUSED'}});
 });
 it('resumes and cancels the same schedule with no reminder task, model or external send',async()=>{
  expect(schedule.state).toBe('PAUSED');const resumeKey=randomUUID(),resumed=await call(path()+'/'+schedule.id+'/resume','POST',{expectedRevision:3},resumeKey);expect(resumed.status).toBe(200);schedule=resumed.body.data!.schedule;expect(schedule).toMatchObject({state:'ACTIVE',revision:4,generation:4});const futureClock=vi.spyOn(w.reminders,'clock').mockReturnValue(Date.now()+180000);try{const replay=await call(path()+'/'+schedule.id+'/resume','POST',{expectedRevision:3},resumeKey);expect(replay.status).toBe(200);expect(replay.body.data).toMatchObject({replayed:true,schedule:{id:schedule.id,revision:4}});}finally{futureClock.mockRestore();}
  await d.root.query("UPDATE group_reminder_schedules SET definition_ref='{}' WHERE tenant_id=$1 AND id=$2",[w.f.ctx.tenantId,schedule.id]);
  const cancelled=await call(path()+'/'+schedule.id+'/cancel','POST',{expectedRevision:4},randomUUID());expect(cancelled.status).toBe(200);schedule={...schedule,...cancelled.body.data!.control};expect(cancelled.body.data!.schedule).toBeUndefined();expect(schedule).toMatchObject({state:'CANCELLED',revision:5,generation:5,nextDueAt:null});
  expect((await call(path()+'/'+schedule.id+'/resume','POST',{expectedRevision:3},randomUUID())).status).toBe(409);
  expect((await d.root.query("SELECT id FROM tasks WHERE tenant_id=$1 AND control_kind='GROUP_REMINDER'",[w.f.ctx.tenantId])).rowCount).toBe(0);expect(w.f.requests).toEqual([]);
 });
});
