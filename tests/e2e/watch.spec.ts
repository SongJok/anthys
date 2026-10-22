import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {Database} from '../../packages/storage/src/database.js';
import {secret} from '../../packages/config/src/index.js';
import {ids} from '../../scripts/seed.js';
test.beforeEach(async({context})=>{await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin==='http://localhost:64702'?route.continue():route.abort('blockedbyclient');});});
test('owner creates, reloads, binds a certified source and stops a finite condition watch from the web UI',async({page},info)=>{
 const fixture=JSON.parse(await readFile('.data/test-environment/browser-watch-fixture.json','utf8')) as {scopeId:string},actor='00000000-0000-4000-8000-000000000089',admin=new pg.Client({connectionString:secret('MIGRATION_DATABASE_URL')!});
 await admin.connect();try{for(const table of ['condition_watch_notifications','condition_watch_checks','condition_watch_sources','condition_watches'])await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND owner_id=$2`,[ids.tenantA,actor]);}finally{await admin.end();}
 expect((await page.request.get('/api/v1/watches')).status()).toBe(401);
 await page.route('https://login.dingtalk.com/oauth2/auth?*',async route=>{const url=new URL(route.request().url()),callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('authCode','synthetic-browser-code');callback.searchParams.set('state',url.searchParams.get('state')!);await route.fulfill({status:302,headers:{location:callback.toString()}});});
 await page.goto('/tasks');await page.getByRole('button',{name:'使用钉钉登录'}).click();await page.getByRole('link',{name:'条件监控',exact:true}).click();await expect(page).toHaveURL(/\/watches$/);
 const region=page.getByRole('region',{name:'条件监控'}),detail=region.getByRole('article',{name:'当前监控详情'});
 await expect(region.getByRole('heading',{name:'条件监控',exact:true})).toBeVisible();await expect(region.getByText('当前可见 0 条监控。')).toBeVisible();
 expect((await page.request.post('/api/v1/watches',{data:{}})).status()).toBe(403);
 const form=region.getByRole('form',{name:'新建条件监控'});await form.getByLabel('静默开始（HH:MM，可不设）').fill('09:00');await expect(form.getByRole('button',{name:'保存条件监控'})).toBeDisabled();await expect(form.getByText('静默窗必须同时填写开始和结束。')).toBeVisible();await form.getByLabel('静默开始（HH:MM，可不设）').fill('');
 const creating=page.waitForResponse(response=>response.url().endsWith('/api/v1/watches')&&response.request().method()==='POST');await form.getByRole('button',{name:'保存条件监控'}).click();const created=await creating;expect(created.status()).toBe(201);const watchId=(await created.json()).data.watchId as string;
 await expect(region.getByRole('status')).toHaveText('条件监控已登记。须绑定已认证数据来源后才会产生可通知的观测值。');await expect(region.getByText('当前可见 1 条监控。')).toBeVisible();await expect(detail).toContainText('编号：'+watchId);await expect(detail).toContainText('状态：检查中');
 await page.reload();await expect(region.getByText('当前可见 1 条监控。')).toBeVisible();await region.getByRole('button',{name:'读取此监控详情'}).click();await expect(detail).toContainText('编号：'+watchId);
 const binding=detail.getByRole('form',{name:'绑定公司数据来源'});await binding.getByLabel('公司数据作用域编号').fill(fixture.scopeId);await binding.getByLabel('指标').selectOption('attempts');await binding.getByLabel('统计窗口（秒）').fill('86400');
 const bindingResponse=page.waitForResponse(response=>response.url().endsWith('/watches/'+watchId+'/source')&&response.request().method()==='POST');await binding.getByRole('button',{name:'绑定来源'}).click();expect((await bindingResponse).status()).toBe(200);await expect(region.getByRole('status')).toHaveText('数据来源绑定成功。绑定不可修改；作用域版本或授权变化会使其停止观测。');
 await detail.getByRole('button',{name:'暂停后续检查'}).click();await expect(region.getByRole('status')).toHaveText('已暂停后续检查。');await expect(detail).toContainText('状态：已暂停');
 await detail.getByRole('button',{name:'恢复后续检查'}).click();await expect(region.getByRole('status')).toHaveText('已恢复后续检查；已耗尽预算或到期的监控不会因恢复而复活。');await expect(detail).toContainText('状态：检查中');
 await detail.getByRole('button',{name:'停止此监控'}).click();await expect(region.getByRole('status')).toHaveText('已登记停止后续检查；在途检查仍可能完成，但不会再预留新的通知。');await expect(detail).toContainText('状态：已停止');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'.data/test-environment/watch-ui-'+info.project.name+'.png',fullPage:true});
 const db=new Database(secret('RUNTIME_DATABASE_URL')!);
 try{
  const record=await db.scope({tenantId:ids.tenantA,actorId:actor},async c=>({watch:(await c.query('SELECT lifecycle,stop_reason,checks_started,notifications_reserved FROM condition_watches WHERE tenant_id=$1 AND id=$2',[ids.tenantA,watchId])).rows[0],source:(await c.query('SELECT scope_id,metric,window_seconds FROM condition_watch_sources WHERE tenant_id=$1 AND watch_id=$2',[ids.tenantA,watchId])).rows[0],notifications:(await c.query('SELECT count(*)::int n FROM condition_watch_notifications WHERE tenant_id=$1 AND watch_id=$2',[ids.tenantA,watchId])).rows[0].n}));
  expect(record.watch).toMatchObject({lifecycle:'CANCELLED',stop_reason:null,checks_started:0,notifications_reserved:0});expect(record.source).toMatchObject({scope_id:fixture.scopeId,metric:'attempts',window_seconds:86400});expect(record.notifications).toBe(0);
 }finally{await db.close();}
 await page.getByRole('button',{name:'退出登录'}).click();await expect(page.getByRole('button',{name:'使用钉钉登录'})).toBeVisible();expect((await page.request.get('/api/v1/watches')).status()).toBe(401);
 await writeFile('reports/watch-ui-'+info.project.name+'.json',JSON.stringify({scenario:'REAL_LOCAL_OWNER_CONDITION_WATCH_CREATE_BIND_PAUSE_RESUME_CANCEL',project:info.project.name,watchId,lifecycle:'CANCELLED',sourceBound:true,crossOwnerDeniedByApiTest:true,live:false},null,2)+'\n');
});
