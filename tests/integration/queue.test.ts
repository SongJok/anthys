import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {loadEnvFile,secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {RunQueue} from '../../packages/tasks/src/queue.js';
import {ids,seed} from '../../scripts/seed.js';
loadEnvFile();const db=new Database(secret('DATABASE_URL')!),runtimeDb=new Database(secret('RUNTIME_DATABASE_URL')!),queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'synthetic-outbox-'+randomUUID()),admin=new Database(secret('MIGRATION_DATABASE_URL')!);
const ctx={tenantId:ids.tenantA,actorId:randomUUID()};
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);await admin.scope(ctx,c=>c.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic queue','ACTIVE')",[ctx.tenantId,ctx.actorId,'synthetic-queue-'+ctx.actorId]));await queue.start();});afterAll(async()=>{await queue.stop();await db.close();await runtimeDb.close();await admin.close();});
it('T005 committed outbox survives publisher absence and is recovered to real pg-boss queue',async()=>{
 const job=await new TaskStore(db).create(ctx,'synthetic outbox crash test',randomUUID());
 const pending=await db.scope(ctx,c=>c.query('SELECT published_at FROM outbox WHERE aggregate_id=$1',[job.runId]));expect(pending.rows[0].published_at).toBeNull();
 expect(await queue.publish(runtimeDb,ctx)).toBeGreaterThan(0);
 const jobs=await queue.boss.findJobs<{runId:string}>(queue.queueName);expect(jobs.some(j=>j.data.runId===job.runId)).toBe(true);
 expect(await queue.publish(runtimeDb,ctx)).toBe(0);
 const published=await db.scope(ctx,c=>c.query('SELECT published_at FROM outbox WHERE aggregate_id=$1',[job.runId]));expect(published.rows[0].published_at).not.toBeNull();
});
it('T005 SIGKILL of the actual ingress process after durable ACK and before publication recovers exactly one real pg-boss job',async()=>{
 const input={...ctx,externalUserId:'synthetic-queue-'+ctx.actorId,messageId:randomUUID(),conversationId:'synthetic-publication-'+randomUUID()},child=fork(new URL('../support/ingress-publication-process.ts',import.meta.url),[JSON.stringify(input)],{execArgv:['--import','tsx'],env:process.env,stdio:['ignore','pipe','pipe','ipc']});
 child.stdout!.resume();child.stderr!.resume();const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  const committed=await new Promise<{taskId:string;runId:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('INGRESS_COMMIT_BOUNDARY_NOT_REACHED')),10000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('INGRESS_COMMIT_CHILD_EARLY_EXIT'));});
   child.on('message',(raw:unknown)=>{const value=raw as {kind?:string;messageId?:string;taskId?:string;runId?:string};if(value.kind==='FAILED'){clearTimeout(timer);reject(Error('INGRESS_COMMIT_CHILD_FAILED'));}else if(value.kind==='COMMITTED_ACK_BEFORE_PUBLICATION'&&value.messageId===input.messageId&&value.taskId&&value.runId){clearTimeout(timer);resolve({taskId:value.taskId,runId:value.runId});}});
  });
  const before=(await runtimeDb.scope(ctx,c=>c.query("SELECT e.state inbox_state,t.status task_state,r.status run_state,o.published_at FROM tasks t JOIN event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id JOIN outbox o ON o.tenant_id=r.tenant_id AND o.aggregate_id=r.id AND o.kind='RUN' WHERE t.id=$1 AND r.id=$2",[committed.taskId,committed.runId]))).rows;
  expect(before).toEqual([{inbox_state:'ENQUEUED',task_state:'OPEN',run_state:'QUEUED',published_at:null}]);expect((await queue.boss.findJobs<{runId:string}>(queue.queueName)).filter(j=>j.data.runId===committed.runId)).toHaveLength(0);
  expect(child.kill('SIGKILL')).toBe(true);expect((await exited).signal).toBe('SIGKILL');
  expect(await queue.publish(runtimeDb,ctx)).toBe(1);expect((await queue.boss.findJobs<{runId:string}>(queue.queueName)).filter(j=>j.data.runId===committed.runId)).toHaveLength(1);expect(await queue.publish(runtimeDb,ctx)).toBe(0);
  expect((await runtimeDb.scope(ctx,c=>c.query('SELECT published_at FROM outbox WHERE aggregate_id=$1',[committed.runId]))).rows[0].published_at).not.toBeNull();
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});
it('queue role cannot read any business table or tenant messages',async()=>{
 const queueDb=new Database(secret('QUEUE_DATABASE_URL')!);try{await expect(queueDb.scope(ctx,c=>c.query('SELECT * FROM tasks'))).rejects.toMatchObject({code:'42501'});}finally{await queueDb.close();}
});
