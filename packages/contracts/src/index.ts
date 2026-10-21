import {z} from 'zod';
export const toolResultSchema=z.object({
 status:z.enum(['OK','PARTIAL','EMPTY','NEEDS_AUTH','NEEDS_APPROVAL','DENIED','RETRYABLE_ERROR','PERMANENT_ERROR','UNKNOWN']),
 data:z.unknown().optional(),evidenceIds:z.array(z.string()),completeness:z.enum(['COMPLETE','TRUNCATED','SAMPLED','UNKNOWN']),
 nextCursor:z.string().optional(),
 coverage:z.object({from:z.string().optional(),to:z.string().optional(),source:z.string(),gaps:z.array(z.string())}).strict().optional(),
 verification:z.object({state:z.enum(['VERIFIED','UNVERIFIED','MISMATCH']),method:z.string()}).strict().optional(),
 externalResourceId:z.string().optional(),externalRequestId:z.string().optional(),
 remediation:z.object({kind:z.string(),requiredScopes:z.array(z.string()).optional(),actionId:z.string().optional()}).strict().optional(),
 // Advisory metadata never certifies idempotency or releases an UNKNOWN write.
 retryAfterMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).strict();
export type ToolResult<T=unknown>=Omit<z.infer<typeof toolResultSchema>,'data'>&{data?:T};
export type Risk='READ'|'PERSONAL_WRITE'|'SHARED_WRITE'|'SENSITIVE'|'FORBIDDEN';
export const blocked=(status:ToolResult['status'],kind:string):ToolResult=>({status,evidenceIds:[],completeness:'UNKNOWN',remediation:{kind}});
