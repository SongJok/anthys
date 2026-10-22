import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import type {Lease,RuntimeStore} from '../../runtime/src/store.js';
import {Gateway,canonical,type Capability} from '../../gateway/src/index.js';
import {reviewedCapability} from '../../gateway/src/reviewed-capabilities.js';
import {blocked,type ToolResult} from '../../contracts/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {CompanySourceError} from './chat.js';
import {CompanyDataClient} from './data-client.js';
import {companyDataResultContract} from './data-result-contract.js';
import {companyDataContractHash,dataCanonicalQuerySchema,dataParametersHash,dataQuerySchema,dataResource,dataRowScopeSchema,dataSourceReceiptSchema,dataTemplateRef,dataWireArguments,dataReplyStatus,parseDataCheckReply,parseDataQueryReply,type DataQuery,type DataScope} from './data-contracts.js';
import {recordDataExecution,type DataExecutionAudit} from './data-execution.js';
import {dataTemplateHash,type DataTemplate} from './data-templates.js';
export const companyDataBindingHash=(connectorId:string,connectionBinding:string,toolName:string,inputSchemaHash:string,registryHash:string)=>hash(canonical({id:'company.data.query',version:'1.0.0',connectorId,connectionBinding,toolName,inputSchemaHash,registryHash,contractHash:companyDataContractHash,outputSchema:companyDataResultContract.outputSchema}));
async function scopeFor(c:pg.PoolClient,ctx:DbContext,client:CompanyDataClient,args:DataQuery):Promise<DataScope|null>{
 const row=(await c.query("SELECT * FROM company_data_scopes WHERE owner_id=$1 AND connector_id=$2 AND connection_binding=$3 AND template_key=$4 AND template_version=$5 AND template_hash=$6 AND contract_hash=$7 AND tool_schema_hash=$8 AND model_egress_allowed AND revoked_at IS NULL AND expires_at>clock_timestamp() AND window_from<=$9::timestamptz AND window_until>=$10::timestamptz AND $10::timestamptz<=clock_timestamp() AND extract(epoch FROM ($10::timestamptz-$9::timestamptz))*1000<=max_window_ms AND public.oa_company_data_template_is_active($4,$5)",[ctx.actorId,client.connectorId,client.connectionBinding,args.templateKey,args.templateVersion,dataTemplateHash(client.template(args.templateKey,args.templateVersion)),companyDataContractHash,client.inputSchemaHash,args.start,args.end])).rows[0];
 if(!row||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1)return null;const rowScope=dataRowScopeSchema.safeParse(row.row_scope);if(!rowScope.success)return null;
 return {id:row.id as string,version:Number(row.version),sourceRevision:row.source_revision as string,templateKey:row.template_key as string,templateVersion:row.template_version as string,templateHash:row.template_hash as string,rowScope:rowScope.data,schemaHash:row.tool_schema_hash as string,classification:row.classification as DataScope['classification'],expiresAt:(row.expires_at as Date).toISOString()};
}
function cachedSource(cached:unknown){if(cached==null)return null;const value=(cached as ToolResult).data;if(value===undefined)return null;const parsed=dataSourceReceiptSchema.safeParse((value as Record<string,unknown>)['source']);return parsed.success?parsed.data:undefined;}
async function localCurrent(c:pg.PoolClient,ctx:DbContext,lease:Lease,client:CompanyDataClient,args:DataQuery,cached:unknown):Promise<DataScope|null>{
 let template;try{template=client.template(args.templateKey,args.templateVersion);}catch{return null;}
 const scope=await scopeFor(c,ctx,client,args),receipt=cachedSource(cached);if(!scope||receipt===undefined)return null;
 if(receipt&&(receipt.scopeId!==scope.id||receipt.scopeVersion!==scope.version||receipt.sourceRevision!==scope.sourceRevision||receipt.templateKey!==args.templateKey||receipt.templateVersion!==args.templateVersion||receipt.templateHash!==scope.templateHash||Date.now()-Date.parse(receipt.observedAt)<0||Date.now()-Date.parse(receipt.observedAt)>template.quality.freshnessMaxMinutes*60000))return null;
 const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'],rank=levels.indexOf(scope.classification),grants=(await c.query("SELECT audience_kind,audience_id,membership_version,classification_ceiling FROM resource_grants WHERE actor_id=$1 AND capability_id='company.data.query' AND resource_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[ctx.actorId,dataResource(args)])).rows;
 if(rank<0||levels.indexOf(String(lease.audience['classificationCeiling']))<rank||!grants.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId&&levels.indexOf(g.classification_ceiling as string)>=rank))return null;
 if(lease.audience['kind']!=='PRIVATE_USER'&&!grants.some(g=>g.audience_kind==='GROUP'&&g.audience_id===lease.audience['targetId']&&Number(g.membership_version)===lease.audience['membershipVersion']&&levels.indexOf(g.classification_ceiling as string)>=rank))return null;return scope;
}
async function current(c:pg.PoolClient,ctx:DbContext,lease:Lease,client:CompanyDataClient,args:DataQuery,cached:unknown,signal:AbortSignal):Promise<DataScope|null>{
 const scope=await localCurrent(c,ctx,lease,client,args,cached);if(!scope)return null;
 try{
  const template=client.template(args.templateKey,args.templateVersion),{value,nonce}=await client.request(ctx,scope,'CHECK',dataWireArguments(template,client.templateMode,args),signal);
  parseDataCheckReply(value,{ctx,scope,template,nonce,query:args});if(signal.aborted)return null;const after=await localCurrent(c,ctx,lease,client,args,cached);return after&&!signal.aborted&&canonical(after)===canonical(scope)?after:null;
 }catch{return null;}
}
export function registerCompanyDataCapabilities(gateway:Gateway,client:CompanyDataClient):void{
 const cap:Capability={...companyDataResultContract,...reviewedCapability('company.data.query',`mcp:${client.connectorId}:${client.toolName}:${client.connectionBinding}`),id:'company.data.query',version:'1.0.0',description:'Execute one certified aggregate data template for the current tenant and actor through a reviewed company MCP data proxy. Results carry exact decimals, template/version provenance, time window, watermark and explicit completeness. Upstream template execution is UNVERIFIED until live certification; user input never selects raw SQL, tables or tenant scope.',provider:'MCP',connectorId:client.connectorId,risk:'READ',state:'READY',protectResult:true,retryableRead:true,schema:dataQuerySchema,jsonSchema:z.toJSONSchema(dataQuerySchema,{io:'input'}),bindingHash:companyDataBindingHash(client.connectorId,client.connectionBinding,client.toolName,client.inputSchemaHash,client.templates.registryHash),resource:a=>dataResource(a as DataQuery),classifyResult:r=>{const source=cachedSource(r);return source?source.classification:'RESTRICTED';},allowResource:async(a,{principal,lease,signal},c,cached)=>!!await current(c,principal,lease,client,a as DataQuery,cached,signal??new AbortController().signal),retainFact:async(a,{principal,lease},c,result)=>{if(!await current(c,principal,lease,client,a as DataQuery,result,new AbortController().signal))throw new CompanySourceError('COMPANY_DATA_SOURCE_CHANGED');},execute:async(a,{principal,signal})=>execute(gateway.store,client,principal,a as DataQuery,signal)};gateway.register(cap);
}
export function dataFailure(error:unknown):ToolResult{
 if(error instanceof CompanySourceError){const denied=['COMPANY_DATA_UPSTREAM_DENIED','COMPANY_DATA_TEMPLATE_UNKNOWN','COMPANY_DATA_TEMPLATE_NOT_CERTIFIED','COMPANY_DATA_TEMPLATE_MISMATCH','COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID','COMPANY_DATA_TEMPLATE_OPERATION_INVALID'].includes(error.code);return blocked(denied?'DENIED':'PERMANENT_ERROR',error.code);}
 return blocked('RETRYABLE_ERROR','COMPANY_DATA_TRANSPORT_UNAVAILABLE');
}
async function execute(store:RuntimeStore,client:CompanyDataClient,ctx:DbContext,args:DataQuery,signal:AbortSignal):Promise<ToolResult>{
 let scope:DataScope|null;try{scope=await store.db.scope(ctx,c=>scopeFor(c,ctx,client,args));}catch(error){return dataFailure(error);}if(!scope)return blocked('DENIED','COMPANY_DATA_SCOPE_UNAVAILABLE');
 try{return await executeDataQuery(client,ctx,scope,args,signal,record=>recordDataExecution(store.db,ctx,record));}
 catch(error){const result=dataFailure(error);try{await recordDataExecution(store.db,ctx,{templateKey:args.templateKey,templateVersion:args.templateVersion,paramsHash:dataParametersHash(args),queryId:null,status:result.status,watermark:null,observedAt:null,completeness:'UNKNOWN',rowCount:'0',evidenceRef:result.remediation?.kind??'COMPANY_DATA_FAILURE'});}catch{}return result;}
}
export async function executeDataQuery(client:CompanyDataClient,ctx:DbContext,scope:DataScope,args:DataQuery,signal:AbortSignal,audit:(record:DataExecutionAudit)=>Promise<void>):Promise<ToolResult>{
 const template:DataTemplate=client.template(args.templateKey,args.templateVersion);if(template.key!==scope.templateKey||template.version!==scope.templateVersion||dataTemplateHash(template)!==scope.templateHash)throw new CompanySourceError('COMPANY_DATA_TEMPLATE_MISMATCH');
 const reference=dataTemplateRef(template),{value,nonce}=await client.request(ctx,scope,'QUERY',dataWireArguments(template,client.templateMode,args),signal),reply=parseDataQueryReply(value,{ctx,scope,template,nonce,query:args}),result=reply.result,status=dataReplyStatus(reply);
 const source={scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,templateKey:template.key,templateVersion:template.version,templateHash:reference.hash,queryId:result.queryId,watermark:result.watermark,observedAt:result.observedAt,completeness:result.completeness,rowScopeHash:hash(canonical(scope.rowScope)),classification:scope.classification},query=dataCanonicalQuerySchema.parse(args),evidence=`company-data:${client.connectorId}:${result.queryId}`;
 const data={source,query,template:reference,queryId:result.queryId,watermark:result.watermark,observedAt:result.observedAt,completeness:result.completeness,window:result.window,rowScope:scope.rowScope,metrics:result.metrics,untrustedContent:true as const,upstreamCertification:'UNVERIFIED' as const};
 await audit({templateKey:template.key,templateVersion:template.version,paramsHash:dataParametersHash(args),queryId:result.queryId,status,watermark:result.watermark,observedAt:result.observedAt,completeness:result.completeness,rowCount:result.metrics.attempts,evidenceRef:evidence});
 return {status,data,evidenceIds:[evidence],externalRequestId:result.queryId,completeness:result.completeness,verification:{state:'VERIFIED',method:'CERTIFIED_DATA_TEMPLATE_CURRENT_ACTOR_UPSTREAM_AGGREGATE'}};
}
