import {z} from 'zod';
import {DwsError,stateSchema,subjectPart} from './contracts.js';
import {groupConversationId,groupInfoPayloadProfile} from './group-contract.js';
import {groupTargetSchema,rpcHash,validateSignedGroupObservation} from './signed-protocol.js';

export const NATIVE_CASE_ROSTER_NOTICE='NATIVE_GROUP_CASE 群名单观察仅为数据绑定；不证明当前成员、任务归属、worker/fence、RUNNING lease 或事项权限。EXECUTION 必须由主服务前后复核真实 RUNNING worker/fence/lease；RESULT_VERIFICATION 必须复核已持久 SUCCEEDED 的同 worker/fence 来源，且仅允许 case.read。PRIVATE_USER 仅绑定已审核服务凭据所有者，不将请求成员替换为该所有者，也不授予其私有数据访问权。合同、scope、目录、取消与授权均须独立复核。';
const positive=z.number().int().positive().safe(),instant=z.number().int().nonnegative().safe();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const purpose=z.literal('NATIVE_GROUP_CASE'),capability=z.literal('dws.group.native-case-roster.v1');
const action=z.enum(['case.read','case.create','case.update']);
const phase=z.enum(['EXECUTION','RESULT_VERIFICATION']);
const principal=z.strictObject({tenantId:z.uuid(),ownerId:z.uuid(),identityId:z.uuid(),authEpoch:positive,authorizationVersion:positive,
  audience:z.strictObject({kind:z.literal('PRIVATE_USER'),id:z.uuid()}),
  subject:z.strictObject({corpId:subjectPart,userId:subjectPart})});

/** Trusted installation snapshot. principal always denotes the reviewed credential owner, never the actual requester. */
export const nativeCaseRosterPolicySchema=z.strictObject({schemaVersion:z.literal(1),purpose,capabilityBindingId:capability,principal,
  contractId:z.uuid(),contractVersion:positive,contractHash:digest,delegationId:z.uuid(),
  allowedActions:z.array(action).min(1).max(3).refine(values=>new Set(values).size===values.length),
  allowedPhases:z.array(phase).min(1).max(2).refine(values=>new Set(values).size===values.length),
  scopeId:z.uuid(),scopeVersion:positive,conversationId:groupConversationId,profile:groupInfoPayloadProfile,
  binaryHash:digest,membersSchemaHash:digest,infoSchemaHash:digest,validFrom:instant,expiresAt:instant,
}).superRefine((p,c)=>{
  if(p.expiresAt<=p.validFrom||p.principal.audience.id!==p.principal.ownerId)c.addIssue({code:'custom',message:'NATIVE_CASE_ROSTER_POLICY_INVALID'});
});
export type NativeCaseRosterPolicy=z.infer<typeof nativeCaseRosterPolicySchema>;

/** Signed caller assertions only. No H5 session, schedule origin, enterprise request claim or fabricated owner lease. */
export const nativeCaseRosterDelegationSchema=principal.extend({purpose,capabilityBindingId:capability,
  requester:z.strictObject({actorId:z.uuid(),authEpoch:positive,taskId:z.uuid(),runId:z.uuid(),workerId:z.uuid(),fence:positive,
    deadline:instant,phase}),
  contract:z.strictObject({contractId:z.uuid(),version:positive,revisionHash:digest,delegationId:z.uuid()}),action,
}).superRefine((d,c)=>{
  if(d.audience.id!==d.ownerId)c.addIssue({code:'custom',message:'NATIVE_CASE_ROSTER_OWNER_MISMATCH'});
  if(d.requester.phase==='RESULT_VERIFICATION'&&d.action!=='case.read')c.addIssue({code:'custom',message:'NATIVE_CASE_ROSTER_RESULT_READ_ONLY'});
});
export type NativeCaseRosterDelegation=z.infer<typeof nativeCaseRosterDelegationSchema>;
export const nativeCaseRosterTargetSchema=groupTargetSchema;
export type NativeCaseRosterTarget=z.infer<typeof nativeCaseRosterTargetSchema>;

