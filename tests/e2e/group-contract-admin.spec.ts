import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test.skip(!process.env['GROUP_CONTRACT_ADMIN_BUNDLE'],'A dedicated offline real-component bundle is required; a skipped run is not validation.');
test.beforeAll(()=>expect(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard'))).toBe(true));
const delegation='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',admin='30000000-0000-4000-8000-000000000001',service='40000000-0000-4000-8000-000000000001',revision='50000000-0000-4000-8000-000000000001',nextRevision='50000000-0000-4000-8000-000000000002';
const secret='SYNTHETIC_PRIVATE_GROUP_MARKER_MUST_DISAPPEAR';
function snapshot(){return {authority:{id:delegation,groupId:'synthetic-group',administratorId:admin,serviceIdentityId:service,reviewReference:'review-2026-1',validUntil:'2099-01-01T00:00:00+00:00',currency:'CNY',maxAmountMinor:100,authority:'REVIEWED_DELEGATION',platformPermissionsVerified:false},contract:{revisionId:revision,version:3,document:{schemaVersion:1,id,tenantId:'synthetic-tenant',groupId:'synthetic-group',version:3,serviceIdentityId:service,administratorAuthorization:{actorId:admin,evidenceRef:'review-2026-1'},responsibilityScope:['记录明确提交的事项'],sources:{mode:'MENTION_ONLY',entries:[{kind:'MENTION',resourceRef:'synthetic-source'}]},actions:{allowed:['case.record'],prohibited:['case.assign']},workHours:{timezone:'Asia/Shanghai',windows:[{daysOfWeek:[1,2,3,4,5],start:'09:00',end:'18:00'}]},mentionUserIds:[],escalationUserIds:[],validFrom:'2020-01-01T00:00:00Z',expiresAt:'2098-01-01T00:00:00Z',state:'ACTIVE',stateUpdatedAt:'2020-01-01T00:00:00Z',budget:{currency:'CNY',maxAmountMinor:50},revocation:{method:'authenticated administrator'}}},platformPermissionsVerified:false};}
const receipt=(state='PAUSED')=>({id,revisionId:nextRevision,version:4,state,replayed:false,currentVersion:4,currentState:state,platformPermissionsVerified:false});
function own(groupRole=true,resources=false){return {roles:{items:[...(groupRole?[{id:admin,name:'GROUP_ADMIN',scope_kind:'GROUP',scope_id:'synthetic-group',state:'ACTIVE',version:1,expires_at:null}]:[]),...(resources?[{id:service,name:'TENANT_ADMIN',scope_kind:'TENANT',scope_id:'synthetic-tenant',state:'ACTIVE',version:1,expires_at:null}]:[])],nextCursor:null},grants:{items:[{id:service,capability_id:'synthetic.own',display_name:'本人合成功能',resource_ref:'own-synthetic-resource',audience_kind:'PRIVATE_USER',classification_ceiling:'INTERNAL',state:'ACTIVE',version:1,expires_at:'2099-01-01T00:00:00Z',versions:['1.0.0']}],nextCursor:null}};}
type Call={path:string;method:string;body:unknown;key:string|undefined;csrf:string|undefined;origin:string|undefined};
type Scenario={metadata?:unknown;readStatus?:number;status?:number;abort?:boolean;hold?:Promise<void>;readHold?:Promise<void>;noRole?:boolean;resources?:boolean;override?:(value:ReturnType<typeof receipt>)=>unknown};
async function mount(page:Page,scenario:Scenario={}){
 const calls:Call[]=[],unexpected:string[]=[];let role=!scenario.noRole;
 const bundle=await readFile(process.env['GROUP_CONTRACT_ADMIN_BUNDLE']!,'utf8');
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!=='http://127.0.0.1:64702'){unexpected.push(url.origin);return route.abort('blockedbyclient');}
  if(path==='/group-contract-admin')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>'});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(path==='/api/v1/permissions')return route.fulfill({json:{data:own(role,scenario.resources)}});
  calls.push({path:path+url.search,method:req.method(),body:req.method()==='POST'?req.postDataJSON():undefined,key:req.headers()['idempotency-key'],csrf:req.headers()['x-csrf-token'],origin:req.headers()['origin']});
  if(path==='/api/v1/group-contracts'){
   if(scenario.readHold)await scenario.readHold;
   return route.fulfill({status:scenario.readStatus??200,json:scenario.readStatus?{error:{code:'GROUP_CONTRACT_AUTHORITY_REQUIRED',correlationId:secret}}:{data:Object.hasOwn(scenario,'metadata')?scenario.metadata:snapshot()}});
  }
  if(path===`/api/v1/group-contracts/${id}/state`){
   if(scenario.hold)await scenario.hold;if(scenario.abort)return route.abort('failed');const value=receipt((req.postDataJSON() as {state:string}).state);
   return route.fulfill({status:scenario.status??200,json:scenario.status?{error:{code:'GROUP_CONTRACT_VERSION_CONFLICT',correlationId:secret}}:{data:scenario.override?scenario.override(value):value,private:secret}});
  }
  if(path==='/api/v1/permissions/admin/resources')return route.fulfill({json:{data:{items:[{id:admin,targetUserId:admin,capabilityId:'synthetic.resource',capabilityVersion:'1.0.0',bindingHash:'a'.repeat(64),manifestId:revision,descriptorHash:'b'.repeat(64),resourceId:'existing-managed-resource',resourceTruncated:false,classificationCeiling:'INTERNAL',expiresAt:'2099-01-01T00:00:00Z',version:3,managed:true,state:'ACTIVE'}],nextCursor:null,scope:'TENANT_POLICY_METADATA_ONLY',platformPermissionsVerified:false}}});
  if(path===`/api/v1/permissions/resources/${service}/diagnostic`)return route.fulfill({json:{data:{description:'本人合成检查',reason:'UNKNOWN',requiredScopes:['Synthetic.Read'],checkedAt:'2026-10-18T00:00:00Z'}}});
  if(path===`/api/v1/permissions/resources/${service}/withdraw`)return route.fulfill({json:{data:{reauthenticationRequired:true}}});
  unexpected.push(path);return route.abort('blockedbyclient');
 });
 await page.goto('http://127.0.0.1:64702/group-contract-admin');
 return {calls,unexpected,revokeRole:()=>{role=false;}};
}
const area=(page:Page)=>page.getByRole('region',{name:'已有群合同管理',exact:true});
async function read(page:Page){await area(page).getByLabel('已审核委托 UUID',{exact:true}).fill(delegation);await area(page).getByRole('button',{name:'读取群合同',exact:true}).click();}
async function prepare(page:Page,state:'PAUSED'|'REVOKED'='PAUSED'){await read(page);await area(page).getByRole('button',{name:state==='PAUSED'?'暂停此群合同':'撤销此群合同',exact:true}).click();await expect(area(page).getByRole('complementary',{name:'确认群合同状态变更'})).toBeVisible();}
const submit=(page:Page,state='PAUSED')=>area(page).getByRole('button',{name:state==='PAUSED'?'确认暂停群合同':'确认撤销群合同',exact:true});
async function safe(page:Page){expect(await page.content()).not.toContain(secret);await expect(area(page).getByRole('button',{name:/创建|激活|恢复|审批委托|重试|重发/})).toHaveCount(0);}

