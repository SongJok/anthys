import {z} from 'zod';
import {dataResultContract} from '../../contracts/src/result-contract.js';
import {subjectPart} from './contracts.js';
import {hash} from '../../storage/src/crypto.js';
const sha256=z.string().regex(/^[a-f0-9]{64}$/),version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const dwsConnectionResultContract=dataResultContract(z.object({state:z.literal('CONNECTED'),authorizationVersion:version,delegationExpiresAt:z.iso.datetime(),platformValidity:z.literal('NOT_RECHECKED'),authorizationEntryAvailable:z.literal(false)}).strict());
export const dwsContactResultContract=dataResultContract(z.object({profile:z.object({userId:subjectPart,name:z.string().max(1024).optional(),dept:z.string().max(1024).optional(),org:z.string().max(1024).optional()}).strict(),source:z.object({identityId:z.uuid(),authorizationVersion:version,contentHash:sha256}).strict()}).strict());
export const documentSourceSchema=z.object({identityId:z.uuid(),authorizationVersion:version,scopeId:z.uuid(),scopeVersion:version,profileHash:sha256,nodeId:z.string().min(1).max(128),revision:z.string().min(1).max(128),observedSourceProof:z.object({version:z.string(),iv:z.string(),tag:z.string(),data:z.string()}).strict(),projectionHash:sha256,classification:z.enum(['CONFIDENTIAL','RESTRICTED'])}).strict();
const selector=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('FULL'),maxCharacters:z.number().int().min(1).max(12000)}).strict(),
 z.object({kind:z.literal('RANGE'),start:z.number().int().min(0).max(1000000),end:z.number().int().min(1).max(1000000)}).strict().refine(v=>v.end>v.start&&v.end-v.start<=12000),
 z.object({kind:z.literal('KEYWORD'),queryHash:sha256,context:z.number().int().min(0).max(200),limit:z.number().int().min(1).max(10)}).strict()
]);
const fragment=z.object({start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),text:z.string(),contentHash:sha256,redacted:z.boolean()}).strict().refine(v=>v.end>=v.start&&Array.from(v.text).length===v.end-v.start&&hash(v.text)===v.contentHash,'DOCUMENT_FRAGMENT_MISMATCH');
export const documentProjectionSchema=z.object({population:z.literal('ONE_DOCUMENT_VERSION'),rangeUnit:z.literal('UNICODE_CODE_POINTS'),selector,observedCharacters:z.number().int().nonnegative().max(262144),upstreamCompleteness:z.enum(['COMPLETE','TRUNCATED','UNKNOWN']),stopReason:z.enum(['DOCUMENT_RESPONSE_TERMINAL','UPSTREAM_COMPLETENESS_UNPUBLISHED','UPSTREAM_CONTINUATION_UNCONSUMED','LOCAL_SELECTION_LIMIT','SELECTED_FRAGMENT_ONLY']),documentComplete:z.boolean(),totalMatches:z.number().int().nonnegative().nullable(),fragments:z.array(fragment).max(10),untrustedContent:z.literal(true)}).strict().refine(v=>v.fragments.every(f=>f.end<=v.observedCharacters)&&(!v.documentComplete||v.selector.kind==='FULL'&&v.upstreamCompleteness==='COMPLETE'&&v.stopReason==='DOCUMENT_RESPONSE_TERMINAL'),'DOCUMENT_COVERAGE_MISMATCH');
export const dwsDocumentResultContract=dataResultContract(z.object({source:documentSourceSchema,document:documentProjectionSchema}).strict());
