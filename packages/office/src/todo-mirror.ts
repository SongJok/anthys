import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';

const instant=z.string().max(35).pipe(z.iso.datetime({offset:true})).transform(value=>new Date(value).toISOString());
const userId=z.uuid();
const revision=z.string().trim().min(1).max(256);
const title=z.string().trim().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'TODO_MIRROR_TITLE_INVALID');
const fields={title,dueAt:instant.nullable(),assignee:userId.nullable(),completed:z.boolean()};
const contentSchema=z.strictObject({todoId:userId,...fields});
const observationSchema=z.strictObject({todoId:userId,revision,...fields});
const localSchema=z.strictObject({title,dueAt:instant.nullable(),assignee:userId.nullable()});
const writeIntentSchema=z.strictObject({operation:z.enum(['UPDATE','CLOSE']),expectedRevision:revision,expected:contentSchema});
type ExternalContent=z.infer<typeof contentSchema>;
type ExternalObservation=z.infer<typeof observationSchema>;
export type TodoSyncState='LOCAL_ONLY'|'LINKED'|'PENDING'|'UNKNOWN'|'CONFLICT';
export interface TodoMirror{
 todoId:string;title:string;dueAt:string|null;assignee:string|null;completed:boolean;
 syncState:TodoSyncState;externalTodoId:string|null;externalRevision:string|null;externalSnapshot:ExternalObservation|null;
 externalVerifiedAt:string|null;pendingOperation:'UPDATE'|'CLOSE'|null;lastError:string|null;version:number;createdAt:string;updatedAt:string;
}
export type TodoMirrorResult=
 |{status:'CREATED';todoId:string;syncState:'LOCAL_ONLY'}
 |{status:'LISTED';items:TodoMirror[]}
 |{status:'READ';todo:TodoMirror}
 |{status:'LINKED';todo:TodoMirror}
 |{status:'PENDING';todo:TodoMirror}
 |{status:'VERIFIED';todo:TodoMirror}
 |{status:'RECONCILED';outcome:'WRITE_APPLIED'|'ALREADY_MATCHED'|'REMOTE_OBSERVED';todo:TodoMirror}
 |{status:'APPLIED';todo:TodoMirror}
 |{status:'IDEMPOTENT';todo:TodoMirror}
 |{status:'ADOPTED';todo:TodoMirror;assigneeUnchanged:true}
 |{status:'UNKNOWN';code:'TODO_MIRROR_WRITE_OUTCOME_UNKNOWN';todoId:string;effect:'UNKNOWN'}
 |{status:'INVALID';code:'TODO_MIRROR_REQUEST_INVALID'|'TODO_MIRROR_ASSIGNEE_INVALID'}
 |{status:'NOT_FOUND'}
 |{status:'CONFLICT';code:'TODO_MIRROR_STATE_INVALID'|'TODO_MIRROR_EXTERNAL_ID_LINKED'|'TODO_MIRROR_EXTERNAL_ID_MISMATCH'|'TODO_MIRROR_REVISION_CHANGED'|'TODO_MIRROR_REMOTE_CONTENT_CHANGED'|'TODO_MIRROR_READBACK_MISMATCH';effect:'NONE'};
