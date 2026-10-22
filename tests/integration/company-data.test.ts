import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName,canonical} from '../../packages/gateway/src/index.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from '../../packages/company/src/data.js';
import {dataParametersHash,dataTemplateRef} from '../../packages/company/src/data-contracts.js';
import {dataTemplateHash} from '../../packages/company/src/data-templates.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import '../support/isolation.js';
import {companyDataFixture,syntheticDataQuery} from '../support/company-data-mcp.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault),sources:Awaited<ReturnType<typeof companyDataFixture>>[]=[];
afterAll(async()=>{for(const source of sources)await source.close();await db.close();await appDb.close();await root.end();});
const name=toolName('company.data.query','1.0.0'),signal=()=>new AbortController().signal;
async function fresh(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic data','ACTIVE') ON CONFLICT(tenant_id) DO NOTHING",[ctx.tenantId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic data','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const binding={corpId:ctx.tenantId,robotCode:'synthetic-data-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:ctx.tenantId,senderCorpId:ctx.tenantId,senderStaffId:ctx.actorId,conversationId:'synthetic-data-dm-'+ctx.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'Query the certified payments success-rate template'},createAt:Date.now(),senderId:ctx.actorId,chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-data',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:ctx.tenantId,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,lease=(await store.acquire(ctx,runId,'synthetic-data'))!,fixture=await companyDataFixture(root,ctx,runId),gateway=new Gateway(store);sources.push(fixture);registerCompanyDataCapabilities(gateway,fixture.adapter);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.data.query','1.0.0','{}',$3,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,risk='READ',state='READY'",[ctx.tenantId,randomUUID(),companyDataBindingHash(fixture.adapter.connectorId,fixture.adapter.connectionBinding,fixture.adapter.toolName,fixture.adapter.inputSchemaHash,fixture.adapter.templates.registryHash)]);await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,fixture.resource]);
 return {ctx,runId,lease,taskId:task.taskId,fixture,gateway};
}
async function auditRows(ctx:{tenantId:string;actorId:string}){return (await db.scope(ctx,c=>c.query('SELECT *,row_count::text count_text FROM data_executions ORDER BY created_at,id'))).rows;}
it('T083 component: gateway executes the certified template through MCP and stores exact provenance without raw parameters',async()=>{
 const f=await fresh(),result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
 expect(result).toMatchObject({status:'OK',completeness:'COMPLETE',externalRequestId:expect.stringMatching(/^[a-f0-9-]{36}$/),verification:{state:'VERIFIED',method:'CERTIFIED_DATA_TEMPLATE_CURRENT_ACTOR_UPSTREAM_AGGREGATE'}});
 const data=result.data as {source:{scopeId:string;queryId:string;templateHash:string;classification:string};template:{key:string;version:string;hash:string};queryId:string;window:{start:string;end:string;interval:string};rowScope:Record<string,string>;metrics:{attempts:string;successes:string;successRate:string|null;byChannel:{channel:string;attempts:string;successes:string;successRate:string|null}[]};untrustedContent:boolean;upstreamCertification:string};
 expect(result.externalRequestId).toBe(data.queryId);expect(data).toMatchObject({source:{scopeId:f.fixture.scope.id,templateHash:f.fixture.scope.templateHash,classification:'CONFIDENTIAL'},template:dataTemplateRef(f.fixture.template),window:{start:syntheticDataQuery.start,end:syntheticDataQuery.end,interval:'[start,end)'},rowScope:{tenant_id:'A',department_id:'d_pay'},metrics:{attempts:'5',successes:'3',successRate:'0.6'},untrustedContent:true,upstreamCertification:'UNVERIFIED'});
 expect(data.metrics.byChannel).toEqual([{channel:'app',attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]);
 expect(result.evidenceIds).toEqual(['company-data:'+f.fixture.adapter.connectorId+':'+data.queryId]);expect(f.fixture.counts().queries).toBe(1);expect(f.fixture.counts().checks).toBeGreaterThan(0);
 const rows=await auditRows(f.ctx);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({tenant_id:f.ctx.tenantId,owner_id:f.ctx.actorId,template_key:'payments.success_rate_daily',template_version:'1.0.0',params_hash:dataParametersHash(syntheticDataQuery),query_id:data.queryId,status:'OK',completeness:'COMPLETE',count_text:'5',evidence_ref:'company-data:'+f.fixture.adapter.connectorId+':'+data.queryId});
 expect(JSON.stringify(rows[0])).not.toContain(syntheticDataQuery.start);expect(JSON.stringify(rows[0])).not.toContain('parameters');expect(Object.keys(rows[0])).not.toContain('params');
 expect((await db.scope({tenantId:randomUUID(),actorId:randomUUID()},c=>c.query('SELECT id FROM data_executions'))).rowCount).toBe(0);
 await expect(appDb.scope(f.ctx,c=>c.query('SELECT id FROM data_executions'))).rejects.toMatchObject({code:'42501'});
});
it('T077 component: EMPTY, TRUNCATED, SAMPLED and DENIED remain distinct and are audited truthfully',async()=>{
 for(const mode of ['empty','truncated','sampled','denied'] as const){
  const f=await fresh();if(mode==='denied')f.fixture.modes.queryDeny=true;else f.fixture.modes[mode]=true;const result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());
  expect(result.status,mode).toBe(mode==='empty'?'EMPTY':mode==='denied'?'DENIED':'PARTIAL');expect(result.completeness,mode).toBe(mode==='empty'?'COMPLETE':mode==='truncated'?'TRUNCATED':mode==='sampled'?'SAMPLED':'UNKNOWN');if(mode==='denied')expect(result.data).toBeUndefined();
  const rows=await auditRows(f.ctx);expect(rows).toHaveLength(1);expect(rows[0],mode).toMatchObject({template_key:'payments.success_rate_daily',template_version:'1.0.0',status:mode==='empty'?'EMPTY':mode==='denied'?'DENIED':'PARTIAL',completeness:mode==='empty'?'COMPLETE':mode==='truncated'?'TRUNCATED':mode==='sampled'?'SAMPLED':'UNKNOWN',params_hash:dataParametersHash(syntheticDataQuery)});
  if(mode==='denied'){expect(rows[0]?.query_id).toBeNull();expect(f.fixture.counts().queryAttempts).toBe(1);expect(f.fixture.counts().queries).toBe(0);}else expect(f.fixture.counts().queries).toBe(1);
 }
});
it('rejects unknown templates locally and upstream scope substitutions without fabricating a result',async()=>{
 const unknown=await fresh(),denied=await unknown.gateway.execute(unknown.ctx,unknown.lease,name,{...syntheticDataQuery,templateKey:'payments.unknown'},signal());
 expect(denied.status).toBe('DENIED');expect(denied.data).toBeUndefined();expect(unknown.fixture.counts().attempts).toBe(0);expect(await auditRows(unknown.ctx)).toHaveLength(0);
 const forged=await fresh();forged.fixture.modes.mutate=value=>{if(value['operation']==='QUERY')value['tenantId']=randomUUID();return value;};
 const rejected=await forged.gateway.execute(forged.ctx,forged.lease,name,syntheticDataQuery,signal());expect(rejected).toMatchObject({status:'PERMANENT_ERROR',remediation:{kind:'COMPANY_DATA_RESPONSE_INVALID'}});expect(rejected.data).toBeUndefined();expect(forged.fixture.counts().queries).toBe(1);
 const rows=await auditRows(forged.ctx);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'PERMANENT_ERROR',completeness:'UNKNOWN',query_id:null,row_count:'0',params_hash:dataParametersHash(syntheticDataQuery)});
});
it('keeps the local data scope authoritative: a revoked scope performs no upstream call and writes no result',async()=>{
 const f=await fresh();await root.query('UPDATE company_data_scopes SET revoked_at=clock_timestamp() WHERE id=$1',[f.fixture.scope.id]);
 const result=await f.gateway.execute(f.ctx,f.lease,name,syntheticDataQuery,signal());expect(result.status).toBe('DENIED');expect(result.data).toBeUndefined();expect(f.fixture.counts().attempts).toBe(0);expect(await auditRows(f.ctx)).toHaveLength(0);
 expect(dataTemplateHash(f.fixture.template)).toBe(f.fixture.scope.templateHash);expect(canonical(f.fixture.scope.rowScope)).toBe(canonical({tenant_id:'A',department_id:'d_pay'}));
});
