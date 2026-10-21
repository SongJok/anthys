import {preview} from '../../schedules/src/rules.js';
import {openGroupReminderDefinition} from './reminders.js';
import {z} from 'zod';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {DwsIdentities} from '../../dws/src/identity.js';
import type {DwsScheduledGroupAuthority} from '../../dws/src/read-client.js';
import {groupReaderBindingHash} from '../../dws/src/read-client.js';
import {groupAudienceContractHash} from '../../dws/src/group-contract.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {caseObserverSchema} from './case-roster.js';
import {groupReminderLimits,GroupReminderError} from './reminder-model.js';
const iso=(v:unknown)=>new Date(v as string|Date).toISOString();
const positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
export const groupReminderObserverSchema=caseObserverSchema.omit({authority:true,sessionAuthEpoch:true,sessionExpiresAt:true}).extend({
 groupId:z.string().min(1).max(2048),contractId:z.uuid(),contractVersion:positive,scopeId:z.uuid(),
 authorization:z.object({id:z.uuid(),version:z.literal(1),documentHash:sha,expiresAt:instant,limits:groupReminderLimits}).strict(),
 schedule:z.object({id:z.uuid(),revision:positive,generation:positive,definitionHash:sha}).strict(),
 occurrence:z.object({id:z.uuid(),fence:positive,scheduledAt:instant,expiresAt:instant,notificationId:z.uuid(),phase:z.enum(['PLAN','SEND'])}).strict(),originHash:sha
}).strict();
export type GroupReminderObserver=z.infer<typeof groupReminderObserverSchema>;
export type GroupReminderOrigin={occurrenceId:string;fence:number;phase:'PLAN'|'SEND'};
export type GroupReminderObservation={observer:GroupReminderObserver;members:{id:string;name:string}[];observationHash:string;membershipHash:string};
/** A fresh scheduled-contract observation has its own authority source. Neither
 * an H5 session, copied mention, directory row nor prior observation can replace it. */
