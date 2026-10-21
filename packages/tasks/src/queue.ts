import {PgBoss} from 'pg-boss';
import type {Database,DbContext} from '../../storage/src/database.js';
import {z} from 'zod';
import {trialState} from '../../storage/src/trial.js';
export const runJobSchema=z.object({tenantId:z.uuid(),actorId:z.uuid(),runId:z.uuid(),generation:z.number().int().nonnegative().default(0)}).strict();
export const sourceReplyJobSchema=z.object({tenantId:z.uuid(),actorId:z.uuid(),replyId:z.uuid(),generation:z.number().int().nonnegative().default(0)}).strict();
export class RunQueue {
 readonly boss:PgBoss;
 readonly queueName:string;
 constructor(url:string,queueName='run',readonly trialProfileHash:string|null=null) {
  if(trialProfileHash!==null&&!/^[a-f0-9]{64}$/.test(trialProfileHash))throw Error('TRIAL_QUEUE_PROFILE_INVALID');
  this.queueName=trialProfileHash?'trial-'+trialProfileHash:queueName;
  // A restricted worker must not run PgBoss's global maintenance/scheduler over
  // old queues while it is attached to its dedicated RUN queue.
  this.boss=new PgBoss({connectionString:url,schema:'oa_queue',max:5,migrate:false,createSchema:false,...(trialProfileHash?{supervise:false,schedule:false}:{})});
 }
 async start():Promise<void> {await this.boss.start();await this.boss.createQueue(this.queueName,{retryLimit:this.trialProfileHash?0:3,retryDelay:5});if(!this.trialProfileHash){await this.boss.createQueue(this.queueName+'-source-reply',{retryLimit:3,retryDelay:5});await this.boss.createQueue(this.queueName+'-group-reply',{retryLimit:3,retryDelay:5});}}
 async publish(db:Database,ctx:DbContext):Promise<number> {
  return db.scope(ctx,async c=>{
   const trial=await trialState(c,undefined,true);if(trial.restricted&&!trial.allowed)return 0;
   if(this.trialProfileHash!==null&&(this.trialProfileHash!==db.trialProfileHash||!trial.restricted||trial.mode==='FORMAL'))throw Error('TRIAL_QUEUE_PROFILE_MISMATCH');
   if(trial.restricted&&trial.mode!=='FORMAL'&&(!this.trialProfileHash||this.trialProfileHash!==db.trialProfileHash))throw Error('TRIAL_QUEUE_PROFILE_MISMATCH');
   const rows=await c.query("SELECT id,kind,payload_ref FROM outbox WHERE public.oa_lifecycle_run_allowed(CASE WHEN kind='RUN' THEN (payload_ref->>'runId')::uuid WHEN kind='SOURCE_REPLY' THEN (SELECT run_id FROM source_choice_replies WHERE id=(payload_ref->>'replyId')::uuid) WHEN kind='GROUP_REPLY' THEN (SELECT run_id FROM group_clarification_messages WHERE id=(payload_ref->>'replyId')::uuid) END) AND kind IN ('RUN','SOURCE_REPLY','GROUP_REPLY') AND published_at IS NULL ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 50");
   let published=0;for(const row of rows.rows) {
    if(trial.restricted&&trial.mode!=='FORMAL'){const current=await trialState(c,undefined,true);if(!current.allowed)return published;if(row.kind!=='RUN'||row.payload_ref.runId!==current.runId||Number(row.payload_ref.generation??0)!==0)continue;}
    if(row.kind==='SOURCE_REPLY'||row.kind==='GROUP_REPLY'){const job=sourceReplyJobSchema.parse(row.payload_ref);if(job.tenantId!==ctx.tenantId||job.actorId!==ctx.actorId)throw Error('OUTBOX_IDENTITY_MISMATCH');await this.boss.send(this.queueName+(row.kind==='GROUP_REPLY'?'-group-reply':'-source-reply'),job,{singletonKey:`${job.replyId}:${job.generation}`});}else{const job=runJobSchema.parse(row.payload_ref);if(job.tenantId!==ctx.tenantId||job.actorId!==ctx.actorId)throw Error('OUTBOX_IDENTITY_MISMATCH');await this.boss.send(this.queueName,job,{singletonKey:`${job.runId}:${job.generation}`});}await c.query('UPDATE outbox SET published_at=now() WHERE id=$1',[row.id]);published++;}return published;
  });
 }
 async work(handler:(job:z.infer<typeof runJobSchema>)=>Promise<void>):Promise<void> {await this.boss.work(this.queueName,{batchSize:1},async jobs=>{for(const job of jobs) await handler(runJobSchema.parse(job.data));});}
 async workSourceReplies(handler:(job:z.infer<typeof sourceReplyJobSchema>)=>Promise<void>):Promise<void>{if(this.trialProfileHash)throw Error('TRIAL_CONTINUATION_QUEUE_DISABLED');await this.boss.work(this.queueName+'-source-reply',{batchSize:1},async jobs=>{for(const job of jobs)await handler(sourceReplyJobSchema.parse(job.data));});}
 async workGroupReplies(handler:(job:z.infer<typeof sourceReplyJobSchema>)=>Promise<void>):Promise<void>{if(this.trialProfileHash)throw Error('TRIAL_CONTINUATION_QUEUE_DISABLED');await this.boss.work(this.queueName+'-group-reply',{batchSize:1},async jobs=>{for(const job of jobs)await handler(sourceReplyJobSchema.parse(job.data));});}
 async stop():Promise<void> {await this.boss.stop({graceful:true,timeout:5000});}
}
