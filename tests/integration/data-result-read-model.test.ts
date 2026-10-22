import '../support/isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {config,secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from '../../packages/company/src/data.js';
import {CertifiedDataResults} from '../../packages/company/src/data-results.js';
import {loadDataTemplates,dataTemplateHash} from '../../packages/company/src/data-templates.js';
import {companyDataFixture,syntheticDataQuery} from '../support/company-data-mcp.js';
import {createServer} from '../../apps/api/src/server.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault);
const templates=await loadDataTemplates(join(fileURLToPath(new URL('../..',import.meta.url)),'config/data-templates')),reader=new CertifiedDataResults(db,store,templates);
const sources:Awaited<ReturnType<typeof companyDataFixture>>[]=[],apis:Awaited<ReturnType<typeof createServer>>[]=[];
afterAll(async()=>{for(const source of sources)await source.close();for(const api of apis)await api.app.close();await db.close();await appDb.close();await root.end();});
const name=toolName('company.data.query','1.0.0'),signal=()=>new AbortController().signal;
async function fresh(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic data result','ACTIVE') ON CONFLICT(tenant_id) DO NOTHING",[ctx.tenantId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic actor','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-data-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,conversationId:'synthetic-result-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'Query the certified payments success-rate template'},createAt:Date.now(),senderId:ctx.actorId,chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-result',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,lease=(await store.acquire(ctx,runId,'synthetic-result'))!,fixture=await companyDataFixture(root,ctx,runId),gateway=new Gateway(store);sources.push(fixture);registerCompanyDataCapabilities(gateway,fixture.adapter);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.data.query','1.0.0','{}',$3,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,risk='READ',state='READY'",[ctx.tenantId,randomUUID(),companyDataBindingHash(fixture.adapter.connectorId,fixture.adapter.connectionBinding,fixture.adapter.toolName,fixture.adapter.inputSchemaHash,fixture.adapter.templates.registryHash)]);await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,fixture.resource]);
 return {ctx,runId,taskId:task.taskId,lease,fixture,gateway};
}
const principalOf=(ctx:{tenantId:string;actorId:string})=>({tenantId:ctx.tenantId,actorId:ctx.actorId,roles:[],authEpoch:1,sessionId:randomUUID()});
it('T091 component: projects the actor own audited certified result with scope, freshness and exact decimals',async()=>{
 const f=await fresh(),executed=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());expect(executed.status).toBe('OK');
 const list=await reader.list(principalOf(f.ctx));
 expect(list).toMatchObject({truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});expect(list.items).toHaveLength(1);
 const item=list.items[0]!;
 expect(item).toMatchObject({templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',completeness:'COMPLETE',status:'OK',rowCount:'5',classification:'CONFIDENTIAL',upstreamCertification:'UNVERIFIED'});
 expect(item.window).toEqual({start:syntheticDataQuery.start,end:syntheticDataQuery.end,interval:'[start,end)'});expect(item.rowScope).toEqual({tenant_id:'A',department_id:'d_pay'});
 expect(item.metrics).toMatchObject({attempts:'5',successes:'3',successRate:'0.6'});expect(item.metrics.byChannel).toEqual([{channel:'app',attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]);
 expect(item.queryId).toBe((executed.data as {queryId:string}).queryId);expect(item.evidenceRef).toBe('company-data:'+f.fixture.adapter.connectorId+':'+item.queryId);
 expect(Date.parse(item.watermark)).toBeLessThanOrEqual(Date.parse(item.observedAt));expect(item.templateHash).toBe(dataTemplateHash(f.fixture.template));
});
it('shows a truncated result without changing its scope and never invents a second actor result',async()=>{
 const f=await fresh();f.fixture.modes.truncated=true;await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 const list=await reader.list(principalOf(f.ctx));expect(list.items).toHaveLength(1);
 expect(list.items[0]).toMatchObject({completeness:'TRUNCATED',status:'PARTIAL',rowCount:'5'});expect(list.items[0]!.rowScope).toEqual({tenant_id:'A',department_id:'d_pay'});
 const other=await reader.list(principalOf({tenantId:f.ctx.tenantId,actorId:randomUUID()}));expect(other.items).toEqual([]);
 expect((await reader.list(principalOf({tenantId:randomUUID(),actorId:f.ctx.actorId}))).items).toEqual([]);
});
it('drops a result whose retained execution audit contradicts the sealed capability result',async()=>{
 const f=await fresh();await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 expect((await reader.list(principalOf(f.ctx))).items).toHaveLength(1);
 await root.query('UPDATE data_executions SET row_count=row_count+1 WHERE tenant_id=$1',[f.ctx.tenantId]);
 expect((await reader.list(principalOf(f.ctx))).items).toEqual([]);
});
it('lists the locally certified catalog with its definitions, freshness ceiling and no platform claim',async()=>{
 const catalog=await reader.catalog(principalOf({tenantId:randomUUID(),actorId:randomUUID()}));
 expect(catalog).toMatchObject({platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});expect(catalog.items).toHaveLength(1);
 expect(catalog.items[0]).toMatchObject({templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',metricName:'支付成功率',grain:['business_date','channel'],numerator:'去重后成功的支付尝试数',denominator:'去重后全部有效支付尝试数',parameterNames:['channel','end','start'],freshnessMaxMinutes:60,classification:'CONFIDENTIAL',allowedRoles:['PAYMENTS_ANALYST'],maxWindowDays:31,certificationReference:'LOCAL_TEMPLATE_CERTIFICATION_20261013',active:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
});
it('serves the certified results and catalog over authenticated read-only HTTP routes',async()=>{
 const f=await fresh();await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),dataResults:reader});apis.push(api);
 const token=await api.sessions.create(f.ctx),cookie='oa_session='+token.cookie;
 const listed=await api.app.inject({method:'GET',url:'/api/v1/data/results',headers:{cookie}});
 expect(listed.statusCode).toBe(200);expect(listed.headers['cache-control']).toBe('private, no-store');
 expect(listed.json()).toMatchObject({data:{items:[{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',status:'OK',rowCount:'5'}],truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false}});
 const catalog=await api.app.inject({method:'GET',url:'/api/v1/data/catalog',headers:{cookie}});
 expect(catalog.statusCode).toBe(200);expect(catalog.json()).toMatchObject({data:{items:[{templateKey:'payments.success_rate_daily',freshnessMaxMinutes:60}],platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false}});
 const anonymous=await api.app.inject({method:'GET',url:'/api/v1/data/results'});
 expect(anonymous.statusCode).toBe(401);
 const filtered=await api.app.inject({method:'GET',url:'/api/v1/data/results?taskId='+randomUUID(),headers:{cookie}});
 expect(filtered.statusCode).toBe(200);expect(filtered.json()).toMatchObject({data:{items:[],truncated:false}});
});
