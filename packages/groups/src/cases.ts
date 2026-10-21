import {payloadSchema,createCaseInput,updateCaseInput,caseListInput} from './case-contracts.js';
export {caseResultSchema,createCaseInput,updateCaseInput,caseListInput} from './case-contracts.js';
import type {GroupCaseRoster,CaseRosterAction} from './case-roster.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Principal} from '../../identity/src/sessions.js';
import type {Lease} from '../../runtime/src/store.js';
import type {GroupAudience} from './audience.js';
import {groupCaseCommandSchema,groupCaseCommand} from './commands.js';
import type {DbContext} from '../../storage/src/database.js';
import type {Database} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {messageInput} from '../../dingtalk/src/message-input.js';
import {advanceCase,GroupCaseError,mentionCoverage} from './case-model.js';
import type {GroupContract} from './contract-model.js';

export type NativeCaseAudiencePort=Pick<GroupAudience,'current'|'currentMembers'>;
type CaseSubject=Principal|DbContext&{native:Lease;modelRead?:true;audiences?:NativeCaseAudiencePort};
const positive=z.number().int().positive().safe();
const authoritySchema=z.object({contractId:z.uuid(),contractVersion:positive,scopeId:z.uuid(),administrator:z.boolean(),ownerReportedAllowed:z.boolean()}).strict();

function failure(error:unknown):never{
 if(error instanceof GroupCaseError||error instanceof z.ZodError)throw error;
 const code=error instanceof Error?error.message:'';
 const statuses:Record<string,number>={GROUP_CASE_NATIVE_INVALID:403,GROUP_CASE_SESSION_INVALID:401,GROUP_CASE_NOT_FOUND:404,GROUP_CASE_ACTION_DENIED:403,GROUP_CASE_LIFECYCLE_BLOCKED:403,GROUP_CASE_CONTRACT_CONFLICT:409};
 if(Object.hasOwn(statuses,code))throw new GroupCaseError(code,statuses[code]);
 throw new GroupCaseError('GROUP_CASE_UNAVAILABLE',503,{cause:error});
}

