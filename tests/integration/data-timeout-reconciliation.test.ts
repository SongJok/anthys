import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from '../../packages/company/src/data.js';
import {CompanyDataClient} from '../../packages/company/src/data-client.js';
import {dataWireArguments} from '../../packages/company/src/data-contracts.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import '../support/isolation.js';
import {companyDataFixture,syntheticDataQuery} from '../support/company-data-mcp.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault),sources:Awaited<ReturnType<typeof companyDataFixture>>[]=[];
afterAll(async()=>{for(const source of sources)await source.close();await db.close();await root.end();});
const name=toolName('company.data.query','1.0.0'),signal=()=>new AbortController().signal;
// The upstream CHECK pays the first pg round trip of the fixture (measured
// 95-140 ms); a 200 ms client budget made the pre-dispatch authorization
// check time out under load and turned the call into DENIED instead of the
// upstream timeout this test exercises.
async function fresh(timeoutMs=600){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic timeout data','ACTIVE') ON CONFLICT(tenant_id) DO NOTHING",[ctx.tenantId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic data','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-data-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,conversationId:'synthetic-timeout-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'Query the certified payments success-rate template'},createAt:Date.now(),senderId:ctx.actorId,chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-timeout',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,lease=(await store.acquire(ctx,runId,'synthetic-timeout'))!,fixture=await companyDataFixture(root,ctx,runId);sources.push(fixture);
 const adapter=new CompanyDataClient(fixture.client,fixture.adapter.connectorId,fixture.adapter.connectionBinding,fixture.adapter.toolName,fixture.adapter.inputSchemaHash,fixture.adapter.templates,'INLINE_DEFINITION',timeoutMs),gateway=new Gateway(store);registerCompanyDataCapabilities(gateway,adapter);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.data.query','1.0.0','{}',$3,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,risk='READ',state='READY'",[ctx.tenantId,randomUUID(),companyDataBindingHash(adapter.connectorId,adapter.connectionBinding,adapter.toolName,adapter.inputSchemaHash,adapter.templates.registryHash)]);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,fixture.resource]);
 return {ctx,runId,lease,taskId:task.taskId,fixture,adapter,gateway};
}
async function auditRows(ctx:{tenantId:string;actorId:string}){return (await db.scope(ctx,c=>c.query('SELECT *,row_count::text count_text FROM data_executions ORDER BY created_at,id'))).rows;}
async function actionRows(ctx:{tenantId:string;actorId:string}){return (await db.scope(ctx,c=>c.query("SELECT state,retry_safety FROM tool_actions WHERE capability_id='company.data.query' ORDER BY created_at,id"))).rows;}
it('T092 component: a timed-out upstream query is never compensated by a new query and stays reconcilable',async()=>{
 const f=await fresh();f.fixture.modes.queryDelayMs=1500;
 const result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 expect(result).toMatchObject({status:'UNKNOWN',completeness:'UNKNOWN',remediation:{kind:'COMPANY_DATA_UPSTREAM_TIMEOUT'}});
 expect(result.data).toBeUndefined();
 const actions=await actionRows(f.ctx);
 expect(actions).toHaveLength(1);
 expect(actions[0]).toMatchObject({state:'UNKNOWN'});
 expect(actions[0]?.state).not.toBe('PREPARED');
 expect(f.fixture.counts().queryAttempts).toBe(1);
 const rows=await auditRows(f.ctx);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({status:'UNKNOWN',completeness:'UNKNOWN',query_id:null,row_count:'0',count_text:'0'});
 const evidence=String(rows[0]?.evidence_ref),parts=evidence.split(':');
 expect(parts[0]).toBe('company-data');expect(parts[2]).toBe('timeout');expect(parts[4]).toBe('reconciled');
 expect(parts[3]).toMatch(/^[0-9a-f-]{36}$/);
 expect(f.fixture.requests.filter(request=>request.nonce===parts[3]).map(request=>request.operation)).toEqual(['QUERY','CHECK']);
 await new Promise(resolve=>setTimeout(resolve,1100));
 expect(f.fixture.counts().queries).toBe(1);
 expect(f.fixture.counts().queryAttempts).toBe(1);
 // Two gateway resource checks (before dispatch and inside the guarded
 // dispatch) plus exactly one reconciliation check. No second query.
 expect(f.fixture.counts().checks).toBe(3);
});
it('T092 component: a caller cancellation is distinct from an upstream timeout and never opens a query',async()=>{
 const f=await fresh(),controller=new AbortController();controller.abort();
 await expect(f.adapter.request(f.ctx,f.fixture.scope,'QUERY',dataWireArguments(f.fixture.template,'INLINE_DEFINITION',syntheticDataQuery),controller.signal)).rejects.toMatchObject({code:'COMPANY_DATA_CALLER_CANCELLED'});
 const result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,controller.signal);
 expect(result.status).not.toBe('OK');
 expect(result.remediation?.kind).toBe('RESOURCE_SOURCE_OR_EGRESS_DENIED');
 expect(result.data).toBeUndefined();
 expect(f.fixture.counts().queryAttempts).toBe(0);
 expect(await auditRows(f.ctx)).toHaveLength(0);
 // The aborted caller is denied before dispatch, so no action row exists and
 // nothing can be retried into a new upstream query.
 expect(await actionRows(f.ctx)).toHaveLength(0);
});
it('T092 component: a timeout inside the upstream gate never produces a result row or a second query',async()=>{
 const f=await fresh();f.fixture.modes.queryDelayMs=1500;
 const result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 expect(result.status).toBe('UNKNOWN');
 const rows=await auditRows(f.ctx);
 expect(rows).toHaveLength(1);
 expect(rows[0]?.query_id).toBeNull();
 expect(JSON.stringify(rows[0])).not.toContain(syntheticDataQuery.start);
 await new Promise(resolve=>setTimeout(resolve,1100));
 expect(f.fixture.counts().queries).toBe(1);
 expect(f.fixture.counts().queryAttempts).toBe(1);
 expect(f.fixture.requests.filter(request=>request.operation==='QUERY')).toHaveLength(1);
});
