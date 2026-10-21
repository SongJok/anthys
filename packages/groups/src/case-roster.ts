import {z} from 'zod';
import type pg from 'pg';
import type {Principal} from '../../identity/src/sessions.js';
import {DwsIdentities} from '../../dws/src/identity.js';
import {groupAudienceContractHash,groupInfoPayloadProfile} from '../../dws/src/group-contract.js';
import {groupReaderBindingHash} from '../../dws/src/read-client.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {GroupCaseError} from './case-model.js';
const positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const caseObserverSchema=z.object({
 authority:z.object({contractId:z.uuid(),contractVersion:positive,scopeId:z.uuid(),administrator:z.boolean(),ownerReportedAllowed:z.boolean()}).strict(),
 contractHash:sha,revisionId:z.uuid(),delegationId:z.uuid(),delegationHash:sha,administratorId:z.uuid(),serviceOwnerId:z.uuid(),identityId:z.uuid(),ownerAuthEpoch:positive,authorizationVersion:positive,
 subject:z.object({corpId:z.string().min(1),userId:z.string().min(1)}).strict(),policyVersion:z.string().min(1),scopeVersion:positive,
 scopeExpiresAt:z.iso.datetime({offset:true}),contractExpiresAt:z.iso.datetime({offset:true}),sessionAuthEpoch:positive,sessionExpiresAt:z.iso.datetime({offset:true}),
 profile:groupInfoPayloadProfile,approvedBots:z.array(z.object({openBotId:z.string().min(1),robotCode:z.string().min(1)}).strict()).min(1).max(100),
 binaryHash:sha,membersSchemaHash:sha,infoSchemaHash:sha,contractSchemaHash:sha,scopeReview:z.string().min(1),directoryReview:z.string().min(1),grantBindings:z.array(z.object({id:z.uuid(),expiresAt:z.iso.datetime({offset:true}),classification:z.enum(['INTERNAL','CONFIDENTIAL','RESTRICTED'])}).strict()).min(1)
}).strict();
export type CaseObserver=z.infer<typeof caseObserverSchema>;
export type CaseRosterAction='case.read'|'case.create'|'case.update'|'case.escalate';
type Member={id:string;name:string};
/** A fresh remote observation and a reviewed mapping are both necessary. Neither
 * the service owner's private identity nor an old directory entry is a member grant. */
