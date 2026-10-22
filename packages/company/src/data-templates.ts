import {lstat,readFile,readdir} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {CompanySourceError} from './chat.js';
import {exactRate} from './data-numeric.js';
const canonicalInstant=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'CANONICAL_UTC_REQUIRED');
const fieldName=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const templateKey=z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(128);
const templateVersion=z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const resourceName=z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/);
const reviewReference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/);
const forbiddenParameter=/^(sql|query|statement|raw|table|schema|where|join|select|insert|update|delete)$/i;
const parameterName=fieldName.refine(v=>!forbiddenParameter.test(v),'RAW_SQL_PARAMETER_FORBIDDEN');
const timeZone=z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
const parameterDefinition=z.union([
 z.object({type:z.literal('string'),format:z.literal('date-time')}).strict(),
 z.object({type:z.literal('string'),enum:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(32).refine(v=>new Set(v).size===v.length,'DUPLICATE_ENUM_VALUE')}).strict()
]);
export const dataTemplateStatusSchema=z.enum(['DRAFT','VALIDATED','APPROVED','PUBLISHED','CERTIFIED','DEPRECATED','REVOKED']);
export const dataTemplateParametersSchema=z.object({type:z.literal('object'),additionalProperties:z.literal(false),required:z.array(parameterName).min(1).max(8).refine(v=>new Set(v).size===v.length,'DUPLICATE_PARAMETER'),properties:z.record(parameterName,parameterDefinition).refine(v=>{const keys=Object.keys(v);return keys.length>=1&&keys.length<=8;},'PARAMETER_COUNT_INVALID')}).strict();
export const dataTemplateMetricSchema=z.object({
 name:z.string().min(1).max(128),grain:z.array(fieldName).min(1).max(4).refine(v=>new Set(v).size===v.length,'DUPLICATE_GRAIN'),
 numerator:z.string().min(1).max(256),denominator:z.string().min(1).max(256),
 dedupKey:z.array(fieldName).min(1).max(4).refine(v=>new Set(v).size===v.length,'DUPLICATE_DEDUP_KEY'),
 dedupScope:z.literal('WITHIN_AUTHORIZED_TIME_WINDOW'),
 validRecordRule:z.object({field:fieldName,operator:z.literal('eq'),value:z.union([z.boolean(),z.string().max(64),z.number().finite()])}).strict(),
 dedupOrder:z.array(z.object({field:fieldName,direction:z.enum(['ASC','DESC'])}).strict()).min(1).max(8),
 processingOrder:z.array(z.enum(['server_authorized_scope','time_window','validity','dedup','channel_filter','aggregate'])).max(6).refine(v=>v.join('>')==='server_authorized_scope>time_window>validity>dedup>channel_filter>aggregate','PROCESSING_ORDER_CHANGED'),
 nullPolicy:z.literal('missing_status_is_unknown_not_success'),zeroDenominator:z.literal('NULL'),
 timezone:timeZone,timeField:fieldName,interval:z.literal('[start,end)'),watermarkRequired:z.literal(true)
}).strict();
export const dataTemplateSchema=z.object({
 schemaVersion:z.literal('1.0'),key:templateKey,version:templateVersion,status:dataTemplateStatusSchema,ownerRole:z.enum(['DATA_STEWARD']),metric:dataTemplateMetricSchema,
 parameters:dataTemplateParametersSchema,
 execution:z.object({kind:z.literal('MCP_DATA_TOOL'),bindingRef:resourceName,operation:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),timeoutMs:z.number().int().min(1000).max(30000),maxRows:z.number().int().min(1).max(100000),maxBytes:z.number().int().min(1).max(10485760),maxWindowDays:z.number().int().min(1).max(31)}).strict(),
 authorization:z.object({allowedRoles:z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).min(1).max(16).refine(v=>new Set(v).size===v.length,'DUPLICATE_ROLE'),rowScope:z.literal('SERVER_INJECTED'),outputClassification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),groupSharing:z.literal('EXPLICIT_RESOURCE_GRANT')}).strict(),
 quality:z.object({assertions:z.array(z.string().min(1).max(256)).min(1).max(16),freshnessMaxMinutes:z.number().int().min(1).max(1440),goldenCasesRef:z.string().min(1).max(1024)}).strict(),
 certification:z.object({reference:reviewReference,certifiedAt:canonicalInstant,oracleRef:z.string().min(1).max(1024),liveStatus:z.literal('UNVERIFIED')}).strict().optional()
}).strict();
export type DataTemplate=z.infer<typeof dataTemplateSchema>;
export type DataTemplateRegistry={templates:readonly DataTemplate[];byRef:ReadonlyMap<string,DataTemplate>;registryHash:string};
const refKey=(key:string,version:string)=>key+'@'+version;
const templateHash=(template:DataTemplate):string=>hash(canonical(template));
export function dataTemplateRegistryHash(templates:readonly DataTemplate[]):string{
 return hash(canonical([...templates].map(t=>({key:t.key,version:t.version,hash:templateHash(t)})).sort((a,b)=>refKey(a.key,a.version).localeCompare(refKey(b.key,b.version),'en'))));
}
export function assertExecutableDataTemplate(template:DataTemplate):void{
 if(template.status!=='CERTIFIED'||!template.certification)throw new CompanySourceError('COMPANY_DATA_TEMPLATE_NOT_CERTIFIED');
 const {required,properties}=template.parameters,keys=Object.keys(properties).sort();
 if(required.join(',')!=='start,end'||keys.join(',')!=='channel,end,start')throw new CompanySourceError('COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID');
 for(const field of ['start','end']){const value=properties[field];if(!value||value.type!=='string'||!('format' in value)||value.format!=='date-time')throw new CompanySourceError('COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID');}
 const channel=properties['channel'];if(!channel||channel.type!=='string'||!('enum' in channel)||channel.enum.join(',')!=='app,web')throw new CompanySourceError('COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID');
 if(template.execution.operation!=='success-rate')throw new CompanySourceError('COMPANY_DATA_TEMPLATE_OPERATION_INVALID');
}
export async function loadDataTemplates(directory:string):Promise<DataTemplateRegistry>{
 let entries:string[];
 try{
  const profile=await lstat(directory);if(!profile.isDirectory()||profile.isSymbolicLink())throw Error('DATA_TEMPLATE_DIRECTORY_INVALID');
  entries=(await readdir(directory)).filter(name=>name.endsWith('.json')).sort();if(!entries.length||entries.length>64)throw Error('DATA_TEMPLATE_SET_INVALID');
 }catch{throw new CompanySourceError('COMPANY_DATA_TEMPLATE_INVALID');}
 const templates:DataTemplate[]=[];
 for(const name of entries){
  try{
   if(!/^[a-z][a-z0-9._-]{0,127}\.json$/.test(name))throw Error('TEMPLATE_FILE_NAME_INVALID');const path=join(directory,name),profile=await lstat(path);
   if(!profile.isFile()||profile.isSymbolicLink()||profile.size<2||profile.size>131072)throw Error('TEMPLATE_FILE_INVALID');
   const template=dataTemplateSchema.parse(JSON.parse(await readFile(path,'utf8')));
   if(basename(name,'.json')!==template.key)throw Error('TEMPLATE_FILE_KEY_MISMATCH');
   templates.push(template);
  }catch(error){if(error instanceof CompanySourceError)throw error;throw new CompanySourceError('COMPANY_DATA_TEMPLATE_INVALID');}
 }
 const byRef=new Map<string,DataTemplate>();
 for(const template of templates){const key=refKey(template.key,template.version);if(byRef.has(key))throw new CompanySourceError('COMPANY_DATA_TEMPLATE_DUPLICATE');byRef.set(key,template);}
 return {templates,byRef,registryHash:dataTemplateRegistryHash(templates)};
}
export function requireDataTemplate(registry:DataTemplateRegistry,key:string,version:string):DataTemplate{
 const template=registry.byRef.get(refKey(key,version));if(!template)throw new CompanySourceError('COMPANY_DATA_TEMPLATE_UNKNOWN');assertExecutableDataTemplate(template);return template;
}
export function dataTemplateHash(template:DataTemplate):string{return templateHash(template);}
export const goldenPaymentEventSchema=z.object({eventId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),attemptId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),tenantId:z.string().min(1).max(64),departmentId:z.string().min(1).max(64),eventTime:canonicalInstant,channel:z.enum(['app','web']),status:z.enum(['success','failed','unknown']),valid:z.boolean()}).strict();
export type GoldenPaymentEvent=z.infer<typeof goldenPaymentEventSchema>;
export type PaymentAggregate={attempts:string;successes:string;successRate:string|null;byChannel:readonly {channel:'app'|'web';attempts:string;successes:string;successRate:string|null}[]};
/** Local certification oracle for the documented template semantics. It never
 * supplies production results; upstream aggregates remain the only data source. */
