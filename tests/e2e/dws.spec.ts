import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
type Fixture={taskId:string;missingAuthTaskId:string;userId:string;actorId:string};
async function fixtures(){return JSON.parse(await readFile('.data/test-environment/browser-dws-fixtures.json','utf8')) as Record<string,Fixture>;}
async function login(page:Page,context:BrowserContext,code:string){
 await context.route('**/*',route=>new URL(route.request().url()).origin==='http://localhost:52339'?route.continue():route.abort('blockedbyclient'));
 await page.route('https://login.dingtalk.com/oauth2/auth?*',async route=>{const url=new URL(route.request().url()),callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('authCode',code);callback.searchParams.set('state',url.searchParams.get('state')!);await route.fulfill({status:302,headers:{location:callback.toString()}});});
 await page.goto('/tasks');await page.getByRole('button',{name:'使用钉钉登录'}).click();await expect(page.getByRole('heading',{name:'创建任务'})).toBeVisible();
}
test('T062/T068 components: owner profile is visible only while connected, and disconnect immediately removes the displayed result before the status refresh',async({page,context},info)=>{
 const all=await fixtures(),fixture=all[info.project.name]!,other=all[info.project.name==='desktop'?'mobile':'desktop']!;
 await login(page,context,'synthetic-dws-'+info.project.name+'-code');
 await page.goto('/tasks?task='+fixture.taskId);const connection=page.getByRole('region',{name:'个人办公连接'}),result=page.locator('pre');
 await expect(connection.getByRole('button',{name:'断开个人办公连接'})).toBeVisible();await expect(result).toContainText(fixture.userId);await expect(result).toContainText('测试部门');await expect(result).toContainText('测试企业');await expect(page.getByText('结果等级：保密')).toBeVisible();
 for(const privateValue of ['SYNTHETIC_DWS_CREDENTIAL_0123456789','SYNTHETIC_PRIVATE_PHONE','SYNTHETIC_PRIVATE_EMAIL',other.userId])expect(await page.content()).not.toContain(privateValue);
 expect((await page.request.get('/api/v1/tasks/'+other.taskId)).status()).toBe(404);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await mkdir('reports/ui',{recursive:true});await result.scrollIntoViewIfNeeded();await page.screenshot({path:'reports/ui/p06-dws-connected-'+info.project.name+'.png',fullPage:false});
 // Hold the follow-up status read so the disappearance is proved to happen
 // on the successful disconnect response, without relying on navigation.
 let releaseStatus!:()=>void;const statusGate=new Promise<void>(resolve=>{releaseStatus=resolve;});
 await page.route('**/api/v1/dws/connection',async route=>{await statusGate;await route.continue();});
 const disconnecting=page.waitForResponse(r=>r.url().endsWith('/api/v1/dws/disconnect')&&r.request().method()==='POST');
 try{await connection.getByRole('button',{name:'断开个人办公连接'}).click();const response=await disconnecting;expect(response.status()).toBe(200);await expect(result).toHaveCount(0);expect(await page.content()).not.toContain(fixture.userId);}finally{releaseStatus();}
 expect((await (await disconnecting).json()).data).toMatchObject({state:'REVOKED',providerRevocation:'NOT_PERFORMED'});
 await expect(connection.getByText('已停止本系统访问。平台端授权可在钉钉中另行管理。')).toBeVisible();await expect(connection.getByRole('button',{name:'断开个人办公连接'})).toHaveCount(0);
 await page.reload();await expect(page.getByText('结果的当前来源权限尚未核实，正文暂不可见。')).toBeVisible();await expect(result).toHaveCount(0);const response=await page.request.get('/api/v1/tasks/'+fixture.taskId);expect(response.headers()['cache-control']).toBe('private, no-store');expect((await response.json()).data.runs[0]).toMatchObject({result:null,result_access:'CURRENT_SOURCE_UNVERIFIED'});expect(await page.content()).not.toContain(fixture.userId);await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.getByText('结果的当前来源权限尚未核实，正文暂不可见。').scrollIntoViewIfNeeded();await page.screenshot({path:'reports/ui/p06-dws-disconnected-'+info.project.name+'.png',fullPage:false});
});
test('T028 component: H5 login leaves personal office authorization unconnected and explains the paused task without a fake authorization entry',async({page,context},info)=>{
 const fixture=(await fixtures())[info.project.name]!;await login(page,context,'synthetic-browser-code');await page.goto('/tasks?task='+fixture.missingAuthTaskId);const connection=page.getByRole('region',{name:'个人办公连接'});
 await expect(connection.getByText('个人办公权限尚未连接。')).toBeVisible();await expect(connection.getByText('请使用本人钉钉账号完成独立授权。')).toBeVisible();await expect(connection.getByText('授权入口尚未启用，请联系管理员开通。')).toBeVisible();await expect(connection.getByRole('button')).toHaveCount(0);await expect(page.getByText('未完成原因：需要使用本人钉钉账号连接个人办公权限后继续。')).toBeVisible();
 const response=await page.request.get('/api/v1/tasks/'+fixture.missingAuthTaskId);expect((await response.json()).data.runs[0]).toMatchObject({status:'WAITING_AUTH',result:null,last_error:'DWS_USER_CONSENT_REQUIRED'});await expect(page.locator('pre')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await mkdir('reports/ui',{recursive:true});await page.getByText('未完成原因：需要使用本人钉钉账号连接个人办公权限后继续。').scrollIntoViewIfNeeded();await page.screenshot({path:'reports/ui/p06-dws-auth-needed-'+info.project.name+'.png',fullPage:false});
});
