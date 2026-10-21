import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// This isolated spec needs a bundle of the real component, supplied by its offline launcher.
test.skip(!process.env['CONTROL_READBACK_BUNDLE'], 'Run with the dedicated offline component bundle and no backend setup.');

const actionId='10000000-0000-4000-8000-000000000001', caseId='20000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64), secret='SYNTHETIC_PRIVATE_PAYLOAD_MUST_NOT_RENDER';
const overview={tenantId:'synthetic-tenant',actorId:'synthetic-reviewer',scopes:[],switches:[],unknown:{items:[{id:actionId,capability_id:'synthetic.journal',state:'UNKNOWN',risk:'WRITE'}],nextCursor:null}};
const session=()=>({id:caseId,nonce:'synthetic-once',argsHash:hash,expiresAt:new Date(Date.now()+300000).toISOString(),action:{id:actionId,capability:'synthetic.journal',state:'UNKNOWN'},verification:'NO_AUTOMATIC_READ_BACK',retryAllowed:false});
const receipt=(state='VERIFIED_APPLIED')=>({id:caseId,state,verification:state==='INCONCLUSIVE'?'INCONCLUSIVE':'CERTIFIED_JOURNAL',retryAllowed:false,actionState:'UNKNOWN'});
type Call={path:string;body:unknown;csrf:string|undefined;origin:string|undefined};
type Scenario={begin?:unknown;beginStatus?:number;result?:unknown;status?:number;abort?:boolean;unauthorized?:boolean;hold?:Promise<void>};
async function mount(page:Page,scenario:Scenario={}){
 const calls:Call[]=[],unexpected:string[]=[];
 // Only a synthetic in-memory page and route replies. Never continue a network request.
 const bundle=await readFile(process.env['CONTROL_READBACK_BUNDLE']!,'utf8');
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(url.origin!=='http://127.0.0.1:64702'){unexpected.push(url.origin);return route.abort('blockedbyclient');}
  if(path==='/control-readback')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>'});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(path==='/api/v1/controls/overview')return route.fulfill({status:scenario.unauthorized?403:200,json:{data:scenario.unauthorized?{private:secret}:overview}});
  calls.push({path,body:request.postDataJSON(),csrf:request.headers()['x-csrf-token'],origin:request.headers()['origin']});
  if(path===`/api/v1/actions/${actionId}/reconciliation-sessions`)return route.fulfill({status:scenario.beginStatus??200,json:{data:scenario.begin??session()}});
  if(path===`/api/v1/reconciliations/${caseId}/read-back`){if(scenario.hold)await scenario.hold;if(scenario.abort)return route.abort('failed');return route.fulfill({status:scenario.status??200,json:{data:scenario.result??receipt(),private:secret}});}
  if(path===`/api/v1/reconciliations/${caseId}/attestation`)return route.fulfill({json:{data:{id:caseId,state:'MANUAL_APPLIED_UNVERIFIED',actionState:'APPLIED_UNVERIFIED',verification:'UNVERIFIED',retryAllowed:false}}});
  unexpected.push(path);return route.abort('blockedbyclient');
 });
 await page.goto('http://127.0.0.1:64702/control-readback');
 return {calls,unexpected};
}
async function begin(page:Page){await page.getByRole('button',{name:'核对此动作',exact:true}).click();}
const readButton=(page:Page)=>page.getByRole('button',{name:'请求认证只读核验',exact:true});
async function safePage(page:Page){expect(await page.content()).not.toContain(secret);await expect(page.getByRole('button',{name:/重发|补写|重试|恢复任务/})).toHaveCount(0);}

test('real component requires explicit read-back and sends one CSRF-bound request despite double click',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const {calls,unexpected}=await mount(page,{hold});
 await begin(page);expect(calls.map(c=>c.path)).toEqual([`/api/v1/actions/${actionId}/reconciliation-sessions`]);
 await page.getByLabel('核对依据',{exact:true}).fill('synthetic manual evidence');
 await readButton(page).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 await expect(page.getByRole('form',{name:'人工核对'})).toHaveCount(0);
 await expect.poll(()=>calls.length).toBe(2);release();await expect(page.getByRole('status')).toContainText('认证日志确认已发生');
 expect(calls).toEqual([{path:`/api/v1/actions/${actionId}/reconciliation-sessions`,body:{},csrf:'synthetic-csrf',origin:'http://127.0.0.1:64702'},{path:`/api/v1/reconciliations/${caseId}/read-back`,body:{nonce:'synthetic-once',argsHash:hash},csrf:'synthetic-csrf',origin:'http://127.0.0.1:64702'}]);
 expect(unexpected).toEqual([]);await safePage(page);
});

