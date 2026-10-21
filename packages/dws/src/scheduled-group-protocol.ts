import {z} from 'zod';
import {DwsError,stateSchema,subjectPart} from './contracts.js';
import {groupConversationId,groupInfoPayloadProfile} from './group-contract.js';
import {groupTargetSchema,rpcHash,validateSignedGroupObservation} from './signed-protocol.js';

const positive=z.number().int().positive().safe(),instant=z.number().int().nonnegative().safe(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const purpose=z.literal('SCHEDULED_CONTRACT'),capability=z.literal('dws.group.reminder-audience.v1');
const principal=z.object({tenantId:z.uuid(),ownerId:z.uuid(),identityId:z.uuid(),authEpoch:positive,authorizationVersion:positive,audience:z.object({kind:z.literal('PRIVATE_USER'),id:z.uuid()}).strict(),subject:z.object({corpId:subjectPart,userId:subjectPart}).strict()}).strict();
/** Trusted installed observation policy, separate from H5 sessions and native mentions. */
export const scheduledGroupPolicySchema=z.object({schemaVersion:z.literal(1),purpose,capabilityBindingId:capability,principal,
 contractId:z.uuid(),delegationId:z.uuid(),scheduleId:z.uuid(),proactiveAuthorizationId:z.uuid(),proactiveAuthorizationHash:digest,
 scopeId:z.uuid(),scopeVersion:positive,conversationId:groupConversationId,profile:groupInfoPayloadProfile,binaryHash:digest,membersSchemaHash:digest,infoSchemaHash:digest,validFrom:instant,expiresAt:instant,
}).strict().superRefine((p,c)=>{if(p.expiresAt<=p.validFrom||p.principal.audience.id!==p.principal.ownerId)c.addIssue({code:'custom',message:'SCHEDULED_GROUP_POLICY_INVALID'});});
export type ScheduledGroupPolicy=z.infer<typeof scheduledGroupPolicySchema>;
/** Occurrence references are caller assertions. Only the outer SQL store proves them. */
export const scheduledGroupDelegationSchema=principal.extend({purpose,capabilityBindingId:capability,
 contract:z.object({contractId:z.uuid(),version:positive,revisionHash:digest,delegationId:z.uuid()}).strict(),
 authorization:z.object({id:z.uuid(),version:positive,documentHash:digest}).strict(),
 scheduled:z.object({scheduleId:z.uuid(),revision:positive,generation:positive,occurrenceId:z.uuid(),fence:positive,scheduledAt:z.iso.datetime(),notificationId:z.uuid(),originHash:digest,phase:z.enum(['PLAN','SEND'])}).strict(),
}).strict().superRefine((d,c)=>{if(d.audience.id!==d.ownerId)c.addIssue({code:'custom',message:'SCHEDULED_GROUP_OWNER_MISMATCH'});});
export type ScheduledGroupDelegation=z.infer<typeof scheduledGroupDelegationSchema>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function snapshotScheduledGroupPolicies(raw:unknown):readonly ScheduledGroupPolicy[]{
 if(raw===undefined)return Object.freeze([]);const r=z.array(scheduledGroupPolicySchema).max(32).safeParse(raw);
 if(!r.success||new Set(r.data.map(p=>p.scopeId+':'+p.scheduleId)).size!==r.data.length)throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');return freeze(r.data);
}
export function scheduledGroupTargetForPolicy(raw:unknown){const p=scheduledGroupPolicySchema.parse(raw);return {conversationId:p.conversationId,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeHash:rpcHash(p),profileHash:rpcHash(p.profile),binaryHash:p.binaryHash,membersSchemaHash:p.membersSchemaHash,infoSchemaHash:p.infoSchemaHash};}
export function validateScheduledGroupDelegation(raw:unknown,policy:unknown,options:{now:number}):ScheduledGroupDelegation{
 const d=scheduledGroupDelegationSchema.safeParse(raw),p=scheduledGroupPolicySchema.safeParse(policy);if(!d.success||!p.success)throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
 if(!instant.safeParse(options.now).success||options.now<p.data.validFrom||options.now>=p.data.expiresAt)throw new DwsError('DWS_RPC_EXPIRED');
 const {tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject}=d.data;
 if(rpcHash({tenantId,ownerId,identityId,authEpoch,authorizationVersion,audience,subject})!==rpcHash(p.data.principal)||d.data.contract.contractId!==p.data.contractId||d.data.contract.delegationId!==p.data.delegationId||d.data.scheduled.scheduleId!==p.data.scheduleId||d.data.authorization.id!==p.data.proactiveAuthorizationId||d.data.authorization.documentHash!==p.data.proactiveAuthorizationHash)throw new DwsError('DWS_RPC_SCOPE_MISMATCH');return d.data;
}
export const scheduledGroupSignedResultSchema=z.object({operation:z.literal('READ_GROUP_REMINDER_AUDIENCE'),grantsAuthority:z.literal(false),delegationHash:digest,group:groupTargetSchema,observation:z.unknown()}).strict().superRefine((r,c)=>{try{validateSignedGroupObservation(r.observation,r.group);}catch{c.addIssue({code:'custom',message:'SCHEDULED_GROUP_OBSERVATION_INVALID'});}});
export function validateScheduledGroupResult(raw:unknown,options:{delegation:unknown;policy:unknown;now:number}){
 const d=validateScheduledGroupDelegation(options.delegation,options.policy,{now:options.now}),p=scheduledGroupPolicySchema.parse(options.policy),target=scheduledGroupTargetForPolicy(p),r=scheduledGroupSignedResultSchema.safeParse(raw);
 if(!r.success||r.data.delegationHash!==rpcHash(d)||rpcHash(r.data.group)!==rpcHash(target))throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');return {value:validateSignedGroupObservation(r.data.observation,target,p.profile),grantsAuthority:false as const};
}
export const scheduledGroupRequestSchema=z.object({type:z.literal('READ_REQUEST'),protocol:z.literal('OA_DWS_READ_V1'),instanceId:z.uuid(),requestId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant,operation:z.literal('READ_GROUP_REMINDER_AUDIENCE'),delegation:scheduledGroupDelegationSchema,group:groupTargetSchema,state:stateSchema}).strict();
