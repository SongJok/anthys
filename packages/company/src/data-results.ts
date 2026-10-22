import {z} from 'zod';
import type pg from 'pg';
import type {Database} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import type {RuntimeStore} from '../../runtime/src/store.js';
import type {ToolResult} from '../../contracts/src/index.js';
import {canonicalInstantSchema,dataMetricsSchema,dataRowScopeSchema,dataTemplateRefSchema,dataWindowSchema} from './data-contracts.js';
import {dataTemplateHash,type DataTemplateRegistry} from './data-templates.js';
export class DataResultsError extends Error{constructor(readonly code:string,readonly status=503){super(code);this.name='DataResultsError';}}
const uuid=z.uuid(),hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const templateKeySchema=z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(128);
const templateVersionSchema=z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const exactCountSchema=z.string().regex(/^(0|[1-9]\d{0,17})$/);
const classificationSchema=z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']);
const completenessSchema=z.enum(['COMPLETE','TRUNCATED','SAMPLED']);
const statusSchema=z.enum(['OK','PARTIAL','EMPTY']);
const sourceSchema=z.object({scopeId:uuid,scopeVersion:z.number().int().positive().safe(),sourceRevision:z.string().min(1).max(256),templateKey:templateKeySchema,templateVersion:templateVersionSchema,templateHash:hashSchema,queryId:uuid,watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,completeness:completenessSchema,rowScopeHash:hashSchema,classification:classificationSchema}).strict();
const querySchema=z.object({templateKey:templateKeySchema,templateVersion:templateVersionSchema,start:canonicalInstantSchema,end:canonicalInstantSchema,channel:z.enum(['app','web']).optional()}).strict();
// The sealed capability result is the only source of the aggregate. It is
// projected, never re-interpreted, and only for the owning actor.
const sealedDataSchema=z.object({source:sourceSchema,query:querySchema,template:dataTemplateRefSchema,queryId:uuid,watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,completeness:completenessSchema,window:dataWindowSchema,rowScope:dataRowScopeSchema,metrics:dataMetricsSchema,untrustedContent:z.literal(true),upstreamCertification:z.literal('UNVERIFIED')}).strict().superRefine((value,ctx)=>{
 if(value.queryId!==value.source.queryId)ctx.addIssue({code:'custom',path:['queryId'],message:'QUERY_ID_MISMATCH'});
 if(value.template.key!==value.query.templateKey||value.template.version!==value.query.templateVersion||value.template.key!==value.source.templateKey||value.template.version!==value.source.templateVersion||value.template.hash!==value.source.templateHash)ctx.addIssue({code:'custom',path:['template'],message:'TEMPLATE_MISMATCH'});
 if(value.watermark!==value.source.watermark||value.observedAt!==value.source.observedAt||value.completeness!==value.source.completeness)ctx.addIssue({code:'custom',path:['source'],message:'SOURCE_RECEIPT_MISMATCH'});
 if(value.window.start!==value.query.start||value.window.end!==value.query.end||value.window.interval!=='[start,end)')ctx.addIssue({code:'custom',path:['window'],message:'WINDOW_MISMATCH'});
 if(value.completeness==='COMPLETE'&&Date.parse(value.watermark)<Date.parse(value.window.end))ctx.addIssue({code:'custom',path:['watermark'],message:'COMPLETE_WATERMARK_INCOMPLETE'});
 if(Date.parse(value.watermark)>Date.parse(value.observedAt))ctx.addIssue({code:'custom',path:['watermark'],message:'WATERMARK_AFTER_OBSERVATION'});
});
export const certifiedDataResultSchema=z.object({
 queryId:uuid,templateKey:templateKeySchema,templateVersion:templateVersionSchema,templateHash:hashSchema,
 window:dataWindowSchema,completeness:completenessSchema,watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,
 rowCount:exactCountSchema,metrics:dataMetricsSchema,rowScope:dataRowScopeSchema,classification:classificationSchema,
 status:statusSchema,evidenceRef:z.string().min(1).max(2048),executedAt:z.iso.datetime({offset:true}),upstreamCertification:z.literal('UNVERIFIED')
}).strict();
export type CertifiedDataResult=z.infer<typeof certifiedDataResultSchema>;
export const certifiedDataResultListSchema=z.object({items:z.array(certifiedDataResultSchema).max(50),truncated:z.boolean(),platformCertification:z.literal('LOCAL_GOLDEN_ONLY'),liveVerified:z.literal(false)}).strict();
export const certifiedDataCatalogItemSchema=z.object({
 templateKey:templateKeySchema,templateVersion:templateVersionSchema,templateHash:hashSchema,
 metricName:z.string().min(1).max(128),grain:z.array(z.string().min(1).max(64)).min(1).max(4),
 numerator:z.string().min(1).max(256),denominator:z.string().min(1).max(256),
 parameterNames:z.array(z.string().min(1).max(64)).min(1).max(8),
 freshnessMaxMinutes:z.number().int().min(1).max(1440),classification:classificationSchema,
 allowedRoles:z.array(z.string().min(1).max(64)).min(1).max(16),maxWindowDays:z.number().int().min(1).max(31),
 certificationReference:z.string().min(1).max(255),active:z.boolean(),
 platformCertification:z.literal('LOCAL_GOLDEN_ONLY'),liveVerified:z.literal(false)
}).strict();
export type CertifiedDataCatalogItem=z.infer<typeof certifiedDataCatalogItemSchema>;
export const certifiedDataCatalogSchema=z.object({items:z.array(certifiedDataCatalogItemSchema).max(64),platformCertification:z.literal('LOCAL_GOLDEN_ONLY'),liveVerified:z.literal(false)}).strict();
const busyCodes=new Set<string|undefined>(['55P03','40P01']);
function translate(error:unknown):never{
 if(error instanceof DataResultsError)throw error;
 const detail=z.object({message:z.string(),code:z.string().optional()}).safeParse(error);
 if(detail.success&&busyCodes.has(detail.data.code))throw new DataResultsError('DATA_RESULTS_BUSY',409);
 throw new DataResultsError('DATA_RESULTS_UNAVAILABLE',503);
}
const envelopeSchema=z.object({ciphertext:z.object({version:z.string(),iv:z.string(),tag:z.string(),data:z.string()}).strict()}).strict();
// Reads only the owning actor's own audited executions. A result is shown only
// when the sealed capability result and the retained execution audit record
// describe the same query, window, watermark and row count.
export class CertifiedDataResults{
 constructor(private readonly db:Database,private readonly store:RuntimeStore,private readonly registry:DataTemplateRegistry){}
 async list(p:Principal,taskId?:string):Promise<z.infer<typeof certifiedDataResultListSchema>>{
  const limit=25;
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   const rows=(await c.query("SELECT a.logical_action_key,a.result,a.created_at FROM tool_actions a WHERE a.tenant_id=$1 AND a.capability_id='company.data.query' AND a.state IN ('VERIFIED','FAILED') AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=a.tenant_id AND r.id=a.run_id AND r.task_id=$2::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $3",[p.tenantId,taskId??null,limit+1])).rows;
   const items:CertifiedDataResult[]=[];
   for(const row of rows.slice(0,limit)){const item=await this.project(c,p,row);if(item)items.push(item);}
   return certifiedDataResultListSchema.parse({items,truncated:rows.length>limit,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
  });}catch(error){translate(error);}
 }
 async catalog(p:Principal):Promise<z.infer<typeof certifiedDataCatalogSchema>>{
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   const active=(await c.query('SELECT template_key,active_version FROM public.company_data_template_active')).rows;
   const items=this.registry.templates.filter(template=>template.status==='CERTIFIED'&&template.certification).map(template=>certifiedDataCatalogItemSchema.parse({
    templateKey:template.key,templateVersion:template.version,templateHash:dataTemplateHash(template),
    metricName:template.metric.name,grain:template.metric.grain,numerator:template.metric.numerator,denominator:template.metric.denominator,
    parameterNames:Object.keys(template.parameters.properties).sort(),freshnessMaxMinutes:template.quality.freshnessMaxMinutes,
    classification:template.authorization.outputClassification,allowedRoles:template.authorization.allowedRoles,maxWindowDays:template.execution.maxWindowDays,
    certificationReference:template.certification!.reference,active:active.some(row=>row.template_key===template.key&&row.active_version===template.version),
    platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false
   }));
   return certifiedDataCatalogSchema.parse({items,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
  });}catch(error){translate(error);}
 }
 private async project(c:pg.PoolClient,p:Principal,row:{logical_action_key:string;result:unknown;created_at:Date}):Promise<CertifiedDataResult|null>{
  const envelope=envelopeSchema.safeParse(row.result);
  if(!envelope.success)return null;
  let result:ToolResult;
  try{result=this.store.openToolResult({tenantId:p.tenantId,actorId:p.actorId},row.logical_action_key,envelope.data);}catch{return null;}
  if(!['OK','PARTIAL','EMPTY'].includes(result.status))return null;
  const data=sealedDataSchema.safeParse(result.data);
  if(!data.success)return null;
  const audit=(await c.query("SELECT template_key,template_version,query_id,status,watermark,observed_at,completeness,row_count,evidence_ref FROM data_executions WHERE tenant_id=$1 AND query_id=$2",[p.tenantId,data.data.queryId])).rows[0];
  if(!audit)return null;
  const watermark=audit.watermark instanceof Date?audit.watermark.toISOString():String(audit.watermark);
  const observedAt=audit.observed_at instanceof Date?audit.observed_at.toISOString():String(audit.observed_at);
  if(audit.template_key!==data.data.template.key||audit.template_version!==data.data.template.version||audit.status!==result.status||audit.completeness!==data.data.completeness||watermark!==data.data.watermark||observedAt!==data.data.observedAt||String(audit.row_count)!==data.data.metrics.attempts)return null;
  const projected=certifiedDataResultSchema.safeParse({queryId:data.data.queryId,templateKey:data.data.template.key,templateVersion:data.data.template.version,templateHash:data.data.template.hash,window:data.data.window,completeness:data.data.completeness,watermark:data.data.watermark,observedAt:data.data.observedAt,rowCount:data.data.metrics.attempts,metrics:data.data.metrics,rowScope:data.data.rowScope,classification:data.data.source.classification,status:result.status,evidenceRef:audit.evidence_ref as string,executedAt:row.created_at.toISOString(),upstreamCertification:'UNVERIFIED'});
  return projected.success?projected.data:null;
 }
}
export type CertifiedDataResultReader=Pick<CertifiedDataResults,'list'|'catalog'>;
