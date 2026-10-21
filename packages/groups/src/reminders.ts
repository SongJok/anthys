import {GroupCaseError} from './case-model.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {preview,ScheduleRuleError} from '../../schedules/src/rules.js';
import {evaluateGroupContract,GROUP_CONTRACT_DEFAULTS,type GroupContract} from './contract-model.js';
import type {GroupCaseRoster} from './case-roster.js';
import {GroupReminderError,groupReminderCreate,groupReminderEdit,groupReminderTransition,groupReminderPreviewInput,groupReminderListInput,groupReminderPage,groupReminderSchedule,groupReminderReceipt,groupReminderNotice,groupReminderRule,groupReminderLimits,groupReminderWorkHours} from './reminder-model.js';
const uuid=z.uuid(),positive=z.number().int().positive().safe();
export const groupReminderDefinition=z.object({rule:groupReminderRule,limits:groupReminderLimits,workHours:groupReminderWorkHours,groupId:z.string().min(1),contractId:uuid,contractVersion:positive,contractHash:z.string().regex(/^[a-f0-9]{64}$/),authorizationId:uuid,serviceOwnerId:uuid}).strict();
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
function failure(e:unknown):never{
 if(e instanceof GroupReminderError||e instanceof z.ZodError)throw e;if(e instanceof GroupCaseError)throw new GroupReminderError(e.code,e.status,{cause:e});if(e instanceof ScheduleRuleError)throw new GroupReminderError(e.code,400);
 const code=e instanceof Error?e.message:'',known:Record<string,number>={GROUP_CASE_SESSION_INVALID:401,GROUP_CASE_NOT_FOUND:404,GROUP_CASE_LIFECYCLE_BLOCKED:403,GROUP_CASE_ACTION_DENIED:403,GROUP_REMINDER_ADMIN_REQUIRED:403,GROUP_REMINDER_STOPPED:403,GROUP_REMINDER_GROUP_LIMIT:429,GROUP_REMINDER_NOT_FOUND:404,GROUP_REMINDER_AUTHORIZATION_REQUIRED:403,GROUP_REMINDER_RULE_OUTSIDE_AUTHORIZATION:400,GROUP_REMINDER_REVISION_CONFLICT:409,GROUP_REMINDER_TRANSITION_DENIED:409,GROUP_REMINDER_REQUEST_CONFLICT:409};
 if(Object.hasOwn(known,code))throw new GroupReminderError(code,known[code]);throw new GroupReminderError('GROUP_REMINDER_UNAVAILABLE',503,{cause:e});
}
export function openGroupReminderDefinition(vault:Vault,ctx:DbContext,row:pg.QueryResultRow){try{
  if(row.tenant_id!==ctx.tenantId||row.owner_id!==ctx.actorId)throw Error('OWNER_MISMATCH');const text=vault.open(row.definition_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:group-reminder:${row.id}`);if(hash(text)!==row.definition_hash)throw Error('HASH_MISMATCH');const d=groupReminderDefinition.parse(JSON.parse(text));
  if(d.groupId!==row.group_id||d.contractId!==row.contract_id||d.authorizationId!==row.authorization_id||d.serviceOwnerId!==ctx.actorId||d.contractVersion!==Number(row.contract_version)||d.limits.remindersPerCasePerDay>Number(row.reminders_per_case_day)||d.limits.summariesPerGroupPerHour>Number(row.summaries_per_group_hour))throw Error('BINDING_MISMATCH');return d;
 }catch(e){throw new GroupReminderError('GROUP_REMINDER_INTEGRITY',503,{cause:e});}}
/** Administrative registration only. No scheduler, notification or model is run here. */
export class GroupReminders {
 constructor(readonly db:Database,readonly vault:Vault,private readonly roster?:GroupCaseRoster,readonly clock:()=>number=Date.now){}
 async close(){await this.roster?.close();}
 aad(ctx:DbContext,id:string){return `${ctx.tenantId}:${ctx.actorId}:group-reminder:${id}`;}
 open(ctx:DbContext,row:pg.QueryResultRow){return openGroupReminderDefinition(this.vault,ctx,row);}

 private async transaction<T>(p:Principal,group:string,signal:AbortSignal|undefined,fn:(c:pg.PoolClient)=>Promise<T>){
  if(!this.roster)throw new GroupReminderError('GROUP_REMINDER_ROSTER_UNAVAILABLE',503);if(signal?.aborted)throw new GroupReminderError('GROUP_REMINDER_CANCELLED',409);
  try{return await this.db.scope(p,async c=>{await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='12s'");const result=await this.roster!.guard(c,p,group,'case.read',null,signal,async()=>{await c.query('SELECT public.oa_group_reminder_admin_authority($1,$2)',[group,p.sessionId]);return fn(c);});signal?.throwIfAborted();return result;});}
  catch(e){if(signal?.aborted)throw new GroupReminderError('GROUP_REMINDER_CANCELLED',409);failure(e);}
 }
 private async contract(c:pg.PoolClient,p:Principal,group:string){
  const row=(await c.query('SELECT c.id,c.version,c.current_revision_id,r.document_ref,r.document_hash FROM group_contracts c JOIN group_contract_revisions r ON r.tenant_id=c.tenant_id AND r.id=c.current_revision_id AND r.contract_id=c.id WHERE c.group_id=$1',[group])).rows[0];if(!row)throw new GroupReminderError('GROUP_REMINDER_NOT_FOUND',404);
  const text=this.vault.open(row.document_ref as Sealed,`${p.tenantId}:group-contract:${row.id}:${row.current_revision_id}`);if(hash(text)!==row.document_hash)throw new GroupReminderError('GROUP_REMINDER_INTEGRITY',503);const document=JSON.parse(text) as GroupContract;
  if(evaluateGroupContract(document,{tenantId:p.tenantId,groupId:group,contractId:row.id,serviceIdentityId:document.serviceIdentityId,currentVersion:Number(row.version),now:this.clock()}).status!=='ELIGIBLE'||document.sources.mode&&document.sources.mode!=='MENTION_ONLY')throw new GroupReminderError('GROUP_REMINDER_SOURCE_DENIED');return {document,hash:row.document_hash as string};
 }
 private async getRow(c:pg.PoolClient,p:Principal,group:string,id:string){return (await c.query('SELECT public.oa_group_reminder_admin_get($1,$2,$3) value',[group,p.sessionId,id])).rows[0].value as pg.QueryResultRow;}
 private async view(c:pg.PoolClient,p:Principal,group:string,row:pg.QueryResultRow){
  const d=this.open({tenantId:p.tenantId,actorId:row.owner_id as string},row),last=(await c.query('SELECT public.oa_group_reminder_admin_occurrence($1,$2,$3) value',[group,p.sessionId,row.id])).rows[0].value;
  return groupReminderSchedule.parse({id:row.id,groupId:group,contractId:row.contract_id,contractVersion:d.contractVersion,authorizationId:row.authorization_id,authorizationExpiresAt:iso(row.authorization_expires_at),revision:Number(row.revision),generation:Number(row.generation),state:!row.authority_live&&['ACTIVE','PAUSED'].includes(row.state as string)?'BLOCKED':row.state,rule:d.rule,limits:d.limits,workHours:d.workHours,nextDueAt:row.next_due_at?iso(row.next_due_at):null,lastError:row.last_error??(!row.authority_live?'GROUP_REMINDER_AUTHORIZATION_UNAVAILABLE':null),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),lastOccurrence:last});
 }
 async list(p:Principal,group:string,raw:unknown,signal?:AbortSignal){const q=groupReminderListInput.parse(raw);return this.transaction(p,group,signal,async c=>{
  const rows=(await c.query('SELECT public.oa_group_reminder_admin_list($1,$2,$3,$4) value',[group,p.sessionId,q.cursor??null,q.limit])).rows[0].value as {schedules:pg.QueryResultRow[];authorizations:pg.QueryResultRow[]},contract=await this.contract(c,p,group),items=[];
  for(const row of rows.schedules.slice(0,q.limit))items.push(await this.view(c,p,group,row));
  return groupReminderPage.parse({items,authorizations:rows.authorizations.map(g=>({id:g.id,contractVersion:Number(g.contract_version),expiresAt:iso(g.expires_at),limits:{remindersPerCasePerDay:Math.min(Number(g.reminders_per_case_day),contract.document.limits?.remindersPerCasePerDay??GROUP_CONTRACT_DEFAULTS.remindersPerCasePerDay),summariesPerGroupPerHour:Math.min(Number(g.summaries_per_group_hour),contract.document.limits?.summariesPerGroupPerHour??GROUP_CONTRACT_DEFAULTS.summariesPerGroupPerHour)},workHours:contract.document.workHours})),nextCursor:rows.schedules.length>q.limit?rows.schedules[q.limit-1]!.id:null,asOf:new Date(this.clock()).toISOString(),coverage:{mode:'MENTION_ONLY',completeChat:false,notice:groupReminderNotice}});
 });}
 async preview(p:Principal,group:string,raw:unknown,signal?:AbortSignal){const {rule}=groupReminderPreviewInput.parse(raw);return this.transaction(p,group,signal,async()=>{const asOf=new Date(this.clock()).toISOString();return {rule,preview:preview(rule,{now:asOf}),asOf};});}
 private async replay(c:pg.PoolClient,p:Principal,group:string,key:string,intent:string){return (await c.query('SELECT public.oa_group_reminder_admin_replay($1,$2,$3,$4) value',[group,p.sessionId,key,intent])).rows[0].value as {id:string;replayed:true}|null;}
 private control(group:string,row:pg.QueryResultRow,replayed:boolean){return groupReminderReceipt.parse({control:{id:row.id,groupId:group,authorizationId:row.authorization_id,revision:Number(row.revision),generation:Number(row.generation),state:row.state,nextDueAt:row.next_due_at?iso(row.next_due_at):null},replayed});}
 async create(p:Principal,group:string,raw:unknown,key:string,signal?:AbortSignal){const b=groupReminderCreate.parse(raw);uuid.parse(key);return this.transaction(p,group,signal,async c=>{
  const old=await this.replay(c,p,group,key,hash(canonical({group,operation:'CREATE',body:b})));if(old)return groupReminderReceipt.parse({schedule:await this.view(c,p,group,await this.getRow(c,p,group,old.id)),replayed:true});
  const source=await this.contract(c,p,group),data=(await c.query('SELECT public.oa_group_reminder_admin_list($1,$2,NULL,50) value',[group,p.sessionId])).rows[0].value as {authorizations:pg.QueryResultRow[]},g=data.authorizations.find(g=>g.id===b.authorizationId);if(!g||source.document.version!==b.contractVersion||!source.document.actions.allowed.includes('case.remind')||source.document.actions.prohibited.includes('case.remind'))throw new GroupReminderError('GROUP_REMINDER_AUTHORIZATION_REQUIRED');
  // Resolve the service owner from the reviewed authorization, never an HTTP ID.
  const owner=(await c.query('SELECT public.oa_group_reminder_admin_service_owner($1,$2,$3) value',[group,p.sessionId,b.authorizationId])).rows[0].value as string;
  const id=randomUUID(),d=groupReminderDefinition.parse({rule:b.rule,limits:{remindersPerCasePerDay:Math.min(Number(g.reminders_per_case_day),source.document.limits?.remindersPerCasePerDay??2),summariesPerGroupPerHour:Math.min(Number(g.summaries_per_group_hour),source.document.limits?.summariesPerGroupPerHour??6)},workHours:source.document.workHours,groupId:group,contractId:source.document.id,contractVersion:b.contractVersion,contractHash:source.hash,authorizationId:b.authorizationId,serviceOwnerId:owner}),text=canonical(d),next=preview(b.rule,{now:new Date(this.clock()).toISOString(),limit:1}).occurrences[0]?.utc;
  if(!next)throw new GroupReminderError('GROUP_REMINDER_FUTURE_TIME_REQUIRED',400);const r=(await c.query('SELECT public.oa_group_reminder_admin_write($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$11) value',[group,p.sessionId,'CREATE',id,b.authorizationId,b.contractVersion,key,hash(canonical({group,operation:'CREATE',body:b})),JSON.stringify(this.vault.seal(text,this.aad({tenantId:p.tenantId,actorId:owner},id))),hash(text),next])).rows[0].value;
  return groupReminderReceipt.parse({schedule:await this.view(c,p,group,await this.getRow(c,p,group,r.id)),replayed:r.replayed});
 });}
 async mutate(p:Principal,group:string,id:string,operation:'EDIT'|'PAUSE'|'RESUME'|'CANCEL',raw:unknown,key:string,signal?:AbortSignal){uuid.parse(id);uuid.parse(key);const b=operation==='EDIT'?groupReminderEdit.parse(raw):groupReminderTransition.parse(raw);return this.transaction(p,group,signal,async c=>{
  const old=await this.replay(c,p,group,key,hash(canonical({group,id,operation,body:b})));if(old){const row=await this.getRow(c,p,group,old.id);return operation==='PAUSE'||operation==='CANCEL'?this.control(group,row,true):groupReminderReceipt.parse({schedule:await this.view(c,p,group,row),replayed:true});}
  const row=await this.getRow(c,p,group,id);
  // A stop must not require opening potentially corrupt schedule content. Its
  // minimal receipt is current persisted control state, never a fabricated rule.
  if(operation==='PAUSE'||operation==='CANCEL'){const r=(await c.query('SELECT public.oa_group_reminder_admin_write($1,$2,$3,$4,$5,NULL,NULL,$6,$7,NULL,NULL,NULL) value',[group,p.sessionId,operation,id,b.expectedRevision,key,hash(canonical({group,id,operation,body:b}))])).rows[0].value,stopped=await this.getRow(c,p,group,r.id);return this.control(group,stopped,r.replayed);}
  if(row.state==='CANCELLED')throw new GroupReminderError('GROUP_REMINDER_TRANSITION_DENIED',409);
  const d=this.open({tenantId:p.tenantId,actorId:row.owner_id as string},row),updated=operation==='EDIT'?groupReminderDefinition.parse({...d,rule:groupReminderEdit.parse(b).rule}):d,text=canonical(updated),next=['EDIT','RESUME'].includes(operation)?preview(updated.rule,{now:new Date(this.clock()).toISOString(),limit:1}).occurrences[0]?.utc:null;
  if(['EDIT','RESUME'].includes(operation)&&!next)throw new GroupReminderError('GROUP_REMINDER_FUTURE_TIME_REQUIRED',400);
  const r=(await c.query('SELECT public.oa_group_reminder_admin_write($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8,$9,$10) value',[group,p.sessionId,operation,id,b.expectedRevision,key,hash(canonical({group,id,operation,body:b})),operation==='EDIT'?JSON.stringify(this.vault.seal(text,this.aad({tenantId:p.tenantId,actorId:row.owner_id as string},id))):null,operation==='EDIT'?hash(text):null,next??null])).rows[0].value;
  return groupReminderReceipt.parse({schedule:await this.view(c,p,group,await this.getRow(c,p,group,r.id)),replayed:r.replayed});
 });}
}
