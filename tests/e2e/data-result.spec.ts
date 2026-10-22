import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test.skip(!process.env['DATA_RESULT_BUNDLE'],'Use the dedicated offline real-component bundle, with no backend setup.');
const secret='SYNTHETIC_PRIVATE_DATA_RESULT_DO_NOT_RENDER';
const templateKey='payments.success_rate_daily',templateHash='a'.repeat(64);
const queryId='60000000-0000-4000-8000-000000000001';
const instant=(minutes:number)=>new Date(Date.now()-minutes*60000).toISOString();
const metrics={attempts:'11',successes:'7',successRate:'0.636363636363636364',byChannel:[{channel:'app',attempts:'8',successes:'5',successRate:'0.625'}]};
const result=(over:Record<string,unknown>={})=>({queryId,templateKey,templateVersion:'1.0.0',templateHash,window:{start:instant(1500),end:instant(60),interval:'[start,end)'},completeness:'COMPLETE',watermark:instant(5),observedAt:instant(0),rowCount:'11',metrics,rowScope:{tenant_id:'A',department_id:'d_pay'},classification:'CONFIDENTIAL',status:'OK',evidenceRef:'company-data:synthetic:'+queryId,executedAt:instant(0),upstreamCertification:'UNVERIFIED',...over});
const list=(items:unknown[]=[result()])=>({items,truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
const catalog=(items:unknown[]=[{templateKey,templateVersion:'1.0.0',templateHash,metricName:'支付成功率',grain:['business_date','channel'],numerator:'去重后成功的支付尝试数',denominator:'去重后全部有效支付尝试数',parameterNames:['channel','end','start'],freshnessMaxMinutes:60,classification:'CONFIDENTIAL',allowedRoles:['PAYMENTS_ANALYST'],maxWindowDays:31,certificationReference:'LOCAL_TEMPLATE_CERTIFICATION_20261013',active:true,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false}])=>({items,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
type Scenario={results?:unknown;catalog?:unknown;resultStatus?:number;catalogStatus?:number;resultAbort?:boolean};
async function mount(page:Page,scenario:Scenario={}){
 const calls:string[]=[],unexpected:string[]=[];
 const bundle=await readFile(process.env['DATA_RESULT_BUNDLE']!,'utf8');
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!=='http://127.0.0.1:64702'){unexpected.push(url.origin);return route.abort('blockedbyclient');}
  if(path==='/data-result')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>'});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(path==='/api/v1/data/results'){
   calls.push(path+url.search);
   if(scenario.resultAbort)return route.abort('failed');
   return route.fulfill({status:scenario.resultStatus??200,json:scenario.resultStatus?{error:{code:'DATA_RESULTS_UNAVAILABLE',correlationId:secret},private:secret}:{data:scenario.results??list()}});
  }
  if(path==='/api/v1/data/catalog'){
   calls.push(path+url.search);
   return route.fulfill({status:scenario.catalogStatus??200,json:scenario.catalogStatus?{error:{code:'DATA_RESULTS_UNAVAILABLE',correlationId:secret},private:secret}:{data:scenario.catalog??catalog()}});
  }
  unexpected.push(path);return route.abort('blockedbyclient');
 });
 await page.goto('http://127.0.0.1:64702/data-result');
 return {calls,unexpected};
}
const area=(page:Page)=>page.getByRole('region',{name:'认证数据结果',exact:true});
const article=(page:Page)=>area(page).getByRole('article',{name:'数据结果 '+queryId});
async function ask(page:Page,question:string){await area(page).getByLabel('业务问题',{exact:true}).fill(question);await area(page).getByRole('button',{name:'核对口径',exact:true}).click();}
async function safe(page:Page){expect(await page.content()).not.toContain(secret);}

test('a complete and fresh result shows scope, freshness and an overall conclusion',async({page})=>{
 const {calls,unexpected}=await mount(page);const item=article(page);await expect(item).toBeVisible();
 await expect(item).toContainText('模板：payments.success_rate_daily@1.0.0');
 await expect(item).toContainText('口径：支付成功率');
 await expect(item).toContainText('行范围：tenant_id=A、department_id=d_pay');
 await expect(item).toContainText('截断状态：完整');
 await expect(item).toContainText('落后 5 分钟（允许上限 60 分钟）');
 await expect(item).toContainText('总体结论：');
 await expect(item).toContainText('成功 7 / 尝试 11');
 expect(calls).toEqual(['/api/v1/data/results','/api/v1/data/catalog']);expect(unexpected).toEqual([]);await safe(page);
});

