import {z} from 'zod';
export const authModeSchema=z.enum(['CORE','APP','USER_DELEGATED','SERVICE']);
export type AuthMode=z.infer<typeof authModeSchema>;
export const capabilityStateSchema=z.enum(['UNCONFIGURED','UNVERIFIED','READY','DEGRADED','BLOCKED','DISABLED']);
export type CapabilityState=z.infer<typeof capabilityStateSchema>;
const reference=z.string().min(3).max(2048).refine(value=>{
 if(!/^[a-z][a-z0-9+.-]*:/i.test(value)||/[\s\u0000-\u001f?#]/.test(value))return false;
 try{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}
},'PRIVATE_BINDING_REFERENCE_REQUIRED');
export const capabilityDescriptorSchema=z.object({
 id:z.string().min(1).max(256),version:z.string().min(1).max(128),description:z.string().min(1).max(4096),
 provider:z.enum(['CORE','DINGTALK_API','DWS','MCP','DATA','SEARCH','SANDBOX']),
 inputSchema:z.record(z.string(),z.unknown()),outputSchema:z.record(z.string(),z.unknown()),
 authModes:z.array(authModeSchema).max(4).refine(v=>new Set(v).size===v.length,'DUPLICATE_AUTH_MODE'),
 risk:z.enum(['READ','PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN']),
 requiredPermissions:z.array(z.object({code:z.string().min(1).max(256).optional(),name:z.string().min(1).max(1000),evidenceRef:z.string().min(1).max(2048)}).strict()).max(64),
 supportsIdempotency:z.boolean(),supportsDryRun:z.boolean(),supportsVerify:z.boolean(),state:capabilityStateSchema,bindingRef:reference
}).strict().superRefine((value,ctx)=>{if(value.state==='READY'){if(!value.authModes.length)ctx.addIssue({code:'custom',path:['authModes'],message:'READY_AUTH_MODE_REQUIRED'});if(/^(unconfigured|unreviewed):/i.test(value.bindingRef))ctx.addIssue({code:'custom',path:['bindingRef'],message:'READY_REVIEWED_BINDING_REQUIRED'});}});
export type CapabilityDescriptor=z.infer<typeof capabilityDescriptorSchema>;
export type CapabilityReview=Pick<CapabilityDescriptor,'authModes'|'requiredPermissions'|'supportsIdempotency'|'supportsDryRun'|'bindingRef'>;
