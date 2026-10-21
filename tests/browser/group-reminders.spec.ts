import {test,expect,type Page} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
type Fixture={group:string;actorId:string;adminCookie:string};
const region=(page:Page)=>page.getByRole('region',{name:'群催办管理',exact:true});
// Parent-owned real isolated API/PG fixture. No route mocks or conditional skip.
async function fixture(project:string){return JSON.parse(await readFile('.data/test-environment/browser-group-reminders.json','utf8'))[project] as Fixture;}
let saved:{id:string};
async function login(page:Page,f:Fixture){await page.context().addCookies([{name:'oa_session',value:f.adminCookie,url:'http://localhost:52339'}]);await page.goto('/groups');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();await region(page).getByLabel('管理员提供的群标识',{exact:true}).fill(f.group);}
test.describe.serial('T111 real persisted reminder across bounded browser phases',()=>{
test('reviewed administrator previews and explicitly registers a real group reminder',async({page},info)=>{
 const f=await fixture(info.project.name);expect(f.actorId).toBeTruthy();await page.context().addCookies([{name:'oa_session',value:f.adminCookie,url:'http://localhost:52339'}]);await page.goto('/groups');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();
 const area=region(page);await area.getByLabel('管理员提供的群标识',{exact:true}).fill(f.group);
 const read=()=>area.getByRole('button',{name:'读取当前审核授权与计划',exact:true}).click();await read();
 const selector=area.getByLabel('当前已审核授权',{exact:true});await expect(selector).toHaveValue('');
 await expect(area.getByRole('button',{name:'准备开始本群催办',exact:true})).toBeDisabled();
 const authorization=await selector.locator('option:not([value=""]):not([disabled])').first().getAttribute('value');expect(authorization).toBeTruthy();await selector.selectOption(authorization!);
 await expect(area.getByRole('complementary',{name:'所选审核授权'})).toContainText('合同工作时区');
 // datetime-local normalizes zero seconds away; use canonical minute precision.
 const start=await page.evaluate(()=>new Date(Date.now()+2*60000).toISOString().slice(0,16));
 await area.getByLabel('规则 IANA 时区',{exact:true}).fill('UTC');await area.getByLabel('起点解释',{exact:true}).selectOption('UTC');await area.getByLabel('规则起点（按上述解释）',{exact:true}).fill(start);await expect(area.getByLabel('规则起点（按上述解释）',{exact:true})).toHaveValue(start);
 const preview=page.waitForResponse(r=>r.url().includes('/reminder-schedules/preview')&&r.request().method()==='POST');await area.getByRole('button',{name:'核对服务端未来五次预览',exact:true}).click();expect((await preview).status()).toBe(200);
 await expect(area.getByRole('complementary',{name:'服务端规则预览'})).toContainText('绝对UTC');
 await area.getByRole('button',{name:'准备开始本群催办',exact:true}).click();await expect(area.getByRole('complementary',{name:'开始本群催办确认'})).toContainText('确认不授予新权限');
 const created=page.waitForResponse(r=>/\/reminder-schedules$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST');await area.getByRole('button',{name:'确认开始本群催办',exact:true}).click();const response=await created;expect(response.status()).toBe(201);saved=(await response.json()).data.schedule;
 await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toContainText(saved.id);await read();await expect(area.getByRole('article',{name:'群催办计划 '+saved.id,exact:true})).toBeVisible();await mkdir('reports/group-reminder-runtime-20261019/screenshots',{recursive:true});await area.screenshot({path:'reports/group-reminder-runtime-20261019/screenshots/'+info.project.name+'-registered.png'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('edits and pauses the same persisted reminder',async({page},info)=>{
 const f=await fixture(info.project.name);expect(saved?.id).toBeTruthy();await login(page,f);const area=region(page),read=()=>area.getByRole('button',{name:'读取当前审核授权与计划',exact:true}).click();await read();
 const card=()=>area.getByRole('article',{name:'群催办计划 '+saved.id,exact:true});await expect(card()).toContainText('启用中');await card().getByRole('button',{name:'编辑此计划',exact:true}).click();
 await area.getByLabel('总发生次数（可不设）',{exact:true}).fill('1');await area.getByRole('button',{name:'核对服务端未来五次预览',exact:true}).click();await expect(area.getByRole('complementary',{name:'服务端规则预览'})).toBeVisible();await area.getByRole('button',{name:'保存规则修改',exact:true}).click();await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toBeVisible();await read();
 await card().getByRole('button',{name:'暂停后续催办',exact:true}).click();await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toContainText('已暂停');await read();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('resumes, cancels and clears the same reminder on group change',async({page},info)=>{
 const f=await fixture(info.project.name);expect(saved?.id).toBeTruthy();await login(page,f);const area=region(page),read=()=>area.getByRole('button',{name:'读取当前审核授权与计划',exact:true}).click();await read();const card=()=>area.getByRole('article',{name:'群催办计划 '+saved.id,exact:true});await expect(card()).toContainText('已暂停');await card().getByRole('button',{name:'恢复后续催办',exact:true}).click();await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toContainText('启用中');await read();await card().getByRole('button',{name:'取消此计划',exact:true}).click();await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toContainText('已取消');
 await area.getByLabel('管理员提供的群标识',{exact:true}).fill('different-unreviewed-group');await expect(area.getByRole('complementary',{name:'群催办计划版本回执'})).toHaveCount(0);await expect(area.getByRole('article')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

});
