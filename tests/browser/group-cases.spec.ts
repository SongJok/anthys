import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
type Fixture={group:string;ownerId:string;ownerCookie:string;ownerApiCookie:string;ownerApiCsrf:string;adminCookie:string;adminCsrf:string;tenantId:string;taskId:string};
const region=(page:Page)=>page.getByRole('region',{name:'群事务登记',exact:true});
async function fixture(project:string){return JSON.parse(await readFile('.data/test-environment/browser-group-cases.json','utf8'))[project] as Fixture;}
async function login(page:Page,cookie:string){await page.context().addCookies([{name:'oa_session',value:cookie,url:'http://localhost:64702'}]);await page.goto('/groups');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();}
async function read(page:Page,f:Fixture){await region(page).getByLabel('管理员提供的群标识',{exact:true}).fill(f.group);await region(page).getByRole('button',{name:'读取今日登记事项',exact:true}).click();await expect(region(page).getByRole('form',{name:'明确共享卡片登记事项'})).toBeVisible({timeout:15000});}
async function create(page:Page,title:string,resource:string){const area=region(page);await area.getByLabel('事项标题',{exact:true}).fill(title);await area.getByLabel('精确资源标识',{exact:true}).fill(resource);const button=area.getByRole('button',{name:'登记为本群待受理事项',exact:true});await expect(button).toBeDisabled();await area.getByRole('checkbox',{name:'我确认标题、资源和内容可共享给这个群的当前成员。',exact:true}).check();await button.click();await expect(area.getByRole('complementary',{name:'群事项逻辑回执'})).toBeVisible({timeout:15000});}
const windowQuery=()=>new URLSearchParams({from:new Date(Date.now()-86400000).toISOString(),until:new Date(Date.now()+86400000).toISOString()});
async function list(request:APIRequestContext,f:Fixture){const response=await request.get('/api/v1/groups/'+encodeURIComponent(f.group)+'/cases?'+windowQuery(),{headers:{cookie:'oa_session='+f.ownerApiCookie}});expect(response.status()).toBe(200);return (await response.json()).data;}
async function ownerPost(request:APIRequestContext,f:Fixture,details:object,source:object){const response=await request.post('/api/v1/groups/'+encodeURIComponent(f.group)+'/cases',{headers:{cookie:'oa_session='+f.ownerApiCookie,origin:'http://localhost:64702','x-csrf-token':f.ownerApiCsrf,'idempotency-key':randomUUID()},data:{contractVersion:1,details,source}});expect(response.status()).toBe(201);return (await response.json()).data.case;}

