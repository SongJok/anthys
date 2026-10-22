import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {TodoMirrorStore} from '../../packages/office/src/todo-mirror.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
afterAll(async()=>{await db.close();await root.end();});
async function world(){
 const tenantId=randomUUID(),actorId=randomUUID(),otherId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic todo mirror','ACTIVE','UTC')",[tenantId,'synthetic-todo-mirror-'+tenantId]);
 for(const id of [actorId,otherId])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic todo owner','ACTIVE')",[tenantId,id,'synthetic-todo-'+id]);
 return {ctx:{tenantId,actorId},other:{tenantId,actorId:otherId},actorId,store:new TodoMirrorStore(db)};
}
const baseExternal={revision:'1',title:'Prepare report',dueAt:'2026-10-22T10:00:00.000Z',assignee:null,completed:false};
async function linkedTodo(w:Awaited<ReturnType<typeof world>>){
 const created=await w.store.createLocal(w.ctx,{title:'Local preparation',dueAt:'2026-10-21T12:00:00.000Z',assignee:w.actorId});
 expect(created.status).toBe('CREATED');if(created.status!=='CREATED')throw Error('CREATE_FAILED');
 const external={todoId:randomUUID(),...baseExternal};
 expect(await w.store.link(w.ctx,created.todoId,external)).toMatchObject({status:'LINKED',todo:{syncState:'LINKED'}});
 return {id:created.todoId,external};
}
it('T071 keeps a local todo id distinct from the external id, links only from a supplied read-back and isolates owners',async()=>{
 const w=await world();
 const local=await w.store.createLocal(w.ctx,{title:'Local preparation',dueAt:'2026-10-21T12:00:00.000Z',assignee:w.actorId});
 expect(local).toMatchObject({status:'CREATED',syncState:'LOCAL_ONLY'});if(local.status!=='CREATED')throw Error('CREATE_FAILED');
 expect(await w.store.get(w.ctx,local.todoId)).toMatchObject({status:'READ',todo:{todoId:local.todoId,title:'Local preparation',assignee:w.actorId,completed:false,externalTodoId:null,syncState:'LOCAL_ONLY',version:1}});
 expect(await w.store.get(w.other,local.todoId)).toEqual({status:'NOT_FOUND'});
 expect(await w.store.list(w.ctx)).toMatchObject({status:'LISTED',items:[{todoId:local.todoId}]});
 expect(await w.store.list(w.other)).toMatchObject({status:'LISTED',items:[]});
 const external={todoId:randomUUID(),...baseExternal};
 expect(await w.store.link(w.other,local.todoId,external)).toEqual({status:'NOT_FOUND'});
 expect(await w.store.link(w.ctx,local.todoId,external)).toMatchObject({status:'LINKED',todo:{todoId:local.todoId,externalTodoId:external.todoId,externalRevision:'1',externalSnapshot:external,syncState:'LINKED',version:2}});
 expect(local.todoId).not.toBe(external.todoId);
 expect(await w.store.link(w.ctx,local.todoId,{...external,revision:'2'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 const second=await w.store.createLocal(w.ctx,{title:'Second local todo',dueAt:null,assignee:null});
 if(second.status!=='CREATED')throw Error('CREATE_FAILED');
 expect(await w.store.link(w.ctx,second.todoId,{...external,revision:'9'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_EXTERNAL_ID_LINKED'});
});
it('T071 persists a one-shot write intent, settles on exact read-back and leaves separate local fields untouched',async()=>{
 const w=await world(),{id,external}=await linkedTodo(w),target={todoId:external.todoId,title:'Updated externally',dueAt:'2026-10-24T09:00:00.000Z',assignee:null,completed:false};
 expect(await w.store.beginWrite(w.ctx,id,{operation:'CLOSE',expectedRevision:'1',expected:{...target,completed:false}})).toMatchObject({status:'INVALID',code:'TODO_MIRROR_REQUEST_INVALID'});
 expect(await w.store.beginWrite(w.ctx,id,{operation:'UPDATE',expectedRevision:'9',expected:target})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_REVISION_CHANGED'});
 expect(await w.store.beginWrite(w.ctx,id,{operation:'UPDATE',expectedRevision:'1',expected:target})).toMatchObject({status:'PENDING',todo:{syncState:'PENDING',pendingOperation:'UPDATE',externalRevision:'1',version:3}});
 expect(await w.store.settleWrite(w.ctx,id,{...external,revision:'2',title:'Someone else'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_READBACK_MISMATCH'});
 expect(await w.store.get(w.ctx,id)).toMatchObject({status:'READ',todo:{syncState:'UNKNOWN',externalRevision:'1',externalSnapshot:external,pendingOperation:'UPDATE',title:'Local preparation',lastError:'READBACK_CONTENT_MISMATCH'}});
 expect(await w.store.reconcile(w.ctx,id,{revision:'2',...target})).toMatchObject({status:'RECONCILED',outcome:'WRITE_APPLIED',todo:{syncState:'LINKED',externalRevision:'2',externalSnapshot:{revision:'2',...target},title:'Local preparation',dueAt:'2026-10-21T12:00:00.000Z',completed:false,pendingOperation:null,lastError:null}});
 expect(await w.store.settleWrite(w.ctx,id,{revision:'2',...target})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.beginWrite(w.ctx,id,{operation:'CLOSE',expectedRevision:'2',expected:{...target,completed:true}})).toMatchObject({status:'PENDING'});
 expect(await w.store.settleWrite(w.ctx,id,{revision:'3',...target,completed:true})).toMatchObject({status:'VERIFIED',todo:{syncState:'LINKED',externalRevision:'3',externalSnapshot:{revision:'3',...target,completed:true},title:'Local preparation',completed:false,pendingOperation:null}});
});
it('T071 makes a lost write durably UNKNOWN and refuses to adopt a differing remote read as success',async()=>{
 const w=await world(),{id,external}=await linkedTodo(w),target={todoId:external.todoId,title:'Target content',dueAt:'2026-10-24T09:00:00.000Z',assignee:null,completed:false};
 expect(await w.store.beginWrite(w.ctx,id,{operation:'UPDATE',expectedRevision:'1',expected:target})).toMatchObject({status:'PENDING'});
 expect(await w.store.markWriteUnknown(w.ctx,id)).toMatchObject({status:'UNKNOWN',code:'TODO_MIRROR_WRITE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 expect(await w.store.get(w.ctx,id)).toMatchObject({status:'READ',todo:{syncState:'UNKNOWN',pendingOperation:'UPDATE',externalRevision:'1',externalSnapshot:external}});
 expect(await w.store.settleWrite(w.ctx,id,{revision:'2',...target})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.reconcile(w.ctx,id,{revision:'2',...target,title:'A different remote value'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_REMOTE_CONTENT_CHANGED'});
 expect(await w.store.get(w.ctx,id)).toMatchObject({status:'READ',todo:{syncState:'CONFLICT',externalRevision:'1',externalSnapshot:external,title:'Local preparation',pendingOperation:null,lastError:'RECONCILE_REMOTE_DIFFERS'}});
 expect(await w.store.markWriteUnknown(w.ctx,id)).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.reconcile(w.ctx,id,{revision:'2',...target,title:'A different remote value'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
});
it('T071 applies a remote revision only to the external snapshot and copies it into local fields only by explicit adoption',async()=>{
 const w=await world(),{id,external}=await linkedTodo(w),remote={todoId:external.todoId,revision:'2',title:'Remote rename',dueAt:'2026-10-25T08:00:00.000Z',assignee:null,completed:true};
 expect(await w.store.applyRemote(w.ctx,id,external)).toMatchObject({status:'IDEMPOTENT',todo:{externalRevision:'1',version:2}});
 expect(await w.store.applyRemote(w.ctx,id,{...external,title:'Changed without a new revision'})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_REMOTE_CONTENT_CHANGED'});
 expect(await w.store.get(w.ctx,id)).toMatchObject({status:'READ',todo:{syncState:'CONFLICT',externalRevision:'1',externalSnapshot:external,title:'Local preparation'}});
 const second=await world(),next=await linkedTodo(second),nextRemote={...remote,todoId:next.external.todoId};
 expect(await second.store.applyRemote(second.ctx,next.id,nextRemote)).toMatchObject({status:'APPLIED',todo:{externalRevision:'2',externalSnapshot:nextRemote,title:'Local preparation',dueAt:'2026-10-21T12:00:00.000Z',completed:false}});
 expect(await second.store.adoptRemote(second.ctx,next.id,'1')).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_REVISION_CHANGED'});
 expect(await second.store.adoptRemote(second.ctx,next.id,'2')).toMatchObject({status:'ADOPTED',assigneeUnchanged:true,todo:{title:'Remote rename',dueAt:'2026-10-25T08:00:00.000Z',completed:true,assignee:second.actorId,externalRevision:'2'}});
 expect(await second.store.beginWrite(second.ctx,next.id,{operation:'UPDATE',expectedRevision:'1',expected:{todoId:next.external.todoId,title:'Remote rename',dueAt:'2026-10-25T08:00:00.000Z',assignee:null,completed:false}})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_REVISION_CHANGED'});
});
it('T071 rejects invalid values and illegal transitions without changing the durable mirror',async()=>{
 const w=await world();
 expect(await w.store.createLocal(w.ctx,{title:'',dueAt:null,assignee:null})).toMatchObject({status:'INVALID',code:'TODO_MIRROR_REQUEST_INVALID'});
 expect(await w.store.createLocal(w.ctx,{title:'Bad date',dueAt:'tomorrow',assignee:null})).toMatchObject({status:'INVALID'});
 expect(await w.store.createLocal(w.ctx,{title:'Unknown assignee',dueAt:null,assignee:randomUUID()})).toMatchObject({status:'INVALID',code:'TODO_MIRROR_ASSIGNEE_INVALID'});
 const local=await w.store.createLocal(w.ctx,{title:'Local only',dueAt:null,assignee:null});if(local.status!=='CREATED')throw Error('CREATE_FAILED');
 expect(await w.store.link(w.ctx,local.todoId,{todoId:randomUUID(),revision:'',title:'External',dueAt:null,assignee:null,completed:false})).toMatchObject({status:'INVALID'});
 expect(await w.store.beginWrite(w.ctx,local.todoId,{operation:'UPDATE',expectedRevision:'1',expected:{todoId:randomUUID(),title:'External',dueAt:'2026-10-22T10:00:00.000Z',assignee:null,completed:false}})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.markWriteUnknown(w.ctx,local.todoId)).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.applyRemote(w.ctx,local.todoId,{todoId:randomUUID(),revision:'1',title:'External',dueAt:null,assignee:null,completed:false})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.adoptRemote(w.ctx,local.todoId,'1')).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_STATE_INVALID'});
 expect(await w.store.get(w.ctx,randomUUID())).toEqual({status:'NOT_FOUND'});
 const {id,external}=await linkedTodo(w);
 expect(await w.store.beginWrite(w.ctx,id,{operation:'UPDATE',expectedRevision:'1',expected:{todoId:randomUUID(),title:'External',dueAt:'2026-10-22T10:00:00.000Z',assignee:null,completed:false}})).toMatchObject({status:'CONFLICT',code:'TODO_MIRROR_EXTERNAL_ID_MISMATCH'});
 expect(await w.store.beginWrite(w.other,id,{operation:'UPDATE',expectedRevision:'1',expected:{todoId:external.todoId,title:'External',dueAt:'2026-10-22T10:00:00.000Z',assignee:null,completed:false}})).toEqual({status:'NOT_FOUND'});
 expect(await w.store.get(w.ctx,id)).toMatchObject({status:'READ',todo:{version:2,syncState:'LINKED',externalRevision:'1',externalSnapshot:external}});
});
