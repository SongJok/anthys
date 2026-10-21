import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertTrial} from '../../storage/src/trial.js';
import type {Database,DbContext} from '../../storage/src/database.js';
export const audienceSchema=z.object({kind:z.enum(['PRIVATE_USER','GROUP','NAMED_USERS']),targetId:z.string().min(1),classificationCeiling:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),membershipVersion:z.number().int().optional()}).strict();
export type Audience=z.infer<typeof audienceSchema>;
export async function insertTask(c:pg.PoolClient,ctx:DbContext,goal:string,audience:Audience,eventId?:string,conversationId?:string,bound?:{taskId:string;runId:string}) {
 const taskId=bound?.taskId??randomUUID(),runId=bound?.runId??randomUUID();await assertTrial(c,runId);
 const identity=await c.query("SELECT u.auth_epoch FROM users u JOIN tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='ACTIVE' AND t.status='ACTIVE'",[ctx.tenantId,ctx.actorId]);if(!identity.rowCount) throw Error('IDENTITY_INACTIVE');
 await c.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at,source_event_id,conversation_id) VALUES($1,$2,$3,$4,'OPEN',$5,$6,now()+interval '1 day',$7,$8)",[ctx.tenantId,taskId,ctx.actorId,goal,JSON.stringify(audienceSchema.parse(audience)),identity.rows[0].auth_epoch,eventId??null,conversationId??null]);
 await c.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'QUEUED',$5)",[ctx.tenantId,runId,taskId,ctx.actorId,JSON.stringify({schemaVersion:1,maxTurns:16,maxTools:24,maxActiveMs:240000})]);
 await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'RUN',$4,$5,$6)",[ctx.tenantId,randomUUID(),ctx.actorId,runId,JSON.stringify({tenantId:ctx.tenantId,actorId:ctx.actorId,runId}),`run:${runId}`]);
 return {taskId,runId};
}
export async function cancelTask(c:pg.PoolClient,id:string){const q=await c.query("UPDATE tasks SET status=CASE WHEN status='COMPLETED' THEN status ELSE 'CANCELLED' END,cancel_requested_at=coalesce(cancel_requested_at,now()),version=version+1 WHERE id=$1 AND status<>'EXPIRED' RETURNING id,status",[id]);
 if(!q.rowCount)return null;await c.query("UPDATE runs SET status='CANCELLED',version=version+1 WHERE task_id=$1 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",[id]);await c.query("UPDATE deliveries SET state='SUPPRESSED',last_error='TASK_CANCELLED' WHERE task_id=$1 AND state='PENDING'",[id]);return {taskId:id,status:q.rows[0].status as string,deliveryCancellationRequested:true,inFlightExternalActions:'MUST_RECONCILE'};
}
export class TaskStore {
 constructor(readonly db:Database) {}
 async create(ctx:DbContext,goal:string,key:string) {
  return this.db.scope(ctx,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.tenantId}:${ctx.actorId}:${key}`]);
   const existing=await c.query('SELECT payload_ref FROM outbox WHERE dedup_key=$1',[`request:${ctx.actorId}:${key}`]);
   if(existing.rowCount) {if(existing.rows[0].payload_ref.goal!==goal) throw Error('IDEMPOTENCY_CONFLICT');return existing.rows[0].payload_ref as {taskId:string;runId:string};}
   const result=await insertTask(c,ctx,goal,{kind:'PRIVATE_USER',targetId:ctx.actorId,classificationCeiling:'RESTRICTED'});
   await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'REQUEST_DEDUP',$4,$5,$6,now())",[ctx.tenantId,randomUUID(),ctx.actorId,result.taskId,JSON.stringify({...result,goal}),`request:${ctx.actorId}:${key}`]);return result;
  });
 }
 async list(ctx:DbContext,cursor?:string,limit=50){const size=Math.min(200,Math.max(1,limit));return this.db.scope(ctx,async c=>{const q=await c.query('SELECT id,goal,status,created_at,version FROM tasks WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM tasks WHERE id=$1::uuid)) ORDER BY created_at DESC,id DESC LIMIT $2',[cursor??null,size+1]);return {items:q.rows.slice(0,size),nextCursor:q.rows.length>size?q.rows[size-1]!.id as string:null};});}
 async get(ctx:DbContext,id:string) {
  return this.db.scope(ctx,async c=>{
   const q=await c.query('SELECT id,goal,status,audience,cancel_requested_at,created_at,version FROM tasks WHERE id=$1',[id]);
   if(!q.rowCount)return null;
   const runs=await c.query(`SELECT r.id,r.status,r.result,r.result_classification,r.last_error,r.provider_session_no,r.clarification_review_id,r.source_choice_id,(SELECT exists(SELECT 1 FROM group_clarification_messages p WHERE p.run_id=r.id AND p.state='PENDING')) group_reply_pending,(SELECT p.state FROM group_clarification_messages p WHERE p.run_id=r.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) group_reply_state,(SELECT exists(SELECT 1 FROM source_choice_replies p WHERE p.run_id=r.id AND p.state='PENDING')) source_reply_pending,(SELECT p.state FROM source_choice_replies p WHERE p.run_id=r.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) source_reply_state,
    (SELECT jsonb_build_object('sessionNo',s.safe_payload->'sessionNo','reason',s.safe_payload->'reason','actions',s.safe_payload->'actions','facts',s.safe_payload->'facts','omitted',s.safe_payload->'omitted','blocked',s.safe_payload->'blocked')
     FROM run_steps s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.kind='context.rebuilt' ORDER BY s.seq DESC LIMIT 1) context_summary
    FROM runs r WHERE r.task_id=$1 ORDER BY r.created_at`,[id]);
   // Read only the owner's already-visible accounting metadata. Do not expose
   // provider payloads, pricing snapshots, raw failure text or monetary totals
   // that could mix currencies. Task outcome and bill confirmation are separate.
   const accounting=runs.rows.length?await c.query(`SELECT run_id,count(*)::int request_count,
    bool_or(accounting_version<>1 OR NOT coalesce(
     (dispatch_state IN ('PREPARED','DISPATCHING') AND token_state='RESERVED' AND cost_state='RESERVED') OR
     (dispatch_state='COMPLETE' AND token_state='SETTLED' AND cost_state='SETTLED') OR
     (dispatch_state='RELEASED' AND token_state='RELEASED' AND cost_state='RELEASED'),false)) has_unconfirmed,
    bool_or(dispatch_state IN ('PREPARED','DISPATCHING') AND token_state='RESERVED' AND cost_state='RESERVED') has_pending,
    bool_or((cost_state IN ('RESERVED','UNKNOWN') AND reservation>0) OR (token_state IN ('RESERVED','UNKNOWN') AND reserved_tokens>0)) held_reservation,
    bool_or(accounting_version<>1) legacy_unmetered,
    bool_or(dispatch_state='UNKNOWN') dispatch_unconfirmed,
    bool_or(token_state='UNKNOWN' OR failure_code='MODEL_USAGE_UNAVAILABLE') usage_unavailable,
    bool_or(dispatch_state='COMPLETE' AND token_state='SETTLED' AND cost_state='UNKNOWN') tariff_unconfirmed
    FROM quota_ledger WHERE tenant_id=$1 AND owner_id=$2 AND run_id=ANY($3::uuid[]) GROUP BY run_id`,[ctx.tenantId,ctx.actorId,runs.rows.map(row=>row.id)]):{rows:[]};
   const byRun=new Map<string,Record<string,unknown>>();for(const row of accounting.rows)byRun.set(row.run_id as string,row);
   for(const run of runs.rows){
    const row=byRun.get(run.id as string),status=!row?'NONE':row.has_unconfirmed===true?'UNKNOWN':row.has_pending===true?'PENDING':'RECORDED';
    const reasons=row?([['legacy_unmetered','LEGACY_UNMETERED'],['dispatch_unconfirmed','DISPATCH_UNCONFIRMED'],['usage_unavailable','USAGE_UNAVAILABLE'],['tariff_unconfirmed','TARIFF_UNCONFIRMED']] as const).filter(([field])=>row[field]===true).map(([,reason])=>reason):[];
    run.model_accounting={status,requestCount:row?Number(row.request_count):0,heldReservation:row?.held_reservation===true,legacyUnmetered:row?.legacy_unmetered===true,reasons:status==='UNKNOWN'&&!reasons.length?['STATE_UNCONFIRMED']:reasons,providerInvoiceVerified:false};
   }
   const deliveries=await c.query('SELECT id,state,verification_state,last_error FROM deliveries WHERE task_id=$1 ORDER BY created_at,id',[id]);
   return {...q.rows[0],runs:runs.rows,deliveries:deliveries.rows};
  });
 }
 async cancel(ctx:DbContext,id:string) {
  return this.db.scope(ctx,c=>cancelTask(c,id));
 }
}
