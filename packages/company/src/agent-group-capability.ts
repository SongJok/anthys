import type {Gateway,Capability} from '../../gateway/src/index.js';
import type {Vault} from '../../storage/src/crypto.js';
import {registerScopedCompanyAgent} from './agent-capability.js';
import {agentGroupPilotBindings,type AgentGroupPilotPolicy} from './agent-group-policy.js';
import {companyAgentGroupObserver} from './agent-group-runtime.js';
const certified=new WeakSet<Capability>();
/** Certification requires the reviewed factory's actual frozen callbacks. */
export const isGroupCompanyAgent=(c:Capability|undefined):boolean=>!!c&&certified.has(c);
export function registerGroupCompanyAgent(gateway:Gateway,vault:Vault,raw:AgentGroupPilotPolicy,isCurrent:()=>boolean=()=>true){
 if(!gateway.store.groupAudiences)throw Error('AGENT_GROUP_AUDIENCE_UNAVAILABLE');
 const observer=companyAgentGroupObserver(gateway.store),service=registerScopedCompanyAgent(gateway,vault,agentGroupPilotBindings(raw),isCurrent,observer.dispatch);
 Object.freeze(service.capability);certified.add(service.capability);
 return {...service,observe:observer.observe};
}
