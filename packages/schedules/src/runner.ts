import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {scheduleIdentity,scheduleAudit,revokeSchedule,Schedules} from './service.js';
import {dueReminder,renderReminder,ScheduleError} from './model.js';
const audience=(owner:string)=>({kind:'PRIVATE_USER',targetId:owner,classificationCeiling:'INTERNAL'});
export class ReminderScheduler {
 constructor(readonly schedules:Schedules){}
 private async block(c:pg.PoolClient,ctx:DbContext,id:string,reason='CURRENT_AUTHORITY_UNAVAILABLE'){
  const blocked=(await c.query("UPDATE schedules SET state='BLOCKED',next_due_at=NULL,last_error=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[id,reason])).rows[0];await scheduleAudit(c,ctx,blocked,reason==='INVALID_SCHEDULE_DATA'?'BLOCK_INVALID_DATA':'BLOCK_AUTHORITY');
  await revokeSchedule(c,id);
 }
 /** Owner-scoped SKIP LOCKED + unique (schedule, revision, instant) transaction. */
 async claimDue(ctx:DbContext,signal?:AbortSignal){return this.schedules.transaction(ctx,signal,async c=>{
  const asOf=new Date(this.schedules.clock()).toISOString(),rows=(await c.query("SELECT * FROM schedules WHERE state='ACTIVE' AND next_due_at<=$1 ORDER BY next_due_at,id FOR UPDATE SKIP LOCKED LIMIT 10",[asOf])).rows,ids:string[]=[];
  for(const row of rows){
   let identity;try{identity=await scheduleIdentity(c,ctx);}catch(error){if(!(error instanceof ScheduleError)||!['SCHEDULE_IDENTITY_INACTIVE','SCHEDULE_STOPPED','SCHEDULE_LIFECYCLE_BLOCKED'].includes(error.code))throw error;await this.block(c,ctx,row.id as string);continue;}
   if(Number(row.auth_epoch)!==identity.authEpoch||row.policy_version!==identity.policyVersion){await this.block(c,ctx,row.id as string);continue;}
   let due;try{const payload=this.schedules.open(ctx,row);due=dueReminder(payload.rule,(row.next_due_at as Date).toISOString(),asOf);}catch{await this.block(c,ctx,row.id as string,'INVALID_SCHEDULE_DATA');continue;}if(!due)continue;
   const id=randomUUID(),expiry=new Date(Date.parse(due.scheduledAt)+3600000).toISOString();let taskId:string|null=null,runId:string|null=null;
   if(!due.missed){taskId=randomUUID();runId=randomUUID();
    await c.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at,control_kind) VALUES($1,$2,$3,'确定性私人提醒','OPEN',$4,$5,$6,'REMINDER')",[ctx.tenantId,taskId,ctx.actorId,JSON.stringify(audience(ctx.actorId)),identity.authEpoch,expiry]);
    // WAITING_USER is intentionally non-runnable by the model worker. Only this
    // deterministic executor stages a receipt after current revision checks.
    await c.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget,persona_context_state) VALUES($1,$2,$3,$4,'WAITING_USER',$5,'BUILTIN_ONLY')",[ctx.tenantId,runId,taskId,ctx.actorId,JSON.stringify({schemaVersion:1,maxTurns:0,maxTools:0,maxActiveMs:1})]);
   }
   await c.query('INSERT INTO schedule_occurrences(tenant_id,id,owner_id,schedule_id,revision,scheduled_at,state,task_id,run_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.tenantId,id,ctx.actorId,row.id,row.revision,due.scheduledAt,due.missed?'MISSED':'QUEUED',taskId,runId,expiry]);
   if(!due.missed){await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'SCHEDULE',$4,$5,$6)",[ctx.tenantId,randomUUID(),ctx.actorId,id,JSON.stringify({scheduleId:row.id,occurrenceId:id,revision:Number(row.revision)}),`schedule:${row.id}:${row.revision}:${due.scheduledAt}`]);ids.push(id);}
   const advanced=(await c.query("UPDATE schedules SET next_due_at=$2,state=CASE WHEN $2::timestamptz IS NULL AND $3 THEN 'COMPLETED' ELSE 'ACTIVE' END,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,due.nextDueAt,due.missed])).rows[0];await scheduleAudit(c,ctx,advanced,due.missed?'MISSED':'QUEUED');
  }return ids;
 });}
 async pending(ctx:DbContext){return this.schedules.transaction(ctx,undefined,async c=>(await c.query("SELECT id FROM schedule_occurrences WHERE state='QUEUED' ORDER BY created_at,id LIMIT 20")).rows.map(row=>row.id as string));}
 async stage(ctx:DbContext,id:string,signal?:AbortSignal){return this.schedules.transaction(ctx,signal,async c=>{
  // Lock schedule before occurrence, matching edits; no inverse lock ordering.
  const schedule=(await c.query('SELECT s.* FROM schedules s JOIN schedule_occurrences o ON o.schedule_id=s.id AND o.tenant_id=s.tenant_id WHERE o.id=$1 FOR UPDATE OF s',[id])).rows[0];if(!schedule)return 'NOT_FOUND';
  const row=(await c.query("SELECT * FROM schedule_occurrences WHERE id=$1 AND state='QUEUED' FOR UPDATE",[id])).rows[0];if(!row)return 'NOT_CLAIMED';
  let valid=['ACTIVE','COMPLETED'].includes(schedule.state as string)&&Number(schedule.revision)===Number(row.revision),identity;
  let authorityValid=true;try{identity=await scheduleIdentity(c,ctx);authorityValid=Number(schedule.auth_epoch)===identity.authEpoch&&schedule.policy_version===identity.policyVersion;}catch(error){if(!(error instanceof ScheduleError))throw error;authorityValid=false;}if(!authorityValid){await this.block(c,ctx,schedule.id as string);valid=false;}
  const task=(await c.query("SELECT id FROM tasks WHERE id=$1 AND requester_id=$2 AND status='OPEN' AND control_kind='REMINDER' AND cancel_requested_at IS NULL",[row.task_id,ctx.actorId])).rowCount;
  if(!valid||!task||Date.parse((row.expires_at as Date).toISOString())<=this.schedules.clock()){
   await c.query("UPDATE schedule_occurrences SET state=$2,updated_at=clock_timestamp() WHERE id=$1",[id,valid&&task?'MISSED':'REVOKED']);
   await c.query("UPDATE tasks SET status='CANCELLED',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) WHERE id=$1",[row.task_id]);await c.query("UPDATE runs SET status='CANCELLED' WHERE id=$1 AND status='WAITING_USER'",[row.run_id]);
   await c.query("UPDATE outbox SET published_at=clock_timestamp() WHERE kind='SCHEDULE' AND aggregate_id=$1",[id]);await this.complete(c,ctx,schedule.id as string);return valid&&task?'MISSED':'SUPPRESSED';
  }
  let payload;try{payload=this.schedules.open(ctx,schedule);}catch{await this.block(c,ctx,schedule.id as string,'INVALID_SCHEDULE_DATA');return 'SUPPRESSED';}
  const text=renderReminder(schedule.id as string,payload.text,(row.scheduled_at as Date).toISOString(),payload.rule.tz),deliveryId=randomUUID();
  await c.query("UPDATE tasks SET status='COMPLETED' WHERE id=$1",[row.task_id]);await c.query("UPDATE runs SET status='SUCCEEDED',result=$2,result_classification='INTERNAL' WHERE id=$1 AND status='WAITING_USER'",[row.run_id,text]);
  await c.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,content_ref,classification,source_run_id,source_session_no) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,'INTERNAL',$8,1)",[ctx.tenantId,deliveryId,ctx.actorId,row.task_id,JSON.stringify(audience(ctx.actorId)),hash(canonical({occurrenceId:id,contentHash:hash(text)})),JSON.stringify(this.schedules.vault.seal(text,`${ctx.tenantId}:${ctx.actorId}:delivery:${deliveryId}`)),row.run_id]);
  await c.query("UPDATE schedule_occurrences SET state='STAGED',delivery_id=$2,content_hash=$3,updated_at=clock_timestamp() WHERE id=$1",[id,deliveryId,hash(text)]);await c.query("UPDATE outbox SET published_at=clock_timestamp() WHERE kind='SCHEDULE' AND aggregate_id=$1",[id]);await this.complete(c,ctx,schedule.id as string);return 'STAGED';
 });}
 private async complete(c:pg.PoolClient,ctx:DbContext,id:string){const row=(await c.query("UPDATE schedules SET state='COMPLETED',updated_at=clock_timestamp() WHERE id=$1 AND state='ACTIVE' AND next_due_at IS NULL RETURNING *",[id])).rows[0];if(row)await scheduleAudit(c,ctx,row,'RULE_EXHAUSTED');}
 async tick(ctx:DbContext,signal?:AbortSignal){await this.claimDue(ctx,signal);for(const id of await this.pending(ctx)){signal?.throwIfAborted();await this.stage(ctx,id,signal);}}
}
