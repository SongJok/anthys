import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
export async function browserControls(store:RuntimeStore,tenantId:string,ownerId:string){
 const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),fixtures:Record<string,unknown>={};
 try{for(const project of ['desktop','mobile']){
  const externalId='synthetic-console-'+project,operatorId=((await root.query('SELECT id FROM users WHERE tenant_id=$1 AND external_user_id=$2',[tenantId,externalId])).rows[0]?.id as string|undefined)??randomUUID(),unionId=externalId+'-union',ctx={tenantId,actorId:ownerId},task=await new TaskStore(store.db).create(ctx,'synthetic control console '+project,randomUUID()),lease=(await store.acquire(ctx,task.runId,'console-browser-setup'))!,gateway=new Gateway(store),actions:Record<string,{id:string;capability:string}>={};
  await root.query("UPDATE users SET union_id=NULL,status='DEPARTED',auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND union_id=$2 AND external_user_id<>$3",[tenantId,unionId,externalId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,union_id,display_name,status) VALUES($1,$2,$3,$4,'synthetic console operator','ACTIVE') ON CONFLICT(tenant_id,external_user_id) DO UPDATE SET union_id=excluded.union_id,status='ACTIVE'",[tenantId,operatorId,externalId,unionId]);await root.query("UPDATE role_bindings SET revoked_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND revoked_at IS NULL AND role_id IN (SELECT id FROM roles WHERE tenant_id=$1 AND name='SECURITY_OPERATOR')",[tenantId,operatorId]);await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'SECURITY_OPERATOR') ON CONFLICT(tenant_id,name) DO NOTHING",[tenantId,randomUUID()]);await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='SECURITY_OPERATOR'),$3,'TASK',$4)",[tenantId,randomUUID(),operatorId,task.taskId]);
  for(const claim of ['APPLIED','NOT_APPLIED','INCONCLUSIVE']){
   const capability='synthetic.console.'+project+'.'+claim.toLowerCase();gateway.register({...syntheticResultContract,id:capability,version:'1.0.0',description:'Synthetic control console database write',risk:'SHARED_WRITE',provider:'CORE',state:'READY',bindingHash:'synthetic-console-reviewed-v1',schema:z.object({note:z.string()}).strict(),jsonSchema:{type:'object',properties:{note:{type:'string'}},required:['note']},resource:(_a,l)=>l.taskId,approvalPreview:()=>({operation:'Synthetic isolated console test'}),operationAudience:(_a,l)=>l.audience,execute:async(args,{principal,lease,actionKey})=>{const receipt=randomUUID();await store.db.scope(principal,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_CONSOLE_WRITE',$4,$5,$6,now())",[tenantId,receipt,ownerId,lease.runId,JSON.stringify(args),actionKey]));return {status:'OK',data:{receipt},evidenceIds:[receipt],completeness:'COMPLETE'};},verify:async(result,_args,{principal})=>{const q=await store.db.scope(principal,c=>c.query("SELECT id FROM outbox WHERE id=$1 AND kind='SYNTHETIC_CONSOLE_WRITE'",[(result.data as {receipt:string}).receipt]));return {...result,verification:{state:q.rowCount?'VERIFIED':'MISMATCH',method:'SYNTHETIC_POSTGRES_READ_BACK'}};}});
   const result=await gateway.execute(ctx,lease,toolName(capability,'1.0.0'),{note:'CONSOLE_PRIVATE_PARAMETER_SENTINEL'},AbortSignal.timeout(5000));if(result.status!=='NEEDS_APPROVAL')throw Error('CONSOLE_FIXTURE_SETUP_FAILED');const action=(await store.db.scope(ctx,c=>c.query('SELECT id FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[task.runId,capability]))).rows[0].id as string;actions[claim]={id:action,capability};
  }
  // An explicitly synthetic uncertified prior-outcome fixture. No approval or
  // business execution is fabricated; browser tests must prove zero effects.
  await root.query("UPDATE tool_actions SET state='UNKNOWN' WHERE run_id=$1",[task.runId]);await store.pause(ctx,lease,'WAITING_USER','RECONCILIATION_REQUIRED');fixtures[project]={tenantId,ownerId,operatorId,...task,actions};
 }}finally{await root.end();}await writeFile('.data/test-environment/browser-control-fixtures.json',JSON.stringify(fixtures),{mode:0o600});
}
