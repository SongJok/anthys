import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {Database} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {aggregatePaymentAttempts,dataTemplateHash,goldenPaymentEventSchema,requireDataTemplate,type DataTemplate,type DataTemplateRegistry} from './data-templates.js';
export class DataTemplateError extends Error{constructor(readonly code:string,readonly status=409){super(code);this.name='DataTemplateError';}}
const uuid=z.uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const templateKey=z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(128),templateVersion=z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const reviewReference=z.string().min(8).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const canonicalInstant=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v,'CANONICAL_UTC_REQUIRED');
const exactCount=z.string().regex(/^(0|[1-9]\d{0,17})$/),exactRate=z.string().regex(/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/).nullable();
const aggregateSchema=z.object({attempts:exactCount,successes:exactCount,successRate:exactRate,byChannel:z.array(z.object({channel:z.enum(['app','web']),attempts:exactCount,successes:exactCount,successRate:exactRate}).strict()).max(2)}).strict();
export const dataGoldenCaseSchema=z.object({
 caseId:z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),aspect:z.enum(['BOUNDARY','EMPTY','SCOPE_FILTER','DEDUP','CHANNEL']),
 scope:z.object({start:canonicalInstant,end:canonicalInstant,tenantId:z.string().regex(/^synthetic-[A-Za-z0-9-]{1,55}$/),departmentId:z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional(),channel:z.enum(['app','web']).optional()}).strict(),
 events:z.array(goldenPaymentEventSchema).max(500),expected:aggregateSchema
}).strict();
export const dataGoldenFileSchema=z.object({
 schemaVersion:z.literal('1.0'),templateKey,templateVersion,templateHash:z.string().regex(/^[a-f0-9]{64}$/),cases:z.array(dataGoldenCaseSchema).min(5).max(64)
}).strict().superRefine((file,ctx)=>{const ids=new Set<string>();for(const item of file.cases){if(ids.has(item.caseId))ctx.addIssue({code:'custom',message:'DUPLICATE_GOLDEN_CASE',path:['cases']});ids.add(item.caseId);}if(file.cases.some(item=>!(Date.parse(item.scope.end)>Date.parse(item.scope.start))))ctx.addIssue({code:'custom',message:'GOLDEN_WINDOW_INVALID',path:['cases']});});
export type DataGoldenCase=z.infer<typeof dataGoldenCaseSchema>;
export const requiredGoldenAspects=['BOUNDARY','EMPTY','SCOPE_FILTER','DEDUP','CHANNEL'] as const;
type LocalScope={start:string;end:string;tenantId:string;departmentId?:string|undefined;channel?:'app'|'web'|undefined};
type LocalOracle=(events:DataGoldenCase['events'],scope:LocalScope)=>unknown;
// Only locally reviewed semantic oracles may certify a template. A template
// without one cannot be published, even if its file declares CERTIFIED.
const localOracles=new Map<string,LocalOracle>([['payments.success_rate_daily',(events,scope)=>aggregatePaymentAttempts(events,{start:scope.start,end:scope.end,tenantId:scope.tenantId,...(scope.departmentId!==undefined?{departmentId:scope.departmentId}:{}),...(scope.channel!==undefined?{channel:scope.channel}:{})})]]);
export async function loadDataGoldens(directory:string,template:DataTemplate):Promise<{hash:string;caseCount:number}>{
 const oracle=localOracles.get(template.key);if(!oracle)throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_UNAVAILABLE',503);
 let raw:string;
 try{
  const path=join(directory,`${template.key}.${template.version}.json`),profile=await lstat(path);
  if(!profile.isFile()||profile.isSymbolicLink()||profile.size<2||profile.size>262144)throw Error('GOLDEN_FILE_INVALID');
  raw=await readFile(path,'utf8');
 }catch{throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_UNAVAILABLE',503);}
 let file:z.infer<typeof dataGoldenFileSchema>;
 try{file=dataGoldenFileSchema.parse(JSON.parse(raw));}catch{throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_INVALID',409);}
 if(file.templateKey!==template.key||file.templateVersion!==template.version||file.templateHash!==dataTemplateHash(template))throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_INVALID',409);
 const aspects=new Set(file.cases.map(item=>item.aspect));
 if(requiredGoldenAspects.some(aspect=>!aspects.has(aspect)))throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_INVALID',409);
 for(const item of file.cases){
  let actual:unknown;try{actual=oracle(item.events,item.scope);}catch{throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_INVALID',409);}
  if(canonical(actual)!==canonical(item.expected))throw new DataTemplateError('DATA_TEMPLATE_GOLDEN_INVALID',409);
 }
 return {hash:hash(canonical(file)),caseCount:file.cases.length};
}
const publishInput=z.object({templateKey,templateVersion,reviewReference}).strict();
const rollbackInput=z.object({templateKey,templateVersion,expectedRevision:version,reviewReference}).strict();
const resultSchema=z.object({templateKey,templateVersion,activeVersion:templateVersion,activeRevision:version,operation:z.enum(['PUBLISH','ROLLBACK']),replayed:z.boolean(),requestId:uuid,platformCertification:z.literal('LOCAL_GOLDEN_ONLY'),liveVerified:z.literal(false),currentActiveVersion:templateVersion.optional(),currentActiveRevision:version.optional()}).strict();
const itemSchema=z.object({templateKey,templateVersion,templateHash:z.string().regex(/^[a-f0-9]{64}$/),certificationReference:z.string().max(255),publishedAt:z.iso.datetime({offset:true}),active:z.boolean(),activeVersion:templateVersion.nullable(),activeRevision:version.nullable()}).strict();
const listSchema=z.object({items:z.array(itemSchema).max(200),truncated:z.boolean(),platformCertification:z.literal('LOCAL_GOLDEN_ONLY'),liveVerified:z.literal(false)}).strict();
const errorStatus=new Map<string,number>([
 ['PERMISSION_SESSION_INVALID',401],['PERMISSION_ADMIN_DENIED',403],
 ['COMPANY_DATA_TEMPLATE_REQUEST_CONFLICT',409],['COMPANY_DATA_TEMPLATE_VERSION_EXISTS',409],['COMPANY_DATA_TEMPLATE_VERSION_CONFLICT',409],['COMPANY_DATA_TEMPLATE_VERSION_MISMATCH',409],
 ['COMPANY_DATA_TEMPLATE_VERSION_UNKNOWN',404],['COMPANY_DATA_TEMPLATE_INPUT_INVALID',400],
 ['COMPANY_DATA_TEMPLATE_UNKNOWN',404],['COMPANY_DATA_TEMPLATE_NOT_CERTIFIED',403],['COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID',409],['COMPANY_DATA_TEMPLATE_OPERATION_INVALID',409]
]);
const driverFailure=z.object({message:z.string(),code:z.string().optional()}),busyCodes=new Set<string|undefined>(['55P03','40P01']);
function translate(error:unknown):never{
 if(error instanceof DataTemplateError||error instanceof z.ZodError)throw error;
 const detail=driverFailure.safeParse(error);
 if(detail.success){
  const status=errorStatus.get(detail.data.message);if(status!==undefined)throw new DataTemplateError(detail.data.message,status);
  if(busyCodes.has(detail.data.code))throw new DataTemplateError('DATA_TEMPLATE_BUSY',409);
 }
 throw new DataTemplateError('DATA_TEMPLATE_SERVICE_UNAVAILABLE',503);
}
function requireInstalled(registry:DataTemplateRegistry,key:string,value:string):DataTemplate{
 try{return requireDataTemplate(registry,key,value);}catch(error){translate(error);}
}
// This service approves only versions already present in the reviewed local
// registry. It never accepts a template body, SQL, row scope or credentials,
// and it cannot certify upstream availability.
export class DataTemplateAdministration{
 constructor(private readonly db:Database,private readonly registry:DataTemplateRegistry,private readonly goldenDirectory:string){}
 async list(p:Principal){
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   return listSchema.parse((await c.query('SELECT public.oa_company_data_template_list($1) value',[p.sessionId])).rows[0].value);
  });}catch(error){translate(error);}
 }
 async publish(p:Principal,input:unknown,requestId:string){
  const body=publishInput.parse(input),request=uuid.parse(requestId),template=requireInstalled(this.registry,body.templateKey,body.templateVersion),goldens=await loadDataGoldens(this.goldenDirectory,template);
  return this.mutate(p,'PUBLISH',template.key,template.version,dataTemplateHash(template),template.certification!.reference,goldens.hash,null,body.reviewReference,request);
 }
 async rollback(p:Principal,input:unknown,requestId:string){
  const body=rollbackInput.parse(input),request=uuid.parse(requestId),template=requireInstalled(this.registry,body.templateKey,body.templateVersion),goldens=await loadDataGoldens(this.goldenDirectory,template);
  return this.mutate(p,'ROLLBACK',template.key,template.version,dataTemplateHash(template),template.certification!.reference,goldens.hash,body.expectedRevision,body.reviewReference,request);
 }
 private async mutate(p:Principal,operation:'PUBLISH'|'ROLLBACK',key:string,templateVersionValue:string,templateHash:string,certification:string,goldenHash:string,expected:number|null,review:string,request:string){
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   return resultSchema.parse((await c.query('SELECT public.oa_company_data_template_admin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value',[operation,key,templateVersionValue,templateHash,certification,goldenHash,expected,review,request,p.sessionId])).rows[0].value);
  });}catch(error){translate(error);}
 }
}
