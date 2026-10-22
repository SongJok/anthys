import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {ConditionWatchStore} from '../../packages/watches/src/store.js';
import {runWatchCycle} from '../../packages/watches/src/cycle.js';
import {CompanyMcpWatchObserver} from '../../packages/company/src/watch-observer.js';
import type {WatchPredicate} from '../../packages/watches/src/predicate.js';
import {companyDataFixture,goldenEvents} from '../support/company-data-mcp.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10),sources:Awaited<ReturnType<typeof companyDataFixture>>[]=[];
afterAll(async()=>{for(const source of sources)await source.close();await db.close();await root.end();});
const windowNow=Date.parse('2026-10-13T12:00:00.000Z');
const predicate=(operator:WatchPredicate['operator'],expected:WatchPredicate['expected']):WatchPredicate=>({schemaVersion:1,operator,expected});
function policy(overrides:Record<string,unknown>={}){
 const now=Date.now();
 return {schemaVersion:1,predicate:predicate('GTE',3),tz:'UTC',validFrom:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString(),intervalSeconds:300,cooldownSeconds:0,maxChecks:10,maxNotifications:5,quietWindow:null,misfire:'MONITOR_CURRENT',notificationRule:'VALUE_CHANGE_ONLY',...overrides};
}
async function world(){
 const tenantId=randomUUID(),actorId=randomUUID(),otherId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic watch observer','ACTIVE','UTC')",[tenantId,'synthetic-watch-observer-'+tenantId]);
 for(const id of [actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic watch observer','ACTIVE')",[tenantId,id,'synthetic-watch-observer-'+id]);
 const ctx={tenantId,actorId},fixture=await companyDataFixture(root,ctx,randomUUID());sources.push(fixture);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[tenantId,randomUUID(),actorId,fixture.resource]);
 let now=Date.now();
 return {ctx,other:{tenantId,actorId:otherId},fixture,store:new ConditionWatchStore(db,()=>now),observer:new CompanyMcpWatchObserver(db,fixture.adapter,()=>windowNow),advance:(ms:number)=>{now+=ms;},now:()=>now};
}
function calls(){const seen:{observation:{state:string;value?:unknown}}[]=[];return {seen,notifier:{notify:async(_ctx:unknown,input:{observation:{state:string;value?:unknown}})=>{seen.push(input);return 'APPLIED_UNVERIFIED' as const;}}};}
it('T055 observes one certified company MCP aggregate, audits it and notifies only on value change',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy()),notifier=calls();
 await w.observer.bind(w.ctx,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400});
 w.fixture.modes.observedAt=new Date(w.now()).toISOString();
 const first=await runWatchCycle([w.ctx],w.store,{observer:w.observer,notifier:notifier.notifier,now:w.now},new AbortController().signal);
 expect(first).toMatchObject({scopes:1,completedScopes:1,failedScopes:0,claimed:1,checksCompleted:1,pending:1,settled:1});
 expect(notifier.seen).toHaveLength(1);expect(notifier.seen[0]!.observation).toMatchObject({state:'OBSERVED',value:5});
 const notifications=(await db.scope(w.ctx,c=>c.query('SELECT state,value_hash FROM condition_watch_notifications'))).rows;
 expect(notifications).toHaveLength(1);expect(notifications[0]).toMatchObject({state:'APPLIED_UNVERIFIED',value_hash:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(await w.store.get(w.ctx,created.watchId)).toMatchObject({notificationState:'IDLE',checksStarted:1,notificationsReserved:1});
 const audits=(await db.scope(w.ctx,c=>c.query('SELECT template_key,status,completeness,row_count::text count_text FROM data_executions'))).rows;
 expect(audits).toHaveLength(1);expect(audits[0]).toMatchObject({template_key:'payments.success_rate_daily',status:'OK',completeness:'COMPLETE',count_text:'5'});
 expect(w.fixture.counts()).toMatchObject({queries:1,checks:1});
 await w.fixture.changeSource({rows:[...goldenEvents,{eventId:'e12',attemptId:'a11',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T05:00:00.000Z',channel:'app',status:'success',valid:true}]});
 w.advance(300_000);w.fixture.modes.observedAt=new Date(w.now()).toISOString();
 const changed=await runWatchCycle([w.ctx],w.store,{observer:w.observer,notifier:notifier.notifier,now:w.now},new AbortController().signal);
 expect(changed).toMatchObject({claimed:1,pending:1,settled:1});expect(notifier.seen).toHaveLength(2);expect(notifier.seen[1]!.observation).toMatchObject({state:'OBSERVED',value:6});
});
it('T055 binds only compatible predicate/metric pairs and rejects cross-owner, duplicate or out-of-window targets before any MCP call',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy());
 await expect(w.observer.bind(w.other,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400})).rejects.toThrow('WATCH_SOURCE_TARGET_UNAVAILABLE');
 await w.observer.bind(w.ctx,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400});
 await expect(w.observer.bind(w.ctx,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400})).rejects.toThrow('WATCH_SOURCE_ALREADY_BOUND');
 const rate=await w.store.create(w.ctx,policy({predicate:predicate('GTE',3)}));
 await expect(w.observer.bind(w.ctx,{watchId:rate.watchId,scopeId:w.fixture.scope.id,metric:'successRate',windowSeconds:86_400})).rejects.toThrow('WATCH_SOURCE_METRIC_PREDICATE_MISMATCH');
 const text=await w.store.create(w.ctx,policy({predicate:predicate('EQ','3')}));
 await expect(w.observer.bind(w.ctx,{watchId:text.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400})).rejects.toThrow('WATCH_SOURCE_METRIC_PREDICATE_MISMATCH');
 const rateEq=await w.store.create(w.ctx,policy({predicate:predicate('EQ','0.6')}));
 const outside=new CompanyMcpWatchObserver(db,w.fixture.adapter,()=>Date.parse('2026-10-15T00:00:00.000Z'));
 await expect(outside.bind(w.ctx,{watchId:rateEq.watchId,scopeId:w.fixture.scope.id,metric:'successRate',windowSeconds:86_400})).rejects.toThrow('WATCH_SOURCE_WINDOW_UNAVAILABLE');
 expect(w.fixture.counts().attempts).toBe(0);
});
it('T055/T058 a revoked scope, grant or identity yields UNAVAILABLE without an upstream call or notification',async()=>{
 const cases=['scope','grant','identity'] as const;
 for(const revoked of cases){
  const w=await world(),created=await w.store.create(w.ctx,policy()),notifier=calls();
  await w.observer.bind(w.ctx,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400});
  if(revoked==='scope')await root.query('UPDATE company_data_scopes SET revoked_at=clock_timestamp() WHERE id=$1',[w.fixture.scope.id]);
  else if(revoked==='grant')await root.query("UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND actor_id=$2",[w.ctx.tenantId,w.ctx.actorId]);
  else await root.query("UPDATE users SET status='SUSPENDED' WHERE tenant_id=$1 AND id=$2",[w.ctx.tenantId,w.ctx.actorId]);
  const before=w.fixture.counts().attempts,summary=await runWatchCycle([w.ctx],w.store,{observer:w.observer,notifier:notifier.notifier,now:w.now},new AbortController().signal);
  expect(summary,revoked).toMatchObject({claimed:1,checksCompleted:1,suppressed:1,pending:0,settled:0});expect(notifier.seen,revoked).toHaveLength(0);expect(w.fixture.counts().attempts,revoked).toBe(before);
  const check=(await db.scope(w.ctx,c=>c.query('SELECT state,observation FROM condition_watch_checks'))).rows[0]!;expect(check.state,revoked).toBe('SUPPRESSED');
  expect((check.observation as {state:string;reason:string}),revoked).toMatchObject({state:'UNAVAILABLE',reason:'SOURCE_UNAVAILABLE'});
 }
});
it('T055 a pinned scope version change or policy mismatch invalidates the binding and abort is a hard stop',async()=>{
 const w=await world(),created=await w.store.create(w.ctx,policy()),bound=predicate('GTE',3);
 await w.observer.bind(w.ctx,{watchId:created.watchId,scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400});
 await root.query("UPDATE company_data_scopes SET readonly_proof_ref='synthetic-watch-version-bump' WHERE id=$1",[w.fixture.scope.id]);
 await expect(w.observer.observe(w.ctx,{watchId:created.watchId,policyHash:created.policyHash,predicate:bound},new AbortController().signal)).rejects.toThrow('WATCH_SOURCE_SCOPE_CHANGED');
 const controller=new AbortController();controller.abort();
 await expect(w.observer.observe(w.ctx,{watchId:created.watchId,policyHash:created.policyHash,predicate:bound},controller.signal)).rejects.toMatchObject({name:'AbortError'});
 const fresh=await world(),second=await fresh.store.create(fresh.ctx,policy());
 await fresh.observer.bind(fresh.ctx,{watchId:second.watchId,scopeId:fresh.fixture.scope.id,metric:'attempts',windowSeconds:86_400});
 await expect(fresh.observer.observe(fresh.ctx,{watchId:second.watchId,policyHash:'b'.repeat(64),predicate:bound},new AbortController().signal)).rejects.toThrow('WATCH_SOURCE_POLICY_CHANGED');
});
