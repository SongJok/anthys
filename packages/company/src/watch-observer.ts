import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
import {canonical} from '../../gateway/src/index.js';
import type {WatchObserver} from '../../watches/src/cycle.js';
import type {WatchPredicate} from '../../watches/src/predicate.js';
import {watchSchedulePolicySchema} from '../../watches/src/schedule-policy.js';
import {CompanyDataClient} from './data-client.js';
import {dataParametersHash,dataQuerySchema,dataResource,dataRowScopeSchema,dataWireArguments,parseDataCheckReply,type DataQuery,type DataScope} from './data-contracts.js';
import {executeDataQuery} from './data.js';
import {recordDataExecution} from './data-execution.js';
import {dataTemplateHash} from './data-templates.js';
import {parseExactCount} from './data-numeric.js';

export const watchSourceMetricSchema=z.enum(['attempts','successes','successRate']);
export type WatchSourceMetric=z.infer<typeof watchSourceMetricSchema>;
const bindInputSchema=z.object({watchId:z.uuid(),scopeId:z.uuid(),metric:watchSourceMetricSchema,windowSeconds:z.number().int().min(60).max(2678400)}).strict();
const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'] as const;
const digest=(value:unknown)=>createHash('sha256').update('anthys.watch.source.v1\0'+canonical(value)).digest('hex');

type WindowBound=Readonly<{windowFrom:number;windowUntil:number;maxWindowMs:number;dbNow:number}>;
type Authority=WindowBound&Readonly<{
 policyHash:string;templateKey:string;templateVersion:string;templateHash:string;
 metric:WatchSourceMetric;windowSeconds:number;scope:DataScope;
}>;
type SourceRow=Record<string,unknown>;

/** The pure predicate can order safe integers only. Rate equality is exact
 * decimal text; an ordered rate threshold is rejected at bind time instead of
 * producing a permanently UNKNOWN observation. */
