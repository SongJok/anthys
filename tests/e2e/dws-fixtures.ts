import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type pg from 'pg';
import type {Database,DbContext} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
import {registerDwsCapabilities,dwsContactBindingHash} from '../../packages/dws/src/capabilities.js';
import {dwsFixture} from '../support/dws-cli.js';

// Only the guarded test server imports this bootstrap. It supplies synthetic
// identity state to the real verifier, gateway and finalizer; it is not OAuth
// enrollment, a production credential import, or live DingTalk acceptance.
export async function browserDws(db:Database,vault:Vault,admin:pg.Pool,tenantId:string,unconnectedActor:string){
 const fixture=await dwsFixture({documents:true}),service=new DwsIdentities(db,vault,fixture.runner),store=new RuntimeStore(db,vault),tasks=new TaskStore(db),records:Record<string,{taskId:string;missingAuthTaskId:string;userId:string;actorId:string}>={};
 try{
  await admin.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,'dws.contact.me','1.0.0','{}',$3,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,state='READY'",[tenantId,randomUUID(),dwsContactBindingHash(service)]);
  for(const project of ['desktop','mobile']){
   const ctx:DbContext={tenantId,actorId:randomUUID()},subject={corpId:'TENANT_A',userId:'synthetic-dws-browser-'+project},unionId='synthetic-dws-'+project+'-union';
   await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id) VALUES($1,$2,$3,$3,'ACTIVE',$4) ON CONFLICT(tenant_id,external_user_id) DO UPDATE SET union_id=excluded.union_id,status='ACTIVE' RETURNING id",[tenantId,ctx.actorId,subject.userId,unionId]).then(result=>{ctx.actorId=result.rows[0].id as string;});
   await service.enroll(ctx,fixture.state(subject),await service.beginEnrollment(ctx),new AbortController().signal);
   await admin.query('UPDATE dws_identities SET model_egress_allowed=true WHERE tenant_id=$1 AND owner_id=$2',[tenantId,ctx.actorId]);
   await admin.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'dws.contact.me',$4,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',now()+interval '1 hour') ON CONFLICT(tenant_id,actor_id,capability_id,resource_id,audience_kind,audience_id) DO UPDATE SET revoked_at=NULL,classification_ceiling='RESTRICTED',expires_at=excluded.expires_at",[tenantId,randomUUID(),ctx.actorId,'dws:self:'+ctx.actorId]);
   const task=await tasks.create(ctx,'读取本人办公资料 '+project,randomUUID()),lease=(await store.acquire(ctx,task.runId,'browser-dws'))!,gateway=new Gateway(store);registerDwsCapabilities(gateway,service);
   const args={authorizationVersion:(await service.connection(ctx)).authorizationVersion!},name=toolName('dws.contact.me','1.0.0'),callId='browser-dws-self-read',result=await gateway.execute(ctx,lease,name,args,new AbortController().signal);
   if(result.status!=='OK')throw Error('BROWSER_DWS_SOURCE_FAILED');
   await store.append(ctx,lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
   await store.append(ctx,lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});
   await gateway.finalize(ctx,lease,JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/profile',expected:(result.data as {profile:unknown}).profile,coverage:'COMPLETE'}],outcome:'COMPLETE'}));
   const stored=await tasks.get(ctx,task.taskId);if(stored?.runs[0]?.status!=='SUCCEEDED')throw Error('BROWSER_DWS_FINALIZATION_FAILED');
   const missingCtx={tenantId,actorId:unconnectedActor},missing=await tasks.create(missingCtx,'连接本人办公权限后继续 '+project,randomUUID()),missingGateway=new Gateway(store);registerDwsCapabilities(missingGateway,service);
   await new AgentRuntime(store,{complete:async()=>({message:{role:'assistant',content:null,tool_calls:[{id:'browser-dws-auth',type:'function',function:{name:toolName('dws.connection.status','1.0.0'),arguments:JSON.stringify({requestNonce:randomUUID()})}}]},usage:null,finishReason:'tool_calls',requestId:'synthetic-browser-dws-auth'})},missingGateway).advance(missingCtx,missing.runId);
   const missingState=await tasks.get(missingCtx,missing.taskId);if(missingState?.runs[0]?.status!=='WAITING_AUTH'||missingState.runs[0].last_error!=='DWS_USER_CONSENT_REQUIRED')throw Error('BROWSER_DWS_AUTH_STATE_FAILED');
   records[project]={taskId:task.taskId,missingAuthTaskId:missing.taskId,userId:subject.userId,actorId:ctx.actorId};
  }
  await writeFile('.data/test-environment/browser-dws-fixtures.json',JSON.stringify(records),{mode:0o600});return fixture;
 }catch(error){await fixture.close();throw error;}
}
