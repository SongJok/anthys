export type DataChannelMetric={channel:'app'|'web';attempts:string;successes:string;successRate:string|null};
export type DataMetrics={attempts:string;successes:string;successRate:string|null;byChannel:DataChannelMetric[]};
export type CertifiedDataResult={
 queryId:string;templateKey:string;templateVersion:string;templateHash:string;
 window:{start:string;end:string;interval:'[start,end)'};completeness:'COMPLETE'|'TRUNCATED'|'SAMPLED';
 watermark:string;observedAt:string;rowCount:string;metrics:DataMetrics;rowScope:Record<string,string>;
 classification:'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED';status:'OK'|'PARTIAL'|'EMPTY';
 evidenceRef:string;executedAt:string;upstreamCertification:'UNVERIFIED';
};
export type CertifiedDataCatalogItem={
 templateKey:string;templateVersion:string;templateHash:string;metricName:string;grain:string[];
 numerator:string;denominator:string;parameterNames:string[];freshnessMaxMinutes:number;
 classification:'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED';allowedRoles:string[];maxWindowDays:number;
 certificationReference:string;active:boolean;platformCertification:'LOCAL_GOLDEN_ONLY';liveVerified:false;
};
export type DataConclusion={allowed:boolean;reasons:string[];lagMinutes:number;limitMinutes:number};
export type PendingDefinition={question:string;state:'PENDING_DEVELOPMENT';requiredElements:string[]};
export type DataResultTransport=(path:string)=>Promise<unknown>;
export class DataResultFailure extends Error{constructor(readonly status:number){super('DATA_RESULT_REQUEST_FAILED');}}
type Outcome={ok:boolean;notice:string;sessionLost?:boolean};
const keyPattern=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/,versionPattern=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/,hashPattern=/^[a-f0-9]{64}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const countPattern=/^(0|[1-9]\d{0,17})$/,ratePattern=/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/;
const instantPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_DATA_RESULT');return value as Record<string,unknown>;}
const isKey=(value:unknown):value is string=>typeof value==='string'&&keyPattern.test(value);
const isVersion=(value:unknown):value is string=>typeof value==='string'&&versionPattern.test(value);
const isHash=(value:unknown):value is string=>typeof value==='string'&&hashPattern.test(value);
const isUuid=(value:unknown):value is string=>typeof value==='string'&&uuidPattern.test(value);
const isCount=(value:unknown):value is string=>typeof value==='string'&&countPattern.test(value);
const isRate=(value:unknown):value is string=>typeof value==='string'&&ratePattern.test(value);
const isInstant=(value:unknown):value is string=>typeof value==='string'&&instantPattern.test(value)&&Number.isFinite(Date.parse(value));
function parseMetrics(raw:unknown):DataMetrics{
 const v=object(raw);
 if(!isCount(v['attempts'])||!isCount(v['successes'])||(v['successRate']!==null&&!isRate(v['successRate'])))throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['byChannel'])||v['byChannel'].length>16)throw Error('INVALID_DATA_RESULT');
 const byChannel=v['byChannel'].map(entry=>{const c=object(entry);if((c['channel']!=='app'&&c['channel']!=='web')||!isCount(c['attempts'])||!isCount(c['successes'])||(c['successRate']!==null&&!isRate(c['successRate'])))throw Error('INVALID_DATA_RESULT');return {channel:c['channel'] as 'app'|'web',attempts:c['attempts'],successes:c['successes'],successRate:c['successRate'] as string|null};});
 return {attempts:v['attempts'],successes:v['successes'],successRate:v['successRate'] as string|null,byChannel};
}
function parseResult(raw:unknown):CertifiedDataResult{
 const v=object(raw),window=object(v['window']),scope=object(v['rowScope']);
 if(!isUuid(v['queryId'])||!isKey(v['templateKey'])||!isVersion(v['templateVersion'])||!isHash(v['templateHash']))throw Error('INVALID_DATA_RESULT');
 if(!isInstant(window['start'])||!isInstant(window['end'])||window['interval']!=='[start,end)'||Date.parse(window['end'])<=Date.parse(window['start']))throw Error('INVALID_DATA_RESULT');
 if(v['completeness']!=='COMPLETE'&&v['completeness']!=='TRUNCATED'&&v['completeness']!=='SAMPLED')throw Error('INVALID_DATA_RESULT');
 if(!isInstant(v['watermark'])||!isInstant(v['observedAt'])||Date.parse(v['watermark'])>Date.parse(v['observedAt']))throw Error('INVALID_DATA_RESULT');
 if(!isCount(v['rowCount'])||v['rowCount']!==parseMetrics(v['metrics']).attempts)throw Error('INVALID_DATA_RESULT');
 if(v['status']!=='OK'&&v['status']!=='PARTIAL'&&v['status']!=='EMPTY')throw Error('INVALID_DATA_RESULT');
 if(v['classification']!=='PUBLIC'&&v['classification']!=='INTERNAL'&&v['classification']!=='CONFIDENTIAL'&&v['classification']!=='RESTRICTED')throw Error('INVALID_DATA_RESULT');
 if(typeof v['evidenceRef']!=='string'||v['evidenceRef'].length<1||v['evidenceRef'].length>2048||!isInstant(v['executedAt']))throw Error('INVALID_DATA_RESULT');
 if(v['upstreamCertification']!=='UNVERIFIED')throw Error('INVALID_DATA_RESULT');
 const rowScope:Record<string,string>={};
 for(const [name,value] of Object.entries(scope)){if(!/^[a-z][a-z0-9_]{0,63}$/.test(name)||typeof value!=='string'||value.length<1||value.length>256)throw Error('INVALID_DATA_RESULT');rowScope[name]=value;}
 if(Object.keys(rowScope).length<1||Object.keys(rowScope).length>16)throw Error('INVALID_DATA_RESULT');
 return {queryId:v['queryId'],templateKey:v['templateKey'],templateVersion:v['templateVersion'],templateHash:v['templateHash'],window:{start:window['start'],end:window['end'],interval:'[start,end)'},completeness:v['completeness'],watermark:v['watermark'],observedAt:v['observedAt'],rowCount:v['rowCount'],metrics:parseMetrics(v['metrics']),rowScope,classification:v['classification'],status:v['status'],evidenceRef:v['evidenceRef'],executedAt:v['executedAt'],upstreamCertification:'UNVERIFIED'};
}
function parseCatalogItem(raw:unknown):CertifiedDataCatalogItem{
 const v=object(raw);
 if(!isKey(v['templateKey'])||!isVersion(v['templateVersion'])||!isHash(v['templateHash']))throw Error('INVALID_DATA_RESULT');
 if(typeof v['metricName']!=='string'||v['metricName'].length<1||v['metricName'].length>128)throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['grain'])||v['grain'].length<1||v['grain'].length>4||v['grain'].some(grain=>typeof grain!=='string'||grain.length<1||grain.length>64))throw Error('INVALID_DATA_RESULT');
 if(typeof v['numerator']!=='string'||!v['numerator']||typeof v['denominator']!=='string'||!v['denominator'])throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['parameterNames'])||v['parameterNames'].length<1||v['parameterNames'].length>8||v['parameterNames'].some(name=>typeof name!=='string'||!name||name.length>64))throw Error('INVALID_DATA_RESULT');
 if(!Number.isSafeInteger(v['freshnessMaxMinutes'])||(v['freshnessMaxMinutes'] as number)<1||(v['freshnessMaxMinutes'] as number)>1440)throw Error('INVALID_DATA_RESULT');
 if(typeof v['maxWindowDays']!=='number'||!Number.isSafeInteger(v['maxWindowDays'])||v['maxWindowDays']<1||v['maxWindowDays']>31)throw Error('INVALID_DATA_RESULT');
 if(typeof v['certificationReference']!=='string'||!v['certificationReference']||v['certificationReference'].length>255)throw Error('INVALID_DATA_RESULT');
 if(typeof v['active']!=='boolean'||v['platformCertification']!=='LOCAL_GOLDEN_ONLY'||v['liveVerified']!==false)throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['allowedRoles'])||v['allowedRoles'].length<1||v['allowedRoles'].length>16||v['allowedRoles'].some(role=>typeof role!=='string'||!role||role.length>64))throw Error('INVALID_DATA_RESULT');
 if(v['classification']!=='PUBLIC'&&v['classification']!=='INTERNAL'&&v['classification']!=='CONFIDENTIAL'&&v['classification']!=='RESTRICTED')throw Error('INVALID_DATA_RESULT');
 return {templateKey:v['templateKey'],templateVersion:v['templateVersion'],templateHash:v['templateHash'],metricName:v['metricName'],grain:v['grain'] as string[],numerator:v['numerator'],denominator:v['denominator'],parameterNames:v['parameterNames'] as string[],freshnessMaxMinutes:v['freshnessMaxMinutes'] as number,classification:v['classification'],allowedRoles:v['allowedRoles'] as string[],maxWindowDays:v['maxWindowDays'] as number,certificationReference:v['certificationReference'],active:v['active'],platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false};
}
function parseResultList(raw:unknown):{items:CertifiedDataResult[];truncated:boolean}{
 const v=object(raw);
 if(v['platformCertification']!=='LOCAL_GOLDEN_ONLY'||v['liveVerified']!==false||typeof v['truncated']!=='boolean')throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['items'])||v['items'].length>50)throw Error('INVALID_DATA_RESULT');
 const items=v['items'].map(parseResult);
 if(new Set(items.map(item=>item.queryId)).size!==items.length)throw Error('INVALID_DATA_RESULT');
 return {items,truncated:v['truncated']};
}
function parseCatalog(raw:unknown):CertifiedDataCatalogItem[]{
 const v=object(raw);
 if(v['platformCertification']!=='LOCAL_GOLDEN_ONLY'||v['liveVerified']!==false)throw Error('INVALID_DATA_RESULT');
 if(!Array.isArray(v['items'])||v['items'].length>64)throw Error('INVALID_DATA_RESULT');
 return v['items'].map(parseCatalogItem);
}
const normalize=(value:string)=>value.toLowerCase().replace(/[\s_\-./,，。]+/g,'');
// A question is covered only when a certified metric or template identifier is
// named in it. Nothing else is treated as an available statistic.
export function matchCertifiedTemplate(question:string,catalog:CertifiedDataCatalogItem[]):CertifiedDataCatalogItem|null{
 const text=normalize(question);
 if(!text)return null;
 for(const item of catalog){
  if(text.includes(normalize(item.metricName))||text.includes(normalize(item.templateKey)))return item;
  const tokens=item.templateKey.split(/[._]/).filter(token=>token.length>1);
  if(tokens.length>1&&tokens.every(token=>text.includes(token)))return item;
 }
 return null;
}
export const pendingDefinitionElements=['统计对象与口径边界','分子与分母定义','去重与有效性规则','时间粒度与时区','数据新鲜度上限','数据分类与允许角色','认证凭据与金标用例'];
// The draft states what still has to be defined. It never carries numbers.
export function buildPendingDefinition(question:string):PendingDefinition{
 return {question:question.trim(),state:'PENDING_DEVELOPMENT',requiredElements:[...pendingDefinitionElements]};
}
export function evaluateConclusion(result:CertifiedDataResult,catalog:CertifiedDataCatalogItem[],now:number):DataConclusion{
 const item=catalog.find(entry=>entry.templateKey===result.templateKey&&entry.templateVersion===result.templateVersion);
 const limit=Math.min(1440,item?.freshnessMaxMinutes??1440);
 const lag=Math.max(0,Math.floor((now-Date.parse(result.watermark))/60000));
 const reasons:string[]=[];
 if(result.completeness==='TRUNCATED')reasons.push('上游结果被截断，统计口径未覆盖全部行');
 if(result.completeness==='SAMPLED')reasons.push('上游结果为抽样，不能代表总体');
 if(result.status!=='OK')reasons.push('本次执行未返回完整结果');
 if(lag>limit)reasons.push(`数据水位落后 ${lag} 分钟，超过允许上限 ${limit} 分钟`);
 return {allowed:reasons.length===0,reasons,lagMinutes:lag,limitMinutes:limit};
}
function failure(error:unknown):Outcome{
 const status=error instanceof DataResultFailure?error.status:0;
 if(status===401)return {ok:false,sessionLost:true,notice:'会话已失效，请重新登录后查看认证数据结果。'};
 if(status===403)return {ok:false,notice:'当前范围未满足查看认证数据结果的条件。'};
 if(status===503)return {ok:false,notice:'认证数据结果服务暂不可用，结果尚未核实。'};
 return {ok:false,notice:'认证数据结果未能核实，旧资料已清除；请重新加载。'};
}
export class DataResultFlow{
 results:CertifiedDataResult[]=[];
 catalog:CertifiedDataCatalogItem[]=[];
 truncated=false;
 pending:PendingDefinition|null=null;
 covered:CertifiedDataCatalogItem|null=null;
 private pendingBusy=false;
 private generation=0;
 constructor(private transport:DataResultTransport,private now:()=>number=()=>Date.now()){}
 get busy(){return this.pendingBusy;}
 private erase(){this.results=[];this.catalog=[];this.truncated=false;this.pending=null;this.covered=null;}
 clear(){this.generation++;this.pendingBusy=false;this.erase();}
 async load():Promise<Outcome|null>{
  if(this.pendingBusy)return null;
  this.erase();this.pendingBusy=true;const generation=++this.generation;
  try{
   const rawResults=await this.transport('/data/results');
   if(generation!==this.generation)return null;
   const rawCatalog=await this.transport('/data/catalog');
   if(generation!==this.generation)return null;
   const listed=parseResultList(rawResults),catalog=parseCatalog(rawCatalog);
   this.results=listed.items;this.truncated=listed.truncated;this.catalog=catalog;
   return {ok:true,notice:'仅展示本账号已执行并留痕的认证口径结果；平台认证与真实数据尚未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pendingBusy=false;}
 }
 conclusion(result:CertifiedDataResult):DataConclusion{return evaluateConclusion(result,this.catalog,this.now());}
 preparePending(question:string):Outcome{
  this.pending=null;this.covered=null;
  const text=question.trim();
  if(this.pendingBusy||text.length<2||text.length>500)return {ok:false,notice:'请填写 2 到 500 字以内的业务问题。'};
  const item=matchCertifiedTemplate(text,this.catalog);
  if(item){this.covered=item;return {ok:true,notice:`该问题有已认证口径：${item.metricName}（模板版本 ${item.templateVersion}）。请通过任务流程执行，页面不会另行统计。`};}
  this.pending=buildPendingDefinition(text);
  return {ok:false,notice:'当前没有任何认证模板覆盖该问题，不能直接统计；已生成待开发口径要素，不含任何数字。'};
 }
}
