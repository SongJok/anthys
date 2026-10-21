// Independent acceptance model: no production authorization, Gateway or SQL
// helper is imported. Inputs describe provisioned facts, not their query rows.
export type AuthorizationCase = {
 actor: 'OWNER' | 'OTHER_ACTOR' | 'OTHER_TENANT';
 identityActive: boolean; epochCurrent: boolean;
 registry: 'READY' | 'UNVERIFIED' | 'DISABLED';
 binding: 'READY' | 'DISABLED' | 'WRONG_HASH' | 'WRONG_RISK' | 'WRONG_VERSION' | 'MISSING';
 grant: 'VALID' | 'REVOKED' | 'EXPIRED' | 'FOREIGN_ACTOR' | 'FOREIGN_TENANT' | 'WRONG_CAPABILITY' | 'WRONG_RESOURCE' | 'MISSING';
 grantAudience: 'SELF' | 'OTHER' | 'GROUP';
 taskAudience: 'SELF' | 'OTHER' | 'GROUP' | 'NAMED_USERS';
 sourceOwned: boolean; notCancelled: boolean; notExpired: boolean;
 quotaAvailable: boolean; killed: boolean; validArguments: boolean;
 risk: 'READ' | 'PERSONAL_WRITE' | 'SHARED_WRITE' | 'SENSITIVE' | 'FORBIDDEN';
 requestApproval: boolean;
};
export function referenceAuthorization(c:AuthorizationCase):boolean {
 if(c.actor!=='OWNER'||!c.identityActive||!c.epochCurrent)return false;
 if(!c.notCancelled||!c.notExpired||c.killed||!c.quotaAvailable)return false;
 if(c.registry!=='READY'||c.binding!=='READY'||!c.validArguments)return false;
 if(c.grant!=='VALID'||c.grantAudience!=='SELF'||c.taskAudience!=='SELF'||!c.sourceOwned)return false;
 if(c.risk==='FORBIDDEN')return false;
 return c.risk==='READ'||c.requestApproval;
}