for(const state of ['PAUSED','REVOKED'] as const){
 test(`${state}: explicit UUID read, cancel, single fixed-key confirmation and exact CSRF/body`,async({page})=>{
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const {calls,unexpected}=await mount(page,{hold});await expect(area(page)).toBeVisible();expect(calls).toEqual([]);await prepare(page,state);expect(calls[0]!.path).toBe(`/api/v1/group-contracts?delegationId=${delegation}`);await expect(area(page)).toContainText('REVIEWED_DELEGATION');await expect(area(page)).toContainText('平台权限：尚未核实');await area(page).getByRole('button',{name:'取消状态变更'}).click();expect(calls.filter(c=>c.method==='POST')).toEqual([]);
  await area(page).getByRole('button',{name:state==='PAUSED'?'暂停此群合同':'撤销此群合同',exact:true}).click();await submit(page,state).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});await expect.poll(()=>calls.filter(c=>c.method==='POST').length).toBe(1);release();await expect(area(page).getByRole('complementary',{name:'群合同状态回执'})).toBeVisible();
  const post=calls.find(c=>c.method==='POST')!;expect(post.path).toBe(`/api/v1/group-contracts/${id}/state`);expect(post.body).toEqual({delegationId:delegation,expectedVersion:3,state});expect(post.csrf).toBe('synthetic-csrf');expect(post.origin).toBe('http://127.0.0.1:64702');expect(post.key).toMatch(/^[a-f0-9-]{36}$/);await expect(area(page)).toContainText('在途或结果未知的动作仍需核对，不会补发');expect(unexpected).toEqual([]);await safe(page);
 });
}

