import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import {groupConversationId} from '../../dws/src/group-contract.js';
import {groupReminderLimits} from '../../groups/src/reminder-model.js';
const uuid=z.uuid().transform(v=>v.toLowerCase()),positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.iso.datetime({offset:true}).refine(v=>!v.startsWith('0000')&&Number.isFinite(Date.parse(v))&&new Date(v.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===v.slice(0,10)).transform(v=>new Date(v).toISOString());
/** Installation of this document requires a separate explicit operator review.
 * Schema validation and a hash do not establish human or platform authorization. */
export const groupReminderAuthorizationProfile=z.object({schemaVersion:z.literal(1),approved:z.literal(true),purpose:z.literal('SCHEDULED_CONTRACT'),
 id:uuid,tenantId:uuid,groupId:groupConversationId,contractId:uuid,contractVersion:positive,contractHash:sha,delegationId:uuid,
 serviceOwnerId:uuid,serviceIdentityId:uuid,scopeId:uuid,ownerAuthEpoch:positive,serviceAuthorizationVersion:positive,scopeVersion:positive,
 validFrom:instant,expiresAt:instant,limits:groupReminderLimits,reviewReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/),sourceReviewHash:sha,
 allowMentionAll:z.literal(false),allowDirectMessages:z.literal(false),allowEscalation:z.literal(false)
}).strict().refine(v=>Date.parse(v.expiresAt)>Date.parse(v.validFrom),'GROUP_REMINDER_AUTHORIZATION_WINDOW_INVALID');
export function groupReminderAuthorizationFingerprint(raw:unknown){const document=groupReminderAuthorizationProfile.parse(raw),serialized=JSON.stringify(document);return {document,serialized,hash:hash(serialized)};}
