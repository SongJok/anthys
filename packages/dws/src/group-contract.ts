import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {DwsError} from './contracts.js';
// CLI-owned projection audited at pinned v1.0.61 smart/group_members.go.
// The CLI deliberately omits upstream corp IDs. Membership completeness is
// not proof that members are internal or authorized to see another resource.
export const groupConversationId=z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._~+/=-]*$/);
const stableId=z.string().min(1).max(256).refine(s=>s===s.trim()&&!/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s));
const user=z.object({name:z.string().max(1024),nick:z.string().max(1024),role:z.string().max(128),openDingtalkId:stableId}).strict();
const bot=z.object({name:z.string().max(1024),openDingtalkId:z.string().max(256),openBotId:stableId,robotCode:z.string().max(256)}).strict();
const failures=z.array(z.record(z.string(),z.unknown())).max(50);
const userBucket=z.object({count:z.number().int().nonnegative(),pagesFetched:z.number().int().min(1).max(50),complete:z.boolean(),hasMore:z.boolean(),partial:z.boolean(),stopReason:z.string().max(128),failedCount:z.number().int().nonnegative(),failures,nextCursor:z.string().max(512).optional()}).strict();
const payload=z.object({contractVersion:z.literal('im.group-members.v1'),conversationId:groupConversationId,users:z.array(user).min(1).max(2000),bots:z.array(bot).max(100),counts:z.object({users:z.number().int().nonnegative(),bots:z.number().int().nonnegative(),total:z.number().int().nonnegative()}).strict(),buckets:z.object({users:userBucket,bots:z.object({complete:z.boolean(),count:z.number().int().nonnegative()}).strict()}).strict(),failedCount:z.number().int().nonnegative(),failures,complete:z.boolean(),hasMore:z.boolean(),partial:z.boolean(),nextCursor:z.string().max(512).optional(),errors:failures.optional()}).strict();
const envelope=z.object({ok:z.literal(true),outcome:z.literal('success'),identity:z.literal('user').optional(),dry_run:z.literal(false).optional(),data:payload,meta:z.record(z.string(),z.unknown()).optional(),_notice:z.unknown().optional()}).strict();
export const groupReadSchema=z.object({conversationId:groupConversationId,authorizationVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),requestNonce:z.uuid()}).strict();
export type GroupRead=z.infer<typeof groupReadSchema>;
export function projectGroupMembers(value:unknown,conversationId:string){
 const id=groupConversationId.parse(conversationId),result=envelope.safeParse(value);if(!result.success)throw new DwsError('DWS_GROUP_MEMBERS_UNVERIFIED');const p=result.data.data,u=p.buckets.users,b=p.buckets.bots;
 if(p.conversationId!==id)throw new DwsError('DWS_GROUP_TARGET_MISMATCH');
 // The pinned CLI can retain its previous page's nextCursor after reaching a
 // terminal page. Its explicit hasMore=false and source_complete govern; a
 // nonempty historical cursor is not silently treated as a new page.
 if(!p.complete||p.hasMore||p.partial||p.failedCount||p.failures.length||p.errors?.length||!u.complete||u.hasMore||u.partial||u.failedCount||u.failures.length||u.stopReason!=='source_complete'||!b.complete)throw new DwsError('DWS_GROUP_MEMBERS_INCOMPLETE');
 const users=p.users.map(m=>({openDingtalkId:m.openDingtalkId,role:m.role})).sort((a,b)=>a.openDingtalkId.localeCompare(b.openDingtalkId,'en')),bots=p.bots.map(m=>({openBotId:m.openBotId,openDingtalkId:m.openDingtalkId,robotCode:m.robotCode})).sort((a,b)=>a.openBotId.localeCompare(b.openBotId,'en'));
 if(new Set(users.map(m=>m.openDingtalkId)).size!==users.length||new Set(bots.map(m=>m.openBotId)).size!==bots.length||p.counts.users!==users.length||u.count!==users.length||p.counts.bots!==bots.length||b.count!==bots.length||p.counts.total!==users.length+bots.length)throw new DwsError('DWS_GROUP_MEMBERS_COUNT_MISMATCH');
 const observation={contractVersion:'im.group-members.v1' as const,conversationId:id,users,bots};return {...observation,membershipHash:hash(canonical(observation)),internalMembersVerified:false as const};
}
export type GroupMembersObservation=ReturnType<typeof projectGroupMembers>;