/** Local state only: this service never sends messages or asserts provider success. */
export class GroupCases {
 private readonly pending=new Map<string,{intent:string;promise:Promise<unknown>}>();
 constructor(readonly db:Database,private vault:Vault,private robotCode:string,private readonly roster?:GroupCaseRoster){}
 async close(){await this.roster?.close();}
 private async scope<T>(p:Principal,signal:AbortSignal|undefined,fn:(c:pg.PoolClient)=>Promise<T>){
  if(signal?.aborted)throw new GroupCaseError('GROUP_CASE_CANCELLED',409);
  try{return await this.db.scope(p,async c=>{await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='12s'");signal?.throwIfAborted();const result=await fn(c);signal?.throwIfAborted();return result;});}
  catch(error){if(signal?.aborted)throw new GroupCaseError('GROUP_CASE_CANCELLED',409);throw error;}
 }
 private async caseScope<T>(p:Principal,group:string,action:CaseRosterAction,version:number|null,signal:AbortSignal|undefined,fn:(c:pg.PoolClient)=>Promise<T>){
  if(!this.roster)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);
  return this.scope(p,signal,c=>this.roster!.guard(c,p,group,action,version,signal,()=>fn(c)));
 }
 private async waitRequest<T>(promise:Promise<T>,signal:AbortSignal|undefined){
  if(!signal)return promise;let stop!:()=>void;
  const cancelled=new Promise<T>((_resolve,reject)=>{stop=()=>reject(new GroupCaseError('GROUP_CASE_CANCELLED',409));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
  try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',stop);}
 }
 /** Coalesce only simultaneous exact requests from the same real session.
  * The guarded transaction still performs both fresh roster checks. Nothing is
  * cached after settlement; a later replay must obtain new current authority. */
 private async request<T>(p:Principal,id:string,intent:string,signal:AbortSignal|undefined,fn:()=>Promise<T>,replay:(result:T)=>T):Promise<T>{
  if(signal?.aborted)throw new GroupCaseError('GROUP_CASE_CANCELLED',409);
  const key=canonical({tenantId:p.tenantId,actorId:p.actorId,sessionId:p.sessionId,authEpoch:p.authEpoch,id}),prior=this.pending.get(key);
  if(prior){if(prior.intent!==intent)throw new GroupCaseError('GROUP_CASE_REQUEST_CONFLICT',409);const result=await this.waitRequest(prior.promise as Promise<T>,signal);if(signal?.aborted)throw new GroupCaseError('GROUP_CASE_CANCELLED',409);return replay(structuredClone(result));}
  if(this.pending.size>=256)throw new GroupCaseError('GROUP_CASE_UNAVAILABLE',503);
  const promise=fn();this.pending.set(key,{intent,promise});try{return structuredClone(await promise);}finally{if(this.pending.get(key)?.promise===promise)this.pending.delete(key);}
 }
 private aad(p:CaseSubject,id:string){return `${p.tenantId}:group-case:${id}`;}
 private async authority(c:pg.PoolClient,p:CaseSubject,group:string,action:string,version:number|null){
  const value=(await ('native' in p?p.modelRead?c.query('SELECT public.oa_group_case_read_authority($1,$2,$3) value',[group,p.native.taskId,p.native.runId]):c.query('SELECT public.oa_group_case_native_authority($1,$2,$3,$4,$5) value',[group,p.native.taskId,p.native.runId,action,version]):c.query('SELECT public.oa_group_case_authority($1,$2,$3,$4) value',[group,p.sessionId,action,version]))).rows[0].value;
  const stopped=await c.query("SELECT id FROM kill_switches WHERE enabled AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (mode='ALL' OR $1) AND (scope_kind='TENANT' AND scope_id=$2 OR scope_kind='USER' AND scope_id=$3 OR scope_kind='GROUP' AND scope_id=$4 OR scope_kind='CONNECTOR' AND scope_id='CORE') LIMIT 1",[action!=='case.read',p.tenantId,p.actorId,group]);
  if(stopped.rowCount)throw new GroupCaseError('GROUP_CASE_STOPPED');
  const authority=authoritySchema.parse(value),revision=(await c.query('SELECT c.current_revision_id,r.document_ref,r.document_hash FROM group_contracts c JOIN group_contract_revisions r ON r.tenant_id=c.tenant_id AND r.id=c.current_revision_id AND r.contract_id=c.id WHERE c.id=$1 AND c.group_id=$2',[authority.contractId,group])).rows[0];
  if(!revision)throw new GroupCaseError('GROUP_CASE_NOT_FOUND',404);
  const text=this.vault.open(revision.document_ref as Sealed,`${p.tenantId}:group-contract:${authority.contractId}:${revision.current_revision_id}`);
  if(hash(text)!==revision.document_hash)throw new GroupCaseError('GROUP_CASE_INTEGRITY',503);
  const document=JSON.parse(text) as GroupContract;
  if(document.id!==authority.contractId||document.version!==authority.contractVersion||document.groupId!==group||document.tenantId!==p.tenantId||document.sources.mode&&document.sources.mode!=='MENTION_ONLY')throw new GroupCaseError('GROUP_CASE_INTEGRITY',503);
  return {...authority,sourceKinds:document.sources.entries.map(entry=>entry.kind),timezone:document.workHours.timezone};
 }
 private open(p:CaseSubject,row:pg.QueryResultRow){
  const text=this.vault.open(row.payload_ref as Sealed,this.aad(p,row.id as string));
  if(hash(text)!==row.payload_hash)throw new GroupCaseError('GROUP_CASE_INTEGRITY',503);
  const payload=payloadSchema.parse(JSON.parse(text));
  if(payload.state!==row.state||payload.ownerId!==row.owner_id||payload.createdBy!==row.created_by||hash(payload.resourceRef)!==row.resource_hash)throw new GroupCaseError('GROUP_CASE_INTEGRITY',503);
  return {id:row.id as string,version:Number(row.version),contractVersion:Number(row.contract_version),updatedAt:(row.updated_at as Date).toISOString(),...payload};
 }
 private async result(c:pg.PoolClient,p:CaseSubject,group:string,id:string){
  const row=(await c.query('SELECT * FROM group_cases WHERE id=$1 AND group_id=$2',[id,group])).rows[0];if(!row)throw new GroupCaseError('GROUP_CASE_NOT_FOUND',404);
  const sources=(await c.query('SELECT id,kind,source_event_id,submitted_by,created_at FROM group_case_sources WHERE case_id=$1 AND group_id=$2 ORDER BY created_at,id',[id,group])).rows;
  return {...this.open(p,row),sources};
 }
 private async receipt(c:pg.PoolClient,p:CaseSubject,group:string,id:string,key:string,intentHash:string){
  await c.query('INSERT INTO group_case_requests(tenant_id,id,actor_id,group_id,case_id,intent_hash) VALUES($1,$2,$3,$4,$5,$6)',[p.tenantId,key,p.actorId,group,id,intentHash]);
 }
 private async members(c:pg.PoolClient,p:CaseSubject,group:string){
  if('native' in p){if(p.modelRead||!p.audiences)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);return p.audiences.currentMembers(c,p,p.native);}
  return this.roster?.members(c,p,group)??[];
 }
 async list(p:Principal,group:string,input:unknown,signal?:AbortSignal){const query=caseListInput.parse(input);try{return await this.caseScope(p,group,'case.read',null,signal,c=>this.listIn(c,p,group,query));}catch(error){failure(error);}}
 private async listIn(c:pg.PoolClient,p:CaseSubject,group:string,query:z.infer<typeof caseListInput>,includeMembers=true){
   const authority=await this.authority(c,p,group,'case.read',null);
   const rows=(await c.query('SELECT * FROM group_cases WHERE group_id=$1 AND created_at>=$2::timestamptz AND created_at<$3::timestamptz AND ($4::uuid IS NULL OR id>$4::uuid) ORDER BY id LIMIT $5',[group,query.from,query.until,query.cursor??null,query.limit+1])).rows;
   const page=rows.slice(0,query.limit),items=[];for(const row of page)items.push(await this.result(c,p,group,row.id as string));
   const members=includeMembers?await this.members(c,p,group):undefined;
   return {items,...(members?{members}:{}),nextCursor:rows.length>query.limit?page.at(-1)!.id as string:null,coverage:{...mentionCoverage,from:query.from,until:query.until,selection:'CASE_REGISTRATION_TIME' as const},contractVersion:authority.contractVersion,administrator:authority.administrator};
 }
 async create(p:Principal,group:string,input:unknown,key:string,signal?:AbortSignal){const body=createCaseInput.parse(input),requestId=z.uuid().parse(key),intentHash=hash(canonical({group,body}));try{return await this.request(p,requestId,intentHash,signal,()=>this.caseScope(p,group,'case.create',body.contractVersion,signal,c=>this.createIn(c,p,group,body,requestId,intentHash)),result=>({...result,replayed:true,duplicate:true}));}catch(error){failure(error);}}
 private async createIn(c:pg.PoolClient,p:CaseSubject,group:string,body:z.infer<typeof createCaseInput>,requestId:string,intentHash:string){
   const authority=await this.authority(c,p,group,'case.create',body.contractVersion);
   if(!authority.sourceKinds.includes(body.source.kind))throw new GroupCaseError('GROUP_CASE_SOURCE_DENIED');
   const prior=(await c.query('SELECT * FROM group_case_requests WHERE id=$1 AND actor_id=$2',[requestId,p.actorId])).rows[0];
   if(prior){if(prior.intent_hash!==intentHash||prior.group_id!==group)throw new GroupCaseError('GROUP_CASE_REQUEST_CONFLICT',409);return {case:await this.result(c,p,group,prior.case_id as string),replayed:true,duplicate:true};}
   let eventId:string|null=null;
   if(body.source.kind==='MENTION'){
    const source=(await c.query("SELECT t.goal,t.source_event_id,e.payload_cipher_ref,v.external_id,u.external_user_id,o.corp_id FROM tasks t JOIN event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id AND e.source='DINGTALK' JOIN conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.source_mode='MENTION_ONLY' JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants o ON o.tenant_id=t.tenant_id WHERE t.id=$1 AND t.requester_id=$2 AND v.external_id=$3",[body.source.taskId,p.actorId,group])).rows[0];
    if(!source)throw new GroupCaseError('GROUP_CASE_SOURCE_DENIED');
    const event=JSON.parse(this.vault.open(JSON.parse(source.payload_cipher_ref as string) as Sealed,`${p.tenantId}:${p.actorId}:inbox:${source.source_event_id}`));
    if(!this.robotCode||event.conversationType!=='2'||event.conversationId!==group||event.senderStaffId!==source.external_user_id||event.senderCorpId!==source.corp_id||event.chatbotCorpId!==source.corp_id||event.robotCode!==this.robotCode||event.msgtype!=='text'||messageInput(event).goal!==source.goal)throw new GroupCaseError('GROUP_CASE_SOURCE_DENIED');
    eventId=source.source_event_id as string;
   }
   const sourceKey=hash(canonical({kind:body.source.kind,actorId:p.actorId,source:eventId??requestId,resource:body.details.resourceRef}));
   const duplicate=(await c.query('SELECT case_id FROM group_case_sources WHERE group_id=$1 AND source_key=$2',[group,sourceKey])).rows[0];
   if(duplicate){await this.receipt(c,p,group,duplicate.case_id as string,requestId,intentHash);return {case:await this.result(c,p,group,duplicate.case_id as string),replayed:false,duplicate:true};}
   const id=randomUUID(),payload=payloadSchema.parse({...body.details,state:'PROPOSED',ownerId:null,createdBy:p.actorId,blockedReason:null,completion:null}),text=canonical(payload);
   await c.query('INSERT INTO group_cases(tenant_id,id,group_id,contract_id,contract_version,created_by,state,resource_hash,payload_ref,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[p.tenantId,id,group,authority.contractId,authority.contractVersion,p.actorId,payload.state,hash(payload.resourceRef),JSON.stringify(this.vault.seal(text,this.aad(p,id))),hash(text)]);
   await c.query('INSERT INTO group_case_sources(tenant_id,id,group_id,case_id,kind,source_key,source_event_id,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.tenantId,randomUUID(),group,id,body.source.kind,sourceKey,eventId,p.actorId]);
   await c.query("INSERT INTO group_case_changes(tenant_id,id,group_id,case_id,actor_id,contract_version,case_version,intent_hash,operation) VALUES($1,$2,$3,$4,$5,$6,1,$7,'CREATE')",[p.tenantId,requestId,group,id,p.actorId,authority.contractVersion,intentHash]);
   await this.receipt(c,p,group,id,requestId,intentHash);
   return {case:await this.result(c,p,group,id),replayed:false,duplicate:false};
 }
 async update(p:Principal,group:string,id:string,input:unknown,key:string,signal?:AbortSignal){const body=updateCaseInput.parse(input),caseId=z.uuid().parse(id),requestId=z.uuid().parse(key),intentHash=hash(canonical({group,caseId,body}));try{return await this.request(p,requestId,intentHash,signal,()=>this.caseScope(p,group,'case.update',body.contractVersion,signal,c=>this.updateIn(c,p,group,caseId,body,requestId,intentHash)),result=>({...result,replayed:true}));}catch(error){failure(error);}}
 private async updateIn(c:pg.PoolClient,p:CaseSubject,group:string,caseId:string,body:z.infer<typeof updateCaseInput>,requestId:string,intentHash:string){
   const authority=await this.authority(c,p,group,'case.update',body.contractVersion);
   const prior=(await c.query('SELECT * FROM group_case_requests WHERE id=$1 AND actor_id=$2',[requestId,p.actorId])).rows[0];
   if(prior){if(prior.intent_hash!==intentHash||prior.group_id!==group||prior.case_id!==caseId)throw new GroupCaseError('GROUP_CASE_REQUEST_CONFLICT',409);return {case:await this.result(c,p,group,caseId),replayed:true};}
   const row=(await c.query('SELECT * FROM group_cases WHERE id=$1 AND group_id=$2 FOR UPDATE',[caseId,group])).rows[0];
   if(!row)throw new GroupCaseError('GROUP_CASE_NOT_FOUND',404);if(Number(row.version)!==body.expectedVersion)throw new GroupCaseError('GROUP_CASE_VERSION_CONFLICT',409);
   const current=this.open(p,row);
   if(body.command.operation==='ASSIGN'){
    const ownerId=body.command.ownerId,owner=(await this.members(c,p,group)).filter(row=>row.id===ownerId);
    if(owner.length!==1)throw new GroupCaseError('GROUP_CASE_OWNER_NOT_MEMBER');
   }
   const lifecycle=advanceCase(current,body.command,{actorId:p.actorId,...authority}),payload=payloadSchema.parse({...lifecycle,title:current.title,resourceRef:current.resourceRef,priority:current.priority,dueAt:current.dueAt});
   // Parse only payload fields: metadata is deliberately not encrypted as authority.
   const text=canonical(payload);
   await c.query('UPDATE group_cases SET owner_id=$2,state=$3,payload_ref=$4,payload_hash=$5,contract_version=$6,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[caseId,payload.ownerId,payload.state,JSON.stringify(this.vault.seal(text,this.aad(p,caseId))),hash(text),authority.contractVersion]);
   await c.query('INSERT INTO group_case_changes(tenant_id,id,group_id,case_id,actor_id,contract_version,case_version,intent_hash,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[p.tenantId,requestId,group,caseId,p.actorId,authority.contractVersion,current.version+1,intentHash,body.command.operation]);
   await this.receipt(c,p,group,caseId,requestId,intentHash);
   return {case:await this.result(c,p,group,caseId),replayed:false};
 }
 private async nativeOrigin(c:pg.PoolClient,ctx:DbContext,lease:Lease,modelRead=false){
  const group=lease.audience['targetId'];if(lease.audience['kind']!=='GROUP'||typeof group!=='string')throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');
  const row=(await c.query("SELECT t.source_event_id,t.goal,t.audience,t.auth_epoch,t.expires_at,r.budget,r.fence,org.policy_version,e.payload_cipher_ref,v.external_id,u.external_user_id,org.corp_id FROM tasks t JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id AND r.owner_id=t.requester_id JOIN event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id AND e.source='DINGTALK' JOIN conversations v ON v.tenant_id=t.tenant_id AND v.id=t.conversation_id AND v.kind='GROUP' AND v.source_mode='MENTION_ONLY' JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id WHERE t.id=$1 AND r.id=$2 AND t.requester_id=$3 AND (CASE WHEN $4::boolean THEN t.control_kind IS NULL ELSE t.control_kind='GROUP_CASE' END) AND t.cancel_requested_at IS NULL AND t.expires_at>clock_timestamp()",[lease.taskId,lease.runId,ctx.actorId,modelRead])).rows[0];
  if(!row||row.goal!==lease.goal||canonical(row.audience)!==canonical(lease.audience)||Number(row.auth_epoch)!==lease.authEpoch||row.policy_version!==lease.policyVersion||Number(row.fence)!==lease.fence||canonical(row.budget)!==canonical(lease.budget)||Date.parse((row.expires_at as Date).toISOString())!==Date.parse(lease.expiresAt)||row.external_id!==group)throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');
  const event=JSON.parse(this.vault.open(JSON.parse(row.payload_cipher_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:inbox:${row.source_event_id}`)),input=messageInput(event);
  if(!this.robotCode||event.conversationType!=='2'||event.conversationId!==group||event.senderStaffId!==row.external_user_id||event.senderCorpId!==row.corp_id||event.chatbotCorpId!==row.corp_id||event.robotCode!==this.robotCode||event.msgtype!=='text'||input.goal!==lease.goal||input.attachments.length)throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');
  return {group,eventId:row.source_event_id as string};
 }
 async modelReadAllowed(c:pg.PoolClient,ctx:DbContext,lease:Lease,audiences:GroupAudience,signal?:AbortSignal){
  signal?.throwIfAborted();const origin=await this.nativeOrigin(c,ctx,lease,true);
  await this.authority(c,{...ctx,native:lease,modelRead:true},origin.group,'case.read',null);
  if(!await audiences.current(c,ctx,lease,signal))throw new GroupCaseError('GROUP_CASE_AUDIENCE_CHANGED');return origin;
 }
 /** “Today” is fixed at trusted task acceptance, in the reviewed contract's
  * zone. Database calendar arithmetic preserves 23/25-hour civil days; neither
  * the model nor callback text can supply a clock, zone or identity. */
 private async todayList(c:pg.PoolClient,p:CaseSubject,group:string,lease:Lease){
  const authority=await this.authority(c,p,group,'case.read',null);
  const row=(await c.query("SELECT created_at anchor,to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') local_date,(date_trunc('day',created_at AT TIME ZONE $2) AT TIME ZONE $2) first,(date_trunc('day',created_at AT TIME ZONE $2)+interval '1 day') AT TIME ZONE $2 last FROM tasks WHERE id=$1 AND requester_id=$3",[lease.taskId,authority.timezone,p.actorId])).rows[0];
  if(!row)throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');
  const query=caseListInput.parse({from:(row.first as Date).toISOString(),until:(row.last as Date).toISOString(),limit:50});
  const page=await this.listIn(c,p,group,query);
  return {kind:'LIST' as const,...page,coverage:{...page.coverage,calendar:{period:'TODAY' as const,timeZone:authority.timezone,localDate:String(row.local_date),anchoredAt:(row.anchor as Date).toISOString()}}};
 }
 async modelRead(c:pg.PoolClient,ctx:DbContext,lease:Lease,audiences:GroupAudience,input:unknown,signal?:AbortSignal){
  signal?.throwIfAborted();const query=caseListInput.parse(input),origin=await this.nativeOrigin(c,ctx,lease,true);
  const page=await this.listIn(c,{...ctx,native:lease,modelRead:true},origin.group,query,false),projection={items:page.items,nextCursor:page.nextCursor,coverage:page.coverage,contractVersion:page.contractVersion};
  await this.modelReadAllowed(c,ctx,lease,audiences,signal);
  return JSON.parse(JSON.stringify({kind:'GROUP_CASE_RESULT_V1',origin:{...origin,tenantId:ctx.tenantId,actorId:ctx.actorId,leaseHash:hash(canonical({taskId:lease.taskId,runId:lease.runId,goal:lease.goal,audience:lease.audience,authEpoch:lease.authEpoch,policyVersion:lease.policyVersion,budget:lease.budget,expiresAt:lease.expiresAt,groupAudience:lease.groupAudience??null,personaSnapshot:lease.personaSnapshot??null}))},query,projection})) as unknown;
 }
 async applyNative(c:pg.PoolClient,ctx:DbContext,lease:Lease,audiences:NativeCaseAudiencePort,raw:unknown,signal:AbortSignal){
  try{if(!(await c.query("SELECT r.id FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.id=$1 AND r.fence=$2 AND r.lease_owner=$3 AND r.lease_until>clock_timestamp() AND r.status='RUNNING' AND t.status='ACTIVE'",[lease.runId,lease.fence,lease.workerId])).rowCount)throw new GroupCaseError('GROUP_CASE_NATIVE_LEASE_LOST',409);const command=groupCaseCommandSchema.parse(raw);if(canonical(groupCaseCommand(lease.goal))!==canonical(command))throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');const origin=await this.nativeOrigin(c,ctx,lease),p:CaseSubject={...ctx,native:lease,audiences};signal.throwIfAborted();
  if(!await audiences.current(c,ctx,lease,signal))throw new GroupCaseError('GROUP_CASE_AUDIENCE_CHANGED');
  let projection:unknown;
  if(command.operation==='CREATE'){const body=createCaseInput.parse({contractVersion:command.contractVersion,details:command.details,source:{kind:'MENTION',taskId:lease.taskId}});const result=await this.createIn(c,p,origin.group,body,origin.eventId,hash(canonical({group:origin.group,body})));projection={kind:'CASE',...result,coverage:mentionCoverage};}
  else if(command.operation==='UPDATE'){const body=updateCaseInput.parse({contractVersion:command.contractVersion,expectedVersion:command.expectedVersion,command:command.command});const result=await this.updateIn(c,p,origin.group,command.id,body,origin.eventId,hash(canonical({group:origin.group,caseId:command.id,body})));projection={kind:'CASE',...result,coverage:mentionCoverage};}
  else if(command.operation==='LIST'){projection={kind:'LIST',...await this.listIn(c,p,origin.group,caseListInput.parse({from:command.from,until:command.until,limit:command.limit,...(command.cursor?{cursor:command.cursor}:{})}))};}
  else if(command.operation==='TODAY')projection=await this.todayList(c,p,origin.group,lease);
  else {await this.authority(c,p,origin.group,'case.read',null);projection={kind:'CLARIFY',notice:command.notice,coverage:mentionCoverage};}
  signal.throwIfAborted();if(!await audiences.current(c,ctx,lease,signal))throw new GroupCaseError('GROUP_CASE_AUDIENCE_CHANGED');return {...origin,command,projection:JSON.parse(JSON.stringify(projection)) as unknown};}catch(error){failure(error);}
 }
 async nativeProjectionCurrent(c:pg.PoolClient,ctx:DbContext,lease:Lease,raw:unknown,projection:unknown,audiences?:NativeCaseAudiencePort){try{if(!audiences)return false;
  const command=groupCaseCommandSchema.parse(raw);if(canonical(groupCaseCommand(lease.goal))!==canonical(command))throw new GroupCaseError('GROUP_CASE_NATIVE_INVALID');const origin=await this.nativeOrigin(c,ctx,lease),p:CaseSubject={...ctx,native:lease,audiences},authority=await this.authority(c,p,origin.group,'case.read',null);
  const saved=projection as {kind?:unknown;case?:{id?:unknown;contractVersion?:unknown}};
  if(command.operation==='CLARIFY')return canonical(projection)===canonical({kind:'CLARIFY',notice:command.notice,coverage:mentionCoverage});
  if(command.operation==='TODAY')return canonical(projection)===canonical(JSON.parse(JSON.stringify(await this.todayList(c,p,origin.group,lease))));
  if(command.operation==='LIST')return canonical(projection)===canonical(JSON.parse(JSON.stringify({kind:'LIST',...await this.listIn(c,p,origin.group,caseListInput.parse({from:command.from,until:command.until,limit:command.limit,...(command.cursor?{cursor:command.cursor}:{})}))})));
  if(saved.kind!=='CASE'||typeof saved.case?.id!=='string'||saved.case.contractVersion!==authority.contractVersion)return false;
  const body=command.operation==='CREATE'?createCaseInput.parse({contractVersion:command.contractVersion,details:command.details,source:{kind:'MENTION',taskId:lease.taskId}}):updateCaseInput.parse({contractVersion:command.contractVersion,expectedVersion:command.expectedVersion,command:command.command});
  const intent=hash(canonical(command.operation==='CREATE'?{group:origin.group,body}:{group:origin.group,caseId:command.id,body}));
  if(!(await c.query('SELECT id FROM group_case_requests WHERE id=$1 AND actor_id=$2 AND group_id=$3 AND case_id=$4 AND intent_hash=$5',[origin.eventId,ctx.actorId,origin.group,saved.case.id,intent])).rowCount)return false;
  if(command.operation==='CREATE'){if(!(await c.query("SELECT id FROM group_case_sources WHERE case_id=$1 AND submitted_by=$2 AND source_event_id=$3 AND kind='MENTION'",[saved.case.id,ctx.actorId,origin.eventId])).rowCount)return false;}
  else if(command.id!==saved.case.id||!(await c.query('SELECT id FROM group_case_changes WHERE id=$1 AND actor_id=$2 AND case_id=$3 AND case_version=$4 AND contract_version=$5 AND operation=$6 AND intent_hash=$7',[origin.eventId,ctx.actorId,command.id,command.expectedVersion+1,command.contractVersion,command.command.operation,intent])).rowCount)return false;
  return canonical(saved.case)===canonical(JSON.parse(JSON.stringify(await this.result(c,p,origin.group,saved.case.id))));
 }catch{return false;}}

}
