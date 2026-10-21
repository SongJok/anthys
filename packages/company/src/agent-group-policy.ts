import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {agentPilotPolicySchema} from './agent-capability.js';
import {agentTextResultContract} from './agent-result.js';

const inherited=agentPilotPolicySchema.shape;
/** Reviewed configuration only. This shape does not establish current group
 * membership, contract/grant authority, enterprise ACLs or permission to send. */
export const agentGroupPilotPolicySchema=z.object({
 ...inherited,
 kind:z.literal('ENTERPRISE_AGENT_GROUP_MENTION_PILOT'),
 scope:inherited.scope.extend({classification:z.literal('INTERNAL')}),
 group:z.object({
  conversationId:z.string().min(1).max(256).refine(value=>value.trim().length>0),
  mode:z.literal('MENTION_ONLY'),
  scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),
  contractId:z.uuid(),contractVersion:z.number().int().positive().safe(),
  contractHash:z.string().regex(/^[a-f0-9]{64}$/),
  membershipHash:z.string().regex(/^[a-f0-9]{64}$/),
  directoryHash:z.string().regex(/^[a-f0-9]{64}$/),
  audienceReviewRef:inherited.approvalReference,
  sharingReviewRef:inherited.approvalReference
 }).strict()
}).strict().superRefine((policy,context)=>{
 // Zod does not allow ordinary extend() on a refined object. Reuse the private
 // field schemas and its existing window/duplicate checks without weakening or
 // duplicating their rules; the parsed output retains the distinct group kind.
 const {group:_group,...fields}=policy;
 const checked=agentPilotPolicySchema.safeParse({...fields,kind:'ENTERPRISE_AGENT_PRIVATE_PILOT'});
 if(!checked.success)for(const issue of checked.error.issues)context.addIssue({code:'custom',path:issue.path,message:issue.message});
});
export type AgentGroupPilotPolicy=z.infer<typeof agentGroupPilotPolicySchema>;
function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
/** Pure immutable pins. Registration, live authorization and all I/O belong to
 * the host; changing a scope or connector alias does not reset its budget id. */
export function agentGroupPilotBindings(raw:AgentGroupPilotPolicy){
 const policy=agentGroupPilotPolicySchema.parse(raw);freeze(policy);
 const upstreamHash=policy.connection.endpointHash,connectionHash=hash(canonical(policy.connection));
 const scopeHash=hash(canonical({id:policy.id,tenantId:policy.tenantId,actorId:policy.actorId,connectionHash,scope:policy.scope,group:policy.group,validFrom:policy.validFrom,validUntil:policy.validUntil,approvalReference:policy.approvalReference}));
 const budgetHash=hash(canonical({tenantId:policy.tenantId,budgetId:policy.budget.id}));
 const bindingHash=hash(canonical({id:'company.agent.ask',version:'1.0.0',policy,outputSchema:agentTextResultContract.outputSchema}));
 return {policy,upstreamHash,connectionHash,scopeHash,budgetHash,bindingHash,resource:'enterprise-agent:'+policy.scope.id};
}
