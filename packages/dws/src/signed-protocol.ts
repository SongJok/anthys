import type {GroupMentionRosterPolicy} from './group-mention-roster-protocol.js';
import type {NativeCaseRosterPolicy} from './native-case-roster-protocol.js';
import type {ScheduledGroupPolicy} from './scheduled-group-protocol.js';
import type {CaseRosterPolicy} from './case-roster-protocol.js';
import {createHash,createPrivateKey,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {DwsError,subjectPart,stateSchema} from './contracts.js';
import {groupConversationId,groupInfoPayloadProfile} from './group-contract.js';
import {documentNode,documentSelector,documentPayloadProfile,type DocumentObservation} from './document-contract.js';
import {documentProjectionSchema} from './result-contracts.js';

// Fixed read leaves only. This transport does not accept argv, endpoints,
// profiles, file paths, write approval flags, or model-supplied commands.
export const rpcOperation=z.enum(['VERIFY_IDENTITY','READ_SELF','READ_GROUP_AUDIENCE','READ_DOCUMENT']);
const digest=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const delegationSchema=z.object({tenantId:z.uuid(),ownerId:z.uuid(),identityId:z.uuid(),taskId:z.uuid(),runId:z.uuid(),authEpoch:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),authorizationVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),capabilityBindingId:z.enum(['dws.identity.verify.v1','dws.contact.me.v1']),audience:z.object({kind:z.literal('PRIVATE_USER'),id:z.uuid()}).strict(),subject:z.object({corpId:subjectPart,userId:subjectPart}).strict()}).strict();
export type DwsReadDelegation=z.infer<typeof delegationSchema>;
export const helloSchema=z.object({protocol:z.literal('OA_DWS_READ_V1'),nonce:z.uuid()}).strict();
export const challengeSchema=z.object({type:z.literal('CHALLENGE'),protocol:z.literal('OA_DWS_READ_V1'),nonce:z.uuid(),instanceId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant}).strict();
const requestFields={type:z.literal('READ_REQUEST'),protocol:z.literal('OA_DWS_READ_V1'),instanceId:z.uuid(),requestId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant};
const legacyRequestSchema=z.object({...requestFields,operation:z.enum(['VERIFY_IDENTITY','READ_SELF']),delegation:delegationSchema,state:stateSchema}).strict();
// Keep legacy public types and wire shapes unchanged. The new leaf has a distinct
// delegation and a closed target structure; no argv, endpoint or profile mapping.
export type DwsSignedReadRequest=z.infer<typeof legacyRequestSchema>;
export const groupDelegationSchema=delegationSchema.extend({capabilityBindingId:z.literal('dws.group.audience.v1')});
export type DwsGroupDelegation=z.infer<typeof groupDelegationSchema>;
export const groupTargetSchema=z.object({conversationId:groupConversationId,scopeId:z.uuid(),scopeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),scopeHash:digest,profileHash:digest,binaryHash:digest,membersSchemaHash:digest,infoSchemaHash:digest}).strict();
export type DwsGroupTarget=z.infer<typeof groupTargetSchema>;
const groupRequestSchema=z.object({...requestFields,operation:z.literal('READ_GROUP_AUDIENCE'),delegation:groupDelegationSchema,group:groupTargetSchema,state:stateSchema}).strict();
export type DwsSignedGroupReadRequest=z.infer<typeof groupRequestSchema>;
export const documentDelegationSchema=delegationSchema.extend({capabilityBindingId:z.literal('dws.doc.read.v1')});
export type DwsDocumentDelegation=z.infer<typeof documentDelegationSchema>;
export const documentTargetSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),scopeHash:digest,profileHash:digest,nodeId:documentNode,selector:documentSelector,binaryHash:digest,documentSchemaHash:digest}).strict();
export type DwsDocumentTarget=z.infer<typeof documentTargetSchema>;
const documentRequestSchema=z.object({...requestFields,operation:z.literal('READ_DOCUMENT'),delegation:documentDelegationSchema,document:documentTargetSchema,state:stateSchema}).strict();
export type DwsSignedDocumentReadRequest=z.infer<typeof documentRequestSchema>;
export const requestSchema=z.union([legacyRequestSchema,groupRequestSchema,documentRequestSchema]);
export type DwsAnySignedReadRequest=z.infer<typeof requestSchema>;
export const responseSchema=z.object({type:z.literal('READ_RESPONSE'),protocol:z.literal('OA_DWS_READ_V1'),instanceId:z.uuid(),requestId:z.uuid(),requestHash:digest,result:z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),value:z.unknown(),state:stateSchema}).strict(),
 z.object({ok:z.literal(false),code:z.enum(['DWS_RPC_REPLAY','DWS_RPC_BUSY','DWS_RPC_EXPIRED','DWS_RPC_SCOPE_MISMATCH','DWS_RPC_BINDING_CHANGED','DWS_RPC_STATE_INVALID','DWS_RPC_EXECUTION_FAILED','DWS_RPC_GROUP_RESULT_INVALID','DWS_RPC_DOCUMENT_RESULT_INVALID','DWS_USER_CONSENT_REQUIRED','DWS_AUTH_IDENTITY_MISMATCH','DWS_PROFILE_MISMATCH','DWS_BINARY_CHANGED','DWS_SCHEMA_CHANGED','DWS_PROCESS_TIMEOUT','DWS_CONFIRMATION_REQUIRED','DWS_BUSINESS_DENIED','DWS_RESULT_PARTIAL','DWS_UPSTREAM_RETRYABLE','DWS_DOCUMENT_ENVELOPE_UNVERIFIED','DWS_DOCUMENT_PAYLOAD_FAILED','DWS_DOCUMENT_TARGET_MISMATCH','DWS_DOCUMENT_PAYLOAD_UNVERIFIED','DWS_DOCUMENT_RANGE_OUTSIDE_OBSERVATION','DWS_DOCUMENT_SECRET_SPAN_LIMIT'])}).strict()
])}).strict();
export type DwsSignedReadResponse=z.infer<typeof responseSchema>;
const envelope=z.object({keyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),payload:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)}).strict();
export type SignedEnvelope=z.infer<typeof envelope>;
// JSON is parsed before canonicalization; no JavaScript objects or undefined
// values cross the boundary. Type-specific schemas reject unknown fields.
export function rpcCanonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(rpcCanonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+rpcCanonical((value as Record<string,unknown>)[k])).join(',')+'}';}
export const rpcHash=(value:unknown)=>createHash('sha256').update(rpcCanonical(value)).digest('hex');
export function rpcKey(pem:string,kind:'private'|'public'):KeyObject{try{const key=kind==='private'?createPrivateKey(pem):createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw Error();return key;}catch{throw new DwsError('DWS_RPC_KEY_INVALID');}}
export function signEnvelope(payload:unknown,keyId:string,key:KeyObject):SignedEnvelope{return envelope.parse({keyId,payload,signature:sign(null,Buffer.from('open_aider.dws.read.v1\0'+rpcCanonical(payload)),key).toString('base64url')});}
export function openEnvelope<T>(raw:unknown,keyId:string,key:KeyObject,schema:z.ZodType<T>):T{try{const e=envelope.parse(raw);if(e.keyId!==keyId||!verify(null,Buffer.from('open_aider.dws.read.v1\0'+rpcCanonical(e.payload)),key,Buffer.from(e.signature,'base64url')))throw Error();return schema.parse(e.payload);}catch{throw new DwsError('DWS_RPC_SIGNATURE_INVALID');}}
export const groupScopeSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),conversationId:groupConversationId,delegation:groupDelegationSchema,profile:groupInfoPayloadProfile,binaryHash:digest,membersSchemaHash:digest,infoSchemaHash:digest,validFrom:instant,expiresAt:instant}).strict().superRefine((s,c)=>{
 if(s.expiresAt<=s.validFrom||s.delegation.audience.id!==s.delegation.ownerId)c.addIssue({code:'custom',message:'GROUP_SCOPE_INVALID'});
});
export type DwsGroupScope=z.infer<typeof groupScopeSchema>;
export function snapshotGroupScopes(raw:unknown):readonly DwsGroupScope[]{
 if(raw===undefined)return Object.freeze([]);
 const parsed=z.array(groupScopeSchema).max(32).safeParse(raw);
 if(!parsed.success||new Set(parsed.data.map(s=>s.scopeId)).size!==parsed.data.length)throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
 const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
 return freeze(parsed.data);
}
/** Snapshot digest, not a database ACL/GroupAudience authority hash. */
export function groupTargetForScope(scope:DwsGroupScope):DwsGroupTarget{
 const s=groupScopeSchema.parse(scope);
 return {conversationId:s.conversationId,scopeId:s.scopeId,scopeVersion:s.scopeVersion,scopeHash:rpcHash(s),profileHash:rpcHash(s.profile),binaryHash:s.binaryHash,membersSchemaHash:s.membersSchemaHash,infoSchemaHash:s.infoSchemaHash};
}
const stableId=z.string().min(1).max(256).refine(s=>s===s.trim()&&!/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s));
const groupObservationSchema=z.object({contractVersion:z.literal('im.group-members.v1'),conversationId:groupConversationId,
 users:z.array(z.object({openDingtalkId:stableId,role:z.string().max(128)}).strict()).min(1).max(2000),
 bots:z.array(z.object({openBotId:stableId,openDingtalkId:z.string().max(256),robotCode:z.string().max(256)}).strict()).max(100),
 membershipHash:digest,internalMembersVerified:z.literal(false),platformCountsVerified:z.literal(true),
 independentSource:z.object({reviewRef:z.string().min(1).max(2048),revision:z.string().min(1).max(128),userCount:z.number().int().min(1).max(2000),botCount:z.number().int().min(0).max(100),recordHash:digest,profileHash:digest}).strict(),
}).strict();
export const groupResultByteLimit=131072;
/** Validate the existing adapter projection, never elevate it to internal/ACL proof. */
export function validateSignedGroupObservation(value:unknown,target:DwsGroupTarget,profile?:DwsGroupScope['profile']){
 try{
  if(Buffer.byteLength(rpcCanonical(value))>groupResultByteLimit)throw Error();
  const o=groupObservationSchema.parse(value),p=o.independentSource;
  if(o.conversationId!==target.conversationId||p.profileHash!==target.profileHash||profile&&(rpcHash(profile)!==target.profileHash||p.reviewRef!==profile.reviewRef))throw Error();
  if(p.userCount!==o.users.length||p.botCount!==o.bots.length||new Set(o.users.map(u=>u.openDingtalkId)).size!==o.users.length||new Set(o.bots.map(b=>b.openBotId)).size!==o.bots.length)throw Error();
  const users=[...o.users].sort((a,b)=>a.openDingtalkId.localeCompare(b.openDingtalkId,'en')),bots=[...o.bots].sort((a,b)=>a.openBotId.localeCompare(b.openBotId,'en'));
  if(rpcHash(users)!==rpcHash(o.users)||rpcHash(bots)!==rpcHash(o.bots)||o.membershipHash!==rpcHash({contractVersion:o.contractVersion,conversationId:o.conversationId,users,bots}))throw Error();
  if(p.recordHash!==rpcHash({conversationId:o.conversationId,revision:p.revision,userCount:p.userCount,botCount:p.botCount}))throw Error();
  return o;
 }catch{throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');}
}
export const signedGroupResultSchema=z.object({operation:z.literal('READ_GROUP_AUDIENCE'),grantsAuthority:z.literal(false),delegationHash:digest,group:groupTargetSchema,observation:groupObservationSchema}).strict();
export type DwsReadPolicy={groupMentionPolicies?:readonly GroupMentionRosterPolicy[];nativeCaseRosterPolicies?:readonly NativeCaseRosterPolicy[];scheduledGroupPolicies?:readonly ScheduledGroupPolicy[];caseRosterPolicies?:readonly CaseRosterPolicy[];tenantId:string;corpId:string;policyHash:string;callerKeyId:string;callerPublicKey:KeyObject;runnerKeyId:string;runnerPrivateKey:KeyObject;maxRequestMs:number;maxConcurrent:number;maxReplayEntries:number;groupScopes?:readonly DwsGroupScope[];documentScopes?:readonly DwsDocumentScope[];documentPolicies?:readonly DwsDocumentPolicy[]};
export const rpcBodyLimit=524288;

// A reviewed document leaf grants no new resource permission. The database owner
// must independently bind the current run, identity, scope and private audience.
export const documentScopeSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),delegation:documentDelegationSchema,nodeId:documentNode,selector:documentSelector,profile:documentPayloadProfile,binaryHash:digest,documentSchemaHash:digest,validFrom:instant,expiresAt:instant}).strict().superRefine((s,c)=>{
 if(s.expiresAt<=s.validFrom||s.delegation.audience.id!==s.delegation.ownerId)c.addIssue({code:'custom',message:'DOCUMENT_SCOPE_INVALID'});
});
export type DwsDocumentScope=z.infer<typeof documentScopeSchema>;
export function snapshotDocumentScopes(raw:unknown):readonly DwsDocumentScope[]{
 if(raw===undefined)return Object.freeze([]);
 const parsed=z.array(documentScopeSchema).max(32).safeParse(raw);
 if(!parsed.success||new Set(parsed.data.map(s=>s.scopeId)).size!==parsed.data.length)throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
 const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};return freeze(parsed.data);
}
export function documentTargetForScope(scope:DwsDocumentScope):DwsDocumentTarget{
 const s=documentScopeSchema.parse(scope);return {scopeId:s.scopeId,scopeVersion:s.scopeVersion,scopeHash:rpcHash(s),profileHash:rpcHash(s.profile),nodeId:s.nodeId,selector:s.selector,binaryHash:s.binaryHash,documentSchemaHash:s.documentSchemaHash};
}
const documentObservationSchema=z.object({nodeId:documentNode,revision:z.string().min(1).max(128),observedTextHash:digest,projection:documentProjectionSchema,completeness:z.enum(['COMPLETE','TRUNCATED','UNKNOWN']),status:z.enum(['OK','EMPTY','PARTIAL']),projectionHash:digest}).strict();
export const documentResultByteLimit=65536;
export function validateSignedDocumentObservation(value:unknown,target:DwsDocumentTarget,profile?:DwsDocumentScope['profile']):DocumentObservation{
 try{
  if(Buffer.byteLength(rpcCanonical(value))>documentResultByteLimit)throw Error();
  const t=documentTargetSchema.parse(target),o=documentObservationSchema.parse(value),p=o.projection,s=t.selector;
  if(o.nodeId!==t.nodeId||profile&&rpcHash(documentPayloadProfile.parse(profile))!==t.profileHash)throw Error();
  const selected=s.kind==='KEYWORD'?{kind:s.kind,queryHash:rpcHashString(s.query),context:s.context,limit:s.limit}:s;
  if(rpcHash(selected)!==rpcHash(p.selector)||p.fragments.reduce((n,f)=>n+Buffer.byteLength(f.text),0)>16000)throw Error();
  let limited=false;
  if(s.kind==='FULL'||s.kind==='RANGE'){
   const f=p.fragments[0];if(p.fragments.length!==1||!f||p.totalMatches!==null)throw Error();
   const start=s.kind==='FULL'?0:s.start,end=Math.min(p.observedCharacters,s.kind==='FULL'?s.maxCharacters:s.end);
   if(f.start!==start||f.end>end||f.end<start||s.kind==='RANGE'&&start>=p.observedCharacters&&!(start===0&&p.observedCharacters===0))throw Error();
   limited=s.kind==='RANGE'||p.observedCharacters>s.maxCharacters||f.end<end;
  }else{
   if(p.totalMatches===null||p.totalMatches<p.fragments.length||p.fragments.length>s.limit||p.totalMatches===0&&p.fragments.length!==0)throw Error();
   if(p.fragments.some((f,i)=>i>0&&f.start<p.fragments[i-1]!.start))throw Error();
   limited=p.totalMatches>s.limit||p.fragments.some(f=>f.start>0||f.end<p.observedCharacters);
  }
  const complete=s.kind==='FULL'&&p.upstreamCompleteness==='COMPLETE'&&!limited;
  const completeness=complete?'COMPLETE':p.upstreamCompleteness==='UNKNOWN'?'UNKNOWN':'TRUNCATED';
  const stop=complete?'DOCUMENT_RESPONSE_TERMINAL':p.upstreamCompleteness==='UNKNOWN'?'UPSTREAM_COMPLETENESS_UNPUBLISHED':p.upstreamCompleteness==='TRUNCATED'?'UPSTREAM_CONTINUATION_UNCONSUMED':limited?'LOCAL_SELECTION_LIMIT':'SELECTED_FRAGMENT_ONLY';
  const status=p.fragments.every(f=>!f.text)?p.upstreamCompleteness==='COMPLETE'?'EMPTY':'PARTIAL':complete?'OK':'PARTIAL';
  if(p.documentComplete!==complete||o.completeness!==completeness||p.stopReason!==stop||o.status!==status||o.projectionHash!==rpcHash({selector:p.selector,fragments:p.fragments,upstream:p.upstreamCompleteness,documentComplete:p.documentComplete,totalMatches:p.totalMatches,observedCharacters:p.observedCharacters}))throw Error();
  return o;
 }catch{throw new DwsError('DWS_RPC_DOCUMENT_RESULT_INVALID');}
}
const rpcHashString=(value:string)=>createHash('sha256').update(value).digest('hex');
export const signedDocumentResultSchema=z.object({operation:z.literal('READ_DOCUMENT'),grantsAuthority:z.literal(false),delegationHash:digest,document:documentTargetSchema,observation:documentObservationSchema}).strict();

