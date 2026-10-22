import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataResultFlow,DataResultFailure,buildPendingDefinition,evaluateConclusion,matchCertifiedTemplate,pendingDefinitionElements} from '../../apps/web/src/data-result-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const queryId='60000000-0000-4000-8000-000000000001';
const templateKey='payments.success_rate_daily',templateHash='a'.repeat(64);
const now=Date.parse('2026-10-13T16:10:00.000Z');
const metrics={attempts:'11',successes:'7',successRate:'0.636363636363636364',byChannel:[{channel:'app',attempts:'8',successes:'5',successRate:'0.625'}]};
const result=(over:Record<string,unknown>={})=>({queryId,templateKey,templateVersion:'1.0.0',templateHash,window:{start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z',interval:'[start,end)'},completeness:'COMPLETE',watermark:'2026-10-13T16:00:00.000Z',observedAt:'2026-10-13T16:05:00.000Z',rowCount:'11',metrics,rowScope:{tenant_id:'A',department_id:'d_pay'},classification:'CONFIDENTIAL',status:'OK',evidenceRef:'company-data:synthetic:'+queryId,executedAt:'2026-10-13T16:06:00.000Z',upstreamCertification:'UNVERIFIED',...over});
const list=(items:unknown[]=[result()])=>({items,truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
const catalogItem=(over:Record<string,unknown>={})=>({templateKey,templateVersion:'1.0.0',templateHash,metricName:'支付成功率',grain:['business_date','channel'],numerator:'去重后成功的支付尝试数',denominator:'去重后全部有效支付尝试数',parameterNames:['channel','end','start'],freshnessMaxMinutes:60,classification:'CONFIDENTIAL',allowedRoles:['PAYMENTS_ANALYST'],maxWindowDays:31,certificationReference:'LOCAL_TEMPLATE_CERTIFICATION_20261013',active:true,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false,...over});
const catalog=(items:unknown[]=[catalogItem()])=>({items,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});

test('malformed, contradictory or uncertified result lists and catalogs are refused without retaining metadata',async()=>{
 const badLists=[{...list(),platformCertification:'LIVE'},{...list(),liveVerified:true},{...list(),truncated:'no'},{...list(),items:[result(),result()]},{...list(),items:[result({rowCount:'10'})]},{...list(),items:[result({watermark:'2026-10-13T16:06:00.000Z',observedAt:'2026-10-13T16:05:00.000Z'})]},{...list(),items:[result({window:{start:'2026-10-13T16:00:00.000Z',end:'2026-10-12T16:00:00.000Z',interval:'[start,end)'}})]},{...list(),items:[result({queryId:'not-a-uuid'})]},{...list(),items:[result({upstreamCertification:'VERIFIED'})]},{...list(),items:[result({rowScope:{}})]},{...list(),items:[result({metrics:{attempts:'11',successes:'7',successRate:'0.63x',byChannel:[]}})]},{...list(),items:[result({status:'UNKNOWN'})]},null];
 for(const value of badLists){const flow=new DataResultFlow(async()=>value,()=>now);const outcome=await flow.load();assert.equal(outcome?.ok,false);assert.deepEqual(flow.results,[]);assert.deepEqual(flow.catalog,[]);assert.equal(flow.truncated,false);}
 const badCatalogs=[{...catalog(),platformCertification:'LIVE'},{...catalog(),liveVerified:true},{...catalog(),items:[catalogItem({freshnessMaxMinutes:0})]},{...catalog(),items:[catalogItem({metricName:''})]},{...catalog(),items:[catalogItem({templateVersion:'1.0'})]},{...catalog(),items:[catalogItem({active:'yes'})]},null];
 for(const value of badCatalogs){const flow=new DataResultFlow(async path=>path==='/data/results'?list():value,()=>now);const outcome=await flow.load();assert.equal(outcome?.ok,false);assert.deepEqual(flow.results,[]);assert.deepEqual(flow.catalog,[]);}
});

test('a complete result inside the freshness limit may carry an overall conclusion',async()=>{
 const flow=new DataResultFlow(async path=>path==='/data/results'?list():catalog(),()=>now);const outcome=await flow.load();
 assert.equal(outcome?.ok,true);assert.equal(flow.results.length,1);const conclusion=flow.conclusion(flow.results[0]!);
 assert.equal(conclusion.allowed,true);assert.deepEqual(conclusion.reasons,[]);assert.equal(conclusion.lagMinutes,10);assert.equal(conclusion.limitMinutes,60);
});

test('T091 component: a truncated result never produces an overall conclusion and still shows scope and freshness',async()=>{
 const flow=new DataResultFlow(async path=>path==='/data/results'?list([result({completeness:'TRUNCATED',status:'PARTIAL'})]):catalog(),()=>now);await flow.load();
 const conclusion=flow.conclusion(flow.results[0]!);
 assert.equal(conclusion.allowed,false);assert.match(conclusion.reasons.join('；'),/截断/);assert.equal(flow.results[0]!.rowScope['department_id'],'d_pay');assert.equal(flow.results[0]!.window.end,'2026-10-13T16:00:00.000Z');
});

test('T091 component: a watermark lagging beyond the allowed freshness never produces an overall conclusion',async()=>{
 const stale=result({watermark:'2026-10-12T16:00:00.000Z',observedAt:'2026-10-12T16:05:00.000Z'});
 const flow=new DataResultFlow(async path=>path==='/data/results'?list([stale]):catalog(),()=>now);await flow.load();
 const conclusion=flow.conclusion(flow.results[0]!);
 assert.equal(conclusion.allowed,false);assert.match(conclusion.reasons.join('；'),/水位落后/);assert.ok(conclusion.lagMinutes>1440);
 const capped=evaluateConclusion(flow.results[0]!,[],now);assert.equal(capped.limitMinutes,1440);assert.equal(capped.allowed,false);
});

test('T095 component: a question without any certified template yields a pending definition that carries no numbers',async()=>{
 const flow=new DataResultFlow(async path=>path==='/data/results'?list():catalog(),()=>now);await flow.load();
 const outcome=flow.preparePending('上月退款金额是多少');
 assert.equal(outcome.ok,false);assert.equal(flow.pending?.state,'PENDING_DEVELOPMENT');assert.deepEqual(flow.pending?.requiredElements,pendingDefinitionElements);
 const text=JSON.stringify(flow.pending);assert.doesNotMatch(text,/\d/);assert.equal(flow.covered,null);
 assert.equal(matchCertifiedTemplate('上月退款金额是多少',flow.catalog),null);
});

test('a question naming a certified metric is answered from the catalog without a pending draft',async()=>{
 const flow=new DataResultFlow(async path=>path==='/data/results'?list():catalog(),()=>now);await flow.load();
 const outcome=flow.preparePending('本月的支付成功率是多少');
 assert.equal(outcome.ok,true);assert.equal(flow.pending,null);assert.equal(flow.covered?.metricName,'支付成功率');assert.match(outcome.notice,/支付成功率/);
 assert.equal(matchCertifiedTemplate('payments success rate daily',flow.catalog)?.templateKey,templateKey);
});

test('the pending definition draft is reproducible and never states a statistic',()=>{
 const draft=buildPendingDefinition('上月退款金额是多少');
 assert.equal(draft.state,'PENDING_DEVELOPMENT');assert.equal(draft.question,'上月退款金额是多少');
 assert.ok(draft.requiredElements.length>=5);assert.doesNotMatch(JSON.stringify(draft),/\d/);
});

test('an unavailable catalog or result service clears every datum and never keeps a conclusion',async()=>{
 for(const error of [new DataResultFailure(401),new DataResultFailure(403),new DataResultFailure(503),new Error('SYNTHETIC_PRIVATE_DATA_DRIVER_ERROR')]){
  const flow=new DataResultFlow(async path=>{if(path==='/data/catalog')throw error;return list();},()=>now);const outcome=await flow.load();
  assert.equal(outcome?.ok,false);assert.doesNotMatch(outcome!.notice,/SYNTHETIC_PRIVATE_DATA_DRIVER_ERROR/);assert.deepEqual(flow.results,[]);assert.deepEqual(flow.catalog,[]);
 }
 const lost=new DataResultFlow(async()=>{throw new DataResultFailure(401);},()=>now);assert.equal((await lost.load())?.sessionLost,true);
});

test('clearing the flow discards a late reply and keeps the view empty',async()=>{
 let resolve!:(value:unknown)=>void;const flow=new DataResultFlow(async()=>new Promise(r=>{resolve=r;}),()=>now);const pending=flow.load();flow.clear();resolve(list());assert.equal(await pending,null);assert.deepEqual(flow.results,[]);
});
