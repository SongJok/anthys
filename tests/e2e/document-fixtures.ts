import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile,rename} from 'node:fs/promises';
import type pg from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Database,DbContext} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
import {registerDwsCapabilities} from '../../packages/dws/src/capabilities.js';
import {dwsDocumentBindingHash,dwsDocumentResource} from '../../packages/dws/src/document-capability.js';
import {documentContractHash,documentPayloadProfile} from '../../packages/dws/src/document-contract.js';
import type {dwsFixture} from '../support/dws-cli.js';
type DocumentFixture={actorId:string;taskId:string;nodeId:string;canary:string;userId:string};
// Test-only provider ACL state, independent of the application grants. This
// module is never imported by the production server or deployed image.
export async function browserDocuments(db:Database,vault:Vault,admin:pg.Pool,tenantId:string,fixture:Awaited<ReturnType<typeof dwsFixture>>){
 const service=new DwsIdentities(db,vault,fixture.runner),store=new RuntimeStore(db,vault),tasks=new TaskStore(db),records:Record<string,DocumentFixture>={},documents:Record<string,{text:string;revision:string;allowedUsers:string[]}>={},profile=documentPayloadProfile.parse({schemaVersion:1,reviewRef:'synthetic-browser-reviewed-payload',nodePointer:'/data/nodeId',revisionPointer:'/data/revision',textPointer:'/data/markdown',typePointer:'/data/resourceType',typeValue:'adoc',completePointer:'/data/complete',hasMorePointer:'/data/hasMore',cursorPointer:'/data/nextCursor',completenessUnit:'ONE_DOCUMENT_VERSION'});
 await admin.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'dws.doc.read','1.0.0','{}',$3,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,state='READY'",[tenantId,randomUUID(),dwsDocumentBindingHash(service)]);
 for(const project of ['desktop','mobile']){
  const ctx:DbContext={tenantId,actorId:randomUUID()},subject={corpId:'TENANT_A',userId:'synthetic-document-browser-'+project},nodeId='synthetic_browser_doc_'+project,canary='BROWSER_AUTHORIZED_DOCUMENT_'+project;
  ctx.actorId=(await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id) VALUES($1,$2,$3,$3,'ACTIVE',$4) ON CONFLICT(tenant_id,external_user_id) DO UPDATE SET union_id=excluded.union_id,status='ACTIVE' RETURNING id",[tenantId,ctx.actorId,subject.userId,'synthetic-document-'+project+'-union'])).rows[0].id as string;
  await service.enroll(ctx,fixture.state(subject),await service.beginEnrollment(ctx),new AbortController().signal);await admin.query('UPDATE dws_identities SET model_egress_allowed=true WHERE owner_id=$1',[ctx.actorId]);
  await admin.query("INSERT INTO dws_document_scopes(tenant_id,id,owner_id,node_id,payload_profile,binary_hash,schema_hash,contract_hash,authorization_review_ref,classification,model_egress_allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-review','CONFIDENTIAL',true,now()+interval '1 hour') ON CONFLICT(tenant_id,owner_id,node_id) DO UPDATE SET payload_profile=excluded.payload_profile,binary_hash=excluded.binary_hash,schema_hash=excluded.schema_hash,contract_hash=excluded.contract_hash,model_egress_allowed=true,expires_at=excluded.expires_at,revoked_at=NULL",[tenantId,randomUUID(),ctx.actorId,nodeId,JSON.stringify(profile),fixture.runner.config.binaryHash,fixture.runner.config.documentSchemaHash,documentContractHash]);
  await admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'dws.doc.read',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour') ON CONFLICT(tenant_id,actor_id,capability_id,resource_id,audience_kind,audience_id) DO UPDATE SET revoked_at=NULL,classification_ceiling='RESTRICTED',expires_at=excluded.expires_at",[tenantId,randomUUID(),ctx.actorId,dwsDocumentResource(nodeId)]);
  documents[nodeId]={text:canary+'\naccess_token=SYNTHETIC_BROWSER_DOC_PRIVATE_0123456789',revision:'browser-r1',allowedUsers:[subject.userId]};await fixture.mode('doc',{documents});
  const task=await tasks.create(ctx,'查看本人授权文档 '+project,randomUUID()),lease=(await store.acquire(ctx,task.runId,'browser-document'))!,gateway=new Gateway(store);registerDwsCapabilities(gateway,service);const args={nodeId,authorizationVersion:(await service.connection(ctx)).authorizationVersion!,requestNonce:randomUUID(),selector:{kind:'FULL',maxCharacters:6000}},name=toolName('dws.doc.read','1.0.0'),callId='browser-document-'+project,result=await gateway.execute(ctx,lease,name,args,new AbortController().signal);if(result.status!=='OK')throw Error('BROWSER_DOCUMENT_SOURCE_FAILED');
  await store.append(ctx,lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]});await store.append(ctx,lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});await gateway.finalize(ctx,lease,JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'QUOTE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/document/fragments/0/text',quote:canary,coverage:'COMPLETE'}],outcome:'COMPLETE'}));if((await tasks.get(ctx,task.taskId))?.runs[0]?.status!=='SUCCEEDED')throw Error('BROWSER_DOCUMENT_FINAL_FAILED');records[project]={actorId:ctx.actorId,taskId:task.taskId,nodeId,canary,userId:subject.userId};
 }
 await writeFile('.data/test-environment/browser-document-fixtures.json',JSON.stringify(records),{mode:0o600});
 let writes=Promise.resolve();
 return (app:FastifyInstance)=>{app.post<{Params:{project:string}}>('/api/v1/__test/document-revoke/:project',async(req,reply)=>{const input=z.object({revoked:z.boolean().default(true)}).strict().parse(req.body??{}),record=records[req.params.project];if(!record||req.principal?.tenantId!==tenantId||req.principal.actorId!==record.actorId)return reply.code(404).send({error:{code:'NOT_FOUND'}});writes=writes.then(async()=>{documents[record.nodeId]!.allowedUsers=input.revoked?[]:[record.userId];const next=fixture.control+'.next';await writeFile(next,JSON.stringify({mode:'doc',documents}),{mode:0o600});await rename(next,fixture.control);});await writes;return {data:{revoked:input.revoked,synthetic:true}};});};
}
