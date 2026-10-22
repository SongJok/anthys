import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {chatSchemaHash,CompanySourceError} from './chat.js';
import {decimalRateSchema,exactCountSchema,exactCountSum,exactDecimalEqual,exactRate} from './data-numeric.js';
import {assertExecutableDataTemplate,dataTemplateHash,type DataTemplate} from './data-templates.js';
export const COMPANY_DATA_CONTRACT={id:'anthys.company.data.query',version:1,operations:['CHECK','QUERY'],authorization:'UPSTREAM_RESOURCE_ENFORCED',sideEffects:'NONE',templates:'CERTIFIED_REGISTRY',aggregates:'SERVER_COMPUTED'} as const;
export const companyDataContractHash=hash(canonical(COMPANY_DATA_CONTRACT));
export const COMPANY_DATA_TOOL_NAME='chat';
export const COMPANY_DATA_TOOL_INPUT_SCHEMA={type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false} as const;
export const companyDataToolSchemaHash=chatSchemaHash({inputSchema:COMPANY_DATA_TOOL_INPUT_SCHEMA});
export const dataTemplateKeySchema=z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(128);
export const dataTemplateVersionSchema=z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
export const dataChannelSchema=z.enum(['app','web']);
export const dataCompletenessSchema=z.enum(['COMPLETE','TRUNCATED','SAMPLED']);
const instant=z.iso.datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)),'FINITE_INSTANT_REQUIRED').transform(v=>new Date(v).toISOString());
export const canonicalInstantSchema=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'CANONICAL_UTC_REQUIRED');
const maxWindowMs=31*86400000;
export const dataQuerySchema=z.object({templateKey:dataTemplateKeySchema,templateVersion:dataTemplateVersionSchema,start:instant,end:instant,channel:dataChannelSchema.optional()}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=maxWindowMs,'BOUNDED_POSITIVE_DATA_WINDOW_REQUIRED');
export type DataQuery=z.infer<typeof dataQuerySchema>;
export const dataCanonicalQuerySchema=z.object({templateKey:dataTemplateKeySchema,templateVersion:dataTemplateVersionSchema,start:canonicalInstantSchema,end:canonicalInstantSchema,channel:dataChannelSchema.optional()}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&Date.parse(v.end)-Date.parse(v.start)<=maxWindowMs,'BOUNDED_POSITIVE_DATA_WINDOW_REQUIRED');
export type CanonicalDataQuery=z.infer<typeof dataCanonicalQuerySchema>;
export const dataResource=(args:Pick<DataQuery,'templateKey'|'templateVersion'>)=>'data:'+args.templateKey+'@'+args.templateVersion;
export const dataParameters=(query:Pick<DataQuery,'start'|'end'|'channel'>)=>({start:query.start,end:query.end,...(query.channel?{channel:query.channel}:{})});
export const dataParametersHash=(query:DataQuery)=>hash(canonical({templateKey:query.templateKey,templateVersion:query.templateVersion,parameters:dataParameters(query)}));
export const dataTemplateRefSchema=z.object({key:dataTemplateKeySchema,version:dataTemplateVersionSchema,hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type DataTemplateRef=z.infer<typeof dataTemplateRefSchema>;
export const dataTemplateRef=(template:DataTemplate):DataTemplateRef=>({key:template.key,version:template.version,hash:dataTemplateHash(template)});
export const dataRowScopeSchema=z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),z.string().min(1).max(256)).refine(v=>Object.keys(v).length>=1&&Object.keys(v).length<=16,'ROW_SCOPE_SIZE_INVALID');
export type DataRowScope=z.infer<typeof dataRowScopeSchema>;
export const dataWindowSchema=z.object({start:canonicalInstantSchema,end:canonicalInstantSchema,interval:z.literal('[start,end)')}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start),'DATA_WINDOW_INVALID');
const metricBaseSchema=z.object({attempts:exactCountSchema,successes:exactCountSchema,successRate:decimalRateSchema.nullable()}).strict();
type MetricBase=z.infer<typeof metricBaseSchema>;
function metricIssue(value:MetricBase):string|null{
 try{
  if(BigInt(value.successes)>BigInt(value.attempts))return 'NUMERATOR_EXCEEDS_DENOMINATOR';const expected=exactRate(value.successes,value.attempts);
  if(expected===null)return value.successRate===null?null:'ZERO_DENOMINATOR_RATE_MUST_BE_NULL';
  return value.successRate!==null&&exactDecimalEqual(value.successRate,expected)?null:'RATE_DENOMINATOR_MISMATCH';
 }catch{return 'EXACT_METRIC_INVALID';}
}
export const dataMetricSchema=metricBaseSchema.superRefine((value,ctx)=>{const issue=metricIssue(value);if(issue)ctx.addIssue({code:'custom',message:issue});});
export const dataChannelMetricSchema=metricBaseSchema.extend({channel:dataChannelSchema}).strict().superRefine((value,ctx)=>{const issue=metricIssue(value);if(issue)ctx.addIssue({code:'custom',message:issue});});
export const dataMetricsSchema=metricBaseSchema.extend({byChannel:z.array(dataChannelMetricSchema).max(16)}).strict().superRefine((value,ctx)=>{
 const issue=metricIssue(value);if(issue)ctx.addIssue({code:'custom',message:issue});
 const channels=value.byChannel.map(channel=>channel.channel);if(new Set(channels).size!==channels.length)ctx.addIssue({code:'custom',path:['byChannel'],message:'DUPLICATE_CHANNEL'});
 try{
  if(exactCountSum(value.byChannel.map(channel=>channel.attempts))!==value.attempts||exactCountSum(value.byChannel.map(channel=>channel.successes))!==value.successes)ctx.addIssue({code:'custom',path:['byChannel'],message:'CHANNEL_TOTAL_MISMATCH'});
 }catch{ctx.addIssue({code:'custom',path:['byChannel'],message:'CHANNEL_TOTAL_INVALID'});}
});
export type DataMetrics=z.infer<typeof dataMetricsSchema>;
export const dataAggregateResultSchema=z.object({queryId:z.uuid(),window:dataWindowSchema,watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,completeness:dataCompletenessSchema,metrics:dataMetricsSchema}).strict();
export type DataAggregateResult=z.infer<typeof dataAggregateResultSchema>;
const replyBinding={contractHash:z.literal(companyDataContractHash),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),sourceRevision:z.string().min(1).max(256),template:dataTemplateRefSchema,rowScope:dataRowScopeSchema};
export const dataCheckReplySchema=z.object({...replyBinding,operation:z.literal('CHECK'),allowed:z.literal(true)}).strict();
export const dataQueryReplySchema=z.object({...replyBinding,operation:z.literal('QUERY'),result:dataAggregateResultSchema}).strict();
export type DataCheckReply=z.infer<typeof dataCheckReplySchema>;
export type DataQueryReply=z.infer<typeof dataQueryReplySchema>;
export type DataScope={id:string;version:number;sourceRevision:string;templateKey:string;templateVersion:string;templateHash:string;rowScope:DataRowScope;schemaHash:string;classification:'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED';expiresAt:string};
export type DataReplyExpectation={ctx:DbContext;scope:DataScope;template:DataTemplate;nonce:string;query:DataQuery};
function bindingMatches(reply:{contractHash:string;nonce:string;tenantId:string;actorId:string;scopeId:string;scopeVersion:number;sourceRevision:string;template:DataTemplateRef;rowScope:DataRowScope},expected:DataReplyExpectation):boolean{
 return reply.contractHash===companyDataContractHash&&reply.nonce===expected.nonce&&reply.tenantId===expected.ctx.tenantId&&reply.actorId===expected.ctx.actorId&&reply.scopeId===expected.scope.id&&reply.scopeVersion===expected.scope.version&&reply.sourceRevision===expected.scope.sourceRevision&&canonical(reply.template)===canonical(dataTemplateRef(expected.template))&&canonical(reply.rowScope)===canonical(expected.scope.rowScope);
}
export function parseDataCheckReply(value:unknown,expected:DataReplyExpectation):DataCheckReply{
 const parsed=dataCheckReplySchema.safeParse(value);if(!parsed.success||!bindingMatches(parsed.data,expected))throw new CompanySourceError('COMPANY_DATA_RESPONSE_INVALID');return parsed.data;
}
export function parseDataQueryReply(value:unknown,expected:DataReplyExpectation):DataQueryReply{
 const parsed=dataQueryReplySchema.safeParse(value);if(!parsed.success||!bindingMatches(parsed.data,expected))throw new CompanySourceError('COMPANY_DATA_RESPONSE_INVALID');
 const reply=parsed.data,result=reply.result,window={start:expected.query.start,end:expected.query.end,interval:'[start,end)' as const};
 if(canonical(result.window)!==canonical(window))throw new CompanySourceError('COMPANY_DATA_WINDOW_MISMATCH');
 if(Date.parse(result.observedAt)<Date.parse(window.end)||Date.parse(result.watermark)>Date.parse(result.observedAt)||Date.parse(result.observedAt)>Date.now()+300000)throw new CompanySourceError('COMPANY_DATA_OBSERVATION_INVALID');
 if(result.completeness==='COMPLETE'&&Date.parse(result.watermark)<Date.parse(window.end))throw new CompanySourceError('COMPANY_DATA_WATERMARK_INCOMPLETE');
 if(expected.query.channel&&result.metrics.byChannel.some(channel=>channel.channel!==expected.query.channel))throw new CompanySourceError('COMPANY_DATA_CHANNEL_SCOPE_MISMATCH');
 return reply;
}
export function dataReplyStatus(reply:DataQueryReply):'OK'|'PARTIAL'|'EMPTY'{
 if(reply.result.completeness!=='COMPLETE')return 'PARTIAL';return reply.result.metrics.attempts==='0'?'EMPTY':'OK';
}
export const dataSourceReceiptSchema=z.object({scopeId:z.uuid(),scopeVersion:z.number().int().positive().safe(),sourceRevision:z.string().min(1).max(256),templateKey:dataTemplateKeySchema,templateVersion:dataTemplateVersionSchema,templateHash:z.string().regex(/^[a-f0-9]{64}$/),queryId:z.uuid(),watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,completeness:dataCompletenessSchema,rowScopeHash:z.string().regex(/^[a-f0-9]{64}$/),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'])}).strict();
export type DataSourceReceipt=z.infer<typeof dataSourceReceiptSchema>;
export function dataWireArguments(template:DataTemplate,mode:'INLINE_DEFINITION'|'KEY_ONLY',query:DataQuery):Record<string,unknown>{
 return {template:dataTemplateRef(template),...(mode==='INLINE_DEFINITION'?{definition:template}:{}),parameters:dataParameters(query)};
}
export function assertCertifiedTemplate(template:DataTemplate,query:DataQuery):void{assertExecutableDataTemplate(template);if(template.key!==query.templateKey||template.version!==query.templateVersion)throw new CompanySourceError('COMPANY_DATA_TEMPLATE_MISMATCH');}
