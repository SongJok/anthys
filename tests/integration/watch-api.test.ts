import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret,config} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {ConditionWatchStore} from '../../packages/watches/src/store.js';
import {CompanyMcpWatchObserver} from '../../packages/company/src/watch-observer.js';
import {createServer} from '../../apps/api/src/server.js';
import {companyDataFixture} from '../support/company-data-mcp.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10),appDb=new Database(secret('DATABASE_URL')!),sources:Awaited<ReturnType<typeof companyDataFixture>>[]=[];
afterAll(async()=>{for(const source of sources)await source.close();await db.close();await appDb.close();await root.end();});
async function world(){
 const tenantId=randomUUID(),actorId=randomUUID(),otherId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic watch api','ACTIVE','UTC')",[tenantId,'synthetic-watch-api-'+tenantId]);
 for(const id of [actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic watch api','ACTIVE')",[tenantId,id,'synthetic-watch-api-'+id]);
 const ctx={tenantId,actorId},fixture=await companyDataFixture(root,ctx,randomUUID());sources.push(fixture);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[tenantId,randomUUID(),actorId,fixture.resource]);
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(ctx),otherSession=await sessions.create({tenantId,actorId:otherId});
 const store=new ConditionWatchStore(db),observer=new CompanyMcpWatchObserver(db,fixture.adapter,()=>Date.parse('2026-10-13T12:00:00.000Z'));
 const api=await createServer({config:config(),db:appDb,sessionSecret:secret('SESSION_SECRET')!,watches:store,watchSources:observer});
 const headers=(active:{cookie:string;csrf:string})=>({cookie:'oa_session='+active.cookie,origin:config().APP_ORIGIN,'x-csrf-token':active.csrf});
 const policy={schemaVersion:1,predicate:{schemaVersion:1,operator:'GTE',expected:3},tz:'UTC',validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3_600_000).toISOString(),intervalSeconds:300,cooldownSeconds:0,maxChecks:10,maxNotifications:5,quietWindow:null,misfire:'MONITOR_CURRENT',notificationRule:'VALUE_CHANGE_ONLY'};
 return {ctx,other:{tenantId,actorId:otherId},fixture,store,sessions,session,otherSession,api,headers,policy};
}
it('T055 authenticated API creates, reads, lists, binds, pauses, resumes and cancels owner-scoped watches',async()=>{
 const w=await world();try{
  const headers=w.headers(w.session);
  const created=await w.api.app.inject({method:'POST',url:'/api/v1/watches',headers,payload:w.policy});
  expect(created.statusCode).toBe(201);const saved=created.json().data as {watchId:string;policyHash:string};expect(saved).toMatchObject({watchId:expect.any(String),policyHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches',headers,payload:{...w.policy,extra:true}})).statusCode).toBe(400);
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches',headers:{...headers,'x-csrf-token':''},payload:w.policy})).statusCode).toBe(401);
  const list=await w.api.app.inject({url:'/api/v1/watches',headers:{cookie:headers.cookie}});expect(list.json().data).toHaveLength(1);
  const read=await w.api.app.inject({url:'/api/v1/watches/'+saved.watchId,headers:{cookie:headers.cookie}});expect(read.json().data).toMatchObject({id:saved.watchId,lifecycle:'ACTIVE',checksStarted:0});
  expect((await w.api.app.inject({url:'/api/v1/watches/'+saved.watchId,headers:w.headers(w.otherSession)})).statusCode).toBe(404);
  const bind=await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/source',headers,payload:{scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400}});
  expect(bind.statusCode).toBe(200);expect(bind.json().data).toEqual({bound:true});
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/source',headers,payload:{scopeId:w.fixture.scope.id,metric:'attempts',windowSeconds:86_400}})).statusCode).toBe(409);
  const incompatible=await w.api.app.inject({method:'POST',url:'/api/v1/watches',headers,payload:w.policy});expect(incompatible.statusCode).toBe(201);
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+incompatible.json().data.watchId+'/source',headers,payload:{scopeId:w.fixture.scope.id,metric:'successRate',windowSeconds:86_400}})).statusCode).toBe(400);
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+incompatible.json().data.watchId+'/cancel',headers,payload:{}})).json().data).toMatchObject({changed:true,lifecycle:'CANCELLED'});
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/pause',headers,payload:{}})).json().data).toMatchObject({found:true,changed:true,lifecycle:'PAUSED'});
  expect(await w.store.claimDue(w.ctx)).toHaveLength(0);
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/resume',headers,payload:{}})).json().data).toMatchObject({changed:true,lifecycle:'ACTIVE'});
  expect(await w.store.claimDue(w.ctx)).toHaveLength(1);
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/cancel',headers,payload:{}})).json().data).toMatchObject({changed:true,lifecycle:'CANCELLED'});
  expect((await w.api.app.inject({method:'POST',url:'/api/v1/watches/'+saved.watchId+'/pause',headers:w.headers(w.otherSession),payload:{}})).statusCode).toBe(404);
  expect((await w.api.app.inject({url:'/api/v1/watches',headers:w.headers(w.otherSession)})).json().data).toHaveLength(0);
 }finally{await w.api.app.close();}
});
