import {z} from 'zod';
import {blocked,type ToolResult} from '../../contracts/src/index.js';

// The upstream enterprise AI base classifies its own refusals. Anthys reports
// that classification as it stands: it never invents a scope the upstream did
// not name, and a refusal that cannot be attributed to this call stays
// UNKNOWN instead of being presented as a permission problem.
export const upstreamErrorKindSchema=z.enum(['MISSING_SCOPES','RESOURCE_ACCESS_DENIED','APPLICATION_UNAVAILABLE']);
export type UpstreamErrorKind=z.infer<typeof upstreamErrorKindSchema>;
export type UpstreamErrorClassification={kind:UpstreamErrorKind|'UNKNOWN';requiredScopes?:string[]};
export const upstreamErrorEnvelopeSchema=z.object({
 contractHash:z.string().regex(/^[a-f0-9]{64}$/),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),
 kind:upstreamErrorKindSchema,requiredScopes:z.array(z.string().min(1).max(128)).max(32).optional(),
});
export type UpstreamErrorBinding={contractHash:string;nonce:string;tenantId:string;actorId:string;scopeId:string};
const UPSTREAM_ERROR_CODES={MISSING_SCOPES:'COMPANY_UPSTREAM_MISSING_SCOPES',RESOURCE_ACCESS_DENIED:'COMPANY_UPSTREAM_RESOURCE_DENIED',APPLICATION_UNAVAILABLE:'COMPANY_UPSTREAM_APPLICATION_UNAVAILABLE',UNKNOWN:'COMPANY_UPSTREAM_ERROR_UNKNOWN'} as const;

export function classifyUpstreamError(raw:unknown,binding:UpstreamErrorBinding):UpstreamErrorClassification{
 const envelope=upstreamErrorEnvelopeSchema.safeParse(raw);
 if(!envelope.success)return {kind:'UNKNOWN'};
 const e=envelope.data;
 // An error that is not bound to this exact call cannot be attributed to it.
 if(e.contractHash!==binding.contractHash||e.nonce!==binding.nonce||e.tenantId!==binding.tenantId||e.actorId!==binding.actorId||e.scopeId!==binding.scopeId)return {kind:'UNKNOWN'};
 if(e.kind!=='MISSING_SCOPES')return {kind:e.kind};
 return {kind:'MISSING_SCOPES',requiredScopes:[...new Set(e.requiredScopes??[])]};
}

export class CompanyUpstreamError extends Error{
 readonly code:string;
 constructor(readonly classification:UpstreamErrorClassification){super(UPSTREAM_ERROR_CODES[classification.kind]);this.code=this.message;this.name='CompanyUpstreamError';}
}

// Only a single bounded text block is inspected, and only as JSON. Upstream
// prose is never echoed and never parsed into a classification.
export function upstreamErrorBody(reply:{content:{type:string;text?:string}[]}):unknown{
 if(reply.content.length!==1||reply.content[0]?.type!=='text')return null;
 const text=reply.content[0].text??'';if(!text||Buffer.byteLength(text,'utf8')>96000)return null;
 try{return JSON.parse(text);}catch{return null;}
}

export function upstreamErrorFrom(reply:{content:{type:string;text?:string}[]},binding:UpstreamErrorBinding):CompanyUpstreamError{
 return new CompanyUpstreamError(classifyUpstreamError(upstreamErrorBody(reply),binding));
}

export function upstreamErrorResult(error:unknown):ToolResult|null{
 if(!(error instanceof CompanyUpstreamError))return null;
 const classification=error.classification;
 if(classification.kind==='MISSING_SCOPES'){
  const requiredScopes=[...(classification.requiredScopes??[])];
  // A permission refusal that names no scope has nothing to ask the user for,
  // so it is reported as a refusal instead of as a permission request.
  if(!requiredScopes.length)return blocked('DENIED','UPSTREAM_MISSING_SCOPES_UNKNOWN');
  return {status:'NEEDS_AUTH',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_MISSING_SCOPES',requiredScopes}};
 }
 if(classification.kind==='RESOURCE_ACCESS_DENIED')return blocked('DENIED','UPSTREAM_RESOURCE_ACCESS_DENIED');
 if(classification.kind==='APPLICATION_UNAVAILABLE')return blocked('PERMANENT_ERROR','UPSTREAM_APPLICATION_UNAVAILABLE');
 return blocked('DENIED','UPSTREAM_ERROR_UNKNOWN');
}