// The projected CLI roster alone can silently omit malformed upstream rows.
// A reviewed *independent* group record must supply counts and a revision that
// changes for every human/bot roster change. No guessed tenant payload mapping.
const pointer=z.string().min(1).max(256).refine(p=>p.startsWith('/')&&p.split('/').length<=12&&p.split('/').slice(1).every(s=>s.length>0&&!['__proto__','constructor','prototype'].includes(s.replace(/~1/g,'/').replace(/~0/g,'~'))&&!/~(?![01])/u.test(s)));
export const groupInfoPayloadProfile=z.object({schemaVersion:z.literal(1),reviewRef:z.string().trim().min(1).max(2048),conversationPointer:pointer,typePointer:pointer,typeValue:z.literal('GROUP'),revisionPointer:pointer,userCountPointer:pointer,botCountPointer:pointer,revisionMeaning:z.literal('EVERY_HUMAN_AND_BOT_ROSTER_CHANGE'),countMeaning:z.literal('ALL_HUMANS_AND_BOTS_INCLUDING_EXTERNAL'),independentFromProjectedRoster:z.literal(true)}).strict();
export type GroupInfoPayloadProfile=z.infer<typeof groupInfoPayloadProfile>;
function field(value:unknown,path:string):unknown{let current=value;for(const part of path.split('/').slice(1)){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(!current||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,key))return null;current=(current as Record<string,unknown>)[key];}return current;}
function failedRecord(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))return false;const r=value as Record<string,unknown>;return r['partial']===true||r['complete']===false||r['hasMore']===true||r['ok']===false||r['success']===false||!!r['error']||r['outcome']!==undefined&&r['outcome']!=='success'||['failure','failed','partial_success','partial_failure','unknown'].includes(String(r['status']));}
function groupRecord(value:unknown,id:string,p:GroupInfoPayloadProfile){
 if(!value||typeof value!=='object'||Buffer.byteLength(canonical(value))>131072)throw new DwsError('DWS_GROUP_INFO_UNVERIFIED');const raw=value as Record<string,unknown>;if(failedRecord(raw)||failedRecord(raw['data']))throw new DwsError('DWS_GROUP_INFO_UNVERIFIED');
 for(const path of [p.conversationPointer,p.typePointer,p.revisionPointer,p.userCountPointer,p.botCountPointer]){const parts=path.split('/').slice(1);for(let depth=1;depth<parts.length;depth++)if(failedRecord(field(value,'/'+parts.slice(0,depth).join('/'))))throw new DwsError('DWS_GROUP_INFO_UNVERIFIED');}
 const revision=field(value,p.revisionPointer),users=field(value,p.userCountPointer),bots=field(value,p.botCountPointer);if(field(value,p.conversationPointer)!==id||field(value,p.typePointer)!==p.typeValue||!(typeof revision==='string'&&revision.length>0&&revision.length<=128||typeof revision==='number'&&Number.isSafeInteger(revision)&&revision>=0)||typeof users!=='number'||!Number.isSafeInteger(users)||users<1||users>2000||typeof bots!=='number'||!Number.isSafeInteger(bots)||bots<0||bots>100)throw new DwsError('DWS_GROUP_INFO_UNVERIFIED');return {conversationId:id,revision:String(revision),userCount:users,botCount:bots};
}
export function projectGroupAudience(before:unknown,members:GroupMembersObservation,after:unknown,profile:GroupInfoPayloadProfile){
 const p=groupInfoPayloadProfile.parse(profile),first=groupRecord(before,members.conversationId,p),last=groupRecord(after,members.conversationId,p);if(canonical(first)!==canonical(last))throw new DwsError('DWS_GROUP_ROSTER_CHANGED');
 if(first.userCount!==members.users.length||first.botCount!==members.bots.length)throw new DwsError('DWS_GROUP_INDEPENDENT_COUNT_MISMATCH');
 return {...members,independentSource:{reviewRef:p.reviewRef,revision:first.revision,userCount:first.userCount,botCount:first.botCount,recordHash:hash(canonical(first)),profileHash:hash(canonical(p))},platformCountsVerified:true as const};
}
export type GroupAudienceObservation=ReturnType<typeof projectGroupAudience>;
export const groupAudienceContractHash=hash('anthys.group-audience.v1:pinned-cli:independent-counts-roster:reviewed-owner-directory:approved-bots:mention-only-general-and-clarification');