export function aggregatePaymentAttempts(events:readonly GoldenPaymentEvent[],scope:{start:string;end:string;tenantId:string;departmentId?:string;channel?:'app'|'web'}):PaymentAggregate{
 if(!(Date.parse(scope.end)>Date.parse(scope.start)))throw Error('WINDOW_INVALID');const parsed=events.map(event=>goldenPaymentEventSchema.parse(event));
 const latest=new Map<string,GoldenPaymentEvent>();
 for(const event of parsed){if(!event.valid||event.tenantId!==scope.tenantId||event.departmentId!==(scope.departmentId??event.departmentId)||event.eventTime<new Date(scope.start).toISOString()||event.eventTime>=new Date(scope.end).toISOString())continue;
  const current=latest.get(event.attemptId);if(!current||event.eventTime>current.eventTime||event.eventTime===current.eventTime&&event.eventId>current.eventId)latest.set(event.attemptId,event);}
 const selected=[...latest.values()].filter(event=>!scope.channel||event.channel===scope.channel),channels=['app','web'] as const;
 const byChannel=channels.map(channel=>{const rows=selected.filter(event=>event.channel===channel),attempts=String(rows.length),successes=String(rows.filter(event=>event.status==='success').length);return {channel,attempts,successes,successRate:exactRate(successes,attempts)};}).filter(channel=>channel.attempts!=='0');
 const attempts=String(selected.length),successes=String(selected.filter(event=>event.status==='success').length);
 return {attempts,successes,successRate:exactRate(successes,attempts),byChannel};
}
export function normalizeDataParameters(query:{start:string;end:string;channel?:'app'|'web'}):{start:string;end:string;channel?:'app'|'web'}{
 const start=new Date(query.start).toISOString(),end=new Date(query.end).toISOString();if(!(Date.parse(end)>Date.parse(start))||Date.parse(end)-Date.parse(start)>31*86400000)throw new CompanySourceError('COMPANY_DATA_WINDOW_INVALID');
 return {start,end,...(query.channel?{channel:query.channel}:{})};
}