for(const [name,scenario] of [
 ['wrong delegation',{metadata:{...snapshot(),authority:{...snapshot().authority,id}}}],['wrong group',{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,groupId:'other'}}}}],['wrong service',{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,serviceIdentityId:admin}}}}],['wrong administrator',{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,administratorAuthorization:{actorId:service,evidenceRef:'review-2026-1'}}}}}],['expired delegation',{metadata:{...snapshot(),authority:{...snapshot().authority,validUntil:'2020-01-01T00:00:00Z'}}}],['over budget',{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,budget:{currency:'CNY',maxAmountMinor:101}}}}}],['old snapshot',{metadata:{contract:snapshot().contract}}],['malformed document',{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,private:secret}}}}],['403 read',{readStatus:403}],['404 read',{readStatus:404}],
] as const){
 test(`${name}: no contract details or confirmation can survive an invalid read`,async({page})=>{const {calls}=await mount(page,scenario);await read(page);await expect(area(page).getByRole('status')).toContainText(/无法核实|未满足|未找到/);await expect(area(page).getByRole('article')).toHaveCount(0);await expect(area(page).getByRole('complementary',{name:'确认群合同状态变更'})).toHaveCount(0);expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);await safe(page);});
}

for(const [name,metadata] of [['missing',{...snapshot(),contract:null}],['expired contract',{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,expiresAt:'2020-02-01T00:00:00Z'}}}],['revoked contract',{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,state:'REVOKED'}}}]] as const){
 test(`${name}: existing delegation is read-only with no state buttons`,async({page})=>{await mount(page,{metadata});await read(page);await expect(area(page).getByRole('article',{name:'审核委托资料'})).toBeVisible();await expect(area(page).getByRole('button',{name:'暂停此群合同'})).toHaveCount(0);await expect(area(page).getByRole('button',{name:'撤销此群合同'})).toHaveCount(0);await safe(page);});
}

test('paused contract offers explicit restoration and retains revocation',async({page})=>{await mount(page,{metadata:{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,state:'PAUSED'}}}});await read(page);await expect(area(page).getByRole('button',{name:'暂停此群合同'})).toHaveCount(0);await expect(area(page).getByRole('button',{name:'恢复此暂停合同',exact:true})).toBeVisible();await area(page).getByRole('button',{name:'撤销此群合同'}).click();await submit(page,'REVOKED').click();await expect(area(page).getByRole('complementary',{name:'群合同状态回执'})).toContainText('逻辑回执：已撤销 · 版本 4');await safe(page);});

test('restoration request reaches the real 15s browser deadline and remains unknown without retry',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const metadata=snapshot();metadata.contract.document.state='PAUSED';const {calls}=await mount(page,{metadata,hold});
 try{await read(page);await area(page).getByRole('button',{name:'恢复此暂停合同',exact:true}).click();await area(page).getByRole('button',{name:'确认恢复群合同',exact:true}).click();await expect(area(page).getByRole('status')).toContainText('状态变更响应无法核实，结果可能未知',{timeout:18000});expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);await expect(area(page).getByRole('article')).toHaveCount(0);await expect(area(page).getByRole('complementary')).toHaveCount(0);await safe(page);}finally{release();}
});

