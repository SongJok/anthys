import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
// An independently reviewed anthys proxy contract. Discovery of a generic
// upstream chat tool never proves that it supports this contract or log access.
export const COMPANY_LOGS_CONTRACT={id:'anthys.company.logs.read',version:1,operations:['CHECK','QUERY'],authorization:'UPSTREAM_RESOURCE_ENFORCED',sideEffects:'NONE',snapshots:'IMMUTABLE_QUERY_RECEIPT'} as const;
export const companyLogsContractHash=hash(canonical(COMPANY_LOGS_CONTRACT));
const instant=z.iso.datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)),'FINITE_INSTANT_REQUIRED').transform(v=>new Date(v).toISOString());
export const logEnvironmentSchema=z.enum(['TEST','STAGING','PRODUCTION']);
export const logServiceSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const logLevelSchema=z.enum(['TRACE','DEBUG','INFO','WARN','ERROR','FATAL']);
const traceId=z.string().regex(/^[a-fA-F0-9]{16,64}$/);
export const logQuerySchema=z.object({service:logServiceSchema,environment:logEnvironmentSchema,start:instant,end:instant,filters:z.object({levels:z.array(logLevelSchema).min(1).max(6).refine(v=>new Set(v).size===v.length,'DUPLICATE_LEVEL').optional(),traceId:traceId.optional()}).strict(),limit:z.number().int().min(1).max(100)}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=86400000,'BOUNDED_POSITIVE_LOG_WINDOW_REQUIRED');
export type LogQuery=z.infer<typeof logQuerySchema>;
export const logResource=(args:Pick<LogQuery,'service'|'environment'>)=>'logs:'+args.service+'@'+args.environment;
export const logRowSchema=z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),timestamp:instant,level:logLevelSchema,message:z.string().max(2048),traceId:traceId.optional()}).strict();
// Defense in depth for the declared text field. This is not independent proof
// that a provider is certified, that all personal data is anonymous, or that
// internal log data is approved for model egress. Those checks remain required.
export function redactLogText(text:string):string{
 return text.replace(/(authorization["']?\s*[:=]\s*["']?)[^\r\n"';,}]+/gi,'$1[REDACTED]')
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]')
  .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|client[-_ ]?secret|customer[-_ ]?id|phone|email)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"';,}]+)/gi,'$1[REDACTED]')
  .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi,'[REDACTED]')
  .replace(/\b(?:86[- ]?)?1[3-9]\d{9}\b/g,'[REDACTED]')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[REDACTED]');
}
// Receipt/output validators do not normalize or strip data. The Gateway keeps
// its original deep-equality check on complete capability results.
export const logCanonicalInstantSchema=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'CANONICAL_UTC_REQUIRED');
export const logCanonicalQuerySchema=z.object({service:logServiceSchema,environment:logEnvironmentSchema,start:logCanonicalInstantSchema,end:logCanonicalInstantSchema,filters:z.object({levels:z.array(logLevelSchema).min(1).max(6).refine(v=>new Set(v).size===v.length).optional(),traceId:traceId.optional()}).strict(),limit:z.number().int().min(1).max(100)}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=86400000);
export const logReceiptRowSchema=z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),timestamp:logCanonicalInstantSchema,level:logLevelSchema,message:z.string().max(4096),traceId:traceId.optional()}).strict();
export const logSamplingSchema=z.object({sampled:z.boolean(),rate:z.number().positive().max(1).nullable()}).strict().refine(v=>v.sampled?v.rate===null||v.rate<1:v.rate===1);
const timeZone=z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
export const logSnapshotSchema=z.object({queryId:z.uuid(),query:logCanonicalQuerySchema,asOf:logCanonicalInstantSchema,snapshotExpiresAt:logCanonicalInstantSchema,timezone:timeZone,rows:z.array(logReceiptRowSchema.extend({message:z.string().max(2048)})).max(100),totalCount:z.number().int().nonnegative().max(1000000000).nullable(),sampling:logSamplingSchema,truncated:z.boolean(),partial:z.boolean()}).strict().refine(v=>v.rows.length<=v.query.limit&&new Set(v.rows.map(r=>r.id)).size===v.rows.length&&v.rows.every(r=>r.timestamp>=v.query.start&&r.timestamp<v.query.end&&(!v.query.filters.levels||v.query.filters.levels.includes(r.level))&&(!v.query.filters.traceId||r.traceId===v.query.filters.traceId))&&Date.parse(v.asOf)>=Date.parse(v.query.end)&&Date.parse(v.snapshotExpiresAt)>Date.parse(v.asOf)&&Date.parse(v.snapshotExpiresAt)-Date.parse(v.asOf)<=600000&&(v.totalCount===null||v.totalCount>=v.rows.length)&&!(v.totalCount!==null&&v.totalCount>v.rows.length&&!v.truncated&&!v.partial&&!v.sampling.sampled)&&!(v.totalCount===v.rows.length&&v.truncated),'LOG_SNAPSHOT_COVERAGE_OR_BINDING_INVALID');
export type LogSnapshot=z.infer<typeof logSnapshotSchema>;
export const logSnapshotProofSchema=z.object({queryId:z.uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const logReplyBinding={contractHash:z.literal(companyLogsContractHash),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),sourceRevision:z.string().min(1).max(256)};
export const logCheckReplySchema=z.object({...logReplyBinding,operation:z.literal('CHECK'),allowed:z.literal(true),snapshot:logSnapshotProofSchema.nullable()}).strict();
export const logQueryReplySchema=z.object({...logReplyBinding,operation:z.literal('QUERY'),snapshot:logSnapshotSchema,snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const logSourceReceiptSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),sourceRevision:z.string().min(1).max(256),service:logServiceSchema,environment:logEnvironmentSchema,queryId:z.uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),snapshotExpiresAt:logCanonicalInstantSchema,classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'])}).strict();
export type LogScope={id:string;version:number;sourceRevision:string;schemaHash:string;allowedFields:string[];classification:'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED';expiresAt:string};
