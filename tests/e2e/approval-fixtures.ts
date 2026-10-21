import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import pg from 'pg';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import type {Sessions} from '../../packages/identity/src/sessions.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
export async function prepareBrowserApprovals(store:RuntimeStore,tenantId:string,ownerId:string,reviewerId:string){
 const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),pending:Record<string,{actionId:string;taskId:string;runId:string;capability:string;ownerId:string;tenantId:string}>={};
 try{for(const project of ['desktop','mobile']){
  const ctx={tenantId,actorId:ownerId},task=await new TaskStore(store.db).create(ctx,'synthetic browser approval '+project,randomUUID()),lease=(await store.acquire(ctx,task.runId,'browser-approval-setup'))!,gateway=new Gateway(store),capability='synthetic.browser.approval.'+project+'.'+randomUUID();
  gateway.register({...syntheticResultContract,id:capability,version:'1.0.0',description:'Isolated synthetic database write',risk:'SHARED_WRITE',provider:'CORE',state:'READY',bindingHash:'synthetic-browser-reviewed-v1',schema:z.object({note:z.string()}).strict(),jsonSchema:{type:'object',properties:{note:{type:'string'}},required:['note']},resource:(_args,l)=>l.taskId,approvalPreview:()=>({操作:'浏览器隔离测试写入',对象:'测试数据库'}),operationAudience:(_args,l)=>l.audience,execute:async(args,{principal,actionKey,lease})=>{const id=randomUUID();await store.db.scope(principal,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_BROWSER_WRITE',$4,$5,$6,now())",[tenantId,id,ownerId,lease.runId,JSON.stringify(args),actionKey]));return {status:'OK',evidenceIds:[id],completeness:'COMPLETE',data:{id}};},verify:async(result,_args,{principal})=>{const q=await store.db.scope(principal,c=>c.query("SELECT id FROM outbox WHERE id=$1 AND kind='SYNTHETIC_BROWSER_WRITE'",[(result.data as {id:string}).id]));return {...result,verification:{state:q.rowCount?'VERIFIED':'MISMATCH',method:'SYNTHETIC_DATABASE_READ_BACK'}};}});
  const result=await gateway.execute(ctx,lease,toolName(capability,'1.0.0'),{note:'BROWSER_APPROVAL_PRIVATE_INPUT_SENTINEL'},AbortSignal.timeout(5000));if(result.status!=='NEEDS_APPROVAL')throw Error('BROWSER_APPROVAL_SETUP_FAILED');const action=(await store.db.scope(ctx,c=>c.query('SELECT id FROM tool_actions WHERE run_id=$1',[task.runId]))).rows[0].id as string;await store.pause(ctx,lease,'WAITING_APPROVAL','APPROVAL_REQUIRED');
  await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'ACTION_APPROVER') ON CONFLICT(tenant_id,name) DO NOTHING",[tenantId,randomUUID()]);await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='ACTION_APPROVER'),$3,'RESOURCE',$4)",[tenantId,randomUUID(),reviewerId,task.taskId]);
  pending[project]={actionId:action,taskId:task.taskId,runId:task.runId,capability,ownerId,tenantId};
 }}finally{await root.end();}
 // All reviewer roles are provisioned before any caller creates actor-bound
 // tasks, credentials, card tokens or approval snapshots for the browser run.
 return async(app:FastifyInstance,sessions:Sessions)=>{
  const fixtures:Record<string,typeof pending[string]&{approvalId:string}>={};
  for(const [project,item] of Object.entries(pending)){
   const session=await sessions.create({tenantId,actorId:ownerId}),requested=await app.inject({method:'POST',url:`/api/v1/actions/${item.actionId}/approvals`,headers:{cookie:`oa_session=${session.cookie}`,origin:'http://localhost:52339','x-csrf-token':session.csrf},payload:{approverId:reviewerId}});if(requested.statusCode!==200)throw Error('BROWSER_APPROVAL_REQUEST_FAILED');fixtures[project]={...item,approvalId:requested.json().data.id as string};
  }
  await writeFile('.data/test-environment/browser-approval-fixtures.json',JSON.stringify(fixtures),{mode:0o600});
 };

}