type ConflictCode='TODO_MIRROR_STATE_INVALID'|'TODO_MIRROR_EXTERNAL_ID_LINKED'|'TODO_MIRROR_EXTERNAL_ID_MISMATCH'|'TODO_MIRROR_REVISION_CHANGED'|'TODO_MIRROR_REMOTE_CONTENT_CHANGED'|'TODO_MIRROR_READBACK_MISMATCH';
const conflict=(code:ConflictCode):TodoMirrorResult=>({status:'CONFLICT',code,effect:'NONE'});
const invalid=(code:'TODO_MIRROR_REQUEST_INVALID'|'TODO_MIRROR_ASSIGNEE_INVALID'='TODO_MIRROR_REQUEST_INVALID'):TodoMirrorResult=>({status:'INVALID',code});
const instantOrNull=(value:unknown)=>value===null||value===undefined?null:new Date(value as string|Date).toISOString();
const sameContent=(left:ExternalContent,right:ExternalContent)=>left.todoId===right.todoId&&left.title===right.title&&left.dueAt===right.dueAt&&left.assignee===right.assignee&&left.completed===right.completed;
function map(row:Record<string,unknown>):TodoMirror{
 return {
  todoId:row.id as string,title:row.title as string,dueAt:instantOrNull(row.due_at),assignee:(row.assignee_id as string|null)??null,completed:row.completed as boolean,
  syncState:row.sync_state as TodoSyncState,externalTodoId:(row.external_todo_id as string|null)??null,externalRevision:(row.external_revision as string|null)??null,
  externalSnapshot:row.external_snapshot===null||row.external_snapshot===undefined?null:observationSchema.parse(row.external_snapshot),
  externalVerifiedAt:instantOrNull(row.last_verified_at),pendingOperation:(row.pending_operation as 'UPDATE'|'CLOSE'|null)??null,lastError:(row.last_error as string|null)??null,
  version:Number(row.version),createdAt:instantOrNull(row.created_at)!,updatedAt:instantOrNull(row.updated_at)!
 };
}
/** Durable owner-scoped mirror for office todos. The local id remains its own
 * identity; an external DingTalk todo id is a nullable, revocable link. A write
 * intent and its expected content are persisted before the external call, and
 * only an exact read-back settles the row as verified. Remote changes update the
 * external snapshot only; copying them into local fields requires adoptRemote. */