for(const [state,text] of [['VERIFIED_APPLIED','认证日志确认已发生'],['VERIFIED_NOT_APPLIED','认证日志确认未发生'],['INCONCLUSIVE','认证读回未能确定结果']] as const){
 test(`certified outcome ${state} never restores task or permits retry`,async({page})=>{
  const {calls}=await mount(page,{result:receipt(state)});await begin(page);await readButton(page).click();
  await expect(page.getByRole('status')).toContainText(text);await expect(page.getByRole('status')).toContainText('原业务动作仍待核对，任务不会恢复，未获得重试许可');
  await expect(readButton(page)).toHaveCount(0);expect(calls).toHaveLength(2);await safePage(page);
 });
}

for(const [name,scenario] of [
 ['wrong case',{result:{...receipt(),id:actionId}}],['old receipt',{result:{id:caseId,state:'VERIFIED_APPLIED'}}],['malformed',{result:{...receipt(),retryAllowed:true}}],['wrong certification',{result:{...receipt(),verification:'UNVERIFIED'}}],['wrong action state',{result:{...receipt(),actionState:'APPLIED'}}],['403',{status:403}],['409',{status:409}],['network failure',{abort:true}],
] as const){
 test(`${name} fails closed without retry or manual fallback`,async({page})=>{
  const {calls}=await mount(page,scenario);await begin(page);await page.getByLabel('核对依据',{exact:true}).fill(secret);await readButton(page).click();
  await expect(page.getByRole('status')).toContainText('核验未完成');await expect(page.getByRole('status')).not.toContainText('认证日志确认');
  await expect(readButton(page)).toHaveCount(0);await expect(page.getByRole('form',{name:'人工核对'})).toHaveCount(0);await expect(page.getByText('synthetic.journal',{exact:true})).toHaveCount(0);
  expect(calls).toHaveLength(2);await safePage(page);
 });
}

for(const [name,value,status] of [['old session',{...session(),verification:undefined},200],['wrong action',{...session(),action:{id:caseId,capability:'synthetic.journal',state:'UNKNOWN'}},200],['expired',{...session(),expiresAt:new Date(0).toISOString()},200],['begin denied',session(),403]] as const){
 test(`${name} cannot enable read-back`,async({page})=>{
  const {calls}=await mount(page,{begin:value,beginStatus:status});await begin(page);await expect(page.getByRole('status')).toContainText('核验未完成');await expect(readButton(page)).toHaveCount(0);expect(calls).toHaveLength(1);await safePage(page);
 });
}

test('manual declaration remains a separate unverified operation with no read-back',async({page})=>{
 const {calls}=await mount(page);await begin(page);await page.getByLabel('核对声明',{exact:true}).selectOption('APPLIED');await page.getByLabel('核对依据',{exact:true}).fill('synthetic manual evidence');
 await page.getByRole('button',{name:'保存人工声明'}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 await expect(page.getByRole('status')).toContainText('人工声明已记录为已发生、尚未核验');expect(calls).toHaveLength(2);expect(calls[1]!.path).toBe(`/api/v1/reconciliations/${caseId}/attestation`);expect(calls[1]!.body).toEqual({nonce:'synthetic-once',argsHash:hash,claim:'APPLIED',evidence:'synthetic manual evidence'});await expect(readButton(page)).toHaveCount(0);await safePage(page);
});

test('unauthorized overview reveals no action data and performs no reconciliation',async({page})=>{
 const {calls}=await mount(page,{unauthorized:true});await expect(page.getByRole('status')).toContainText('当前无法访问安全控制');await expect(page.getByText('synthetic.journal',{exact:true})).toHaveCount(0);expect(calls).toEqual([]);await safePage(page);
});

test('CSRF/session change and unmount erase evidence and suppress late read-back',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const {calls}=await mount(page,{hold});await begin(page);await page.getByLabel('核对依据',{exact:true}).fill(secret);await readButton(page).click();await expect.poll(()=>calls.length).toBe(2);
 await page.evaluate(()=>Reflect.get(window,'replaceControlCsrf')('replacement-csrf'));
 await expect(page.getByRole('status')).toHaveCount(0);release();await expect(page.getByRole('button',{name:'核对此动作',exact:true})).toBeVisible();await expect(page.getByRole('status')).toHaveCount(0);await expect(readButton(page)).toHaveCount(0);await safePage(page);
 await begin(page);await page.getByLabel('核对依据',{exact:true}).fill(secret);await page.evaluate(()=>Reflect.get(window,'unmountControl')());await expect(page.getByRole('region',{name:'安全控制中心'})).toHaveCount(0);await safePage(page);
});
