import '../support/isolation.js';
import {test,expect,type Page} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
type Fixture={nativeCookie:string;nativeTaskId:string;nativeRunId:string;nativeExpectedValue:string;nativeArtifactId:string;ownerCookie:string;taskId:string;runId:string;tenantId:string;actorId:string;isolatedDatabase:string;expectedValue:string};
const fixture=async(project:string)=>JSON.parse(await readFile('.data/test-environment/browser-artifacts.json','utf8'))[project] as Fixture;
const area=(page:Page)=>page.getByRole('region',{name:'任务成果',exact:true});
async function login(page:Page,f:Fixture){await page.context().addCookies([{name:'oa_session',value:f.ownerCookie,url:'http://localhost:64702'}]);await page.goto('/tasks');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();await page.locator('button.task').first().click();await expect(area(page)).toBeVisible();}
type NativeArtifactReceipt={path:string;status:number;requestBody:string|null;body?:unknown;bodyError?:string};
/** Observe the real fetch response in its owning browser realm. Chromium CDP
 * body handles are not a portable second consumer (CI mobile loses them even
 * with immediate response.json). Return the exact original response unchanged;
 * never route, fabricate a response, retry a request or catch an app failure. */
async function observeNativeReceipts(page:Page){await page.addInitScript(()=>{
 const receipts:NativeArtifactReceipt[]=[],nativeFetch=window.fetch.bind(window);
 Object.defineProperty(window,'__oaArtifactReceipts',{value:receipts});
 window.fetch=async(...args:Parameters<typeof fetch>)=>{
  const response=await nativeFetch(...args),[input,init]=args,url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  if(url.origin===location.origin&&method==='POST'&&(/^\/api\/v1\/tasks\/[a-f0-9-]{36}\/artifacts$/.test(url.pathname)||/^\/api\/v1\/artifacts\/[a-f0-9-]{36}\/download-ticket$/.test(url.pathname))){
   const receipt:NativeArtifactReceipt={path:url.pathname,status:response.status,requestBody:typeof init?.body==='string'?init.body:null};receipts.push(receipt);
   try{void response.clone().json().then(body=>{receipt.body=body;},()=>{receipt.bodyError='NATIVE_RESPONSE_BODY_UNAVAILABLE';});}catch{receipt.bodyError='NATIVE_RESPONSE_CLONE_UNAVAILABLE';}
  }
  return response;
 };
});}
async function nativeReceipt<T>(page:Page,path:string){
 await page.waitForFunction(path=>((window as typeof window&{__oaArtifactReceipts:NativeArtifactReceipt[]}).__oaArtifactReceipts??[]).some(r=>r.path===path&&(r.body!==undefined||r.bodyError!==undefined)),path);
 const rows=await page.evaluate(path=>(window as typeof window&{__oaArtifactReceipts:NativeArtifactReceipt[]}).__oaArtifactReceipts.filter(r=>r.path===path),path);expect(rows.length).toBe(1);const row=rows[0]!;expect(row.bodyError).toBeUndefined();expect(row.body).not.toBeUndefined();return {...row,body:row.body as T};
}
test.describe.serial('actual task workbench through real API and disposable PostgreSQL, no route mocks',()=>{
 let artifactId:string;
 test('generates from the protected result and saves actual server bytes with a one-use ticket',async({page},info)=>{
  const f=await fixture(info.project.name);await observeNativeReceipts(page);await login(page,f);const panel=area(page);await expect(panel.getByRole('button',{name:'生成受保护成果',exact:true})).toBeEnabled();await panel.getByLabel('成果格式',{exact:true}).selectOption('txt');
  // Keep navigation guards: a real page replacement cannot inherit receipts.
  const navigations:string[]=[],location=page.url();page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push(frame.url());});
  const created=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/tasks/${f.taskId}/artifacts`&&r.request().method()==='POST');
  const [response]=await Promise.all([created,panel.getByRole('button',{name:'生成受保护成果',exact:true}).click()]);expect(response.status()).toBe(201);const receipt=await nativeReceipt<{data:{artifact:{id:string;sha256:string;byteSize:number}}}>(page,`/api/v1/tasks/${f.taskId}/artifacts`);expect(receipt.status).toBe(201);expect(JSON.parse(receipt.requestBody!)).toEqual({runId:f.runId,format:'txt'});const item=receipt.body.data.artifact;artifactId=item.id;expect(navigations).toEqual([]);expect(page.url()).toBe(location);
  await expect(panel.getByRole('article')).toContainText('来源尚未核验');const posted=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/artifacts/${artifactId}/download-ticket`),bytesResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/artifacts/${artifactId}/download`),saved=page.waitForEvent('download');
  const [ticketResponse,byteResponse,download]=await Promise.all([posted,bytesResponse,saved,panel.getByRole('button',{name:'受保护下载',exact:true}).click()]);expect(ticketResponse.status()).toBe(200);const ticketReceipt=await nativeReceipt<{data:{ticket:string}}>(page,`/api/v1/artifacts/${artifactId}/download-ticket`);expect(ticketReceipt.status).toBe(200);expect(JSON.parse(ticketReceipt.requestBody!)).toEqual({});expect(byteResponse.status()).toBe(200);const path=await download.path();expect(path).toBeTruthy();const bytes=await readFile(path!);expect(bytes.toString()).toContain(f.expectedValue);expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);expect(bytes.length).toBe(item.byteSize);
  const t=ticketReceipt.body.data.ticket;expect(navigations).toEqual([]);expect(page.url()).toBe(location);expect(new URL((await bytesResponse).url()).search).toBe('');expect(typeof t==='string'&&/^[A-Za-z0-9_-]{43}$/.test(t)).toBe(true);expect(await (await bytesResponse).request().headerValue('x-artifact-download-ticket')===t).toBe(true);
  // The same authenticated session cannot consume its ticket twice.
  const replay=await page.evaluate(async({id,ticket})=>{const r=await fetch('/api/v1/artifacts/'+id+'/download',{headers:{'x-artifact-download-ticket':ticket},credentials:'same-origin'});return r.status;},{id:artifactId,ticket:t});expect(replay).toBe(403);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await mkdir('reports/task-result-artifacts-20261019/screenshots',{recursive:true});await panel.screenshot({path:'reports/task-result-artifacts-20261019/screenshots/'+info.project.name+'-real-api.png'});
 });
 test('a real native draft is shown as unverified and downloads through the actual session-bound API',async({page},info)=>{
  const original=await fixture(info.project.name),f={...original,ownerCookie:original.nativeCookie,taskId:original.nativeTaskId,runId:original.nativeRunId};await observeNativeReceipts(page);await login(page,f);const panel=area(page);
  await expect(panel.getByRole('article')).toContainText('工具草稿');await expect(panel.getByRole('article')).toContainText('事实未核验');
  const saved=page.waitForEvent('download'),ticket=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/artifacts/${f.nativeArtifactId}/download-ticket`);
  const [download,response]=await Promise.all([saved,ticket,panel.getByRole('button',{name:'受保护下载',exact:true}).click()]);expect(response.status()).toBe(200);const receipt=await nativeReceipt<{data:{ticket:string;sha256:string;byteSize:number}}>(page,`/api/v1/artifacts/${f.nativeArtifactId}/download-ticket`);expect(receipt.status).toBe(200);
  const path=await download.path();expect(path).toBeTruthy();const bytes=await readFile(path!);expect(bytes.toString()).toContain(f.nativeExpectedValue);expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.body.data.sha256);expect(bytes.length).toBe(receipt.body.data.byteSize);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await mkdir('reports/native-artifact-host-20261020/screenshots',{recursive:true});await panel.screenshot({path:'reports/native-artifact-host-20261020/screenshots/'+info.project.name+'-actual-api.png'});
 });
 test('revocation after rendering denies the next ticket and clears the old file entry',async({page},info)=>{
  const f=await fixture(info.project.name);await login(page,f);await expect(area(page).getByRole('button',{name:'受保护下载',exact:true})).toBeVisible();
  const url=new URL(secret('MIGRATION_DATABASE_URL')!);expect(url.hostname).toBe('127.0.0.1');expect(url.port).toBe('64711');expect(f.isolatedDatabase).toMatch(/^anthys_test_group_reminder_[a-f0-9]{32}$/);url.pathname='/'+f.isolatedDatabase;const db=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:3000,query_timeout:12000});
  try{await db.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND actor_id=$2',[f.tenantId,f.actorId]);}finally{await db.end();}
  let downloads=0;page.on('request',r=>{if(new URL(r.url()).pathname===`/api/v1/artifacts/${artifactId}/download`)downloads++;});const rejected=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/artifacts/${artifactId}/download-ticket`);await area(page).getByRole('button',{name:'受保护下载',exact:true}).click();expect((await rejected).status()).toBe(409);await expect(area(page).getByRole('article')).toHaveCount(0);expect(downloads).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
});
