import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CompanySourceError} from '../../packages/company/src/chat.js';
import {CompanyUpstreamError} from '../../packages/company/src/upstream-error.js';
import {companyDataContractHash,companyDataToolSchemaHash,dataQuerySchema,dataReplyStatus,dataTemplateRef,parseDataQueryReply,type DataQuery,type DataScope} from '../../packages/company/src/data-contracts.js';
import {dataFailure} from '../../packages/company/src/data.js';
import {dataTemplateHash,loadDataTemplates,requireDataTemplate,type DataTemplate} from '../../packages/company/src/data-templates.js';
const root=fileURLToPath(new URL('../..',import.meta.url)),ctx={tenantId:randomUUID(),actorId:randomUUID()},query:DataQuery=dataQuerySchema.parse({templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z'}),nonce=randomUUID();
let template:DataTemplate,scope:DataScope;
beforeAll(async()=>{template=requireDataTemplate(await loadDataTemplates(join(root,'config/data-templates')),query.templateKey,query.templateVersion);scope={id:randomUUID(),version:2,sourceRevision:'data-rev-1',templateKey:template.key,templateVersion:template.version,templateHash:dataTemplateHash(template),rowScope:{tenant_id:'A',department_id:'d_pay'},schemaHash:companyDataToolSchemaHash,classification:'CONFIDENTIAL',expiresAt:new Date(Date.now()+3600000).toISOString()};});
function expectation(channel?:'app'|'web'){return {ctx,scope,template,nonce,query:channel?{...query,channel}:query};}
function reply(observedAt=new Date().toISOString()){
 return {contractHash:companyDataContractHash,nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,template:dataTemplateRef(template),rowScope:scope.rowScope,operation:'QUERY' as const,result:{queryId:randomUUID(),window:{start:query.start,end:query.end,interval:'[start,end)' as const},watermark:observedAt,observedAt,completeness:'COMPLETE' as const,metrics:{attempts:'5',successes:'3',successRate:'0.6',byChannel:[{channel:'app' as const,attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web' as const,attempts:'2',successes:'1',successRate:'0.5'}]}}};
}
function rejection(run:()=>void,code:string):void{
 try{run();}catch(error){expect(error).toMatchObject({code});return;}throw Error('EXPECTED_'+code);
}
const zeroMetrics={attempts:'0',successes:'0',successRate:null,byChannel:[] as {channel:'app'|'web';attempts:string;successes:string;successRate:string|null}[]};
describe('T083/T084/T087 deterministic MCP data response mapping',()=>{
 it('maps COMPLETE, EMPTY, TRUNCATED and SAMPLED to distinct truthful results',()=>{
  const valid=parseDataQueryReply(reply(),expectation());
  expect(dataReplyStatus(valid)).toBe('OK');expect(valid.result.completeness).toBe('COMPLETE');
  const empty={...valid,result:{...valid.result,metrics:zeroMetrics}};expect(dataReplyStatus(empty)).toBe('EMPTY');expect(empty.result.metrics.successRate).toBeNull();
  const truncated={...valid,result:{...valid.result,completeness:'TRUNCATED' as const}};expect(dataReplyStatus(truncated)).toBe('PARTIAL');
  const sampled={...valid,result:{...valid.result,completeness:'SAMPLED' as const}};expect(dataReplyStatus(sampled)).toBe('PARTIAL');
  expect(new Set([dataReplyStatus(valid),dataReplyStatus(empty),dataReplyStatus(truncated)])).toEqual(new Set(['OK','EMPTY','PARTIAL']));
 });
 it('keeps DENIED, EMPTY and PARTIAL distinct at the deterministic failure boundary',()=>{
  expect(dataFailure(new CompanyUpstreamError({kind:'UNKNOWN'}))).toMatchObject({status:'DENIED',completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_ERROR_UNKNOWN'}});
  expect(dataFailure(new CompanyUpstreamError({kind:'MISSING_SCOPES',requiredScopes:['scope.a']}))).toMatchObject({status:'NEEDS_AUTH',remediation:{kind:'UPSTREAM_MISSING_SCOPES',requiredScopes:['scope.a']}});
  expect(dataFailure(new CompanySourceError('COMPANY_DATA_TEMPLATE_UNKNOWN'))).toMatchObject({status:'DENIED',remediation:{kind:'COMPANY_DATA_TEMPLATE_UNKNOWN'}});
  expect(dataFailure(new CompanySourceError('COMPANY_DATA_RESPONSE_INVALID'))).toMatchObject({status:'PERMANENT_ERROR',remediation:{kind:'COMPANY_DATA_RESPONSE_INVALID'}});
  expect(dataFailure(new Error('socket closed'))).toMatchObject({status:'RETRYABLE_ERROR',remediation:{kind:'COMPANY_DATA_TRANSPORT_UNAVAILABLE'}});
 });
 it('requires queryId, observedAt, watermark and a complete watermark for COMPLETE results',()=>{
  const missingQueryId=reply() as Record<string,unknown>,result=missingQueryId['result'] as Record<string,unknown>;delete result['queryId'];rejection(()=>parseDataQueryReply(missingQueryId,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  const wrongQueryId=structuredClone(reply());(wrongQueryId.result as unknown as Record<string,unknown>)['queryId']='not-a-uuid';rejection(()=>parseDataQueryReply(wrongQueryId,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  const missingWatermark=structuredClone(reply()) as unknown as {result:Record<string,unknown>};delete missingWatermark.result['watermark'];rejection(()=>parseDataQueryReply(missingWatermark,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  const ahead=structuredClone(reply());ahead.result.watermark=new Date(Date.parse(ahead.result.observedAt)+1000).toISOString();rejection(()=>parseDataQueryReply(ahead,expectation()),'COMPANY_DATA_OBSERVATION_INVALID');
  const stale=structuredClone(reply(new Date(Date.parse(query.end)-1000).toISOString()));rejection(()=>parseDataQueryReply(stale,expectation()),'COMPANY_DATA_OBSERVATION_INVALID');
  const incomplete=structuredClone(reply());incomplete.result.watermark=new Date(Date.parse(query.end)-1000).toISOString();incomplete.result.completeness='COMPLETE';rejection(()=>parseDataQueryReply(incomplete,expectation()),'COMPANY_DATA_WATERMARK_INCOMPLETE');
  const partial={...incomplete,result:{...incomplete.result,completeness:'TRUNCATED' as const}};expect(dataReplyStatus(parseDataQueryReply(partial,expectation()))).toBe('PARTIAL');
 });
 it('T085 rejects tenant, actor, scope, template, row-scope and window substitutions',()=>{
  const cases=[['tenantId',randomUUID()],['actorId',randomUUID()],['scopeId',randomUUID()],['sourceRevision','other-revision'],['nonce',randomUUID()],['contractHash','0'.repeat(64)],['scopeVersion',999]] as const;
  for(const [field,value] of cases){const bad=structuredClone(reply()) as unknown as Record<string,unknown>;bad[field]=value;rejection(()=>parseDataQueryReply(bad,expectation()),'COMPANY_DATA_RESPONSE_INVALID');}
  for(const mutate of [(value:ReturnType<typeof reply>)=>{value.template={...value.template,version:'1.0.1'};},(value:ReturnType<typeof reply>)=>{value.template={...value.template,hash:'f'.repeat(64)};},(value:ReturnType<typeof reply>)=>{value.rowScope={tenant_id:'A',department_id:'d_other'};},(value:ReturnType<typeof reply>)=>{value.rowScope={tenant_id:'B',department_id:'d_pay'};}]){
   const bad=structuredClone(reply());mutate(bad);rejection(()=>parseDataQueryReply(bad,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  }
  const shifted=structuredClone(reply());shifted.result.window.start='2026-10-12T15:59:59.000Z';rejection(()=>parseDataQueryReply(shifted,expectation()),'COMPANY_DATA_WINDOW_MISMATCH');
  const otherTemplate=structuredClone(reply());otherTemplate.template={key:'payments.other_template',version:'1.0.0',hash:dataTemplateHash(template)};rejection(()=>parseDataQueryReply(otherTemplate,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  rejection(()=>requireDataTemplate({templates:[template],byRef:new Map([[template.key+'@'+template.version,template]]),registryHash:'0'.repeat(64)},'payments.unknown','1.0.0'),'COMPANY_DATA_TEMPLATE_UNKNOWN');
 });
 it('rejects channel scope leaks, unknown fields and inconsistent exact metrics',()=>{
  rejection(()=>parseDataQueryReply(reply(),expectation('app')),'COMPANY_DATA_CHANNEL_SCOPE_MISMATCH');
  const extra=structuredClone(reply()) as unknown as Record<string,unknown>;extra['rawSecret']='SYNTHETIC_PRIVATE_DATA';rejection(()=>parseDataQueryReply(extra,expectation()),'COMPANY_DATA_RESPONSE_INVALID');
  for(const metrics of [
   {attempts:'5',successes:'3',successRate:'0.583333333333',byChannel:[{channel:'app',attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]},
   {attempts:'5',successes:'3',successRate:'0.6',byChannel:[{channel:'app',attempts:'2',successes:'2',successRate:'1'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]},
   {attempts:'2',successes:'3',successRate:'1.5',byChannel:[]},
   {attempts:'1',successes:'1',successRate:'1',byChannel:[{channel:'app',attempts:'1',successes:'1',successRate:'1'},{channel:'app',attempts:'0',successes:'0',successRate:null}]},
   {attempts:'9007199254740993',successes:'1',successRate:'0',byChannel:[]},
  ]){const bad=structuredClone(reply());bad.result.metrics=metrics as unknown as typeof bad.result.metrics;rejection(()=>parseDataQueryReply(bad,expectation()),'COMPANY_DATA_RESPONSE_INVALID');}
 });
});
