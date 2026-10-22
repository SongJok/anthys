import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {escalationUiRequestLifetimeMs} from '../../apps/web/src/group-escalations-flow.js';
import {installEscalationFetchWitness} from '../support/escalation-fetch-witness.js';
type Fixture={group:string;ownerCookie:string;ownerApiCookie:string;ownerApiCsrf:string;adminCookie:string;adminCsrf:string;adminApiCookie:string;adminApiCsrf:string};
type ActualBody={data:{kind:string;code?:string;receipt?:{caseId:string;caseVersion:number;replayed?:boolean}}};

// One persisted case crosses both phases. Each phase uses Playwright's own page
// fixture so its network/trace lifetime belongs to that test. Keep the original
// 30s per-test limit, zero retries and every authority observation.
test.describe.serial('selected real case uses actual API and PostgreSQL for administrator escalation',()=>{
 let f:Fixture,item:{id:string;version:number};
 async function login(page:Page,cookie:string,title:string){const area=page.getByRole('region',{name:'群事务登记',exact:true});await page.context().addCookies([{name:'oa_session',value:cookie,url:'http://localhost:64702'}]);await page.goto('/groups');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();await area.getByLabel('管理员提供的群标识',{exact:true}).fill(f.group);await area.getByRole('button',{name:'读取今日登记事项',exact:true}).click();await expect(area.getByRole('article',{name:'群事项 '+title,exact:true})).toBeVisible({timeout:15000});}
 test('owner is denied for the actual persisted open case',async({page,request},info)=>{
  f=JSON.parse(await readFile('.data/test-environment/browser-group-cases.json','utf8'))[info.project.name] as Fixture;
  const base='/api/v1/groups/'+encodeURIComponent(f.group),title='SYNTHETIC single case escalation '+info.project.name;
  const created=await request.post(base+'/cases',{headers:{cookie:'oa_session='+f.ownerApiCookie,origin:'http://localhost:64702','x-csrf-token':f.ownerApiCsrf,'idempotency-key':randomUUID()},data:{contractVersion:1,details:{title,resourceRef:'release:'+randomUUID(),priority:'HIGH',dueAt:new Date(Date.now()-3600000).toISOString()},source:{kind:'CARD',shareWithGroup:true}}});expect(created.status()).toBe(201);item=(await created.json()).data.case;
  const opened=await request.patch(base+'/cases/'+item.id,{headers:{cookie:'oa_session='+f.adminApiCookie,origin:'http://localhost:64702','x-csrf-token':f.adminApiCsrf,'idempotency-key':randomUUID()},data:{contractVersion:1,expectedVersion:item.version,command:{operation:'OPEN'}}});expect(opened.status()).toBe(200);
  const area=page.getByRole('region',{name:'群事务登记',exact:true});
  await login(page,f.ownerCookie,title);expect(await area.getByRole('button',{name:'申请此事项同群升级',exact:true}).count()).toBe(0);
 });
 test('administrator reviews, confirms, reads without repeating, then cancels once',async({page,request},info)=>{
  const title='SYNTHETIC single case escalation '+info.project.name,sent:string[]=[];
  const witness=await installEscalationFetchWitness(page,{origin:'http://localhost:64702',group:f.group,timeoutMs:escalationUiRequestLifetimeMs,maxBodyBytes:64*1024});
  try{
  page.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/case-escalations/'))sent.push(req.url());});
  await login(page,f.adminCookie,title);const card=page.getByRole('region',{name:'群事务登记',exact:true}).getByRole('article',{name:'群事项 '+title,exact:true});
  await card.getByRole('button',{name:'申请此事项同群升级',exact:true}).click();const panel=card.getByRole('region',{name:'事项升级申请',exact:true});await panel.getByLabel('升级理由',{exact:true}).fill('SYNTHETIC independent reviewed escalation reason');await panel.getByRole('button',{name:'核对服务端预览',exact:true}).click();await expect(panel.getByRole('complementary',{name:'服务端升级预览',exact:true})).toBeVisible();await expect(panel).toContainText('事实尚未核验，通知尚未发送');
  // HTTP metadata still comes from the real browser request. The exact original
  // fetch response is independently cloned in-page, without CDP's body cache.
  // Keep the existing total response lifetime and default 5s rendering checks.
  const remaining=(start:number)=>{const ms=escalationUiRequestLifetimeMs-(Date.now()-start);expect(ms).toBeGreaterThan(0);return ms;};
  async function action(button:string,method:'GET'|'POST',path:string,kind:string){
   const start=Date.now(),afterSequence=await witness.sequence();
   const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()===method&&new URL(r.url()).pathname===path,{timeout:escalationUiRequestLifetimeMs}),panel.getByRole('button',{name:button,exact:true}).click()]);
   const observed=await witness.read({afterSequence,method,path,timeoutMs:remaining(start)}),body=observed.body as ActualBody;
   expect(observed.url).toBe(response.url());expect(observed.status).toBe(response.status());
   await info.attach('actual-escalation-response',{contentType:'application/json',body:Buffer.from(JSON.stringify({operation:kind,elapsedMs:Date.now()-start,status:response.status(),kind:body.data?.kind??null,code:body.data?.code??null}))});
   expect(response.status()).toBe(200);expect(body.data.kind).toBe(kind);return body.data;
  }
  // Derive the proposal reference from the actual confirmation response's request.
  const start=Date.now(),afterSequence=await witness.sequence();
  const [response]=await Promise.all([page.waitForResponse(r=>{const url=new URL(r.url()),prefix='/api/v1/groups/'+encodeURIComponent(f.group)+'/case-escalations/';return r.request().method()==='POST'&&url.origin==='http://localhost:64702'&&url.pathname.startsWith(prefix)&&/^[0-9a-f-]{36}\/confirm$/.test(url.pathname.slice(prefix.length));},{timeout:escalationUiRequestLifetimeMs}),panel.getByRole('button',{name:'确认申请同群升级',exact:true}).click()]);
  const confirmationPath=new URL(response.request().url()).pathname,observed=await witness.read({afterSequence,method:'POST',path:confirmationPath,timeoutMs:remaining(start)}),confirmed=observed.body as ActualBody;
  expect(observed.url).toBe(response.url());expect(observed.status).toBe(response.status());
  await info.attach('actual-escalation-confirmation',{contentType:'application/json',body:Buffer.from(JSON.stringify({elapsedMs:Date.now()-start,status:response.status(),kind:confirmed.data?.kind??null,code:confirmed.data?.code??null}))});
  expect(response.status()).toBe(200);expect(confirmed.data).toMatchObject({kind:'QUEUED',receipt:{caseId:item.id,caseVersion:item.version+1}});
  await expect(panel.getByRole('heading',{name:'已登记入队',exact:true})).toBeVisible();expect(sent.filter(url=>url.endsWith('/confirm'))).toHaveLength(1);
  const reference=new URL(response.request().url()).pathname.replace(/\/confirm$/,'');
  const queued=await request.get(reference,{headers:{cookie:'oa_session='+f.adminCookie}});expect(queued.status()).toBe(200);expect((await queued.json()).data).toMatchObject({kind:'QUEUED',receipt:{caseId:item.id,caseVersion:item.version+1,replayed:true}});
  await action('读取本申请当前状态','GET',reference,'QUEUED');await expect(panel.getByRole('heading',{name:'已登记入队',exact:true})).toBeVisible();expect(sent.filter(url=>url.endsWith('/confirm'))).toHaveLength(1);
  await action('停止未派发后续','POST',reference+'/cancel','CANCELLED_LOCAL');await expect(panel.getByRole('heading',{name:'已停止未派发后续',exact:true})).toBeVisible();const stopped=await request.get(reference,{headers:{cookie:'oa_session='+f.adminCookie}});expect(stopped.status()).toBe(200);expect((await stopped.json()).data.kind).toBe('CANCELLED_LOCAL');expect(sent.filter(url=>url.endsWith('/confirm'))).toHaveLength(1);expect(sent.filter(url=>url.endsWith('/cancel'))).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'reports/group-case-escalation-core-20261020/'+info.project.name+'-actual-api.png',fullPage:true});
  }finally{await witness.dispose();}
 });
});