export class GroupCaseRoster {
 private readonly active=new WeakMap<pg.PoolClient,{principal:Principal;group:string;members:Member[];observer:CaseObserver;hash:string}>();
 private readonly identities:DwsIdentities;private readonly authorityDb:import('../../storage/src/database.js').Database;private closed=false;
 constructor(identities:DwsIdentities,private readonly robotCode:string){this.authorityDb=identities.db.forkForAuthority(4);this.identities=new DwsIdentities(this.authorityDb,identities.vault,identities.runner);}
 async close(){if(this.closed)return;this.closed=true;await this.authorityDb.close();}
 private async local(c:pg.PoolClient,p:Principal,group:string,action:CaseRosterAction,version:number|null){
  const value=caseObserverSchema.parse((await c.query('SELECT public.oa_group_case_observer($1,$2,$3,$4) value',[group,p.sessionId,action,version])).rows[0]?.value),r=this.identities.runner;
  if(!r||!this.robotCode||value.sessionAuthEpoch!==p.authEpoch||value.binaryHash!==r.config.binaryHash||value.membersSchemaHash!==r.config.groupMembersSchemaHash||value.infoSchemaHash!==r.config.groupInfoSchemaHash||value.contractSchemaHash!==groupAudienceContractHash)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);
  if(!(await c.query("SELECT id FROM capability_bindings WHERE logical_id='dws.group.audience' AND semantic_version='1.0.0' AND schema_hash=$1 AND risk='READ' AND state='READY'",[groupReaderBindingHash(r)])).rowCount)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);
  const stopped=await c.query("SELECT id FROM kill_switches WHERE enabled AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (mode='ALL' OR $1) AND (scope_kind='TENANT' AND scope_id=$2 OR scope_kind='USER' AND scope_id=ANY($3::text[]) OR scope_kind='GROUP' AND scope_id=$4 OR scope_kind='CONNECTOR' AND scope_id IN ('CORE','DWS')) LIMIT 1",[action!=='case.read',p.tenantId,[p.actorId,value.serviceOwnerId],group]);
  if(stopped.rowCount)throw new GroupCaseError('GROUP_CASE_STOPPED');return value;
 }
 private async observe(c:pg.PoolClient,p:Principal,group:string,action:CaseRosterAction,version:number|null,expected:CaseObserver,signal:AbortSignal){
  const current=async()=>{signal.throwIfAborted();const value=await this.local(c,p,group,action,version);if(canonical(value)!==canonical(expected))throw new GroupCaseError('GROUP_CASE_ROSTER_CHANGED',409);return value;};
  const result=await this.identities.readGroupCaseRoster(p,group,action,expected,signal,current);signal.throwIfAborted();await current();
  const observed=result.members;
  if(observed.conversationId!==group||!observed.platformCountsVerified||observed.internalMembersVerified||!observed.bots.some(b=>b.robotCode===this.robotCode)||observed.bots.some(b=>!expected.approvedBots.some(a=>a.openBotId===b.openBotId&&a.robotCode===b.robotCode)))throw new GroupCaseError('GROUP_CASE_ROSTER_UNVERIFIED');
  const rows=(await c.query('SELECT * FROM public.oa_group_case_observed_members($1,$2,$3,$4,$5)',[group,p.sessionId,action,version,observed.users.map(u=>u.openDingtalkId)])).rows;
  if(rows.length!==observed.users.length||new Set(rows.map(x=>x.id)).size!==rows.length||new Set(rows.map(x=>x.open_id)).size!==rows.length||!rows.some(x=>x.id===p.actorId)||!rows.some(x=>x.id===expected.serviceOwnerId)||!rows.some(x=>x.id===expected.administratorId))throw new GroupCaseError('GROUP_CASE_NOT_MEMBER');
  return {members:rows.map(x=>({id:x.id as string,name:x.name as string})),hash:hash(canonical({scope:expected,observation:observed,directory:rows}))};
 }
 async guard<T>(c:pg.PoolClient,p:Principal,group:string,action:CaseRosterAction,version:number|null,signal:AbortSignal|undefined,fn:()=>Promise<T>):Promise<T>{
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);bounded.throwIfAborted();let callbackFailed=false;
  try{const before=await this.local(c,p,group,action,version),observed=await this.observe(c,p,group,action,version,before,bounded);
   this.active.set(c,{principal:p,group,members:observed.members,observer:before,hash:observed.hash});let value:T;try{value=await fn();}catch(error){callbackFailed=true;throw error;}bounded.throwIfAborted();
   const after=await this.observe(c,p,group,action,version,before,bounded);if(after.hash!==observed.hash)throw new GroupCaseError('GROUP_CASE_ROSTER_CHANGED',409);return value;
  }catch(error){if(callbackFailed||error instanceof GroupCaseError||(error as {code?:string})?.code==='P0001')throw error;throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503,{cause:error});}
  finally{this.active.delete(c);}
 }
 members(c:pg.PoolClient,p:Principal,group:string){const current=this.active.get(c);if(!current||current.principal!==p||current.group!==group)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);return current.members.map(m=>({...m}));}
 evidence(c:pg.PoolClient,p:Principal,group:string){const current=this.active.get(c);if(!current||current.principal!==p||current.group!==group)throw new GroupCaseError('GROUP_CASE_ROSTER_UNAVAILABLE',503);return structuredClone({observer:current.observer,members:current.members,hash:current.hash});}
}
