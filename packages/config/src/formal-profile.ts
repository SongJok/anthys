import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/);
export const lifecycleServiceSchema=z.enum(['INGRESS','WORKER','NOTIFIER','API','MAINTENANCE']);
export type LifecycleService=z.infer<typeof lifecycleServiceSchema>;
export const formalPrivateProfileSchema=z.object({
 schemaVersion:z.literal(1),authorizationId:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),
 sourceTrialProfileHash:sha,corpId:z.string().min(1).max(256),externalUserId:z.string().min(1).max(256),robotCode:z.string().min(1).max(256),conversationId:z.string().min(1).max(512),
 validFrom:z.iso.datetime({offset:true}),validUntil:z.iso.datetime({offset:true}),budgetPolicyHash:sha,
 approvalReference:reference,modelAllowed:z.boolean(),modelApprovalReference:reference.nullable(),
 entrypoints:z.array(lifecycleServiceSchema).min(1).max(5).refine(v=>new Set(v).size===v.length,'DUPLICATE_SERVICE'),
 inputPolicy:z.object({attachments:z.boolean(),controls:z.boolean()}).strict(),
 capabilities:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),version:z.string().regex(/^\d+\.\d+\.\d+$/).max(64),bindingHash:sha}).strict()).max(256).refine(v=>new Set(v.map(c=>c.id+'@'+c.version)).size===v.length,'DUPLICATE_CAPABILITY')
}).strict().superRefine((profile,ctx)=>{if(Date.parse(profile.validUntil)<=Date.parse(profile.validFrom))ctx.addIssue({code:'custom',path:['validUntil'],message:'FORMAL_VALIDITY_WINDOW_INVALID'});if(profile.modelAllowed!==(profile.modelApprovalReference!==null))ctx.addIssue({code:'custom',path:['modelApprovalReference'],message:'DISTINCT_MODEL_RUN_APPROVAL_REQUIRED'});});
/** A separate single-group approval. It never modifies the CLOSED source
 * trial or grants a contract/resource just because the document parses. */
export const formalGroupProfileSchema=z.object({
 ...formalPrivateProfileSchema.shape,schemaVersion:z.literal(2),kind:z.literal('FORMAL_GROUP_MENTION_ENTERPRISE'),
 group:z.object({mode:z.literal('MENTION_ONLY'),contractId:z.uuid(),contractVersion:z.number().int().positive().safe(),contractHash:sha,
  scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),membershipHash:sha,directoryHash:sha,enterprisePolicyHash:sha,enterpriseResource:z.string().regex(/^enterprise-agent:[a-fA-F0-9-]{36}$/),questionHash:sha,
  audienceReviewReference:reference,sharingReviewReference:reference,allowStop:z.literal(true)}).strict()
}).strict().superRefine((profile,ctx)=>{
 const {kind:_kind,group:_group,...base}=profile,checked=formalPrivateProfileSchema.safeParse({...base,schemaVersion:1});
 if(!checked.success)for(const issue of checked.error.issues)ctx.addIssue({code:'custom',path:issue.path,message:issue.message});
 if(!profile.modelAllowed||profile.inputPolicy.attachments||profile.inputPolicy.controls||Date.parse(profile.validUntil)-Date.parse(profile.validFrom)>30*60_000)ctx.addIssue({code:'custom',message:'FORMAL_GROUP_FINITE_READ_ONLY_MODEL_WINDOW_REQUIRED'});
 if(profile.entrypoints.length!==4||!['INGRESS','WORKER','NOTIFIER','API'].every(s=>profile.entrypoints.includes(s as LifecycleService)))ctx.addIssue({code:'custom',message:'FORMAL_GROUP_EXACT_SERVICES_REQUIRED'});
 if(profile.capabilities.length!==2||!['company.agent.ask','dws.group.audience'].every(id=>profile.capabilities.some(c=>c.id===id&&c.version==='1.0.0')))ctx.addIssue({code:'custom',message:'FORMAL_GROUP_EXACT_ENTERPRISE_AND_ROSTER_REQUIRED'});
 const references=[profile.approvalReference,profile.modelApprovalReference,profile.group.audienceReviewReference,profile.group.sharingReviewReference];
 if(new Set(references).size!==references.length)ctx.addIssue({code:'custom',message:'FORMAL_GROUP_INDEPENDENT_APPROVALS_REQUIRED'});
});
export const formalProfileSchema=z.discriminatedUnion('schemaVersion',[formalPrivateProfileSchema,formalGroupProfileSchema]);
export type FormalGroupProfile=z.infer<typeof formalGroupProfileSchema>;
export type FormalProfile=z.infer<typeof formalProfileSchema>;
export function formalProfileFingerprint(input:unknown){const profile=formalProfileSchema.parse(input),serialized=JSON.stringify(profile);if(Buffer.byteLength(serialized)>131072)throw Error('FORMAL_PROFILE_SIZE_LIMIT');return {profile,serialized,hash:hash(serialized)};}
