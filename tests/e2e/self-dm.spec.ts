import {test,expect} from '@playwright/test';

test('T001 trusted ordinary DM persists one task, traverses the real queue and replies once to its original conversation with a visible task ID',async({page,context},info)=>{
 await context.route('**/*',route=>new URL(route.request().url()).origin==='http://localhost:64702'?route.continue():route.abort('blockedbyclient'));
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());url.pathname='/__test/self-dm-api'+url.pathname;const response=await route.fetch({url:url.toString(),headers:await route.request().allHeaders()});await route.fulfill({response});});
 const response=await page.request.post('/__test/self-dm',{data:{project:info.project.name}});expect(response.status()).toBe(200);
 const f=await response.json() as {taskId:string;runId:string;actorId:string;tenantId:string;answer:string;acks:number;logicalTasks:number;replies:number;replyText:string;modelRequests:number;maxOutputTokens:number;audit:{action:string;result:string}[]};
 expect(f).toMatchObject({acks:21,logicalTasks:1,replies:1,modelRequests:2,maxOutputTokens:1024});expect(f.replyText).toBe(`任务 ${f.taskId}\n\n${f.answer}`);
 expect(f.audit.map(a=>a.result)).toEqual(['ENQUEUED','SUCCEEDED','SUPPRESSED','SENDING','APPLIED_UNVERIFIED']);
 await page.route('https://login.dingtalk.com/oauth2/auth?*',async route=>{const u=new URL(route.request().url()),callback=new URL(u.searchParams.get('redirect_uri')!);callback.searchParams.set('authCode','synthetic-self-dm-'+info.project.name);callback.searchParams.set('state',u.searchParams.get('state')!);await route.fulfill({status:302,headers:{location:callback.toString()}});});
 await page.goto('/tasks');await page.getByRole('button',{name:'使用钉钉登录'}).click();await expect(page.getByRole('heading',{name:'创建任务'})).toBeVisible();
 expect((await(await page.request.get('/__test/self-dm-api/api/v1/me')).json()).data).toMatchObject({id:f.actorId,tenantId:f.tenantId});
 await page.goto('/tasks?task='+f.taskId);await expect(page.getByRole('heading',{name:'解释幂等性的含义',exact:true})).toBeVisible();await expect(page.locator('pre')).toHaveText(f.answer);
 const task=(await(await page.request.get('/__test/self-dm-api/api/v1/tasks/'+f.taskId)).json()).data;expect(task).toMatchObject({id:f.taskId,status:'COMPLETED'});expect(task.runs).toHaveLength(1);expect(task.runs[0]).toMatchObject({id:f.runId,status:'SUCCEEDED'});expect(task.deliveries).toHaveLength(1);expect(task.deliveries[0]).toMatchObject({state:'APPLIED_UNVERIFIED',verification_state:'UNVERIFIED'});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
