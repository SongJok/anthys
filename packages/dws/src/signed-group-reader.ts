import {validateGroupMentionRosterDelegation,validateGroupMentionRosterResult,groupMentionRosterTargetForPolicy,type GroupMentionRosterDelegation,type GroupMentionRosterPolicy} from './group-mention-roster-protocol.js';
import {validateNativeCaseRosterDelegation,validateNativeCaseRosterResult,nativeCaseRosterTargetForPolicy,type NativeCaseRosterDelegation,type NativeCaseRosterPolicy} from './native-case-roster-protocol.js';
import {validateScheduledGroupDelegation,validateScheduledGroupResult,scheduledGroupTargetForPolicy,type ScheduledGroupDelegation,type ScheduledGroupPolicy} from './scheduled-group-protocol.js';
import {validateCaseRosterDelegation,validateCaseRosterResult,caseRosterTargetForPolicy,type CaseRosterDelegation,type CaseRosterPolicy} from './case-roster-protocol.js';
import {DwsError,type DwsState} from './contracts.js';
import type {SignedDwsReadClient} from './signed-client.js';
import {groupDelegationSchema,groupScopeSchema,groupTargetForScope,rpcHash,validateSignedGroupObservation,type DwsGroupDelegation,type DwsGroupScope} from './signed-protocol.js';

/** Owner supplies current authority; this adapter returns signed read metadata only. */
export class SignedGroupAudienceReader {
 constructor(private readonly client:SignedDwsReadClient){}
 async read(delegation:DwsGroupDelegation,state:DwsState,scope:DwsGroupScope,signal:AbortSignal){
  signal.throwIfAborted();
  const approved=groupScopeSchema.safeParse(scope);
  if(!approved.success)throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  const candidate=groupDelegationSchema.safeParse(delegation);
  if(!candidate.success||rpcHash(candidate.data)!==rpcHash(approved.data.delegation))throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  const target=groupTargetForScope(approved.data),result=await this.client.readGroupAudience(candidate.data,state,target,signal);
  signal.throwIfAborted();
  if(result.grantsAuthority!==false)throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');
  return {value:validateSignedGroupObservation(result.value,target,approved.data.profile),state:result.state,grantsAuthority:false as const};
 }
 async readGroupMentionAudience(delegation:GroupMentionRosterDelegation,state:DwsState,policy:GroupMentionRosterPolicy,signal:AbortSignal){
  signal.throwIfAborted();const d=validateGroupMentionRosterDelegation(delegation,policy,{now:Date.now()}),target=groupMentionRosterTargetForPolicy(policy),result=await this.client.readGroupMentionAudience(d,state,target,signal);signal.throwIfAborted();
  const validated=validateGroupMentionRosterResult({operation:'READ_GROUP_MENTION_AUDIENCE',grantsAuthority:result.grantsAuthority,delegationHash:rpcHash(d),group:target,observation:result.value},{delegation:d,policy,now:Date.now()});return {value:validated.value,state:result.state,grantsAuthority:false as const};
 }
 async readNativeCaseRoster(delegation:NativeCaseRosterDelegation,state:DwsState,policy:NativeCaseRosterPolicy,signal:AbortSignal){
  signal.throwIfAborted();const d=validateNativeCaseRosterDelegation(delegation,policy,{now:Date.now()}),target=nativeCaseRosterTargetForPolicy(policy),result=await this.client.readNativeCaseRoster(d,state,target,signal);signal.throwIfAborted();
  const validated=validateNativeCaseRosterResult({operation:'READ_NATIVE_GROUP_CASE_ROSTER',grantsAuthority:result.grantsAuthority,delegationHash:rpcHash(d),group:target,observation:result.value},{delegation:d,policy,now:Date.now()});return {value:validated.value,state:result.state,grantsAuthority:false as const};
 }
 async readScheduled(delegation:ScheduledGroupDelegation,state:DwsState,policy:ScheduledGroupPolicy,signal:AbortSignal){
  signal.throwIfAborted();const d=validateScheduledGroupDelegation(delegation,policy,{now:Date.now()}),target=scheduledGroupTargetForPolicy(policy),result=await this.client.readGroupReminderAudience(d,state,target,signal);signal.throwIfAborted();
  const validated=validateScheduledGroupResult({operation:'READ_GROUP_REMINDER_AUDIENCE',grantsAuthority:result.grantsAuthority,delegationHash:rpcHash(d),group:target,observation:result.value},{delegation:d,policy,now:Date.now()});return {value:validated.value,state:result.state,grantsAuthority:false as const};
 }
 async readCaseRoster(delegation:CaseRosterDelegation,state:DwsState,policy:CaseRosterPolicy,signal:AbortSignal){
  signal.throwIfAborted();const d=validateCaseRosterDelegation(delegation,policy,{now:Date.now()}),target=caseRosterTargetForPolicy(policy),result=await this.client.readGroupCaseRoster(d,state,target,signal);signal.throwIfAborted();
  const validated=validateCaseRosterResult({operation:'READ_GROUP_CASE_ROSTER',grantsAuthority:result.grantsAuthority,delegationHash:rpcHash(d),group:target,observation:result.value},{delegation:d,policy,now:Date.now()});return {value:validated.value,state:result.state,grantsAuthority:false as const};
 }

}
