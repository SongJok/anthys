import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import {modelBudgetPolicySchema,assertPolicyEnvironment} from '../../runtime/src/budget-policy.js';
import {formalProfileFingerprint} from './formal-profile.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const budgetTransitionSchema=z.object({
 schemaVersion:z.literal(1),transitionId:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),sourceTrialProfileHash:sha,
 expectedPolicyHash:sha,expectedPolicyVersion:z.string().regex(/^[1-9][0-9]{0,17}$/),policyHash:sha,formalProfileHash:sha,
 reviewReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/)
}).strict();
export function budgetTransitionFingerprint(input:unknown,policyInput:unknown,formalInput:unknown){
 const request=budgetTransitionSchema.parse(input),policy=modelBudgetPolicySchema.parse(policyInput),formal=formalProfileFingerprint(formalInput);
 assertPolicyEnvironment(policy);const policyText=JSON.stringify(policy),policyHash=hash(policyText);
 if(request.policyHash!==policyHash||request.formalProfileHash!==formal.hash||request.tenantId!==formal.profile.tenantId||request.actorId!==formal.profile.actorId
  ||request.sourceTrialProfileHash!==formal.profile.sourceTrialProfileHash||formal.profile.budgetPolicyHash!==policyHash
  ||request.reviewReference!==policy.approvalReference||request.reviewReference===formal.profile.approvalReference
  ||request.expectedPolicyHash===policyHash||Date.parse(formal.profile.validUntil)>Date.parse(policy.validUntil))throw Error('BUDGET_TRANSITION_BINDING_MISMATCH');
 const serialized=JSON.stringify(request);return {request,serialized,hash:hash(serialized),policy,policyText,policyHash,formal};
}