export class TodoMirrorStore{
 constructor(readonly db:Database){}
 private async lock(c:pg.PoolClient,ctx:DbContext,id:string){
  return (await c.query('SELECT * FROM office_todos WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,id])).rows[0] as Record<string,unknown>|undefined;
 }
 async createLocal(ctx:DbContext,raw:unknown):Promise<TodoMirrorResult>{
  const parsed=localSchema.safeParse(raw);if(!parsed.success)return invalid();
  const id=randomUUID();
  try{
   await this.db.scope(ctx,c=>c.query(`INSERT INTO office_todos(tenant_id,id,owner_id,title,due_at,assignee_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId,id,ctx.actorId,parsed.data.title,parsed.data.dueAt,parsed.data.assignee]));
   return {status:'CREATED',todoId:id,syncState:'LOCAL_ONLY'};
  }catch(error){if((error as {code?:string}).code==='23503')return invalid('TODO_MIRROR_ASSIGNEE_INVALID');throw error;}
 }
 async list(ctx:DbContext,limit=50):Promise<TodoMirrorResult>{
  const size=Math.min(200,Math.max(1,Math.trunc(limit)));
  return this.db.scope(ctx,async c=>({status:'LISTED',items:(await c.query('SELECT * FROM office_todos ORDER BY created_at DESC,id DESC LIMIT $1',[size])).rows.map(map)}));
 }
 async get(ctx:DbContext,id:string):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=(await c.query('SELECT * FROM office_todos WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,id])).rows[0] as Record<string,unknown>|undefined;
   return row?{status:'READ',todo:map(row)}:{status:'NOT_FOUND'};
  });
 }
 async link(ctx:DbContext,id:string,raw:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const parsed=observationSchema.safeParse(raw);if(!parsed.success)return invalid();
  try{
   return await this.db.scope(ctx,async c=>{
    const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
    if(row.sync_state!=='LOCAL_ONLY'||row.external_todo_id!==null)return conflict('TODO_MIRROR_STATE_INVALID');
    const q=await c.query(`UPDATE office_todos SET external_todo_id=$1,external_revision=$2,external_snapshot=$3,sync_state='LINKED',last_verified_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp(),version=version+1
     WHERE tenant_id=$4 AND id=$5 RETURNING *`,[parsed.data.todoId,parsed.data.revision,JSON.stringify(parsed.data),ctx.tenantId,id]);
    return {status:'LINKED',todo:map(q.rows[0]!)} as const;
   });
  }catch(error){if((error as {code?:string}).code==='23505')return conflict('TODO_MIRROR_EXTERNAL_ID_LINKED');throw error;}
 }
 async beginWrite(ctx:DbContext,id:string,raw:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const parsed=writeIntentSchema.safeParse(raw);
  if(!parsed.success||(parsed.data.operation==='UPDATE'&&parsed.data.expected.completed)||(parsed.data.operation==='CLOSE'&&!parsed.data.expected.completed))return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='LINKED'||row.external_todo_id===null)return conflict('TODO_MIRROR_STATE_INVALID');
   if(row.external_todo_id!==parsed.data.expected.todoId)return conflict('TODO_MIRROR_EXTERNAL_ID_MISMATCH');
   if(row.external_revision!==parsed.data.expectedRevision)return conflict('TODO_MIRROR_REVISION_CHANGED');
   const q=await c.query(`UPDATE office_todos SET sync_state='PENDING',pending_operation=$1,pending_snapshot=$2,last_error=NULL,updated_at=clock_timestamp(),version=version+1
    WHERE tenant_id=$3 AND id=$4 RETURNING *`,[parsed.data.operation,JSON.stringify(parsed.data.expected),ctx.tenantId,id]);
   return {status:'PENDING',todo:map(q.rows[0]!)} as const;
  });
 }
 async markWriteUnknown(ctx:DbContext,id:string):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='PENDING'||row.pending_operation===null)return conflict('TODO_MIRROR_STATE_INVALID');
   await c.query(`UPDATE office_todos SET sync_state='UNKNOWN',last_error='WRITE_OUTCOME_UNKNOWN',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
   return {status:'UNKNOWN',code:'TODO_MIRROR_WRITE_OUTCOME_UNKNOWN',todoId:id,effect:'UNKNOWN' as const};
  });
 }
 async settleWrite(ctx:DbContext,id:string,raw:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const parsed=observationSchema.safeParse(raw);if(!parsed.success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='PENDING'||row.pending_snapshot===null)return conflict('TODO_MIRROR_STATE_INVALID');
   if(parsed.data.todoId!==row.external_todo_id){
    await c.query(`UPDATE office_todos SET sync_state='UNKNOWN',last_error='READBACK_TODO_MISMATCH',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
    return conflict('TODO_MIRROR_READBACK_MISMATCH');
   }
   const expected=contentSchema.parse(row.pending_snapshot);
   if(!sameContent(parsed.data,expected)){
    await c.query(`UPDATE office_todos SET sync_state='UNKNOWN',last_error='READBACK_CONTENT_MISMATCH',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
    return conflict('TODO_MIRROR_READBACK_MISMATCH');
   }
   const q=await c.query(`UPDATE office_todos SET sync_state='LINKED',external_revision=$1,external_snapshot=$2,last_verified_at=clock_timestamp(),pending_operation=NULL,pending_snapshot=NULL,last_error=NULL,updated_at=clock_timestamp(),version=version+1
    WHERE tenant_id=$3 AND id=$4 RETURNING *`,[parsed.data.revision,JSON.stringify(parsed.data),ctx.tenantId,id]);
   return {status:'VERIFIED',todo:map(q.rows[0]!)} as const;
  });
 }
 async reconcile(ctx:DbContext,id:string,raw:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const parsed=observationSchema.safeParse(raw);if(!parsed.success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='UNKNOWN')return conflict('TODO_MIRROR_STATE_INVALID');
   if(parsed.data.todoId!==row.external_todo_id){
    await c.query(`UPDATE office_todos SET last_error='RECONCILE_TODO_MISMATCH',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
    return conflict('TODO_MIRROR_READBACK_MISMATCH');
   }
   if(row.pending_snapshot!==null){
    if(!sameContent(parsed.data,contentSchema.parse(row.pending_snapshot))){
     await c.query(`UPDATE office_todos SET sync_state='CONFLICT',pending_operation=NULL,pending_snapshot=NULL,last_error='RECONCILE_REMOTE_DIFFERS',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
     return conflict('TODO_MIRROR_REMOTE_CONTENT_CHANGED');
    }
    const q=await c.query(`UPDATE office_todos SET sync_state='LINKED',external_revision=$1,external_snapshot=$2,last_verified_at=clock_timestamp(),pending_operation=NULL,pending_snapshot=NULL,last_error=NULL,updated_at=clock_timestamp(),version=version+1
     WHERE tenant_id=$3 AND id=$4 RETURNING *`,[parsed.data.revision,JSON.stringify(parsed.data),ctx.tenantId,id]);
    return {status:'RECONCILED',outcome:'WRITE_APPLIED',todo:map(q.rows[0]!)} as const;
   }
   const current=row.external_snapshot===null?null:observationSchema.parse(row.external_snapshot);
   if(current&&current.revision===parsed.data.revision&&sameContent(current,parsed.data)){
    const q=await c.query(`UPDATE office_todos SET sync_state='LINKED',last_verified_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp(),version=version+1
     WHERE tenant_id=$1 AND id=$2 RETURNING *`,[ctx.tenantId,id]);
    return {status:'RECONCILED',outcome:'ALREADY_MATCHED',todo:map(q.rows[0]!)} as const;
   }
   const q=await c.query(`UPDATE office_todos SET sync_state='LINKED',external_revision=$1,external_snapshot=$2,last_verified_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp(),version=version+1
    WHERE tenant_id=$3 AND id=$4 RETURNING *`,[parsed.data.revision,JSON.stringify(parsed.data),ctx.tenantId,id]);
   return {status:'RECONCILED',outcome:'REMOTE_OBSERVED',todo:map(q.rows[0]!)} as const;
  });
 }
 async applyRemote(ctx:DbContext,id:string,raw:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const parsed=observationSchema.safeParse(raw);if(!parsed.success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='LINKED'||row.external_snapshot===null)return conflict('TODO_MIRROR_STATE_INVALID');
   if(parsed.data.todoId!==row.external_todo_id)return conflict('TODO_MIRROR_EXTERNAL_ID_MISMATCH');
   const current=observationSchema.parse(row.external_snapshot);
   if(current.revision===parsed.data.revision){
    if(sameContent(current,parsed.data))return {status:'IDEMPOTENT',todo:map(row)} as const;
    await c.query(`UPDATE office_todos SET sync_state='CONFLICT',last_error='REVISION_REUSED_WITH_DIFFERENT_CONTENT',updated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,id]);
    return conflict('TODO_MIRROR_REMOTE_CONTENT_CHANGED');
   }
   const q=await c.query(`UPDATE office_todos SET external_revision=$1,external_snapshot=$2,last_verified_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp(),version=version+1
    WHERE tenant_id=$3 AND id=$4 RETURNING *`,[parsed.data.revision,JSON.stringify(parsed.data),ctx.tenantId,id]);
   return {status:'APPLIED',todo:map(q.rows[0]!)} as const;
  });
 }
 async adoptRemote(ctx:DbContext,id:string,expectedRevision:unknown):Promise<TodoMirrorResult>{
  if(!userId.safeParse(id).success)return invalid();
  const expected=revision.safeParse(expectedRevision);if(!expected.success)return invalid();
  return this.db.scope(ctx,async c=>{
   const row=await this.lock(c,ctx,id);if(!row)return {status:'NOT_FOUND'} as const;
   if(row.sync_state!=='LINKED'||row.external_snapshot===null)return conflict('TODO_MIRROR_STATE_INVALID');
   if(row.external_revision!==expected.data)return conflict('TODO_MIRROR_REVISION_CHANGED');
   const snapshot=observationSchema.parse(row.external_snapshot);
   const q=await c.query(`UPDATE office_todos SET title=$1,due_at=$2,completed=$3,updated_at=clock_timestamp(),version=version+1
    WHERE tenant_id=$4 AND id=$5 RETURNING *`,[snapshot.title,snapshot.dueAt,snapshot.completed,ctx.tenantId,id]);
   return {status:'ADOPTED',assigneeUnchanged:true as const,todo:map(q.rows[0]!)} as const;
  });
 }
}