test('T091 browser: a truncated result refuses an overall conclusion and still shows scope and freshness',async({page})=>{
 await mount(page,{results:list([result({completeness:'TRUNCATED',status:'PARTIAL'})])});const item=article(page);
 await expect(item).toContainText('不能据此给出总体确定结论');
 await expect(item).toContainText('上游结果被截断');
 await expect(item).not.toContainText('总体结论：');
 await expect(item).toContainText('行范围：tenant_id=A、department_id=d_pay');
 await expect(item).toContainText('截断状态：已截断');
 await safe(page);
});

test('T091 browser: a watermark lagging more than 24 hours refuses an overall conclusion',async({page})=>{
 await mount(page,{results:list([result({watermark:instant(60*24*3),observedAt:instant(60*24*3-1)})])});const item=article(page);
 await expect(item).toContainText('不能据此给出总体确定结论');
 await expect(item).toContainText('水位落后');
 await expect(item).not.toContainText('总体结论：');
 await expect(item).toContainText('数据新鲜度：');
 await safe(page);
});

test('the certified catalog shows local certification, definitions and freshness limits only',async({page})=>{
 await mount(page);const catalogArea=area(page).getByRole('region',{name:'认证口径目录',exact:true});
 await expect(catalogArea.getByRole('article',{name:'口径 payments.success_rate_daily@1.0.0'})).toBeVisible();
 await expect(catalogArea).toContainText('分子：去重后成功的支付尝试数');
 await expect(catalogArea).toContainText('新鲜度上限：60 分钟');
 await expect(catalogArea).toContainText('仅本地认证');
 await expect(catalogArea).toContainText('平台认证与真实数据尚未核实');
 await safe(page);
});

test('T095 browser: a question without any certified template yields a pending definition that states no number',async({page})=>{
 await mount(page);await ask(page,'上月退款金额是多少');const draft=area(page).getByRole('complementary',{name:'待开发口径'});
 await expect(draft).toBeVisible();await expect(draft).toContainText('不能直接统计');
 await expect(draft).toContainText('上月退款金额是多少');
 expect(await draft.textContent()).not.toMatch(/\d/);
 await expect(area(page).getByRole('complementary',{name:'已认证口径'})).toHaveCount(0);
 await expect(area(page).getByRole('status')).toContainText('不能直接统计');
 await safe(page);
});

test('a question naming a certified metric points to the certified definition without a pending draft',async({page})=>{
 await mount(page);await ask(page,'本月的支付成功率是多少');const covered=area(page).getByRole('complementary',{name:'已认证口径'});
 await expect(covered).toBeVisible();await expect(covered).toContainText('支付成功率');
 await expect(covered).toContainText('新鲜度上限 60 分钟');
 await expect(area(page).getByRole('complementary',{name:'待开发口径'})).toHaveCount(0);
 await safe(page);
});

test('401 clears every datum and requests session-lost handling',async({page})=>{
 await mount(page,{resultStatus:401});await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();
 await expect(area(page)).toHaveCount(0);expect(await page.evaluate(()=>Reflect.get(window,'sessionLosses'))).toBe(1);
 await safe(page);
});

test('malformed or uncertified payloads show no result and no private server text',async({page})=>{
 for(const scenario of [{results:list([result({upstreamCertification:'VERIFIED'})])},{results:list([result({rowCount:'10'})])},{results:{...list(),platformCertification:'LIVE'}},{catalog:{...catalog(),liveVerified:true}},{resultStatus:503},{catalogStatus:503},{resultAbort:true}] as Scenario[]){
  await mount(page,scenario);await expect(area(page).getByRole('status')).toContainText(/未能核实|暂不可用|未满足/);
  await expect(area(page).getByRole('article')).toHaveCount(0);await safe(page);
 }
});

test('a visibility change clears the loaded results and requires an explicit reload',async({page})=>{
 await mount(page);await expect(article(page)).toBeVisible();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await expect(article(page)).toHaveCount(0);await expect(area(page).getByRole('status')).toContainText('页面可见性已变化');
 await safe(page);
});
