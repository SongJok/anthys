import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import {groupConversationId} from '../../dws/src/group-contract.js';
const uuid=z.uuid().transform(v=>v.toLowerCase()),positive=z.number().int().positive().safe();
export const groupDelegationSchema=z.object({
 schemaVersion:z.literal(1),approved:z.literal(true),id:uuid,tenantId:uuid,groupId:groupConversationId,
 administratorId:uuid,serviceOwnerId:uuid,serviceIdentityId:uuid,scopeId:uuid,roleBindingId:uuid,
 administratorAuthEpoch:positive,serviceOwnerAuthEpoch:positive,roleVersion:positive,serviceAuthorizationVersion:positive,scopeVersion:positive,
 validUntil:z.iso.datetime({offset:true}),currency:z.enum(['CNY','USD']),maxAmountMinor:z.number().int().nonnegative().safe(),
 reviewReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/),sourceReviewHash:z.string().regex(/^[a-f0-9]{64}$/),administratorDirectoryHash:z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export function groupDelegationFingerprint(input:unknown){const document=groupDelegationSchema.parse(input),serialized=JSON.stringify(document);return {document,serialized,hash:hash(serialized)};}
