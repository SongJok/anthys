import {z} from 'zod';
import {lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {hash} from '../../storage/src/crypto.js';
import {groupConversationId} from '../../dws/src/group-contract.js';
import {readOperationsPrivateFile} from '../../operations/src/private-file.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true}).transform(v=>new Date(v).toISOString());
/** Explicit operator pin for one attempt, never a grant, session, source proof
 * or automatic approval. The host must compare the schema pin/current authority
 * and enforce the current window, durable single claim and physical-send gates. */
export const groupEscalationRuntimeProfile=z.object({
 schemaVersion:z.literal(1),approved:z.literal(true),purpose:z.literal('GROUP_CASE_ESCALATION_RUN_ONCE'),
 reviewReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/),sourceReviewHash:sha,requiredSchemaHash:sha,
 validFrom:instant,expiresAt:instant,maxNotifications:z.literal(1),modelCalls:z.literal(0),allowMentionAll:z.literal(false),allowDirectMessages:z.literal(false),
 target:z.object({tenantId:uuid,actorId:uuid,groupId:groupConversationId,proposalId:uuid,previewHash:sha,contractHash:sha}).strict()
}).strict().superRefine((p,c)=>{if(Date.parse(p.expiresAt)<=Date.parse(p.validFrom)||Date.parse(p.expiresAt)-Date.parse(p.validFrom)>120000)c.addIssue({code:'custom',message:'GROUP_ESCALATION_RUNTIME_WINDOW_INVALID'});});
export type GroupEscalationRuntimeProfile=z.infer<typeof groupEscalationRuntimeProfile>;
function freeze(document:GroupEscalationRuntimeProfile){Object.freeze(document.target);return Object.freeze(document);}
export function groupEscalationRuntimeFingerprint(raw:unknown){
 try{const document=freeze(groupEscalationRuntimeProfile.parse(raw)),serialized=JSON.stringify(document);return {document,serialized,hash:hash(serialized)};}
 catch{throw Error('GROUP_ESCALATION_RUNTIME_PROFILE_INVALID');}
}
/** Reads only this explicit bounded private file; no environment or DB lookup.
 * Current UID is the operations trust boundary, not a hostile same-UID sandbox. */
export async function readGroupEscalationRuntimeProfile(path:string){
 let bytes:Buffer|undefined;
 try{const parent=await lstat(dirname(path));if((parent.mode&0o777)!==0o700)throw Error();bytes=await readOperationsPrivateFile(path,32768);const after=await lstat(dirname(path));if(parent.ino!==after.ino||parent.dev!==after.dev||(after.mode&0o777)!==0o700)throw Error();return groupEscalationRuntimeFingerprint(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
 catch{throw Error('GROUP_ESCALATION_RUNTIME_PRIVATE_PROFILE_REQUIRED');}
 finally{bytes?.fill(0);}
}
