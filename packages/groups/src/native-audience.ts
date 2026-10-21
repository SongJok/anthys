import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Database,DbContext} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import type {Lease} from '../../runtime/src/store.js';
import {groupAudienceRef} from '../../runtime/src/lease-contract.js';
import {DwsIdentities} from '../../dws/src/identity.js';
import {DwsError} from '../../dws/src/contracts.js';
import {rpcHash} from '../../dws/src/signed-protocol.js';
import {groupReaderBindingHash} from '../../dws/src/read-client.js';
import {nativeCaseRosterDelegationSchema} from '../../dws/src/native-case-roster-protocol.js';
import {groupAudienceContractHash,type GroupAudienceObservation} from '../../dws/src/group-contract.js';
import {messageInput} from '../../dingtalk/src/message-input.js';
import {caseObserverSchema,type CaseRosterAction} from './case-roster.js';
import {groupCaseCommand,groupCaseCommandSchema} from './commands.js';
import {killed} from '../../gateway/src/controls.js';

export const nativeCaseObserverSchema=caseObserverSchema.omit({sessionAuthEpoch:true,sessionExpiresAt:true}).extend({requesterAuthEpoch:z.number().int().positive().safe(),requesterDeadline:z.iso.datetime({offset:true})}).strict();
export type NativeCaseObserver=z.infer<typeof nativeCaseObserverSchema>;
export type NativeCasePhase='EXECUTION'|'RESULT_VERIFICATION';
const snapshot=(l:Lease)=>({runId:l.runId,taskId:l.taskId,workerId:l.workerId,fence:l.fence,goal:l.goal,authEpoch:l.authEpoch,policyVersion:l.policyVersion,expiresAt:l.expiresAt,budget:l.budget,audience:l.audience});
const proofSchema=z.strictObject({version:z.literal(1),tenantId:z.uuid(),actorId:z.uuid(),leaseHash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['case.read','case.create','case.update']),observer:nativeCaseObserverSchema,membershipHash:z.string().regex(/^[a-f0-9]{64}$/),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),directoryHash:z.string().regex(/^[a-f0-9]{64}$/),members:z.array(z.strictObject({id:z.uuid(),name:z.string()})).min(1).max(2000)});
/** Only deterministic native case tasks use this separately persisted audience.
 * The requesting member never becomes the service credential owner. */