function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
}
/** Disabled when absent. This snapshots definitions; it does not install grants or infer approval. */
export function snapshotNativeCaseRosterPolicies(raw:unknown):readonly NativeCaseRosterPolicy[] {
  if(raw===undefined)return Object.freeze([]);
  const result=z.array(nativeCaseRosterPolicySchema).max(32).safeParse(raw);
  if(!result.success||new Set(result.data.map(p=>p.scopeId.toLowerCase())).size!==result.data.length)throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  return freeze(result.data);
}
/** Every fixed credential/contract/scope/action/phase field is included; old leaf scope hashes are not interchangeable. */
export function nativeCaseRosterTargetForPolicy(raw:unknown):NativeCaseRosterTarget {
  const p=nativeCaseRosterPolicySchema.parse(raw);
  return {conversationId:p.conversationId,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeHash:rpcHash(p),profileHash:rpcHash(p.profile),
    binaryHash:p.binaryHash,membersSchemaHash:p.membersSchemaHash,infoSchemaHash:p.infoSchemaHash};
}

/** Checks claimed data and fixed policy only. SQL must separately prove current or historical run authority before and after the read. */
export function validateNativeCaseRosterDelegation(raw:unknown,policy:unknown,options:{now:number}):NativeCaseRosterDelegation {
  const d=nativeCaseRosterDelegationSchema.safeParse(raw),p=nativeCaseRosterPolicySchema.safeParse(policy);
  if(!d.success||!p.success)throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  if(!instant.safeParse(options.now).success||options.now<p.data.validFrom||options.now>=p.data.expiresAt||options.now>=d.data.requester.deadline)throw new DwsError('DWS_RPC_EXPIRED');
  const {tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject}=d.data;
  if(rpcHash({tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject})!==rpcHash(p.data.principal)
    ||d.data.contract.contractId!==p.data.contractId||d.data.contract.version!==p.data.contractVersion
    ||d.data.contract.revisionHash!==p.data.contractHash||d.data.contract.delegationId!==p.data.delegationId
    ||!p.data.allowedActions.includes(d.data.action)||!p.data.allowedPhases.includes(d.data.requester.phase))throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  return freeze(d.data);
}

/** Existing signed transport must verify the envelope, request hash/instance/ID/deadline and credential state first. */
export const nativeCaseRosterSignedResultSchema=z.strictObject({operation:z.literal('READ_NATIVE_GROUP_CASE_ROSTER'),grantsAuthority:z.literal(false),
  delegationHash:digest,group:nativeCaseRosterTargetSchema,observation:z.unknown(),
}).superRefine((r,c)=>{
  try{validateSignedGroupObservation(r.observation,r.group);}catch{c.addIssue({code:'custom',message:'NATIVE_CASE_ROSTER_OBSERVATION_INVALID'});}
});
export type NativeCaseRosterSignedResult=z.infer<typeof nativeCaseRosterSignedResultSchema>;
export function validateNativeCaseRosterResult(raw:unknown,options:{delegation:unknown;policy:unknown;now:number}) {
  const d=validateNativeCaseRosterDelegation(options.delegation,options.policy,{now:options.now});
  const p=nativeCaseRosterPolicySchema.parse(options.policy),target=nativeCaseRosterTargetForPolicy(p),r=nativeCaseRosterSignedResultSchema.safeParse(raw);
  if(!r.success||r.data.delegationHash!==rpcHash(d)||rpcHash(r.data.group)!==rpcHash(target))throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');
  return freeze({value:validateSignedGroupObservation(r.data.observation,target,p.profile),grantsAuthority:false as const,notice:NATIVE_CASE_ROSTER_NOTICE});
}

// A separate strict leaf, deliberately not appended to any existing union here.
// deadline is the fixed task/contract/scope minimum, not a renewed lease_until.
export const nativeCaseRosterRequestSchema=z.strictObject({type:z.literal('READ_REQUEST'),protocol:z.literal('OA_DWS_READ_V1'),
  instanceId:z.uuid(),requestId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant,
  operation:z.literal('READ_NATIVE_GROUP_CASE_ROSTER'),delegation:nativeCaseRosterDelegationSchema,group:nativeCaseRosterTargetSchema,state:stateSchema,
}).superRefine((r,c)=>{
  if(r.expiresAt<=r.issuedAt||r.expiresAt-r.issuedAt>10_000||r.expiresAt>r.delegation.requester.deadline)c.addIssue({code:'custom',message:'NATIVE_CASE_ROSTER_REQUEST_DEADLINE_INVALID'});
});
export type NativeCaseRosterRequest=z.infer<typeof nativeCaseRosterRequestSchema>;
