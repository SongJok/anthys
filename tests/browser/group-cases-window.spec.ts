import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Executed by group-cases.config.ts against the isolated real API/PG server.
// No page.route, response substitution, fake success, DWS production or external send.
test.use({timezoneId:'Asia/Shanghai'});
type Fixture={group:string;ownerCookie:string;ownerApiCookie:string;ownerApiCsrf:string};
const area=(page:Page)=>page.getByRole('region',{name:'群事务登记',exact:true});
async function fixture(project:string){return JSON.parse(await readFile('.data/test-environment/browser-group-cases.json','utf8'))[project] as Fixture;}
async function endpoints(page:Page,instant:string,offsetDays=0){
 return page.evaluate(({instant,offsetDays})=>{
  const date=new Date(instant);date.setDate(date.getDate()+offsetDays);date.setSeconds(0,0);
  const from=new Date(date.getTime()-60000),until=new Date(date.getTime()+120000);
  const text=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return {from:text(from),until:text(until),utcFrom:from.toISOString(),utcUntil:until.toISOString()};
 },{instant,offsetDays});
}
async function selectWindow(page:Page,window:{from:string;until:string}){
 await area(page).getByLabel('登记时间范围',{exact:true}).selectOption('custom');
 await area(page).getByLabel('登记起点（含，浏览器本地时间）',{exact:true}).fill(window.from);
 await area(page).getByLabel('登记终点（不含，浏览器本地时间）',{exact:true}).fill(window.until);
}

test('registration windows use real API/PG, show UTC coverage, clear drafts and ignore a late real response',async({page,request},info)=>{
 const f=await fixture(info.project.name),title='窗口查询 '+randomUUID();
 const response=await request.post('/api/v1/groups/'+encodeURIComponent(f.group)+'/cases',{
  headers:{cookie:'oa_session='+f.ownerApiCookie,origin:'http://localhost:64702','x-csrf-token':f.ownerApiCsrf,'idempotency-key':randomUUID()},
  data:{contractVersion:1,details:{title,resourceRef:'window:'+randomUUID(),priority:'NORMAL',dueAt:null},source:{kind:'CARD',shareWithGroup:true}},
 });
 expect(response.status()).toBe(201);
 const created=(await response.json()).data.case as {id:string;sources:{created_at:string}[]};
 expect(created.sources[0]?.created_at).toBeTruthy();
 await page.context().addCookies([{name:'oa_session',value:f.ownerCookie,url:'http://localhost:64702'}]);
 await page.goto('/groups');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();
 await area(page).getByLabel('管理员提供的群标识',{exact:true}).fill(f.group);
 const current=await endpoints(page,created.sources[0]!.created_at),past=await endpoints(page,created.sources[0]!.created_at,-2);
 await selectWindow(page,current);
 const loaded=page.waitForResponse(r=>r.url().includes('/cases?')&&r.request().method()==='GET');
 await area(page).getByRole('button',{name:'读取所选登记事项',exact:true}).click();
 const actual=await loaded;expect(actual.status()).toBe(200);
 const query=new URL(actual.url()).searchParams;expect(query.get('from')).toBe(current.utcFrom);expect(query.get('until')).toBe(current.utcUntil);
 const body=(await actual.json()).data;expect(body.coverage.from).toBeTruthy();expect(Date.parse(body.coverage.from)).toBe(Date.parse(current.utcFrom));expect(Date.parse(body.coverage.until)).toBe(Date.parse(current.utcUntil));
 expect(body.items.some((item:{id:string})=>item.id===created.id)).toBe(true);
 await expect(area(page).getByRole('article',{name:'群事项 '+title,exact:true})).toBeVisible();
 await expect(area(page)).toContainText('Asia/Shanghai');await expect(area(page)).toContainText(current.utcFrom);
 await area(page).getByLabel('事项标题',{exact:true}).fill('不应保留的草稿');
 await selectWindow(page,past);await expect(area(page).getByRole('article')).toHaveCount(0);await expect(area(page).getByRole('complementary',{name:'群事项逻辑回执'})).toHaveCount(0);
 const pastLoaded=page.waitForResponse(r=>r.url().includes('/cases?')&&r.request().method()==='GET');
 await area(page).getByRole('button',{name:'读取所选登记事项',exact:true}).click();
 const pastResponse=await pastLoaded;expect(pastResponse.status()).toBe(200);await pastResponse.finished();
 const pastQuery=new URL(pastResponse.url()).searchParams;expect(pastQuery.get('from')).toBe(past.utcFrom);expect(pastQuery.get('until')).toBe(past.utcUntil);
 await expect(area(page).getByRole('form',{name:'明确共享卡片登记事项'})).toBeVisible();
 await expect(area(page).getByLabel('事项标题',{exact:true})).toHaveValue('');
 await expect(area(page).getByRole('article',{name:'群事项 '+title,exact:true})).toHaveCount(0);
 // Delay real network transport, not its response body, to exercise invalidation.
 const network=await page.context().newCDPSession(page);
 await network.send('Network.enable');await network.send('Network.emulateNetworkConditions',{offline:false,latency:700,downloadThroughput:-1,uploadThroughput:-1});
 try{
  await selectWindow(page,current);const started=page.waitForRequest(r=>r.url().includes('/cases?')&&r.method()==='GET');
  const late=page.waitForResponse(r=>r.url().includes('/cases?')&&r.request().method()==='GET');
  await area(page).getByRole('button',{name:'读取所选登记事项',exact:true}).click();await started;
  await area(page).getByLabel('登记起点（含，浏览器本地时间）',{exact:true}).fill(past.from);
  const real=await late;expect(real.status()).toBe(200);await real.finished();
  await expect(area(page).getByRole('article')).toHaveCount(0);await expect(area(page).getByRole('form',{name:'明确共享卡片登记事项'})).toHaveCount(0);
 }finally{await network.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await network.detach();}
 await area(page).getByLabel('登记终点（不含，浏览器本地时间）',{exact:true}).fill('2027-12-31T00:00');
 await expect(area(page).getByRole('button',{name:'读取所选登记事项',exact:true})).toBeDisabled();
 await expect(area(page).getByRole('alert')).toContainText('不超过31天');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
