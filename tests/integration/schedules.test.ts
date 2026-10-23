import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {secret,config} from '../../packages/config/src/index.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {Schedules} from '../../packages/schedules/src/service.js';
import {runReminderCycle} from '../../packages/schedules/src/cycle.js';
import {reminderResultAllowed} from '../../packages/schedules/src/delivery.js';
import {ReminderScheduler} from '../../packages/schedules/src/runner.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {createServer} from '../../apps/api/src/server.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,30),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await appDb.close();await root.end();});
async function world(){const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='synthetic-reminder-'+ctx.tenantId;
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic reminder','ACTIVE')",[ctx.tenantId,corpId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic reminder owner','ACTIVE')",[ctx.tenantId,ctx.actorId,'synthetic-owner-'+ctx.actorId]);
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(ctx),principal=(await sessions.authenticate(session.cookie))!;
 // Creation in the deterministic past lets delivery retain real DB-time guards.
 let now=Date.now()-10000;const service=new Schedules(db,vault,()=>now),scheduler=new ReminderScheduler(service),due=new Date(Math.floor((now+5000)/1000)*1000).toISOString();
 const rule={schemaVersion:1,kind:'ONCE',tz:'Asia/Shanghai',start:{kind:'UTC',at:due},dst:{overlap:'EARLIER',gap:'SKIP'},misfire:{kind:'REMINDER_LATEST',graceSeconds:3600}};
 const body={kind:'PRIVATE_TEXT_REMINDER',text:'核对交付清单',rule},create=(key=randomUUID())=>service.create(principal,body,key),advance=(ms=0)=>{now=Date.now()+ms;};
 const gateway=new Gateway(new RuntimeStore(db,vault));let sends=0;const delivery=new DeliveryGateway(db,vault,{sendReply:async()=>{throw Error('TEMP_WEBHOOK_MUST_NOT_BE_USED');},sendProactive:async(target,text)=>{expect(target).toEqual({kind:'PRIVATE_USER',externalId:'synthetic-owner-'+ctx.actorId});expect(text).toContain('核对交付清单');sends++;return {state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-receipt'};}},{corpId,robotCode:'synthetic-reminder-robot',appOrigin:config().APP_ORIGIN},Date.now,(...args)=>gateway.finalSourcesAllowed(...args));
 return {ctx,corpId,session,principal,sessions,service,scheduler,rule,body,create,advance,gateway,delivery,sends:()=>sends};
}
it('T047 authenticated real API persists explicit private reminder and returns absolute time/timezone/id; no model or delivery occurs during registration',async()=>{
 const w=await world(),api=await createServer({config:config(),db:appDb,sessionSecret:secret('SESSION_SECRET')!,schedules:w.service});try{
 const headers={cookie:'oa_session='+w.session.cookie,origin:config().APP_ORIGIN,'x-csrf-token':w.session.csrf,'idempotency-key':randomUUID()},url='/api/v1/schedules';
 const response=await api.app.inject({method:'POST',url,headers,payload:w.body});expect(response.statusCode).toBe(201);const saved=response.json().data.schedule;expect(saved).toMatchObject({id:expect.any(String),ownerId:w.ctx.actorId,revision:1,state:'ACTIVE',nextDueAt:w.rule.start.at,rule:{tz:'Asia/Shanghai'},lastOccurrence:null});
 const replay=await api.app.inject({method:'POST',url,headers,payload:w.body});expect(replay.json().data).toMatchObject({schedule:{id:saved.id},replayed:true});
 expect((await api.app.inject({url,headers:{cookie:headers.cookie}})).json().data.items).toHaveLength(1);expect((await api.app.inject({url:url+'/'+saved.id,headers:{cookie:headers.cookie}})).json().data.preview.occurrences[0].utc).toBe(w.rule.start.at);
 expect((await api.app.inject({method:'POST',url,headers:{...headers,'idempotency-key':randomUUID()},payload:{...w.body,targetId:w.ctx.actorId}})).statusCode).toBe(400);
 expect((await api.app.inject({method:'POST',url,headers:{...headers,'x-csrf-token':''},payload:w.body})).statusCode).toBe(401);
 expect(w.sends()).toBe(0);expect((await root.query('SELECT count(*)::int n FROM runs WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
 }finally{await api.app.close();}
});
it('T048/T060 two schedulers create one atomic occurrence/task/outbox and deterministic delivery survives a nonexistent model',async()=>{
 const w=await world(),saved=(await w.create()).schedule;w.advance();const second=new ReminderScheduler(new Schedules(db,vault,Date.now));
 const claimed=await Promise.all([w.scheduler.claimDue(w.ctx),second.claimDue(w.ctx)]);expect(claimed.flat()).toHaveLength(1);const id=claimed.flat()[0]!;
 expect((await root.query('SELECT count(*)::int n FROM schedule_occurrences WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(1);expect((await root.query("SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND kind='SCHEDULE'",[w.ctx.tenantId])).rows[0].n).toBe(1);
 expect(await Promise.all([w.scheduler.stage(w.ctx,id),second.stage(w.ctx,id)])).toEqual(expect.arrayContaining(['STAGED','NOT_CLAIMED']));
 const row=(await root.query('SELECT * FROM schedule_occurrences WHERE id=$1',[id])).rows[0];expect(await w.delivery.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await w.delivery.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(w.sends()).toBe(1);
 const result=(await root.query('SELECT result FROM runs WHERE id=$1',[row.run_id])).rows[0].result;expect(await w.gateway.finalResultAllowed(w.ctx,row.run_id,result)).toBe(true);expect((await w.service.get(w.principal,saved.id)).schedule.lastOccurrence).toMatchObject({taskId:row.task_id,deliveryState:'APPLIED_UNVERIFIED',verification:'UNVERIFIED'});
 expect((await root.query('SELECT count(*)::int n FROM provider_journals WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);
});
it('T053 queued and already staged old revisions are suppressed by pause/edit/cancel before physical send; stale etags conflict',async()=>{
 const w=await world(),saved=(await w.create()).schedule;w.advance();const [id]=await w.scheduler.claimDue(w.ctx);const paused=(await w.service.mutate(w.principal,saved.id,'PAUSE',{},saved.etag,randomUUID())).schedule;
 expect(await w.scheduler.stage(w.ctx,id!)).toBe('NOT_CLAIMED');await expect(w.service.cancel(w.principal,saved.id,{},saved.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_REVISION_CONFLICT'});
 const future={...w.body.rule,start:{kind:'UTC',at:new Date(Date.now()+10000).toISOString().replace(/\.\d{3}Z$/,'Z')}};
 const edited=(await w.service.mutate(w.principal,saved.id,'EDIT',{text:'核对交付清单',rule:future},paused.etag,randomUUID())).schedule;expect(edited.state).toBe('PAUSED');const resumed=(await w.service.mutate(w.principal,saved.id,'RESUME',{},edited.etag,randomUUID())).schedule;expect(resumed.state).toBe('ACTIVE');expect(resumed.revision).toBe(4);
 const another=await world(),one=(await another.create()).schedule;another.advance();const [oid]=await another.scheduler.claimDue(another.ctx);await another.scheduler.stage(another.ctx,oid!);await another.service.cancel(another.principal,one.id,{},one.etag,randomUUID());
 const d=(await root.query('SELECT delivery_id FROM schedule_occurrences WHERE id=$1',[oid])).rows[0].delivery_id;expect(await another.delivery.process(another.ctx,d,new AbortController().signal)).toBe('NOT_CLAIMED');expect(another.sends()).toBe(0);
});
it('T054 inactive owner and changed authentication epoch block queued execution and all future occurrences',async()=>{
 for(const change of ["status='DEPARTED'","auth_epoch=auth_epoch+1"]){const w=await world();await w.create();await root.query('UPDATE users SET '+change+' WHERE id=$1',[w.ctx.actorId]);w.advance();expect(await w.scheduler.claimDue(w.ctx)).toEqual([]);expect((await root.query('SELECT state FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0].state).toBe('BLOCKED');expect(w.sends()).toBe(0);}
});
it('T052 reminders past the one-hour grace are recorded MISSED without tasks or synthetic historical delivery',async()=>{
 const w=await world();await w.create();w.advance(2*3600000);expect(await w.scheduler.claimDue(w.ctx)).toEqual([]);const row=(await root.query('SELECT state,task_id FROM schedule_occurrences WHERE owner_id=$1',[w.ctx.actorId])).rows[0];expect(row).toEqual({state:'MISSED',task_id:null});expect(w.sends()).toBe(0);
});
it('private schedules enforce session/tenant/owner isolation, immutable request identity, abort rollback and current-authority delivery checks',async()=>{
 const w=await world(),other=await world(),key=randomUUID(),saved=(await w.create(key)).schedule;
 await expect(other.service.get(other.principal,saved.id)).rejects.toMatchObject({code:'SCHEDULE_NOT_FOUND'});await expect(w.service.create(w.principal,{...w.body,text:'different'},key)).rejects.toMatchObject({code:'SCHEDULE_REQUEST_CONFLICT'});
 const controller=new AbortController();controller.abort();await expect(w.service.create(w.principal,w.body,randomUUID(),controller.signal)).rejects.toMatchObject({code:'SCHEDULE_CANCELLED'});
 w.advance();const [id]=await w.scheduler.claimDue(w.ctx);await w.scheduler.stage(w.ctx,id!);const row=(await root.query('SELECT * FROM schedule_occurrences WHERE id=$1',[id])).rows[0];await root.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[w.ctx.actorId]);expect(await w.delivery.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
 await w.sessions.revoke(w.principal);await expect(w.service.list(w.principal,{})).rejects.toMatchObject({code:'SCHEDULE_SESSION_INVALID'});
});
it('current-authority changes between enqueue and deterministic execution block the schedule; cancelling BLOCKED is still a local stop',async()=>{
 const w=await world(),saved=(await w.create()).schedule;w.advance();const [id]=await w.scheduler.claimDue(w.ctx);await root.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[w.ctx.actorId]);expect(await w.scheduler.stage(w.ctx,id!)).toBe('SUPPRESSED');
 const session=await w.sessions.create(w.ctx),principal=(await w.sessions.authenticate(session.cookie))!;const blocked=(await w.service.get(principal,saved.id)).schedule;expect(blocked.state).toBe('BLOCKED');await expect(w.service.mutate(principal,saved.id,'RESUME',{},blocked.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_TRANSITION_DENIED'});
 expect((await w.service.cancel(principal,saved.id,{},blocked.etag,randomUUID())).stopped.state).toBe('CANCELLED');
});
it('UNKNOWN external acceptance is never converted to success or retried by another tick/delivery process',async()=>{
 const w=await world();await w.create();w.advance();await w.scheduler.tick(w.ctx);const row=(await root.query('SELECT * FROM schedule_occurrences WHERE owner_id=$1',[w.ctx.actorId])).rows[0];let calls=0;
 const gateway=new DeliveryGateway(db,vault,{sendReply:async()=>{throw Error('NOT_ALLOWED');},sendProactive:async()=>{calls++;return {state:'UNKNOWN',reason:'SYNTHETIC_RESPONSE_LOST'};}},{corpId:w.corpId,robotCode:'synthetic-reminder-robot',appOrigin:config().APP_ORIGIN},Date.now,(...args)=>w.gateway.finalSourcesAllowed(...args));
 expect(await gateway.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('UNKNOWN');await w.scheduler.tick(w.ctx);expect(await gateway.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(calls).toBe(1);expect((await w.service.list(w.principal,{})).items[0]!.lastOccurrence).toMatchObject({deliveryState:'UNKNOWN',verification:'UNVERIFIED'});
});
it('tampered encrypted plan, tenant policy changes and kill switches suppress old bytes before physical send; global stop still permits local cancel',async()=>{
 for(const mode of ['tamper','policy','kill']){const w=await world(),saved=(await w.create()).schedule;w.advance();await w.scheduler.tick(w.ctx);const row=(await root.query('SELECT * FROM schedule_occurrences WHERE owner_id=$1',[w.ctx.actorId])).rows[0];
 if(mode==='tamper')await root.query("UPDATE schedules SET payload_hash=repeat('0',64) WHERE id=$1",[saved.id]);
 if(mode==='policy')await root.query("UPDATE tenants SET policy_version='changed' WHERE tenant_id=$1",[w.ctx.tenantId]);
 if(mode==='kill')await root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,enabled,mode,reason_hash) VALUES($1,$2,$3,'USER',$3::uuid::text,true,'ALL',repeat('0',64))",[w.ctx.tenantId,randomUUID(),w.ctx.actorId]);
 expect(await w.delivery.process(w.ctx,row.delivery_id,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(0);
 if(mode==='kill')expect((await w.service.cancel(w.principal,saved.id,{},saved.etag,randomUUID())).stopped.state).toBe('CANCELLED');
 }
});
it('forced RLS, private owner scope and append-only schedule history retain independent responsibility and no application direct writes',async()=>{
 const w=await world(),saved=(await w.create()).schedule,otherId=randomUUID();await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2::uuid,$2::uuid::text,'synthetic other','ACTIVE')",[w.ctx.tenantId,otherId]);const other={tenantId:w.ctx.tenantId,actorId:otherId},s=await w.sessions.create(other),principal=(await w.sessions.authenticate(s.cookie))!;
 expect((await w.service.list(principal,{})).items).toEqual([]);await expect(w.service.get(principal,saved.id)).rejects.toMatchObject({code:'SCHEDULE_NOT_FOUND'});
 await expect(appDb.scope(w.ctx,c=>c.query('SELECT * FROM schedules'))).rejects.toMatchObject({code:'42501'});await expect(db.scope(other,c=>c.query('SELECT * FROM schedules WHERE id=$1',[saved.id]))).resolves.toMatchObject({rowCount:0});
 await w.service.mutate(w.principal,saved.id,'PAUSE',{},saved.etag,randomUUID());const history=(await root.query('SELECT operation,revision,state FROM schedule_events WHERE schedule_id=$1 ORDER BY created_at,id',[saved.id])).rows;expect(history).toEqual([{operation:'CREATE',revision:'1',state:'ACTIVE'},{operation:'PAUSE',revision:'2',state:'PAUSED'}]);
 await expect(root.query("UPDATE schedule_events SET operation='forged' WHERE schedule_id=$1",[saved.id])).rejects.toBeDefined();
});
it('connection acquisition timeout is controlled and a later identical request creates only one persisted plan',async()=>{
 const w=await world(),small=new Database(secret('RUNTIME_DATABASE_URL')!,1),service=new Schedules(small,vault,()=>Date.now()-10000),held=await small.pool.connect(),key=randomUUID();try{await expect(service.create(w.principal,w.body,key)).rejects.toMatchObject({code:'SCHEDULE_UNAVAILABLE',status:503,cause:{message:'timeout exceeded when trying to connect'}});expect((await root.query('SELECT count(*)::int n FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0].n).toBe(0);}finally{held.release();}
 try{const a=await service.create(w.principal,w.body,key),b=await service.create(w.principal,w.body,key);expect(a.schedule.id).toBe(b.schedule.id);expect(b.replayed).toBe(true);}finally{await small.close();}
});
it('abort after an actual insert rolls back plan, request and immutable history; a failed atomic due advance leaves no occurrence/task/outbox',async()=>{
 const w=await world(),faultDb=db.forkForAuthority(2),scope=faultDb.scope.bind(faultDb),controller=new AbortController();let fault:'ABORT_INSERT'|'FAIL_ADVANCE'|null='ABORT_INSERT';
 faultDb.scope=<T>(ctx:Parameters<Database['scope']>[0],fn:(client:pg.PoolClient)=>Promise<T>)=>scope(ctx,c=>fn(new Proxy(c,{get(target,key,receiver){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(typeof args[0]==='string'&&fault==='ABORT_INSERT'&&args[0].startsWith('INSERT INTO schedules')){fault=null;controller.abort();}if(typeof args[0]==='string'&&fault==='FAIL_ADVANCE'&&args[0].startsWith('UPDATE schedules SET next_due_at')){fault=null;throw Error('SYNTHETIC_FAILURE_AFTER_DUE_ADVANCE');}return result;};return Reflect.get(target,key,receiver);}})));
 const service=new Schedules(faultDb,vault,()=>Date.now()-10000),key=randomUUID();try{
 await expect(service.create(w.principal,w.body,key,controller.signal)).rejects.toMatchObject({code:'SCHEDULE_CANCELLED'});
 for(const table of ['schedules','schedule_requests','schedule_events'])expect((await root.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id=$1`,[w.ctx.actorId])).rows[0].n).toBe(0);
 await service.create(w.principal,w.body,key);fault='FAIL_ADVANCE';const runner=new ReminderScheduler(new Schedules(faultDb,vault,Date.now));await expect(runner.claimDue(w.ctx)).rejects.toMatchObject({code:'SCHEDULE_UNAVAILABLE',cause:{message:'SYNTHETIC_FAILURE_AFTER_DUE_ADVANCE'}});
 for(const table of ['schedule_occurrences','tasks','runs','outbox'])expect((await root.query(`SELECT count(*)::int n FROM ${table} WHERE ${table==='tasks'?'requester_id':'owner_id'}=$1`,[w.ctx.actorId])).rows[0].n).toBe(0);
 expect((await root.query('SELECT state,next_due_at FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0]).toMatchObject({state:'ACTIVE',next_due_at:expect.any(Date)});expect(await runner.claimDue(w.ctx)).toHaveLength(1);
 }finally{await faultDb.close();}
});
it('trial/formal process attestations cannot create schedules or reuse a closed-trial authority through this new entry point',async()=>{
 const w=await world(),restricted=db.forkForAuthority(2),service=new Schedules(restricted,vault);try{for(const kind of ['trial','formal'] as const){restricted.trialProfileHash=kind==='trial'?'synthetic-trial-hash':null;restricted.formalProfileHash=kind==='formal'?'synthetic-formal-hash':null;await expect(service.create(w.principal,w.body,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_LIFECYCLE_BLOCKED'});}expect((await root.query('SELECT count(*)::int n FROM schedules WHERE owner_id=$1',[w.ctx.actorId])).rows[0].n).toBe(0);}finally{await restricted.close();}
});
it('preview, pagination and idempotent mutations expose only current owner rules and reject unsupported or exhausted requests',async()=>{
 const w=await world(),saved=(await w.create()).schedule;await w.create();await w.create();const first=await w.service.list(w.principal,{limit:1});expect(first.items).toHaveLength(1);expect(first.nextCursor).toBe(first.items[0]!.id);const second=await w.service.list(w.principal,{limit:1,cursor:first.nextCursor});expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
 const view=await w.service.preview(w.principal,{rule:w.rule});expect(view.preview.occurrences[0]!.utc).toBe(w.rule.start.at);expect(view.rule.tz).toBe('Asia/Shanghai');
 await expect(w.service.preview(w.principal,{rule:{...w.rule,misfire:{kind:'REPORT_COALESCE'}}})).rejects.toMatchObject({code:'PRIVATE_REMINDER_RULE_REQUIRED'});
 await expect(w.service.preview(w.principal,{rule:{...w.rule,businessCalendar:{id:'not-configured',version:1}}})).rejects.toMatchObject({code:'PRIVATE_REMINDER_RULE_REQUIRED'});
 await expect(w.service.preview(w.principal,{rule:{...w.rule,until:new Date(Date.now()-86400000).toISOString()}})).rejects.toMatchObject({code:'UNTIL_BEFORE_START',status:400});
 await expect(w.service.create(w.principal,{...w.body,rule:{...w.rule,start:{kind:'UTC',at:new Date(Math.floor((Date.now()-86400000)/1000)*1000).toISOString()}}},randomUUID())).rejects.toMatchObject({code:'SCHEDULE_FUTURE_TIME_REQUIRED'});
 const key=randomUUID(),paused=await w.service.mutate(w.principal,saved.id,'PAUSE',{},saved.etag,key);expect((await w.service.mutate(w.principal,saved.id,'PAUSE',{},saved.etag,key)).replayed).toBe(true);w.advance();await expect(w.service.mutate(w.principal,saved.id,'RESUME',{},paused.schedule.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_FUTURE_TIME_REQUIRED'});
 await expect(w.service.cancel(w.principal,randomUUID(),{},saved.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_NOT_FOUND'});
 await root.query("UPDATE tenants SET policy_version='new-policy' WHERE tenant_id=$1",[w.ctx.tenantId]);await expect(w.service.mutate(w.principal,saved.id,'RESUME',{},paused.schedule.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_AUTHORITY_CHANGED'});
});
it('expired queued reminders become MISSED, cancelled tasks cannot stage, and revoked outbox entries are durably closed',async()=>{
 const w=await world(),saved=(await w.create()).schedule;w.advance();const [id]=await w.scheduler.claimDue(w.ctx);w.advance(2*3600000);expect(await w.scheduler.stage(w.ctx,id!)).toBe('MISSED');expect((await w.service.get(w.principal,saved.id)).schedule.lastOccurrence).toMatchObject({deliveryState:'MISSED'});expect(await w.scheduler.stage(w.ctx,randomUUID())).toBe('NOT_FOUND');
 const b=await world(),plan=(await b.create()).schedule;b.advance();const [oid]=await b.scheduler.claimDue(b.ctx);await b.service.mutate(b.principal,plan.id,'PAUSE',{},plan.etag,randomUUID());expect((await b.service.get(b.principal,plan.id)).schedule.lastOccurrence).toMatchObject({deliveryState:'SUPPRESSED'});expect((await root.query("SELECT published_at FROM outbox WHERE kind='SCHEDULE' AND aggregate_id=$1",[oid])).rows[0].published_at).toBeInstanceOf(Date);
 const c=await world();await c.create();c.advance();const [cid]=await c.scheduler.claimDue(c.ctx);await root.query("UPDATE tasks SET status='CANCELLED',cancel_requested_at=clock_timestamp() WHERE id=(SELECT task_id FROM schedule_occurrences WHERE id=$1)",[cid]);expect(await c.scheduler.stage(c.ctx,cid!)).toBe('SUPPRESSED');expect(c.sends()).toBe(0);
});
it('private plan limits preserve an existing request replay and inactive identities or damaged stored rules cannot bypass read checks',async()=>{
 const w=await world(),key=randomUUID(),first=await w.create(key);for(let n=1;n<100;n++)await w.create();await expect(w.create()).rejects.toMatchObject({code:'SCHEDULE_OWNER_LIMIT',status:429});expect((await w.create(key)).schedule.id).toBe(first.schedule.id);
 await root.query("UPDATE schedules SET payload_hash=repeat('0',64) WHERE id=$1",[first.schedule.id]);await expect(w.service.get(w.principal,first.schedule.id)).rejects.toMatchObject({code:'SCHEDULE_INTEGRITY',status:503});await root.query("UPDATE users SET status='SUSPENDED' WHERE id=$1",[w.ctx.actorId]);await expect(w.service.list(w.principal,{})).rejects.toMatchObject({code:'SCHEDULE_IDENTITY_INACTIVE'});
});

it.each(['badDue','badQueued','queuedThenBadDue','badCursor'])('a %s plan is quarantined without starving an already queued or due healthy reminder',async mode=>{
 const w=await world(),healthy=(await w.create()).schedule,bad=(await w.create()).schedule;
 if(mode==='queuedThenBadDue')await root.query("UPDATE schedules SET next_due_at=clock_timestamp()+interval '1 day' WHERE id=$1",[bad.id]);
 w.advance();if(['badQueued','queuedThenBadDue'].includes(mode))await w.scheduler.claimDue(w.ctx);
 if(mode==='badCursor')await root.query("UPDATE schedules SET next_due_at=next_due_at+interval '1 second' WHERE id=$1",[bad.id]);else await root.query("UPDATE schedules SET payload_hash=repeat('0',64),next_due_at=CASE WHEN $2 THEN $3::timestamptz ELSE next_due_at END WHERE id=$1",[bad.id,mode==='queuedThenBadDue',w.rule.start.at]);
 await w.scheduler.tick(w.ctx);await w.scheduler.tick(w.ctx);
 const blocked=(await root.query('SELECT state,last_error,next_due_at FROM schedules WHERE id=$1',[bad.id])).rows[0];expect(blocked).toEqual({state:'BLOCKED',last_error:'INVALID_SCHEDULE_DATA',next_due_at:null});
 const good=(await root.query("SELECT * FROM schedule_occurrences WHERE schedule_id=$1",[healthy.id])).rows;expect(good).toHaveLength(1);expect(good[0].state).toBe('STAGED');expect(await w.delivery.process(w.ctx,good[0].delivery_id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await w.delivery.process(w.ctx,good[0].delivery_id,new AbortController().signal)).toBe('NOT_CLAIMED');expect(w.sends()).toBe(1);
 expect((await root.query("SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1 AND state IN ('QUEUED','STAGED')",[bad.id])).rows[0].n).toBe(0);
});
it('damaged ciphertext can still be cancelled through the real owner API, replayed once and cannot authorize another owner or changed intent',async()=>{
 const w=await world(),other=await world(),saved=(await w.create()).schedule,key=randomUUID();w.advance();const [oid]=await w.scheduler.claimDue(w.ctx);await root.query("UPDATE schedules SET payload_ref='{}'::jsonb WHERE id=$1",[saved.id]);await expect(w.service.get(w.principal,saved.id)).rejects.toMatchObject({code:'SCHEDULE_INTEGRITY'});
 const api=await createServer({config:config(),db:appDb,sessionSecret:secret('SESSION_SECRET')!,schedules:w.service});try{
 const request={method:'POST' as const,url:'/api/v1/schedules/'+saved.id+'/cancel',headers:{cookie:'oa_session='+w.session.cookie,origin:config().APP_ORIGIN,'x-csrf-token':w.session.csrf,'if-match':saved.etag,'idempotency-key':key},payload:{}};
 const response=await api.app.inject(request);expect(response.statusCode).toBe(200);expect(response.json().data).toEqual({stopped:{id:saved.id,ownerId:w.ctx.actorId,revision:2,etag:`"schedule-${saved.id}-r2"`,state:'CANCELLED'},replayed:false});
 const repeated=await api.app.inject(request);expect(repeated.statusCode).toBe(200);expect(repeated.json().data.replayed).toBe(true);expect((await root.query("SELECT count(*)::int n FROM schedule_events WHERE schedule_id=$1 AND operation='CANCEL'",[saved.id])).rows[0].n).toBe(1);
 expect(await w.scheduler.stage(w.ctx,oid!)).toBe('NOT_CLAIMED');expect(w.sends()).toBe(0);await expect(w.service.cancel(other.principal,saved.id,{},saved.etag,randomUUID())).rejects.toMatchObject({code:'SCHEDULE_NOT_FOUND'});await expect(w.service.cancel(w.principal,saved.id,{},'changed',key)).rejects.toMatchObject({code:'SCHEDULE_REQUEST_CONFLICT'});
 }finally{await api.app.close();}
});
it('a persisted occurrence whose instant was tampered away from the stored rule cannot stage or send',async()=>{
 const w=await world();await w.create();w.advance();const [id]=await w.scheduler.claimDue(w.ctx);
 await root.query("UPDATE schedule_occurrences SET scheduled_at=scheduled_at+interval '500 milliseconds',expires_at=expires_at+interval '500 milliseconds' WHERE id=$1",[id]);
 expect(await w.scheduler.stage(w.ctx,id!)).toBe('MISSED');
 const row=(await root.query('SELECT state,task_id,delivery_id FROM schedule_occurrences WHERE id=$1',[id])).rows[0];expect(row).toEqual({state:'MISSED',task_id:expect.any(String),delivery_id:null});
 expect((await root.query('SELECT status FROM tasks WHERE id=$1',[row.task_id])).rows[0].status).toBe('CANCELLED');
 expect((await root.query("SELECT published_at FROM outbox WHERE kind='SCHEDULE' AND aggregate_id=$1",[id])).rows[0].published_at).toBeInstanceOf(Date);
 expect((await root.query('SELECT count(*)::int n FROM deliveries WHERE tenant_id=$1',[w.ctx.tenantId])).rows[0].n).toBe(0);expect(w.sends()).toBe(0);
});
it('a newer queued occurrence supersedes an older staged instant before physical send while exact fast-interval instants stay deliverable',async()=>{
 const w=await world(),start=new Date(Math.floor((Date.now()-2000)/1000)*1000).toISOString();
 const body={kind:'PRIVATE_TEXT_REMINDER',text:'核对交付清单',rule:{schemaVersion:1,kind:'INTERVAL',tz:'UTC',start:{kind:'UTC',at:start},everySeconds:1,misfire:{kind:'REMINDER_LATEST',graceSeconds:3600}}};
 const first=(await w.service.create(w.principal,body,randomUUID())).schedule,second=(await w.service.create(w.principal,body,randomUUID())).schedule;w.advance();expect(await w.scheduler.claimDue(w.ctx)).toHaveLength(2);
 const a=(await root.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[first.id])).rows[0],b=(await root.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[second.id])).rows[0];
 expect(await w.scheduler.stage(w.ctx,a.id)).toBe('STAGED');expect(await w.scheduler.stage(w.ctx,b.id)).toBe('STAGED');
 const staged=(await root.query('SELECT id,run_id,delivery_id,scheduled_at,revision FROM schedule_occurrences WHERE id=ANY($1::uuid[])',[[a.id,b.id]])).rows,sa=staged.find(row=>row.id===a.id)!,sb=staged.find(row=>row.id===b.id)!;
 const result=(id:string)=>root.query('SELECT result FROM runs WHERE id=$1',[id]).then(r=>r.rows[0].result as string),allowed=(id:string)=>result(id).then(text=>db.scope(w.ctx,c=>reminderResultAllowed(c,w.ctx,vault,id,text)));
 expect(await allowed(sa.run_id)).toBe(true);expect(await w.delivery.process(w.ctx,sa.delivery_id,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');
 const at=Date.parse((sb.scheduled_at as Date).toISOString());
 await root.query("INSERT INTO schedule_occurrences(tenant_id,id,owner_id,schedule_id,revision,scheduled_at,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'QUEUED',$7)",[w.ctx.tenantId,randomUUID(),w.ctx.actorId,second.id,sb.revision,new Date(at+1000).toISOString(),new Date(at+3600000).toISOString()]);
 expect(await allowed(sb.run_id)).toBe(false);expect(await w.delivery.process(w.ctx,sb.delivery_id,new AbortController().signal)).toBe('SUPPRESSED');expect(w.sends()).toBe(1);
});
it('scope failure or inactive ownership cannot starve healthy owners; abort stops the cycle rather than being swallowed',async()=>{
 const inactive=await world(),healthy=await world();await inactive.create();await healthy.create();await root.query("UPDATE users SET status='DEPARTED' WHERE id=$1",[inactive.ctx.actorId]);healthy.advance();inactive.advance();const scheduler=new ReminderScheduler(new Schedules(db,vault));let failures=0;
 expect(await runReminderCycle([inactive.ctx,healthy.ctx],scheduler,new AbortController().signal,()=>failures++)).toEqual({completed:2,failed:0});expect(failures).toBe(0);expect((await root.query('SELECT state FROM schedule_occurrences WHERE owner_id=$1',[healthy.ctx.actorId])).rows[0].state).toBe('STAGED');
 const next=await world();await next.create();next.advance();expect(await runReminderCycle([inactive.ctx,next.ctx],{tick:async(ctx,signal)=>{if(ctx.actorId===inactive.ctx.actorId)throw Error('SYNTHETIC_SCOPE_FAILURE');await scheduler.tick(ctx,signal);}},new AbortController().signal,()=>failures++)).toEqual({completed:1,failed:1});expect(failures).toBe(1);expect((await root.query('SELECT state FROM schedule_occurrences WHERE owner_id=$1',[next.ctx.actorId])).rows[0].state).toBe('STAGED');
 const controller=new AbortController();await expect(runReminderCycle([inactive.ctx,next.ctx],{tick:async()=>{controller.abort();throw Error('INTERRUPTED');}},controller.signal,()=>failures++)).rejects.toMatchObject({name:'AbortError'});expect(failures).toBe(1);
});