export class NativeCaseAudience {
 private readonly authorityDb:Database;private readonly identities:DwsIdentities;
 constructor(readonly db:Database,readonly vault:Vault,identities:DwsIdentities,private readonly robotCode:string){this.authorityDb=db.forkForAuthority(4);this.identities=new DwsIdentities(this.authorityDb,vault,identities.runner);}
 async close(){await this.authorityDb.close();}
 private async local(c:pg.PoolClient,ctx:DbContext,l:Lease,action:CaseRosterAction,phase:NativeCasePhase){
  if(l.audience['kind']!=='GROUP'||l.audience['classificationCeiling']!=='INTERNAL'||!z.uuid().safeParse(l.workerId).success)throw new DwsError('GROUP_ORIGIN_UNVERIFIED');
  const group=String(l.audience['targetId']),value=nativeCaseObserverSchema.parse((await c.query('SELECT public.oa_group_case_native_observer($1,$2,$3,$4,$5,$6,$7,NULL) value',[group,l.taskId,l.runId,l.workerId,l.fence,phase,action])).rows[0]?.value),r=this.identities.runner;
  if(!r||!this.robotCode||value.requesterAuthEpoch!==l.authEpoch||value.policyVersion!==l.policyVersion||value.binaryHash!==r.config.binaryHash||value.membersSchemaHash!==r.config.groupMembersSchemaHash||value.infoSchemaHash!==r.config.groupInfoSchemaHash||value.contractSchemaHash!==groupAudienceContractHash)throw new DwsError('GROUP_SCOPE_UNVERIFIED');
  if(!(await c.query("SELECT id FROM capability_bindings WHERE logical_id='dws.group.audience' AND semantic_version='1.0.0' AND schema_hash=$1 AND risk='READ' AND state='READY'",[groupReaderBindingHash(r)])).rowCount||await killed(c,ctx,l,'DWS',action!=='case.read'))throw new DwsError('GROUP_SCOPE_UNVERIFIED');
  if((await c.query("SELECT id FROM kill_switches WHERE enabled AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (mode='ALL' OR $1) AND (scope_kind='USER' AND scope_id=$2 OR scope_kind='CONNECTOR' AND scope_id='CORE') LIMIT 1",[action!=='case.read',value.serviceOwnerId])).rowCount)throw new DwsError('GROUP_SCOPE_UNVERIFIED');
  const origin=(await c.query("SELECT t.goal,t.audience,t.auth_epoch,r.budget,e.id event_id,e.payload_cipher_ref,u.external_user_id,org.corp_id FROM tasks t JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id AND r.owner_id=t.requester_id JOIN event_inbox e ON e.tenant_id=t.tenant_id AND e.id=t.source_event_id AND e.owner_id=t.requester_id AND e.source='DINGTALK' JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.requester_id JOIN tenants org ON org.tenant_id=t.tenant_id WHERE t.id=$1 AND r.id=$2 AND t.requester_id=$3 AND t.control_kind='GROUP_CASE' AND t.expires_at=$4::timestamptz",[l.taskId,l.runId,ctx.actorId,l.expiresAt])).rows[0];
  if(!origin||origin.goal!==l.goal||Number(origin.auth_epoch)!==l.authEpoch||canonical(origin.audience)!==canonical(l.audience)||canonical(origin.budget)!==canonical(l.budget))throw new DwsError('GROUP_ORIGIN_UNVERIFIED');
  const event=JSON.parse(this.vault.open(JSON.parse(origin.payload_cipher_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:inbox:${origin.event_id}`)),input=messageInput(event);
  if(event.conversationType!=='2'||event.conversationId!==group||event.senderStaffId!==origin.external_user_id||event.senderCorpId!==origin.corp_id||event.chatbotCorpId!==origin.corp_id||event.robotCode!==this.robotCode||event.msgtype!=='text'||input.goal!==l.goal||input.attachments.length)throw new DwsError('GROUP_ORIGIN_UNVERIFIED');return value;
 }
 private delegation(ctx:DbContext,l:Lease,o:NativeCaseObserver,action:CaseRosterAction,phase:NativeCasePhase){return nativeCaseRosterDelegationSchema.parse({purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',tenantId:ctx.tenantId,ownerId:o.serviceOwnerId,identityId:o.identityId,authEpoch:o.ownerAuthEpoch,authorizationVersion:o.authorizationVersion,audience:{kind:'PRIVATE_USER',id:o.serviceOwnerId},subject:o.subject,requester:{actorId:ctx.actorId,authEpoch:l.authEpoch,taskId:l.taskId,runId:l.runId,workerId:l.workerId,fence:l.fence,deadline:Date.parse(o.requesterDeadline),phase},contract:{contractId:o.authority.contractId,version:o.authority.contractVersion,revisionHash:o.contractHash,delegationId:o.delegationId},action});}
 private async observe(c:pg.PoolClient,ctx:DbContext,l:Lease,action:CaseRosterAction,phase:NativeCasePhase,expected:NativeCaseObserver,signal:AbortSignal){
  const current=async()=>{signal.throwIfAborted();const value=await this.local(c,ctx,l,action,phase);if(canonical(value)!==canonical(expected))throw new DwsError('GROUP_SCOPE_CHANGED');return value;};
  const delegation=this.delegation(ctx,l,expected,action,phase),authority={conversationId:String(l.audience['targetId']),delegation,scopeId:expected.authority.scopeId,scopeVersion:expected.scopeVersion,scopeExpiresAtMs:Date.parse(expected.scopeExpiresAt),contractExpiresAtMs:Date.parse(expected.contractExpiresAt),profileHash:rpcHash(expected.profile)};
  const result=await this.identities.readNativeCaseRoster(ctx,authority,expected.profile,signal,async()=>{await current();return authority;});
  signal.throwIfAborted();await current();return result;
 }
 private async directory(c:pg.PoolClient,ctx:DbContext,l:Lease,action:CaseRosterAction,phase:NativeCasePhase,o:NativeCaseObserver,observed:GroupAudienceObservation){
  if(observed.conversationId!==l.audience['targetId']||!observed.platformCountsVerified||observed.internalMembersVerified||!observed.bots.some(b=>b.robotCode===this.robotCode)||observed.bots.some(b=>!o.approvedBots.some(a=>a.openBotId===b.openBotId&&a.robotCode===b.robotCode)))throw new DwsError('GROUP_MEMBER_DIRECTORY_UNVERIFIED');
  const rows=(await c.query('SELECT * FROM public.oa_group_case_native_observed_members($1,$2,$3,$4,$5,$6,$7,NULL,$8)',[String(l.audience['targetId']),l.taskId,l.runId,l.workerId,l.fence,phase,action,observed.users.map(u=>u.openDingtalkId)])).rows;
  if(rows.length!==observed.users.length||new Set(rows.map(x=>x.id)).size!==rows.length||new Set(rows.map(x=>x.open_id)).size!==rows.length||![ctx.actorId,o.serviceOwnerId,o.administratorId].every(id=>rows.some(x=>x.id===id)))throw new DwsError('GROUP_MEMBER_DIRECTORY_UNVERIFIED');
  return {members:rows.map(x=>({id:x.id as string,name:x.name as string})),hash:hash(canonical(rows))};
 }
 private async load(c:pg.PoolClient,ctx:DbContext,l:Lease){
  const ref=groupAudienceRef.parse(l.nativeCaseAudience),row=(await c.query('SELECT q.* FROM run_native_case_audiences q JOIN runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.owner_id=q.owner_id AND r.native_case_audience_id=q.id WHERE q.id=$1 AND q.run_id=$2 AND q.owner_id=$3 AND q.task_id=$4 AND q.worker_id=$5 AND q.fence=$6 AND q.expires_at>clock_timestamp() AND q.expires_at=$7::timestamptz',[ref.id,l.runId,ctx.actorId,l.taskId,l.workerId,l.fence,l.expiresAt])).rows[0];
  if(!row||row.proof_hash!==ref.hash)return null;const text=this.vault.open(row.proof_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:native-case-audience:${ref.id}`);if(hash(text)!==ref.hash)return null;const p=proofSchema.parse(JSON.parse(text));
  return p.tenantId===ctx.tenantId&&p.actorId===ctx.actorId&&p.leaseHash===hash(canonical(snapshot(l)))?p:null;
 }
 async issue(ctx:DbContext,l:Lease,guard:(c:pg.PoolClient)=>Promise<void>,parent:AbortSignal){
  const signal=AbortSignal.any([parent,AbortSignal.timeout(12000)]),command=groupCaseCommandSchema.parse(groupCaseCommand(l.goal)),action:CaseRosterAction=command.operation==='CREATE'?'case.create':command.operation==='UPDATE'?'case.update':'case.read';
  return this.db.scope(ctx,async c=>{await guard(c);const existing=(await c.query('SELECT native_case_audience_id FROM runs WHERE id=$1',[l.runId])).rows[0]?.native_case_audience_id as string|null;
   if(existing){const old=(await c.query('SELECT worker_id,fence FROM run_native_case_audiences WHERE id=$1 AND run_id=$2',[existing,l.runId])).rows[0];if(old?.worker_id===l.workerId&&Number(old.fence)===l.fence){if(!await this.current(c,ctx,l,signal))throw new DwsError('GROUP_SCOPE_CHANGED');return groupAudienceRef.parse(l.nativeCaseAudience);}
    if((await c.query('SELECT id FROM group_case_responses WHERE run_id=$1',[l.runId])).rowCount)throw new DwsError('GROUP_SCOPE_CHANGED');}
   const before=await this.local(c,ctx,l,action,'EXECUTION'),observed=await this.observe(c,ctx,l,action,'EXECUTION',before,signal),directory=await this.directory(c,ctx,l,action,'EXECUTION',before,observed.members);await guard(c);signal.throwIfAborted();if(canonical(await this.local(c,ctx,l,action,'EXECUTION'))!==canonical(before))throw new DwsError('GROUP_SCOPE_CHANGED');
   const p=proofSchema.parse({version:1,tenantId:ctx.tenantId,actorId:ctx.actorId,leaseHash:hash(canonical(snapshot(l))),action,observer:before,membershipHash:observed.members.membershipHash,sourceHash:observed.contentHash,directoryHash:directory.hash,members:directory.members}),id=randomUUID(),text=canonical(p),digest=hash(text);
   await c.query('INSERT INTO run_native_case_audiences(tenant_id,id,owner_id,run_id,task_id,service_owner_id,identity_id,authorization_version,scope_id,scope_version,contract_id,worker_id,fence,proof_ref,proof_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[ctx.tenantId,id,ctx.actorId,l.runId,l.taskId,before.serviceOwnerId,before.identityId,before.authorizationVersion,before.authority.scopeId,before.scopeVersion,before.authority.contractId,l.workerId,l.fence,JSON.stringify(this.vault.seal(text,`${ctx.tenantId}:${ctx.actorId}:native-case-audience:${id}`)),digest,l.expiresAt]);
   if(!(await c.query('UPDATE runs SET native_case_audience_id=$2 WHERE id=$1 AND group_audience_id IS NULL AND native_case_audience_id IS NOT DISTINCT FROM $3::uuid',[l.runId,id,existing])).rowCount)throw new DwsError('GROUP_SCOPE_CHANGED');return {id,hash:digest};
  });
 }
 async current(c:pg.PoolClient,ctx:DbContext,l:Lease,parent:AbortSignal=AbortSignal.timeout(12000)):Promise<boolean>{
  try{if(l.groupAudience||l.audience['kind']!=='GROUP')return false;const p=await this.load(c,ctx,l);if(!p)return false;
   const row=(await c.query('SELECT status FROM runs WHERE id=$1',[l.runId])).rows[0],phase:NativeCasePhase=row?.status==='SUCCEEDED'?'RESULT_VERIFICATION':'EXECUTION',action=phase==='RESULT_VERIFICATION'?'case.read':p.action,signal=AbortSignal.any([parent,AbortSignal.timeout(12000)]),before=await this.local(c,ctx,l,action,phase);
   if(canonical(before)!==canonical(p.observer))return false;const observed=await this.observe(c,ctx,l,action,phase,before,signal),directory=await this.directory(c,ctx,l,action,phase,before,observed.members);
   return observed.members.membershipHash===p.membershipHash&&observed.contentHash===p.sourceHash&&directory.hash===p.directoryHash&&canonical(directory.members)===canonical(p.members)&&canonical(await this.local(c,ctx,l,action,phase))===canonical(before)&&!signal.aborted;
  }catch{return false;}
 }
 async currentMembers(c:pg.PoolClient,ctx:DbContext,l:Lease,signal:AbortSignal=AbortSignal.timeout(12000)){
  if(!await this.current(c,ctx,l,signal))throw new DwsError('GROUP_MEMBER_DIRECTORY_UNVERIFIED');const p=await this.load(c,ctx,l);if(!p)throw new DwsError('GROUP_MEMBER_DIRECTORY_UNVERIFIED');return p.members.map(m=>({...m}));
 }
}
