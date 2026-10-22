import '../support/isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {config,secret} from '../../packages/config/src/index.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from '../../packages/company/src/data.js';
import {DataTemplateAdministration} from '../../packages/company/src/data-template-administration.js';
import {dataTemplateHash,loadDataTemplates,type DataTemplate} from '../../packages/company/src/data-templates.js';
import {companyDataFixture,syntheticDataQuery} from '../support/company-data-mcp.js';
import {createServer} from '../../apps/api/src/server.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,8),appDb=new Database(secret('DATABASE_URL')!,8),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault);
const rootDirectory=fileURLToPath(new URL('../..',import.meta.url)),templateDirectory=join(rootDirectory,'config/data-templates'),goldenDirectory=join(rootDirectory,'config/data-goldens'),templates=await loadDataTemplates(templateDirectory);
const apis:Awaited<ReturnType<typeof createServer>>[]=[],fixtures:Awaited<ReturnType<typeof companyDataFixture>>[]=[];
afterAll(async()=>{for(const fixture of fixtures)await fixture.close();for(const api of apis)await api.app.close();await db.close();await appDb.close();await root.end();});
async function variant(options:{version:string;key?:string;status?:DataTemplate['status'];certification?:boolean;tamper?:boolean;omitGolden?:boolean}){
 const directory=await mkdtemp(join(tmpdir(),'anthys-template-registry-')),goldens=await mkdtemp(join(tmpdir(),'anthys-template-goldens-'));
 const template:DataTemplate={...structuredClone(templates.templates[0]!),key:options.key??templates.templates[0]!.key,version:options.version,status:options.status??templates.templates[0]!.status};
 if(options.certification===false)delete template.certification;
 await writeFile(join(directory,`${template.key}.json`),JSON.stringify(template));
 const registry=await loadDataTemplates(directory);
 if(!options.omitGolden){
  const golden=JSON.parse(await readFile(join(goldenDirectory,'payments.success_rate_daily.1.0.0.json'),'utf8'));
  golden.templateKey=template.key;golden.templateVersion=template.version;golden.templateHash=dataTemplateHash(template);
  if(options.tamper)golden.cases[0].expected.attempts='9';
  await writeFile(join(goldens,`${template.key}.${template.version}.json`),JSON.stringify(golden));
 }
 return {registry,goldens,template};
}
function administration(registry=templates,directory=goldenDirectory){return new DataTemplateAdministration(appDb,registry,directory);}
async function fresh(){
 const tenant=randomUUID(),admin={tenantId:tenant,actorId:randomUUID()},employee={tenantId:tenant,actorId:randomUUID()};
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic template lifecycle','ACTIVE')",[tenant,'synthetic-template-'+tenant]);
 for(const person of [admin,employee])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic actor','ACTIVE')",[tenant,person.actorId,'synthetic-'+person.actorId]);
 const roleId=randomUUID();await root.query('INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,$3)',[tenant,roleId,'TENANT_ADMIN']);
 await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id,managed_review_hash,managed_by) VALUES($1,$2,$3,$4,'TENANT',$1::uuid::text,$5,$4)",[tenant,randomUUID(),roleId,admin.actorId,'a'.repeat(64)]);
 const service=administration(),api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),dataTemplates:service});apis.push(api);
 const login=async(person:typeof admin)=>{const token=await api.sessions.create(person);return {p:(await api.sessions.authenticate(token.cookie))!,cookie:'oa_session='+token.cookie,csrf:token.csrf};};
 return {tenant,admin,employee,service,api,a:await login(admin),e:await login(employee)};
}
const publishInput={templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',reviewReference:'synthetic-template-publish'};
it('publishes one exact certified version with immutable receipts and rejects overwrite attempts',async()=>{
 const f=await fresh(),key=randomUUID(),result=await f.service.publish(f.a.p,publishInput,key);
 expect(result).toMatchObject({templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',activeVersion:'1.0.0',activeRevision:1,operation:'PUBLISH',replayed:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
 const list=await f.service.list(f.a.p);expect(list).toMatchObject({truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
 expect(list.items).toEqual([expect.objectContaining({templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',templateHash:'970e2f6ead6741b0609c0d19e13e40a489bc5bfba7a7cb390bca052233bbd344',certificationReference:'LOCAL_TEMPLATE_CERTIFICATION_20261013',active:true,activeVersion:'1.0.0',activeRevision:1})]);
 expect((await f.service.publish(f.a.p,publishInput,key)).replayed).toBe(true);
 await expect(f.service.publish(f.a.p,publishInput,randomUUID())).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_VERSION_EXISTS',status:409});
 await expect(f.service.publish(f.a.p,{...publishInput,reviewReference:'synthetic-template-altered'},key)).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_REQUEST_CONFLICT',status:409});
 await expect(f.service.list(f.e.p)).rejects.toMatchObject({code:'PERMISSION_ADMIN_DENIED',status:403});
 await expect(f.service.publish(f.e.p,publishInput,randomUUID())).rejects.toMatchObject({code:'PERMISSION_ADMIN_DENIED',status:403});
 await expect(f.service.publish(f.a.p,{...publishInput,reviewReference:'short'},randomUUID())).rejects.toBeInstanceOf(Error);
 expect((await root.query('SELECT count(*)::int n FROM company_data_template_requests WHERE tenant_id=$1',[f.tenant])).rows[0].n).toBe(1);
 await expect(root.query("UPDATE company_data_template_versions SET template_hash=$1 WHERE tenant_id=$2",['f'.repeat(64),f.tenant])).rejects.toMatchObject({message:'PERMISSION_RECORD_IMMUTABLE'});
 await expect(root.query('DELETE FROM company_data_template_requests WHERE tenant_id=$1',[f.tenant])).rejects.toMatchObject({message:'PERMISSION_RECORD_IMMUTABLE'});
 await expect(appDb.scope(f.a.p,c=>c.query('SELECT * FROM company_data_template_versions'))).resolves.toBeDefined();
 await expect(appDb.scope(f.a.p,c=>c.query('SELECT * FROM company_data_template_requests'))).rejects.toMatchObject({code:'42501'});
});
it('rolls back only to an unchanged published artifact and enforces revision CAS',async()=>{
 const f=await fresh();await f.service.publish(f.a.p,publishInput,randomUUID());
 const next=await variant({version:'1.1.0'}),upgraded=administration(next.registry,next.goldens);
 const published=await upgraded.publish(f.a.p,{...publishInput,templateVersion:'1.1.0',reviewReference:'synthetic-template-upgrade'},randomUUID());
 expect(published).toMatchObject({activeVersion:'1.1.0',activeRevision:2});
 const rollbackKey=randomUUID(),rolled=await f.service.rollback(f.a.p,{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',expectedRevision:2,reviewReference:'synthetic-template-rollback'},rollbackKey);
 expect(rolled).toMatchObject({operation:'ROLLBACK',templateVersion:'1.0.0',activeVersion:'1.0.0',activeRevision:3,replayed:false});
 expect(await f.service.rollback(f.a.p,{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',expectedRevision:2,reviewReference:'synthetic-template-rollback'},rollbackKey)).toMatchObject({replayed:true,currentActiveVersion:'1.0.0',currentActiveRevision:3});
 await expect(f.service.rollback(f.a.p,{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',expectedRevision:2,reviewReference:'synthetic-template-stale'},randomUUID())).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_VERSION_CONFLICT',status:409});
 await expect(f.service.rollback(f.a.p,{templateKey:'payments.success_rate_daily',templateVersion:'9.9.9',expectedRevision:3,reviewReference:'synthetic-template-unknown'},randomUUID())).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_UNKNOWN',status:404});
 await expect(appDb.scope(f.a.p,c=>c.query('SELECT public.oa_company_data_template_admin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value',['ROLLBACK','payments.success_rate_daily','1.1.0',dataTemplateHash(next.template),templates.templates[0]!.certification!.reference,'f'.repeat(64),3,'synthetic-template-mismatch',randomUUID(),f.a.p.sessionId]))).rejects.toMatchObject({message:'COMPANY_DATA_TEMPLATE_VERSION_MISMATCH'});
 const list=await f.service.list(f.a.p);
 expect(list.items.map(item=>[item.templateVersion,item.active,item.activeRevision])).toEqual([['1.0.0',true,3],['1.1.0',false,3]]);
});
it('refuses unapproved, unoracled, missing and tampered local certification material',async()=>{
 const f=await fresh(),unapproved=await variant({version:'2.0.0',status:'VALIDATED',certification:false});
 await expect(administration(unapproved.registry,unapproved.goldens).publish(f.a.p,{...publishInput,templateVersion:'2.0.0',reviewReference:'synthetic-template-unapproved'},randomUUID())).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_NOT_CERTIFIED',status:403});
 const unoracled=await variant({version:'2.0.0',key:'orders.count_daily'});
 await expect(administration(unoracled.registry,unoracled.goldens).publish(f.a.p,{...publishInput,templateKey:'orders.count_daily',templateVersion:'2.0.0',reviewReference:'synthetic-template-unoracled'},randomUUID())).rejects.toMatchObject({code:'DATA_TEMPLATE_GOLDEN_UNAVAILABLE',status:503});
 const tampered=await variant({version:'2.0.0',tamper:true});
 await expect(administration(tampered.registry,tampered.goldens).publish(f.a.p,{...publishInput,templateVersion:'2.0.0',reviewReference:'synthetic-template-tampered'},randomUUID())).rejects.toMatchObject({code:'DATA_TEMPLATE_GOLDEN_INVALID',status:409});
 const missing=await variant({version:'2.0.0',omitGolden:true});
 await expect(administration(missing.registry,missing.goldens).publish(f.a.p,{...publishInput,templateVersion:'2.0.0',reviewReference:'synthetic-template-missing'},randomUUID())).rejects.toMatchObject({code:'DATA_TEMPLATE_GOLDEN_UNAVAILABLE',status:503});
 await expect(f.service.publish(f.a.p,{...publishInput,templateVersion:'9.9.9',reviewReference:'synthetic-template-unknown'},randomUUID())).rejects.toMatchObject({code:'COMPANY_DATA_TEMPLATE_UNKNOWN',status:404});
 expect((await root.query('SELECT count(*)::int n FROM company_data_template_versions WHERE tenant_id=$1',[f.tenant])).rows[0].n).toBe(0);
});
it('serves the lifecycle over authenticated CSRF-protected HTTP routes',async()=>{
 const f=await fresh(),origin='http://localhost:64700',headers={cookie:f.a.cookie,'x-csrf-token':f.a.csrf,origin};
 const published=await f.api.app.inject({method:'POST',url:'/api/v1/data/templates/publish',headers:{...headers,'idempotency-key':randomUUID()},payload:publishInput});
 expect(published.statusCode).toBe(200);expect(published.json()).toMatchObject({data:{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',activeVersion:'1.0.0',activeRevision:1,liveVerified:false}});
 expect(published.headers['cache-control']).toBe('private, no-store');
 const listed=await f.api.app.inject({method:'GET',url:'/api/v1/data/templates',headers:{cookie:f.a.cookie}});
 expect(listed.statusCode).toBe(200);expect(listed.json()).toMatchObject({data:{items:[{templateVersion:'1.0.0',active:true}],truncated:false}});
 const forged=await f.api.app.inject({method:'POST',url:'/api/v1/data/templates/publish',headers:{cookie:f.a.cookie,origin,'idempotency-key':randomUUID()},payload:publishInput});
 expect(forged.statusCode).toBe(403);expect(forged.json()).toMatchObject({error:{code:'CSRF_REQUIRED'}});
 const invalid=await f.api.app.inject({method:'POST',url:'/api/v1/data/templates/rollback',headers:{...headers,'idempotency-key':randomUUID()},payload:{templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',expectedRevision:1,reviewReference:'synthetic-template-rollback',rawSql:'select 1'}});
 expect(invalid.statusCode).toBe(400);expect(invalid.json()).toMatchObject({error:{code:'INVALID_INPUT'}});
 const denied=await f.api.app.inject({method:'GET',url:'/api/v1/data/templates',headers:{cookie:f.e.cookie}});
 expect(denied.statusCode).toBe(403);expect(denied.json()).toMatchObject({error:{code:'PERMISSION_ADMIN_DENIED'}});
});
it('blocks new and retained execution against a superseded template version',async()=>{
 const tenant=randomUUID(),actor={tenantId:tenant,actorId:randomUUID()};
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic template gate','ACTIVE')",[tenant,'synthetic-template-gate-'+tenant]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic actor','ACTIVE')",[tenant,actor.actorId]);
 const roleId=randomUUID();await root.query('INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,$3)',[tenant,roleId,'TENANT_ADMIN']);
 await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id,managed_review_hash,managed_by) VALUES($1,$2,$3,$4,'TENANT',$1::uuid::text,$5,$4)",[tenant,randomUUID(),roleId,actor.actorId,'a'.repeat(64)]);
 const api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),dataTemplates:administration()});apis.push(api);
 const token=await api.sessions.create(actor),principal=(await api.sessions.authenticate(token.cookie))!;
 const binding={corpId:tenant,robotCode:'synthetic-data-robot',appOrigin:'http://localhost:64700'},msgId=randomUUID(),event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:msgId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId,chatbotCorpId:tenant,senderCorpId:tenant,senderStaffId:actor.actorId,conversationId:'synthetic-template-gate-'+actor.actorId,conversationType:'1',robotCode:binding.robotCode,msgtype:'text',text:{content:'Query the active certified payments template'},createAt:Date.now(),senderId:actor.actorId,chatbotUserId:'bot',sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-template-gate',sessionWebhookExpiredTime:Date.now()+600000})};
 const task=(await new DingTalkIngress(db,vault,{tenantId:tenant,...binding}).acceptTrustedCallback(event))!,runId=(await db.scope(actor,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[task.taskId]))).rows[0].id as string,lease=(await store.acquire(actor,runId,'synthetic-template-gate'))!,fixture=await companyDataFixture(root,actor,runId);fixtures.push(fixture);
 await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'company.data.query','1.0.0','{}',$3,'READ','READY')",[tenant,randomUUID(),companyDataBindingHash(fixture.adapter.connectorId,fixture.adapter.connectionBinding,fixture.adapter.toolName,fixture.adapter.inputSchemaHash,fixture.adapter.templates.registryHash)]);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'company.data.query',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour')",[tenant,randomUUID(),actor.actorId,fixture.resource]);
 const gateway=new Gateway(store),name=toolName('company.data.query','1.0.0'),signal=()=>new AbortController().signal;registerCompanyDataCapabilities(gateway,fixture.adapter);
 const first=await gateway.execute(actor,lease,name,syntheticDataQuery,signal());expect(first.status).toBe('OK');const attempts=fixture.counts().attempts;
 expect((await appDb.scope(actor,c=>c.query("SELECT public.oa_company_data_template_is_active('payments.success_rate_daily','1.0.0') active"))).rows[0].active).toBe(true);
 const next=await variant({version:'1.1.0'});
 await administration(next.registry,next.goldens).publish(principal,{templateKey:'payments.success_rate_daily',templateVersion:'1.1.0',reviewReference:'synthetic-template-gate'},randomUUID());
 expect((await appDb.scope(actor,c=>c.query("SELECT public.oa_company_data_template_is_active('payments.success_rate_daily','1.0.0') active"))).rows[0].active).toBe(false);
 const denied=await gateway.execute(actor,lease,name,syntheticDataQuery,signal());expect(denied.status).toBe('DENIED');expect(denied.data).toBeUndefined();expect(fixture.counts().attempts).toBe(attempts);
 expect((await db.scope(actor,c=>c.query('SELECT count(*)::int n FROM data_executions'))).rows[0].n).toBe(1);
});