for(const [name,scenario] of [
 ['403 write',{status:403}],['409 conflict',{status:409}],['network unknown',{abort:true}],['wrong contract',{override:(v:ReturnType<typeof receipt>)=>({...v,id:service})}],['old revision',{override:(v:ReturnType<typeof receipt>)=>({...v,revisionId:revision})}],['old version',{override:(v:ReturnType<typeof receipt>)=>({...v,version:3})}],['wrong state',{override:(v:ReturnType<typeof receipt>)=>({...v,state:'ACTIVE'})}],['stale current version',{override:(v:ReturnType<typeof receipt>)=>({...v,currentVersion:2})}],['contradictory current state',{override:(v:ReturnType<typeof receipt>)=>({...v,currentState:'ACTIVE'})}],['malformed receipt',{override:(v:ReturnType<typeof receipt>)=>({...v,platformPermissionsVerified:true})}],['old incomplete receipt',{override:()=>({id,state:'PAUSED'})}],['foreign receipt shape',{override:(v:ReturnType<typeof receipt>)=>({...v,requestId:delegation})}],
] as const){
 test(`${name}: no success, retry, fallback action or old private text`,async({page})=>{
  const metadata=snapshot();metadata.contract.document.responsibilityScope=[secret];const {calls}=await mount(page,{...scenario,metadata});await prepare(page);await expect(area(page).getByText(secret,{exact:true})).toBeVisible();await submit(page).click();await expect(area(page).getByRole('status')).toContainText(/未满足|未确认|无法核实/);await expect(area(page).getByRole('complementary',{name:'群合同状态回执'})).toHaveCount(0);await expect(area(page).getByRole('article')).toHaveCount(0);expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

for(const scenario of [{readStatus:401},{status:401}]){
 test(`401 ${scenario.readStatus?'read':'write'} invokes original re-login and clears private data`,async({page})=>{const {calls}=await mount(page,scenario);if(scenario.readStatus)await read(page);else{await prepare(page);await submit(page).click();}await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();await expect(area(page)).toHaveCount(0);expect(await page.evaluate(()=>Reflect.get(window,'sessionLosses'))).toBe(1);expect(calls.filter(c=>c.method==='POST')).toHaveLength(scenario.readStatus?0:1);expect(await page.content()).not.toContain(secret);});
}

test('historical pause and newer revoked state stay separate; a subsequent old read is refused',async({page})=>{await mount(page,{override:v=>({...v,replayed:true,currentVersion:9,currentState:'REVOKED'})});await prepare(page);await submit(page).click();const view=area(page).getByRole('complementary',{name:'群合同状态回执'});await expect(view).toContainText('逻辑回执：已暂停 · 版本 4');await expect(view).toContainText('记录状态：已撤销 · 版本 9');await expect(view).toContainText('不能作为当前状态');await area(page).getByRole('button',{name:'读取群合同'}).click();await expect(area(page).getByRole('status')).toContainText('群合同资料无法核实');await expect(area(page).getByRole('article')).toHaveCount(0);await safe(page);});

test('contract markup is inert text, never HTML or injected code',async({page})=>{const value=snapshot(),markup='<img src="/private-marker" onerror="window.groupInjected=true">';value.contract.document.responsibilityScope=[markup];const {unexpected}=await mount(page,{metadata:value});await read(page);await expect(area(page).getByText(markup,{exact:true})).toBeVisible();await expect(page.locator('img')).toHaveCount(0);expect(await page.evaluate(()=>Reflect.get(window,'groupInjected'))).toBeUndefined();expect(unexpected).toEqual([]);await safe(page);});

for(const kind of ['read','write'] as const)for(const lifecycle of ['csrf','role','unmount'] as const){
 test(`${lifecycle} invalidation discards late ${kind} response`,async({page})=>{
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const fixture=await mount(page,kind==='read'?{readHold:hold}:{hold});if(kind==='read'){await read(page);await expect.poll(()=>fixture.calls.length).toBe(1);}else{await prepare(page);await submit(page).click();await expect.poll(()=>fixture.calls.filter(c=>c.method==='POST').length).toBe(1);}
  if(lifecycle==='csrf')await page.evaluate(()=>Reflect.get(window,'replaceGroupCsrf')('replacement-csrf'));else if(lifecycle==='role'){fixture.revokeRole();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}else await page.evaluate(()=>Reflect.get(window,'unmountPermissions')());
  release();if(lifecycle==='csrf'){await expect(area(page)).toBeVisible();await expect(area(page).getByRole('article')).toHaveCount(0);await expect(area(page).getByRole('complementary')).toHaveCount(0);await expect(area(page).getByLabel('已审核委托 UUID')).toHaveValue('');}else await expect(area(page)).toHaveCount(0);expect(fixture.calls.filter(c=>c.method==='POST')).toHaveLength(kind==='read'?0:1);expect(await page.content()).not.toContain(secret);
 });
}

test('without GROUP_ADMIN there is no group entry or group request',async({page})=>{const {calls}=await mount(page,{noRole:true});await expect(page.getByRole('heading',{name:'我的权限',exact:true})).toBeVisible();await expect(area(page)).toHaveCount(0);expect(calls).toEqual([]);});

test('own permission and managed-resource entries remain interactive',async({page})=>{
 const {calls}=await mount(page,{resources:true});const adminArea=page.getByRole('region',{name:'管理员资源策略',exact:true});await expect(adminArea.getByText('资源：existing-managed-resource',{exact:true})).toBeVisible();await adminArea.getByRole('button',{name:'选择此策略'}).click();await expect(adminArea.getByRole('form',{name:'管理所选策略'})).toBeVisible();await adminArea.getByRole('button',{name:'取消选择'}).click();await page.getByRole('button',{name:'重新检查',exact:true}).click();await expect(page.getByRole('complementary',{name:'权限检查结果'})).toContainText('平台状态：尚未核实');await page.getByRole('button',{name:'撤销此资源授权',exact:true}).click();await page.getByRole('button',{name:'保留授权',exact:true}).click();expect(calls.filter(c=>c.path.endsWith('/withdraw'))).toHaveLength(0);await page.getByRole('button',{name:'撤销此资源授权',exact:true}).click();await page.getByRole('button',{name:'确认撤销并重新登录',exact:true}).click();await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();expect(calls.filter(c=>c.path.startsWith('/api/v1/group-contracts'))).toHaveLength(0);expect(await page.content()).not.toContain(secret);
});
