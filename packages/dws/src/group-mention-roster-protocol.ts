import {z} from 'zod';
import {DwsError,stateSchema,subjectPart} from './contracts.js';
import {groupConversationId,groupInfoPayloadProfile} from './group-contract.js';
import {groupTargetSchema,rpcHash,validateSignedGroupObservation} from './signed-protocol.js';

const positive=z.number().int().positive().safe(),instant=z.number().int().nonnegative().safe(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const purpose=z.literal('GROUP_MENTION'),capability=z.literal('dws.group.mention-audience.v1'),action=z.literal('question.answer'),sourceMode=z.literal('MENTION_ONLY');
const phase=z.enum(['EXECUTION','WAITING_EXTERNAL','RESULT_VERIFICATION']);
const principal=z.strictObject({tenantId:z.uuid(),ownerId:z.uuid(),identityId:z.uuid(),authEpoch:positive,authorizationVersion:positive,
 audience:z.strictObject({kind:z.literal('PRIVATE_USER'),id:z.uuid()}),subject:z.strictObject({corpId:subjectPart,userId:subjectPart})});
export const GROUP_MENTION_ROSTER_NOTICE='GROUP_MENTION 名单观察只绑定数据，不授予群共享、平台权限、企业资源或发送许可。请求者必须是已审核凭据所有者。EXECUTION、WAITING_EXTERNAL 与 RESULT_VERIFICATION 的真实 run/worker/fence、后台 request claim 或历史结果来源，以及合同、成员、目录、取消和到期，均由主服务前后独立复核；签名不是 ACL、持久重放保护或仍持 RUNNING lease 的证明。';

/** Reviewed installation policy can span many actual runs; it never selects or fabricates their authority. */
export const groupMentionRosterPolicySchema=z.strictObject({schemaVersion:z.literal(1),purpose,capabilityBindingId:capability,action,sourceMode,principal,
 contractId:z.uuid(),contractVersion:positive,contractHash:digest,delegationId:z.uuid(),
 scopeId:z.uuid(),scopeVersion:positive,conversationId:groupConversationId,profile:groupInfoPayloadProfile,
 binaryHash:digest,membersSchemaHash:digest,infoSchemaHash:digest,validFrom:instant,expiresAt:instant,
 allowedPhases:z.array(phase).min(1).max(3).refine(values=>new Set(values).size===values.length),
}).superRefine((p,c)=>{if(p.expiresAt<=p.validFrom||p.principal.audience.id!==p.principal.ownerId)c.addIssue({code:'custom',message:'GROUP_MENTION_POLICY_INVALID'});});
export type GroupMentionRosterPolicy=z.infer<typeof groupMentionRosterPolicySchema>;
export const groupMentionRosterOriginSchema=z.discriminatedUnion('phase',[
 z.strictObject({phase:z.literal('EXECUTION'),workerId:z.uuid(),fence:positive}),
 z.strictObject({phase:z.literal('WAITING_EXTERNAL'),requestId:z.uuid(),workerId:z.uuid(),requestFence:positive}),
 z.strictObject({phase:z.literal('RESULT_VERIFICATION'),workerId:z.uuid(),fence:positive}),
]);
export const groupMentionRosterDelegationSchema=principal.extend({purpose,capabilityBindingId:capability,action,sourceMode,
 contract:z.strictObject({contractId:z.uuid(),version:positive,revisionHash:digest,delegationId:z.uuid()}),
 requester:z.strictObject({actorId:z.uuid(),authEpoch:positive,taskId:z.uuid(),runId:z.uuid(),deadline:instant}),
 origin:groupMentionRosterOriginSchema,
}).superRefine((d,c)=>{if(d.audience.id!==d.ownerId||d.requester.actorId!==d.ownerId||d.requester.authEpoch!==d.authEpoch)c.addIssue({code:'custom',message:'GROUP_MENTION_REVIEWED_OWNER_REQUIRED'});});
export type GroupMentionRosterDelegation=z.infer<typeof groupMentionRosterDelegationSchema>;
export const groupMentionRosterTargetSchema=groupTargetSchema;
export type GroupMentionRosterTarget=z.infer<typeof groupMentionRosterTargetSchema>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function snapshotGroupMentionPolicies(raw:unknown):readonly GroupMentionRosterPolicy[]{
 if(raw===undefined)return Object.freeze([]);const result=z.array(groupMentionRosterPolicySchema).max(32).safeParse(raw);
 if(!result.success||new Set(result.data.map(p=>p.scopeId.toLowerCase())).size!==result.data.length)throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');return freeze(result.data);
}
export function groupMentionRosterTargetForPolicy(raw:unknown):GroupMentionRosterTarget{
 const p=groupMentionRosterPolicySchema.parse(raw);return {conversationId:p.conversationId,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeHash:rpcHash(p),profileHash:rpcHash(p.profile),binaryHash:p.binaryHash,membersSchemaHash:p.membersSchemaHash,infoSchemaHash:p.infoSchemaHash};
}
/** Validates claimed data only. Persistent SQL authority and replay/claim state remain host responsibilities. */
export function validateGroupMentionRosterDelegation(raw:unknown,policy:unknown,options:{now:number}):GroupMentionRosterDelegation{
 const d=groupMentionRosterDelegationSchema.safeParse(raw),p=groupMentionRosterPolicySchema.safeParse(policy);if(!d.success||!p.success)throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
 if(!instant.safeParse(options.now).success||options.now<p.data.validFrom||options.now>=p.data.expiresAt||options.now>=d.data.requester.deadline)throw new DwsError('DWS_RPC_EXPIRED');
 const {tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject}=d.data;
 if(rpcHash({tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject})!==rpcHash(p.data.principal)||d.data.contract.contractId!==p.data.contractId||d.data.contract.version!==p.data.contractVersion||d.data.contract.revisionHash!==p.data.contractHash||d.data.contract.delegationId!==p.data.delegationId||!p.data.allowedPhases.includes(d.data.origin.phase))throw new DwsError('DWS_RPC_SCOPE_MISMATCH');return freeze(d.data);
}
export const groupMentionRosterSignedResultSchema=z.strictObject({operation:z.literal('READ_GROUP_MENTION_AUDIENCE'),grantsAuthority:z.literal(false),delegationHash:digest,group:groupMentionRosterTargetSchema,observation:z.unknown()}).superRefine((r,c)=>{try{validateSignedGroupObservation(r.observation,r.group);}catch{c.addIssue({code:'custom',message:'GROUP_MENTION_OBSERVATION_INVALID'});}});
export function validateGroupMentionRosterResult(raw:unknown,options:{delegation:unknown;policy:unknown;now:number}){
 const d=validateGroupMentionRosterDelegation(options.delegation,options.policy,{now:options.now}),p=groupMentionRosterPolicySchema.parse(options.policy),target=groupMentionRosterTargetForPolicy(p),r=groupMentionRosterSignedResultSchema.safeParse(raw);
 if(!r.success||r.data.delegationHash!==rpcHash(d)||rpcHash(r.data.group)!==rpcHash(target))throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');return freeze({value:validateSignedGroupObservation(r.data.observation,target,p.profile),grantsAuthority:false as const,notice:GROUP_MENTION_ROSTER_NOTICE});
}
export const groupMentionRosterRequestSchema=z.strictObject({type:z.literal('READ_REQUEST'),protocol:z.literal('OA_DWS_READ_V1'),instanceId:z.uuid(),requestId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant,operation:z.literal('READ_GROUP_MENTION_AUDIENCE'),delegation:groupMentionRosterDelegationSchema,group:groupMentionRosterTargetSchema,state:stateSchema}).superRefine((r,c)=>{if(r.expiresAt<=r.issuedAt||r.expiresAt-r.issuedAt>10000||r.expiresAt>r.delegation.requester.deadline)c.addIssue({code:'custom',message:'GROUP_MENTION_REQUEST_DEADLINE_INVALID'});});
export type GroupMentionRosterRequest=z.infer<typeof groupMentionRosterRequestSchema>;
