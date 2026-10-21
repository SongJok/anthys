import type {CapabilityReview} from '../../contracts/src/capability.js';
export const reviewedCapabilityIds=['tasks.get','attachments.inspect','attachments.read_text','company.code.search','company.code.read','company.logs.query','dws.connection.status','dws.contact.me','dws.doc.read'] as const;
export type ReviewedCapabilityId=typeof reviewedCapabilityIds[number];
// These are actual local preconditions and evidence references, never guessed
// vendor scope codes. Platform authorization still requires current checks.
const reviews:Record<ReviewedCapabilityId,Omit<CapabilityReview,'bindingRef'|'supportsIdempotency'|'supportsDryRun'>>={
 'tasks.get':{authModes:['CORE'],requiredPermissions:[{name:'Current task owner and private task audience',evidenceRef:'code:packages/gateway/src/index.ts#execute'}]},
 'attachments.inspect':{authModes:['CORE','APP'],requiredPermissions:[{name:'Current owner task/event attachment binding; APP robot download only when a fresh download is necessary',evidenceRef:'code:packages/attachments/src/service.ts#inspect'}]},
 'attachments.read_text':{authModes:['CORE'],requiredPermissions:[{name:'Current owner verified attachment plus explicit model-egress grant and classification ceiling',evidenceRef:'code:packages/attachments/src/capabilities.ts#attachments.read_text'}]},
 'company.code.search':{authModes:['SERVICE'],requiredPermissions:[{name:'Independently reviewed read-only chat contract and upstream actor/resource enforcement',evidenceRef:'code:packages/company/src/configuration.ts#companyConfigurationSchema'},{name:'Current owner exact repository/commit/path scope, model-egress grant and live CHECK receipt',evidenceRef:'code:packages/company/src/code.ts#current'}]},
 'company.code.read':{authModes:['SERVICE'],requiredPermissions:[{name:'Independently reviewed read-only chat contract and upstream actor/resource enforcement',evidenceRef:'code:packages/company/src/configuration.ts#companyConfigurationSchema'},{name:'Current owner exact repository/commit/path scope, model-egress grant and live CHECK receipt',evidenceRef:'code:packages/company/src/code.ts#current'}]},
 'company.logs.query':{authModes:['SERVICE'],requiredPermissions:[{name:'Independent reviewed read-only log proxy and current actor/resource enforcement',evidenceRef:'code:packages/company/src/log-configuration.ts#configureCompanyLogs'},{name:'Current service/environment/window/fields, model-egress grant and immutable query CHECK',evidenceRef:'code:packages/company/src/logs.ts#current'}]},
 'dws.connection.status':{authModes:['CORE'],requiredPermissions:[{name:'Only the current owner local identity record; no platform permission certification',evidenceRef:'code:packages/dws/src/identity.ts#connection'}]},
 'dws.contact.me':{authModes:['USER_DELEGATED'],requiredPermissions:[{name:'Current user exact private profile, pinned contact +me schema and delegation version',evidenceRef:'code:packages/dws/src/runner.ts#readSelf'},{name:'Explicit private model-egress grant with current classification ceiling',evidenceRef:'code:packages/dws/src/capabilities.ts#local'}]},
 'dws.doc.read':{authModes:['USER_DELEGATED'],requiredPermissions:[{name:'Current user exact profile, pinned doc +fetch schema and reviewed payload mapping',evidenceRef:'code:packages/dws/src/runner.ts#readDocument'},{name:'Current owner exact document scope plus private model-egress grant',evidenceRef:'code:packages/dws/src/document-capability.ts#allowed'}]}
};
export function reviewedCapability(id:ReviewedCapabilityId,bindingRef:string):CapabilityReview{
 // None of the current read adapters offers a provider idempotency-key or
 // dry-run protocol. READ retry certification is a separate existing gate.
 return {...structuredClone(reviews[id]),supportsIdempotency:false,supportsDryRun:false,bindingRef};
}
