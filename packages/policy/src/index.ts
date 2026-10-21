import type {Risk} from '../../contracts/src/index.js';
export interface PolicyInput {identityActive:boolean;epochMatches:boolean;appReady:boolean;platformPermission:boolean;delegationValid:boolean;resourceAllowed:boolean;audienceAllowed:boolean;budgetAvailable:boolean;notExpired:boolean;notCancelled:boolean;killSwitch:boolean;approvalValid:boolean;risk:Risk}
export function authorize(p:PolicyInput):{allowed:boolean;reason:string} {
 const checks:[boolean,string][]=[[p.identityActive&&p.epochMatches,'IDENTITY_INVALID'],[p.notCancelled,'CANCELLED'],[p.notExpired,'EXPIRED'],[!p.killSwitch,'KILL_SWITCH'],[p.risk!=='FORBIDDEN','FORBIDDEN'],[p.appReady,'SOURCE_UNAVAILABLE'],[p.platformPermission,'PLATFORM_PERMISSION'],[p.delegationValid,'USER_CONSENT_REQUIRED'],[p.resourceAllowed,'RESOURCE_DENIED'],[p.audienceAllowed,'AUDIENCE_DENIED'],[p.budgetAvailable,'BUDGET_EXHAUSTED'],[p.risk==='READ'||p.approvalValid,'APPROVAL_REQUIRED']];
 for(const [ok,reason] of checks) if(!ok) return {allowed:false,reason};return {allowed:true,reason:'AUTHORIZED'};
}