test('T108/T109 browser uses real API and PG for shared cards, received mentions, coverage and distinct resources',async({page,request},info)=>{
 const f=await fixture(info.project.name),title='发布阻塞 '+info.project.name;const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await login(page,f.ownerCookie);await read(page,f);await create(page,title,'release:'+info.project.name+':a');
 await ownerPost(request,f,{title,resourceRef:'release:'+info.project.name+':b',priority:'HIGH',dueAt:null},{kind:'MENTION',taskId:f.taskId});
 await read(page,f);const area=region(page);await expect(area.getByRole('article',{name:'群事项 '+title,exact:true})).toHaveCount(2);
 await expect(area).toContainText('不覆盖全部群聊');await expect(area).toContainText('明确共享卡片');await expect(area).toContainText('已登记 @ 提交');await expect(area).toContainText('未设置负责人');await expect(area).toContainText('未设置截止时间');
 const rows=(await list(request,f)).items.filter((x:{title:string})=>x.title===title);expect(rows).toHaveLength(2);expect(new Set(rows.map((x:{resourceRef:string})=>x.resourceRef)).size).toBe(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
 await page.screenshot({path:'reports/phase-one-takeover-20261018/group-cases-'+info.project.name+'.png',fullPage:true});
 await area.getByLabel('管理员提供的群标识',{exact:true}).fill('unreviewed-other-group');await area.getByRole('button',{name:'读取今日登记事项',exact:true}).click();await expect(area.getByRole('article')).toHaveCount(0);
});

// One real persisted case crosses all three phases. The suite is serial, with
// the original30s per-test bound and zero retries; no authority check is cached.
test.describe.serial('T110 actual assignment, owner statement and independent administrator confirmation',()=>{
 let title:string;
 test('browser administrator assigns the current member',async({page,browser,request},info)=>{
  const f=await fixture(info.project.name);title='确认闭环 '+info.project.name;await login(page,f.ownerCookie);await read(page,f);await create(page,title,'release:'+info.project.name+':completion');
  const adminContext=await browser.newContext({baseURL:'http://localhost:64702',...(info.project.use.viewport?{viewport:info.project.use.viewport}:{}),timezoneId:'Asia/Shanghai'}),adminPage=await adminContext.newPage();
  try{
   await login(adminPage,f.adminCookie);await read(adminPage,f);let card=region(adminPage).getByRole('article',{name:'群事项 '+title,exact:true});await card.getByRole('button',{name:'受理事项',exact:true}).click();await read(adminPage,f);
   card=region(adminPage).getByRole('article',{name:'群事项 '+title,exact:true});await expect(card.getByRole('button',{name:'确认分派负责人',exact:true})).toBeDisabled();await card.getByLabel('从当前授权成员中选择负责人',{exact:true}).selectOption(f.ownerId);await card.getByRole('button',{name:'确认分派负责人',exact:true}).click();
   await expect(region(adminPage).getByRole('complementary',{name:'群事项逻辑回执'})).toBeVisible({timeout:15000});
   const assigned=(await list(request,f)).items.find((x:{title:string})=>x.title===title);expect(assigned).toMatchObject({state:'ASSIGNED',ownerId:f.ownerId});
  }finally{await adminContext.close();}
 });
 test('browser owner statement stays waiting for independent confirmation',async({page,request},info)=>{
  const f=await fixture(info.project.name);await login(page,f.ownerCookie);
  await read(page,f);let ownerCard=region(page).getByRole('article',{name:'群事项 '+title,exact:true});await ownerCard.getByRole('button',{name:'开始处理',exact:true}).click();await read(page,f);ownerCard=region(page).getByRole('article',{name:'群事项 '+title,exact:true});await ownerCard.getByLabel('完成声明或独立确认说明',{exact:true}).fill('已经好了');await ownerCard.getByRole('button',{name:'提交负责人完成声明',exact:true}).click();
  await read(page,f);await expect(region(page).getByRole('article',{name:'群事项 '+title,exact:true})).toContainText('完成声明待确认');await expect(region(page).getByRole('button',{name:'作为管理员确认完成',exact:true})).toHaveCount(0);
  const row=(await list(request,f)).items.find((x:{title:string})=>x.title===title);expect(row).toMatchObject({state:'WAITING_CONFIRMATION',completion:{method:'UNVERIFIED'}});
 });
 test('browser independent administrator confirms and closes the same case',async({page,request},info)=>{
  const f=await fixture(info.project.name);await login(page,f.adminCookie);await read(page,f);let card=region(page).getByRole('article',{name:'群事项 '+title,exact:true});await card.getByLabel('完成声明或独立确认说明',{exact:true}).fill('独立人工核对交付检查单');await card.getByRole('button',{name:'作为管理员确认完成',exact:true}).click();await read(page,f);card=region(page).getByRole('article',{name:'群事项 '+title,exact:true});await expect(card).toContainText('管理员已确认，未经自动验证');await card.getByRole('button',{name:'关闭事项',exact:true}).click();
  await expect(region(page).getByRole('complementary',{name:'群事项逻辑回执'})).toBeVisible({timeout:15000});
  const row=(await list(request,f)).items.find((x:{title:string})=>x.title===title);expect(row).toMatchObject({state:'CLOSED',completion:{method:'ADMIN_CONFIRMED'}});
 });
});