export class GroupReminderAudience {
 private readonly identities:DwsIdentities;private closed=false;
 constructor(identities:DwsIdentities,private readonly robotCode:string){this.identities=new DwsIdentities(identities.db.forkForAuthority(4),identities.vault,identities.runner);}
 async close(){if(this.closed)return;this.closed=true;await this.identities.db.close();}
 async local(c:pg.PoolClient,ctx:DbContext,origin:GroupReminderOrigin){
  const o=groupReminderObserverSchema.parse((await c.query('SELECT public.oa_group_reminder_observer($1,$2,$3) value',[origin.occurrenceId,origin.fence,origin.phase])).rows[0]?.value),r=this.identities.runner;
  if(!r||!this.robotCode||o.serviceOwnerId!==ctx.actorId||o.occurrence.id!==origin.occurrenceId||o.occurrence.fence!==origin.fence||o.occurrence.phase!==origin.phase||o.binaryHash!==r.config.binaryHash||o.membersSchemaHash!==r.config.groupMembersSchemaHash||o.infoSchemaHash!==r.config.groupInfoSchemaHash||o.contractSchemaHash!==groupAudienceContractHash)throw new GroupReminderError('GROUP_REMINDER_ROSTER_UNAVAILABLE',503);
  if(!(await c.query("SELECT id FROM capability_bindings WHERE logical_id='dws.group.audience' AND semantic_version='1.0.0' AND schema_hash=$1 AND risk='READ' AND state='READY'",[groupReaderBindingHash(r)])).rowCount)throw new GroupReminderError('GROUP_REMINDER_ROSTER_UNAVAILABLE',503);
  const row=(await c.query('SELECT s.*,g.contract_version,g.reminders_per_case_day,g.summaries_per_group_hour FROM group_reminder_schedules s JOIN group_reminder_authorizations g ON g.tenant_id=s.tenant_id AND g.id=s.authorization_id WHERE s.id=$1',[o.schedule.id])).rows[0];if(!row||row.definition_hash!==o.schedule.definitionHash)throw new GroupReminderError('GROUP_REMINDER_ORIGIN_INVALID');
  const d=openGroupReminderDefinition(this.identities.vault,ctx,row),at=Date.parse(o.occurrence.scheduledAt),expires=Date.parse(o.occurrence.expiresAt);
  if(d.contractHash!==o.contractHash||d.contractVersion!==o.contractVersion||d.contractId!==o.contractId||d.groupId!==o.groupId||d.authorizationId!==o.authorization.id||at<Date.parse(iso(row.created_at))||expires>Math.min(at+3600000,Date.parse(o.authorization.expiresAt),Date.parse(o.contractExpiresAt),Date.parse(o.scopeExpiresAt))||preview(d.rule,{now:new Date(at-1).toISOString(),limit:1}).occurrences[0]?.utc!==new Date(at).toISOString())throw new GroupReminderError('GROUP_REMINDER_ORIGIN_INVALID');return o;
 }
 private authority(ctx:DbContext,group:string,o:GroupReminderObserver):DwsScheduledGroupAuthority{
  return {conversationId:group,scopeId:o.scopeId,scopeVersion:o.scopeVersion,scopeExpiresAtMs:Date.parse(o.scopeExpiresAt),contractExpiresAtMs:Date.parse(o.contractExpiresAt),authorizationExpiresAtMs:Date.parse(o.authorization.expiresAt),profileHash:hash(canonical(o.profile)),delegation:{
   tenantId:ctx.tenantId,ownerId:ctx.actorId,identityId:o.identityId,authEpoch:o.ownerAuthEpoch,authorizationVersion:o.authorizationVersion,audience:{kind:'PRIVATE_USER',id:ctx.actorId},subject:o.subject,
   purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',contract:{contractId:o.contractId,version:o.contractVersion,revisionHash:o.contractHash,delegationId:o.delegationId},authorization:{id:o.authorization.id,version:o.authorization.version,documentHash:o.authorization.documentHash},
   scheduled:{scheduleId:o.schedule.id,revision:o.schedule.revision,generation:o.schedule.generation,occurrenceId:o.occurrence.id,fence:o.occurrence.fence,scheduledAt:new Date(o.occurrence.scheduledAt).toISOString(),notificationId:o.occurrence.notificationId,originHash:o.originHash,phase:o.occurrence.phase}
  }};
 }
 async observe(c:pg.PoolClient,ctx:DbContext,group:string,origin:GroupReminderOrigin,signal:AbortSignal,expected?:GroupReminderObserver):Promise<GroupReminderObservation>{
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(12000)]);bounded.throwIfAborted();
  try{
   const before=await this.local(c,ctx,origin);if(before.groupId!==group||expected&&canonical(before)!==canonical(expected))throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED',409);
   const current=async()=>{bounded.throwIfAborted();const now=await this.local(c,ctx,origin);if(canonical(now)!==canonical(before))throw new GroupReminderError('GROUP_REMINDER_SOURCE_CHANGED',409);return this.authority(ctx,group,now);};
   const result=await this.identities.readScheduledGroupAudience(ctx,this.authority(ctx,group,before),before.profile,bounded,current);bounded.throwIfAborted();await current();const m=result.members;
   if(m.conversationId!==group||!m.platformCountsVerified||m.internalMembersVerified||!m.bots.some(b=>b.robotCode===this.robotCode)||m.bots.some(b=>!before.approvedBots.some(a=>a.openBotId===b.openBotId&&a.robotCode===b.robotCode)))throw new GroupReminderError('GROUP_REMINDER_ROSTER_UNVERIFIED');
   const rows=(await c.query('SELECT * FROM public.oa_group_reminder_observed_members($1,$2,$3,$4)',[origin.occurrenceId,origin.fence,origin.phase,m.users.map(u=>u.openDingtalkId)])).rows;
   if(rows.length!==m.users.length||new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.open_id)).size!==rows.length||!rows.some(r=>r.id===ctx.actorId)||!rows.some(r=>r.id===before.administratorId))throw new GroupReminderError('GROUP_REMINDER_NOT_MEMBER');
   return {observer:before,members:rows.map(r=>({id:r.id as string,name:r.name as string})),observationHash:hash(canonical({observer:before,observation:m,directory:rows})),membershipHash:hash(canonical({observation:m,directory:rows}))};
  }catch(error){if(error instanceof GroupReminderError||(error as {code?:string})?.code==='P0001')throw error;throw new GroupReminderError('GROUP_REMINDER_ROSTER_UNAVAILABLE',503,{cause:error});}
 }
}
