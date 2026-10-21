import {z} from 'zod';
import {lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {hash} from '../../storage/src/crypto.js';
import {readOperationsPrivateFile} from '../../operations/src/private-file.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/);
const instant=z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString());
const identifier=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim()===value&&!/[\x00-\x1f\x7f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value));
const enterpriseResource=z.string().startsWith('enterprise-agent:').refine(value=>uuid.safeParse(value.slice('enterprise-agent:'.length)).success);
const enterpriseCost=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('FIXED_INTERNAL'),currency:z.literal('CNY'),maxAmountMinor:z.number().int().nonnegative().safe(),reviewReference:reference,upstreamReviewHash:sha}).strict(),
 z.object({kind:z.literal('ENFORCED_CAP'),currency:z.literal('CNY'),maxAmountMinor:z.number().int().nonnegative().safe(),reviewReference:reference,enforcementHash:sha}).strict(),
 z.object({kind:z.literal('EXPLICIT_UNKNOWN_SINGLE_CALL'),riskAcceptanceReference:reference,upstreamReviewHash:sha}).strict()
]);
/** A reviewed, finite private pilot declaration, never an ACL, enrollment,
 * actual money-cap proof or permission to reopen CLOSED/UNKNOWN work. */
export const finitePrivatePilotProfile=z.object({
 schemaVersion:z.literal(1),purpose:z.literal('FINITE_PRIVATE_ENTERPRISE_PILOT'),approved:z.literal(true),
 id:uuid,tenantId:uuid,actorId:uuid,sourceTrialProfileHash:sha,formalAuthorizationId:uuid,formalProfileHash:sha,
 corpId:identifier(256),externalUserId:identifier(256),robotCode:identifier(256),conversationId:identifier(512),
 questionHash:sha,companyPolicyHash:sha,enterpriseBudgetHash:sha,enterpriseUpstreamHash:sha,budgetPolicyHash:sha,enterpriseResourceId:enterpriseResource,
 validFrom:instant,expiresAt:instant,maxModelRequests:z.number().int().min(1).max(4),maxEnterpriseRequests:z.literal(1),maxPhysicalMessages:z.literal(1),finalOnly:z.literal(true),enterpriseWaitMs:z.number().int().min(1).max(1200000),
 modelCurrency:z.literal('CNY'),modelMaxAmountMinor:z.number().int().min(1).max(100),reviewReference:reference,modelApprovalReference:reference,sourceReviewHash:sha,enterpriseApprovalReference:reference,enterpriseCost
}).strict().superRefine((p,c)=>{if(Date.parse(p.expiresAt)<=Date.parse(p.validFrom)||Date.parse(p.expiresAt)-Date.parse(p.validFrom)>1800000)c.addIssue({code:'custom',message:'FINITE_PRIVATE_PILOT_WINDOW_INVALID'});});
export type FinitePrivatePilotProfile=z.infer<typeof finitePrivatePilotProfile>;
export function finitePrivatePilotFingerprint(raw:unknown){
 try{const document=finitePrivatePilotProfile.parse(raw);Object.freeze(document.enterpriseCost);Object.freeze(document);const serialized=JSON.stringify(document),pilotKey=hash('FINITE_PRIVATE_ENTERPRISE_PILOT_V1:'+document.tenantId.toLowerCase()+':'+document.actorId.toLowerCase()+':'+document.sourceTrialProfileHash+':'+document.questionHash);return {document,serialized,hash:hash(serialized),pilotKey};}
 catch{throw Error('FINITE_PRIVATE_PILOT_PROFILE_INVALID');}
}
/** Only explicit private operator input. No env, current schema, DB or network
 * lookup; same-UID operations ownership is the filesystem trust boundary. */
export async function readFinitePrivatePilotProfile(path:string){
 let bytes:Buffer|undefined;
 try{const parent=await lstat(dirname(path));if((parent.mode&0o777)!==0o700)throw Error();bytes=await readOperationsPrivateFile(path,32768);const after=await lstat(dirname(path));if(parent.ino!==after.ino||parent.dev!==after.dev||(after.mode&0o777)!==0o700)throw Error();return finitePrivatePilotFingerprint(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
 catch{throw Error('FINITE_PRIVATE_PILOT_PRIVATE_PROFILE_REQUIRED');}
 finally{bytes?.fill(0);}
}
