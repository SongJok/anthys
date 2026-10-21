import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Separate nonce tenants from all case/escalation scenarios. No route interception,
// model, enterprise query, physical message or shared-database migration.
type Fixture={delegationId:string;contractId:string;adminCookie:string;apiCookie:string;apiCsrf:string;ownerCookie:string;ownerCsrf:string};
test('administrator explicitly restores a paused contract through the actual UI/API/PostgreSQL',async({page,request},info)=>{
 const f=(JSON.parse(await readFile('.data/test-environment/browser-group-cases.json','utf8'))[info.project.name] as {contractAdmin:Fixture}).contractAdmin;
 const path='/api/v1/group-contracts/'+f.contractId+'/state',readPath='/api/v1/group-contracts?delegationId='+f.delegationId;
 const headers={cookie:'oa_session='+f.apiCookie,origin:'http://localhost:52339','x-csrf-token':f.apiCsrf};
 const initial=await request.get(readPath,{headers});expect(initial.status()).toBe(200);const before=(await initial.json()).data.contract;expect(before.version).toBe(2);expect(before.document.state).toBe('PAUSED');
 const body={delegationId:f.delegationId,expectedVersion:2,state:'ACTIVE'};
 const denied=await request.post(path,{headers:{...headers,cookie:'oa_session='+f.ownerCookie,'x-csrf-token':f.ownerCsrf,'idempotency-key':randomUUID()},data:body});expect(denied.status()).toBe(403);
 await page.context().addCookies([{name:'oa_session',value:f.adminCookie,url:'http://localhost:52339'}]);await page.goto('/permissions');await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();
 const area=page.getByRole('region',{name:'已有群合同管理',exact:true});await area.getByLabel('已审核委托 UUID',{exact:true}).fill(f.delegationId);await area.getByRole('button',{name:'读取群合同',exact:true}).click();await expect(area.getByText('合同登记状态：已暂停',{exact:true})).toBeVisible();
 const posts:{body:unknown;key:string|undefined}[]=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname===path)posts.push({body:r.postDataJSON(),key:r.headers()['idempotency-key']});});
 await area.getByRole('button',{name:'恢复此暂停合同',exact:true}).click();const confirmation=area.getByRole('complementary',{name:'确认群合同状态变更',exact:true});await expect(confirmation).toContainText('后端会重新核对当前身份和授权');await area.getByRole('button',{name:'取消状态变更',exact:true}).click();expect(posts).toHaveLength(0);const cancelled=await request.get(readPath,{headers});expect((await cancelled.json()).data.contract.version).toBe(2);
 await area.getByRole('button',{name:'恢复此暂停合同',exact:true}).click();await area.getByRole('button',{name:'确认恢复群合同',exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 const receipt=area.getByRole('complementary',{name:'群合同状态回执',exact:true});await expect(receipt).toContainText('逻辑回执：已登记启用 · 版本 3');expect(posts).toHaveLength(1);expect(posts[0]!.body).toEqual(body);expect(posts[0]!.key).toMatch(/^[a-f0-9-]{36}$/);
 const current=await request.get(readPath,{headers});expect(current.status()).toBe(200);const after=(await current.json()).data.contract;expect(after.version).toBe(3);expect(after.document).toEqual({...before.document,state:'ACTIVE',version:3,stateUpdatedAt:after.document.stateUpdatedAt});
 const replay=await request.post(path,{headers:{...headers,'idempotency-key':posts[0]!.key!},data:body});expect(replay.status()).toBe(200);expect((await replay.json()).data).toMatchObject({state:'ACTIVE',version:3,replayed:true,currentVersion:3});
 const stale=await request.post(path,{headers:{...headers,'idempotency-key':randomUUID()},data:body});expect(stale.status()).toBe(409);
 const revoked=await request.post(path,{headers:{...headers,'idempotency-key':randomUUID()},data:{...body,expectedVersion:3,state:'REVOKED'}});expect(revoked.status()).toBe(200);
 await area.getByRole('button',{name:'读取群合同',exact:true}).click();await expect(area.getByText('合同登记状态：已撤销',{exact:true})).toBeVisible();await expect(area.getByRole('button',{name:'恢复此暂停合同',exact:true})).toHaveCount(0);
 const resurrection=await request.post(path,{headers:{...headers,'idempotency-key':randomUUID()},data:{...body,expectedVersion:4}});expect(resurrection.status()).toBe(409);const final=await request.get(readPath,{headers});expect((await final.json()).data.contract).toMatchObject({version:4,document:{state:'REVOKED'}});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'reports/group-contract-restoration-20261021/'+info.project.name+'-actual-api.png',fullPage:true});
});