// The reviewed provider/resource binding must exist before native ingress makes
// a new random task/run. Only those two IDs are dynamic, from the trusted
// caller's guarded current lease, and remain signed in each full request target.
export const documentPrincipalSchema=documentDelegationSchema.omit({taskId:true,runId:true});
export const documentPolicySchema=z.object(documentScopeSchema.shape).omit({delegation:true}).extend({principal:documentPrincipalSchema}).strict().superRefine((s,c)=>{
 if(s.expiresAt<=s.validFrom||s.principal.audience.id!==s.principal.ownerId)c.addIssue({code:'custom',message:'DOCUMENT_POLICY_INVALID'});
});
export type DwsDocumentPolicy=z.infer<typeof documentPolicySchema>;
export function snapshotDocumentPolicies(raw:unknown):readonly DwsDocumentPolicy[]{
 if(raw===undefined)return Object.freeze([]);
 const parsed=z.array(documentPolicySchema).max(32).safeParse(raw);
 if(!parsed.success||new Set(parsed.data.map(s=>s.scopeId)).size!==parsed.data.length)throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
 const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};return freeze(parsed.data);
}
export function documentScopeForPolicy(policy:DwsDocumentPolicy,delegation:DwsDocumentDelegation):DwsDocumentScope{
 const p=documentPolicySchema.parse(policy),d=documentDelegationSchema.parse(delegation),principal=documentPrincipalSchema.parse(Object.fromEntries(Object.entries(d).filter(([key])=>key!=='taskId'&&key!=='runId')));
 if(rpcHash(p.principal)!==rpcHash(principal))throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
 return documentScopeSchema.parse({...Object.fromEntries(Object.entries(p).filter(([key])=>key!=='principal')),delegation:d});
}
