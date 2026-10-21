import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';

// This is an open_aider scoped-proxy contract, NOT an assertion that an
// arbitrary upstream chat agent understands or enforces these instructions.
export const COMPANY_CHAT_CONTRACT={id:'open_aider.company.code.read',version:1,operations:['CHECK','SEARCH','READ'],authorization:'UPSTREAM_RESOURCE_ENFORCED',sideEffects:'NONE'} as const;
export const companyContractHash=hash(canonical(COMPANY_CHAT_CONTRACT));
export const repoSchema=z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(s=>!s.split('/').some(p=>p==='..'||!p),'INVALID_REPO');
export const commitSchema=z.string().regex(/^[a-f0-9]{40}$/);
export const pathSchema=z.string().min(1).max(1024).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!/[\u0000-\u001f]/.test(p)&&!p.split('/').some(s=>s==='..'||s==='.'||!s),'INVALID_PATH');
const codeTarget={repo:repoSchema,commit:commitSchema};
export const searchSchema=z.object({...codeTarget,keyword:z.string().min(1).max(256),limit:z.number().int().min(1).max(20)}).strict();
export const readSchema=z.object({...codeTarget,path:pathSchema,startLine:z.number().int().min(1).max(1000000),endLine:z.number().int().min(1).max(1000000)}).strict().refine(v=>v.endLine>=v.startLine&&v.endLine-v.startLine<200,'LINE_RANGE_LIMIT');
export type CodeSearch=z.infer<typeof searchSchema>;
export type CodeRead=z.infer<typeof readSchema>;
export const codeResource=(args:{repo:string;commit:string})=>'code:'+args.repo+'@'+args.commit;
export function pathAllowed(path:string,prefixes:readonly string[]):boolean{return pathSchema.safeParse(path).success&&prefixes.some(prefix=>path===prefix||path.startsWith(prefix.endsWith('/')?prefix:prefix+'/'));}
export const codeFragmentSchema=z.object({...codeTarget,path:pathSchema,startLine:z.number().int().positive(),endLine:z.number().int().positive(),snippet:z.string().max(24000),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(v=>v.endLine>=v.startLine&&v.endLine-v.startLine<200&&v.snippet.split('\n').length===v.endLine-v.startLine+1,'FRAGMENT_RANGE_MISMATCH');
const replyBinding={contractHash:z.literal(companyContractHash),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),scopeVersion:z.number().int().positive(),sourceRevision:z.string().min(1).max(256)};
export const checkReplySchema=z.object({...replyBinding,operation:z.literal('CHECK'),allowed:z.literal(true)}).strict();
export const searchReplySchema=z.object({...replyBinding,operation:z.literal('SEARCH'),queryId:z.uuid(),matches:z.array(codeFragmentSchema).max(20),totalCount:z.number().int().nonnegative().max(1000000000),truncated:z.boolean()}).strict().refine(v=>v.totalCount>=v.matches.length&&v.truncated===(v.totalCount>v.matches.length),'SEARCH_COVERAGE_MISMATCH');
export const readReplySchema=z.object({...replyBinding,operation:z.literal('READ'),queryId:z.uuid(),fragment:codeFragmentSchema,totalLines:z.number().int().positive().max(1000000),truncated:z.boolean()}).strict();
export type CodeScope={id:string;version:number;sourceRevision:string;schemaHash:string;allowedPaths:string[];classification:'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED'};
export const sourceReceiptSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive(),sourceRevision:z.string(),repo:repoSchema,commit:commitSchema,classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'])}).strict();
export function redactCode(text:string):string{return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"';,]+/gi,'$1[REDACTED]');}