function assertMetricPredicate(metric:WatchSourceMetric,predicate:WatchPredicate):void{
 if(metric==='successRate'){
  if(typeof predicate.expected!=='string'||(predicate.operator!=='EQ'&&predicate.operator!=='NE'))throw Error('WATCH_SOURCE_METRIC_PREDICATE_MISMATCH');
 }else if(typeof predicate.expected!=='number')throw Error('WATCH_SOURCE_METRIC_PREDICATE_MISMATCH');
}
function scopeFromRow(row:SourceRow):DataScope{
 const rowScope=dataRowScopeSchema.safeParse(row['scope_row_scope']),classification=row['scope_classification'] as DataScope['classification'];
 if(!rowScope.success||!levels.includes(classification))throw Error('WATCH_SOURCE_SCOPE_INVALID');
 return Object.freeze({id:String(row['scope_live_id']),version:Number(row['scope_live_version']),sourceRevision:String(row['scope_source_revision']),templateKey:String(row['scope_template_key']),templateVersion:String(row['scope_template_version']),templateHash:String(row['scope_template_hash']),rowScope:rowScope.data,schemaHash:String(row['scope_schema_hash']),classification,expiresAt:new Date(row['scope_expires_at'] as string|Date).toISOString()});
}
async function assertGrant(c:{query:(text:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},ctx:DbContext,scope:DataScope):Promise<void>{
 const rank=levels.indexOf(scope.classification),grants=(await c.query("SELECT audience_kind,audience_id,classification_ceiling FROM resource_grants WHERE actor_id=$1 AND capability_id='company.data.query' AND resource_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[ctx.actorId,dataResource(scope)])).rows;
 if(rank<0||!grants.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId&&levels.indexOf(g.classification_ceiling as typeof levels[number])>=rank))throw Error('WATCH_SOURCE_UNAUTHORIZED');
}
function coverage(input:WindowBound&{templateKey:string;templateVersion:string;windowSeconds:number},endMs:number):DataQuery{
 const windowMs=input.windowSeconds*1000,startMs=endMs-windowMs;
 if(!Number.isSafeInteger(endMs)||!Number.isSafeInteger(startMs)||windowMs>input.maxWindowMs||startMs<input.windowFrom||endMs>input.windowUntil||endMs>input.dbNow)throw Error('WATCH_SOURCE_WINDOW_UNAVAILABLE');
 return dataQuerySchema.parse({templateKey:input.templateKey,templateVersion:input.templateVersion,start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()});
}
const comparable=(a:Authority,query:DataQuery)=>({policyHash:a.policyHash,templateKey:a.templateKey,templateVersion:a.templateVersion,templateHash:a.templateHash,metric:a.metric,windowSeconds:a.windowSeconds,scope:a.scope,query});

/** A watch observation is one certified aggregate metric read through the same
 * reviewed company MCP data proxy used by company.data.query. Binding pins the
 * exact scope version; the observer rechecks live scope, grant, watch policy,
 * template and connection before and after the upstream CHECK. */
export class CompanyMcpWatchObserver implements WatchObserver{
 constructor(private readonly db:Database,private readonly client:CompanyDataClient,private readonly clock:()=>number=Date.now){}
 private async authority(ctx:DbContext,watchId:string,policyHash:string,predicate:WatchPredicate):Promise<Authority>{
  return this.db.scope(ctx,async c=>{
   const row=(await c.query(`SELECT s.scope_id,s.scope_version,s.connector_id,s.connection_binding,s.tool_name,s.tool_schema_hash,
     s.template_key,s.template_version,s.template_hash,s.metric,s.window_seconds,
     w.lifecycle watch_lifecycle,w.policy watch_policy,w.policy_hash watch_policy_hash,
     u.status user_status,t.status tenant_status,
     d.id scope_live_id,d.version scope_live_version,d.source_revision scope_source_revision,
     d.template_key scope_template_key,d.template_version scope_template_version,d.template_hash scope_template_hash,
     d.row_scope scope_row_scope,d.tool_schema_hash scope_schema_hash,d.classification scope_classification,
     d.expires_at scope_expires_at,d.revoked_at scope_revoked_at,d.window_from scope_window_from,d.window_until scope_window_until,
     d.max_window_ms scope_max_window_ms,clock_timestamp() db_now
     FROM condition_watch_sources s
     JOIN condition_watches w ON w.tenant_id=s.tenant_id AND w.id=s.watch_id
     JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id
     JOIN tenants t ON t.tenant_id=s.tenant_id
     JOIN company_data_scopes d ON d.tenant_id=s.tenant_id AND d.id=s.scope_id
     WHERE s.tenant_id=$1 AND s.owner_id=$2 AND s.watch_id=$3`,[ctx.tenantId,ctx.actorId,watchId])).rows[0] as SourceRow|undefined;
   if(!row)throw Error('WATCH_SOURCE_NOT_BOUND');
   if(row['user_status']!=='ACTIVE'||row['tenant_status']!=='ACTIVE')throw Error('WATCH_SOURCE_IDENTITY_INACTIVE');
   if(row['watch_lifecycle']!=='ACTIVE'||row['watch_policy_hash']!==policyHash)throw Error('WATCH_SOURCE_POLICY_CHANGED');
   const policy=(()=>{const parsed=watchSchedulePolicySchema.safeParse(row['watch_policy']);if(!parsed.success)throw Error('WATCH_SOURCE_POLICY_INVALID');return parsed.data;})();
   if(canonical(policy.predicate)!==canonical(predicate))throw Error('WATCH_SOURCE_POLICY_CHANGED');
   const metric=watchSourceMetricSchema.parse(row['metric']);
   assertMetricPredicate(metric,predicate);
   if(row['connector_id']!==this.client.connectorId||row['connection_binding']!==this.client.connectionBinding||row['tool_name']!==this.client.toolName||row['tool_schema_hash']!==this.client.inputSchemaHash)throw Error('WATCH_SOURCE_CONNECTION_CHANGED');
   const scope=scopeFromRow(row),scoped=this.client.template(String(row['template_key']),String(row['template_version'])),templateHash=dataTemplateHash(scoped);
   if(scope.id!==String(row['scope_id'])||scope.version!==Number(row['scope_version'])||scope.templateKey!==String(row['template_key'])||scope.templateVersion!==String(row['template_version'])||scope.templateHash!==String(row['template_hash'])||scope.templateHash!==templateHash||scope.schemaHash!==this.client.inputSchemaHash)throw Error('WATCH_SOURCE_SCOPE_CHANGED');
   const dbNow=new Date(row['db_now'] as string|Date).getTime(),expires=Date.parse(scope.expiresAt);
   if(row['scope_revoked_at']!==null||!Number.isFinite(dbNow)||!Number.isFinite(expires)||expires<=dbNow)throw Error('WATCH_SOURCE_SCOPE_EXPIRED');
   await assertGrant(c,ctx,scope);
   return Object.freeze({policyHash,templateKey:scope.templateKey,templateVersion:scope.templateVersion,templateHash,metric,windowSeconds:Number(row['window_seconds']),scope,windowFrom:Date.parse(new Date(row['scope_window_from'] as string|Date).toISOString()),windowUntil:Date.parse(new Date(row['scope_window_until'] as string|Date).toISOString()),maxWindowMs:Number(row['scope_max_window_ms']),dbNow});
  });
 }
 async bind(ctx:DbContext,input:{watchId:string;scopeId:string;metric:WatchSourceMetric;windowSeconds:number}):Promise<void>{
  const {watchId,scopeId,metric,windowSeconds}=bindInputSchema.parse(input);
  await this.db.scope(ctx,async c=>{
   const row=(await c.query(`SELECT w.lifecycle watch_lifecycle,w.policy watch_policy,w.policy_hash watch_policy_hash,
     u.status user_status,t.status tenant_status,
     d.id scope_live_id,d.version scope_live_version,d.source_revision scope_source_revision,
     d.template_key scope_template_key,d.template_version scope_template_version,d.template_hash scope_template_hash,
     d.row_scope scope_row_scope,d.tool_schema_hash scope_schema_hash,d.classification scope_classification,
     d.expires_at scope_expires_at,d.revoked_at scope_revoked_at,d.window_from scope_window_from,d.window_until scope_window_until,
     d.max_window_ms scope_max_window_ms,clock_timestamp() db_now
     FROM condition_watches w
     JOIN users u ON u.tenant_id=w.tenant_id AND u.id=w.owner_id
     JOIN tenants t ON t.tenant_id=w.tenant_id
     JOIN company_data_scopes d ON d.tenant_id=w.tenant_id AND d.id=$1
     WHERE w.tenant_id=$2 AND w.owner_id=$3 AND w.id=$4 AND d.owner_id=$3`,[scopeId,ctx.tenantId,ctx.actorId,watchId])).rows[0] as SourceRow|undefined;
   if(!row)throw Error('WATCH_SOURCE_TARGET_UNAVAILABLE');
   if(row['user_status']!=='ACTIVE'||row['tenant_status']!=='ACTIVE')throw Error('WATCH_SOURCE_IDENTITY_INACTIVE');
   if(row['watch_lifecycle']!=='ACTIVE')throw Error('WATCH_SOURCE_WATCH_INACTIVE');
   const policy=(()=>{const parsed=watchSchedulePolicySchema.safeParse(row['watch_policy']);if(!parsed.success)throw Error('WATCH_SOURCE_POLICY_INVALID');return parsed.data;})();
   assertMetricPredicate(metric,policy.predicate);
   const scope=scopeFromRow(row),template=this.client.template(scope.templateKey,scope.templateVersion);
   if(scope.templateHash!==dataTemplateHash(template)||scope.schemaHash!==this.client.inputSchemaHash)throw Error('WATCH_SOURCE_TEMPLATE_CHANGED');
   const dbNow=new Date(row['db_now'] as string|Date).getTime(),expires=Date.parse(scope.expiresAt);
   if(row['scope_revoked_at']!==null||!Number.isFinite(dbNow)||!Number.isFinite(expires)||expires<=dbNow)throw Error('WATCH_SOURCE_SCOPE_EXPIRED');
   await assertGrant(c,ctx,scope);
   coverage({templateKey:scope.templateKey,templateVersion:scope.templateVersion,windowSeconds,windowFrom:Date.parse(new Date(row['scope_window_from'] as string|Date).toISOString()),windowUntil:Date.parse(new Date(row['scope_window_until'] as string|Date).toISOString()),maxWindowMs:Number(row['scope_max_window_ms']),dbNow},Math.floor(this.clock()/1000)*1000);
   try{
    await c.query(`INSERT INTO condition_watch_sources(tenant_id,watch_id,owner_id,scope_id,scope_version,connector_id,connection_binding,tool_name,tool_schema_hash,template_key,template_version,template_hash,metric,window_seconds)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[ctx.tenantId,watchId,ctx.actorId,scope.id,scope.version,this.client.connectorId,this.client.connectionBinding,this.client.toolName,this.client.inputSchemaHash,scope.templateKey,scope.templateVersion,scope.templateHash,metric,windowSeconds]);
   }catch(error){if((error as {code?:string}).code==='23505')throw Error('WATCH_SOURCE_ALREADY_BOUND');throw error;}
  });
 }
 async observe(ctx:DbContext,input:Readonly<{watchId:string;policyHash:string;predicate:WatchPredicate}>,signal:AbortSignal):Promise<unknown>{
  signal.throwIfAborted();
  const first=await this.authority(ctx,input.watchId,input.policyHash,input.predicate),endMs=Math.floor(this.clock()/1000)*1000,args=coverage(first,endMs);
  signal.throwIfAborted();
  const template=this.client.template(first.templateKey,first.templateVersion),{value,nonce}=await this.client.request(ctx,first.scope,'CHECK',dataWireArguments(template,this.client.templateMode,args),signal);
  parseDataCheckReply(value,{ctx,scope:first.scope,template,nonce,query:args});
  signal.throwIfAborted();
  const second=await this.authority(ctx,input.watchId,input.policyHash,input.predicate),args2=coverage(second,endMs);
  if(canonical(comparable(first,args))!==canonical(comparable(second,args2)))throw Error('WATCH_SOURCE_CHANGED');
  let result;try{result=await executeDataQuery(this.client,ctx,second.scope,args2,signal,record=>recordDataExecution(this.db,ctx,record));}
  catch(error){try{await recordDataExecution(this.db,ctx,{templateKey:args2.templateKey,templateVersion:args2.templateVersion,paramsHash:dataParametersHash(args2),queryId:null,status:'RETRYABLE_ERROR',watermark:null,observedAt:null,completeness:'UNKNOWN',rowCount:'0',evidenceRef:'WATCH_SOURCE_FAILURE'});}catch{}throw error;}
  const data=result.data as {source:{scopeId:string;scopeVersion:number;sourceRevision:string;templateKey:string;templateVersion:string;templateHash:string;queryId:string;watermark:string;observedAt:string;completeness:string;rowScopeHash:string;classification:string};metrics:{attempts:string;successes:string;successRate:string|null}}|undefined;
  if(!data)throw Error('WATCH_SOURCE_RESULT_MISSING');
  const sourceHash=digest({...data.source,metric:second.metric});
  if(data.source.completeness!=='COMPLETE')return {schemaVersion:1 as const,state:'UNKNOWN' as const,reason:'INCOMPLETE_RESULT' as const,asOf:data.source.observedAt,sourceHash};
  const valueOf=data.metrics[second.metric];
  if(second.metric==='successRate'){
   if(valueOf===null)return {schemaVersion:1 as const,state:'UNKNOWN' as const,reason:'NOT_OBSERVED' as const,asOf:data.source.observedAt,sourceHash};
   return {schemaVersion:1 as const,state:'OBSERVED' as const,value:valueOf,asOf:data.source.observedAt,sourceHash};
  }
  const exact=BigInt(parseExactCount(valueOf));
  if(exact>BigInt(Number.MAX_SAFE_INTEGER))return {schemaVersion:1 as const,state:'UNKNOWN' as const,reason:'INCOMPLETE_RESULT' as const,asOf:data.source.observedAt,sourceHash};
  return {schemaVersion:1 as const,state:'OBSERVED' as const,value:Number(exact),asOf:data.source.observedAt,sourceHash};
 }
}
