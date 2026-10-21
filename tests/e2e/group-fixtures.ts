import '../support/isolation.js';
import {writeFile} from 'node:fs/promises';
import type pg from 'pg';
import type {Database} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import type {Gateway} from '../../packages/gateway/src/index.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
export async function browserGroups(root:pg.Pool,db:Database,vault:Vault,tenantId:string,reader:Gateway){
 const f=await groupRuntimeFixture(root,db,vault,{tenantId,corpId:'TENANT_A'}),records:Record<string,{taskId:string;runId:string;goal:string;answer:string}>={desktop:{taskId:f.taskId,runId:f.runId,goal:f.goal,answer:f.answer}};
 await root.query("UPDATE users SET union_id=NULL WHERE tenant_id=$1 AND union_id='synthetic-group-browser-union'",[tenantId]);
 await root.query("UPDATE users SET union_id='synthetic-group-browser-union' WHERE tenant_id=$1 AND id=$2",[tenantId,f.ctx.actorId]);
 const next=(await f.ingress.acceptTrustedCallback(f.callback(f.goal)))!,runId=(await db.scope(f.ctx,c=>c.query('SELECT id FROM runs WHERE task_id=$1',[next.taskId]))).rows[0].id as string;records['mobile']={taskId:next.taskId,runId,goal:f.goal,answer:f.answer};reader.store.configureGroupAudience(f.audience);
 await writeFile('.data/test-environment/browser-group-fixtures.json',JSON.stringify(records),{mode:0o600});
 let timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|null=null;const start=()=>{timer=setInterval(()=>{if(pending)return;pending=(async()=>{for(const record of Object.values(records)){const reply=(await db.scope(f.ctx,c=>c.query("SELECT id,worker_generation,created_at FROM group_clarification_messages WHERE run_id=$1 AND state='PENDING'",[record.runId]))).rows[0];
   // A test worker delay makes the genuine durable PENDING state observable.
   // Its authority checks and continuation use the production implementation.
   if(reply&&Date.now()-new Date(reply.created_at as string).getTime()>=2000)await f.gateway.processGroupReply(f.ctx,reply.id as string,Number(reply.worker_generation));
   const run=(await db.scope(f.ctx,c=>c.query('SELECT status,retry_generation,group_reply_id FROM runs WHERE id=$1',[record.runId]))).rows[0];if(run.status==='QUEUED'&&!run.group_reply_id)await f.runtime.advance(f.ctx,record.runId,undefined,undefined,Number(run.retry_generation));
  }})().finally(()=>{pending=null;});},100);timer.unref();};
 return {start,close:async()=>{clearInterval(timer);await pending;await f.close();}};
}
