import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test.skip(!process.env['PERMISSION_ADMIN_BUNDLE'],'Use the dedicated offline real-component bundle, with no backend setup.');
const id='10000000-0000-4000-8000-000000000001',target='20000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002',manifest='40000000-0000-4000-8000-000000000001';
const secret='SYNTHETIC_PRIVATE_ADMIN_DATA_DO_NOT_RENDER';
const item=()=>({id,targetUserId:target,capabilityId:'synthetic.read',capabilityVersion:'1.0.0',bindingHash:'a'.repeat(64),manifestId:manifest,descriptorHash:'b'.repeat(64),resourceId:'synthetic-resource',resourceTruncated:false,classificationCeiling:'INTERNAL',expiresAt:'2098-01-01T00:00:00Z',version:3,managed:true,state:'ACTIVE'});
const list=()=>({items:[item()],nextCursor:null,scope:'TENANT_POLICY_METADATA_ONLY',platformPermissionsVerified:false});
const receipt=(key:string,operation='renew')=>({id,targetUserId:target,version:4,state:operation==='renew'?'ACTIVE':'REVOKED',replayed:false,reauthenticationRequired:false,platformPermissionsVerified:false,requestId:key,currentVersion:4,currentState:operation==='renew'?'ACTIVE':'REVOKED'});
const own=(admin=true)=>({roles:{items:admin?[{id:manifest,name:'TENANT_ADMIN',scope_kind:'TENANT',scope_id:manifest,state:'ACTIVE',version:1,expires_at:null}]:[],nextCursor:null},grants:{items:[{id:second,capability_id:'synthetic.own',display_name:'本人合成功能',resource_ref:'own-synthetic-resource',audience_kind:'PRIVATE_USER',classification_ceiling:'INTERNAL',state:'ACTIVE',version:1,expires_at:'2098-01-01T00:00:00Z',versions:['1.0.0']}],nextCursor:null}});
const roleId='50000000-0000-4000-8000-000000000001';
const roleItem=()=>({id:roleId,targetUserId:target,roleName:'ACTION_APPROVER',scopeKind:'CAPABILITY',scopeId:'synthetic.capability',scopeTruncated:false,expiresAt:'2027-01-01T00:00:00Z',version:2,managed:true,state:'ACTIVE'});
const roleList=()=>({items:[roleItem()],nextCursor:null,scope:'TENANT_ROLE_METADATA_ONLY',platformPermissionsVerified:false});
function roleReceiptFor(key:string,path:string,body:Record<string,unknown>){
 const operation=path.endsWith('/renew')?'renew':path.endsWith('/revoke')?'revoke':'assign',version=operation==='assign'?1:Number(body['version'])+1;
 return {id:roleId,targetUserId:body['targetUserId'],roleName:operation==='assign'?body['roleName']:'ACTION_APPROVER',scopeKind:operation==='assign'?body['scopeKind']:'CAPABILITY',scopeId:operation==='assign'?body['scopeId']:'synthetic.capability',version,state:operation==='revoke'?'REVOKED':'ACTIVE',expiresAt:body['expiresAt']??'2027-06-01T00:00:00.000Z',replayed:false,reauthenticationRequired:false,platformPermissionsVerified:false,requestId:key,currentVersion:version,currentState:operation==='revoke'?'REVOKED':'ACTIVE'};
}
const templateKey='payments.success_rate_daily';
const templateItem=(version='1.0.0',active=false)=>({templateKey,templateVersion:version,templateHash:(version==='1.0.0'?'c':'d').repeat(64),certificationReference:'cert-review-2026-10',publishedAt:'2026-10-20T00:00:00.000Z',active,activeVersion:'1.1.0',activeRevision:4});
const templateList=()=>({items:[templateItem('1.0.0',false),templateItem('1.1.0',true)],truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
function templateReceiptFor(key:string,path:string,body:Record<string,unknown>){
 const version=String(body['templateVersion']),rollback=path.endsWith('/rollback');
 return {templateKey:body['templateKey'],templateVersion:version,activeVersion:version,activeRevision:rollback?Number(body['expectedRevision'])+1:5,operation:rollback?'ROLLBACK':'PUBLISH',replayed:false,requestId:key,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false};
}
type Call={path:string;method:string;body:unknown;key:string|undefined;csrf:string|undefined;origin:string|undefined};
type Scenario={metadata?:unknown;listStatus?:number;status?:number;abort?:boolean;hold?:Promise<void>;noAdmin?:boolean;pages?:boolean;override?:(value:ReturnType<typeof receipt>)=>unknown;roleMetadata?:unknown;roleListStatus?:number;roleStatus?:number;roleOverride?:(value:ReturnType<typeof roleReceiptFor>)=>unknown;templateMetadata?:unknown;templateListStatus?:number;templateStatus?:number;templateAbort?:boolean;templateHold?:Promise<void>;templateOverride?:(value:ReturnType<typeof templateReceiptFor>)=>unknown};
async function mount(page:Page,scenario:Scenario={}){
 const calls:Call[]=[],templateCalls:Call[]=[],unexpected:string[]=[];let admin=!scenario.noAdmin;
 const bundle=await readFile(process.env['PERMISSION_ADMIN_BUNDLE']!,'utf8');
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(url.origin!=='http://127.0.0.1:64702'){unexpected.push(url.origin);return route.abort('blockedbyclient');}
  if(path==='/permission-admin')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script></html>'});
  if(path==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:bundle});
  if(path==='/api/v1/permissions')return route.fulfill({json:{data:own(admin)}});
  if(path==='/api/v1/permissions/admin/roles'&&req.method()==='GET')return route.fulfill({status:scenario.roleListStatus??200,json:scenario.roleListStatus?{error:{code:'PERMISSION_ADMIN_DENIED',correlationId:secret}}:{data:scenario.roleMetadata??roleList()}});
  if(path==='/api/v1/permissions/admin/roles'||path.startsWith('/api/v1/permissions/admin/roles/')){
   const body=req.postDataJSON() as Record<string,unknown>,key=req.headers()['idempotency-key']!,value=roleReceiptFor(key,path,body);
   calls.push({path,method:req.method(),body,key,csrf:req.headers()['x-csrf-token'],origin:req.headers()['origin']});
   return route.fulfill({status:scenario.roleStatus??200,json:scenario.roleStatus?{error:{code:'PERMISSION_ROLE_BINDING_EXISTS',correlationId:secret}}:{data:scenario.roleOverride?scenario.roleOverride(value):value,private:secret}});
  }
  if(path==='/api/v1/data/templates'&&req.method()==='GET'){
   templateCalls.push({path,method:'GET',body:undefined,key:undefined,csrf:undefined,origin:req.headers()['origin']});
   return route.fulfill({status:scenario.templateListStatus??200,json:scenario.templateListStatus?{error:{code:'PERMISSION_ADMIN_DENIED',correlationId:secret}}:{data:scenario.templateMetadata??templateList()}});
  }
  if(path==='/api/v1/data/templates/publish'||path==='/api/v1/data/templates/rollback'){
   const body=req.postDataJSON() as Record<string,unknown>,key=req.headers()['idempotency-key']!,value=templateReceiptFor(key,path,body);
   templateCalls.push({path,method:req.method(),body,key,csrf:req.headers()['x-csrf-token'],origin:req.headers()['origin']});
   if(scenario.templateHold)await scenario.templateHold;
   if(scenario.templateAbort)return route.abort('failed');
   return route.fulfill({status:scenario.templateStatus??200,json:scenario.templateStatus?{error:{code:'COMPANY_DATA_TEMPLATE_VERSION_CONFLICT',correlationId:secret}}:{data:scenario.templateOverride?scenario.templateOverride(value):value,private:secret}});
  }
  calls.push({path:path+url.search,method:req.method(),body:req.method()==='POST'?req.postDataJSON():undefined,key:req.headers()['idempotency-key'],csrf:req.headers()['x-csrf-token'],origin:req.headers()['origin']});
  if(path==='/api/v1/permissions/admin/resources'){
   let data=scenario.metadata??list();if(scenario.pages)data=url.searchParams.has('cursor')?{...list(),items:[{...item(),id:second}],nextCursor:null}:{...list(),nextCursor:second};
   return route.fulfill({status:scenario.listStatus??200,json:scenario.listStatus?{error:{code:'PERMISSION_ADMIN_DENIED',correlationId:secret}}:{data}});
  }
  if(path.startsWith(`/api/v1/permissions/admin/resources/${id}/`)){
   if(scenario.hold)await scenario.hold;if(scenario.abort)return route.abort('failed');const value=receipt(req.headers()['idempotency-key']!,path.endsWith('/revoke')?'revoke':'renew');
   return route.fulfill({status:scenario.status??200,json:scenario.status?{error:{code:'PERMISSION_VERSION_CONFLICT',correlationId:secret}}:{data:scenario.override?scenario.override(value):value,private:secret}});
  }
  if(path===`/api/v1/permissions/resources/${second}/diagnostic`)return route.fulfill({json:{data:{grantId:second,description:'本人合成检查',reason:'UNKNOWN',requiredScopes:['Synthetic.Read'],checkedAt:'2026-10-18T00:00:00Z'}}});
  if(path===`/api/v1/permissions/resources/${second}/withdraw`)return route.fulfill({json:{data:{reauthenticationRequired:true}}});
  unexpected.push(path);return route.abort('blockedbyclient');
 });
 await page.goto('http://127.0.0.1:64702/permission-admin');
 return {calls,templateCalls,unexpected,revokeRole:()=>{admin=false;}};
}
const center=(page:Page)=>page.getByRole('region',{name:'管理员资源策略',exact:true});
async function prepare(page:Page,operation:'renew'|'revoke'='renew'){
 const area=center(page);await area.getByRole('button',{name:'选择此策略',exact:true}).first().click();await area.getByLabel('策略操作',{exact:true}).selectOption(operation);if(operation==='renew')await area.getByLabel('新到期时间',{exact:true}).fill('2099-01-01T12:00');await area.getByLabel('审核引用',{exact:true}).fill('review-2026:1');await area.getByRole('button',{name:'核对变更',exact:true}).click();await expect(area.getByRole('complementary',{name:'确认管理变更'})).toBeVisible();
}
const submit=(page:Page,operation='renew')=>center(page).getByRole('button',{name:operation==='renew'?'确认续期':'确认撤销策略',exact:true});
async function safe(page:Page){expect(await page.content()).not.toContain(secret);await expect(page.getByRole('button',{name:/新授|重授|自动重试|重发/})).toHaveCount(0);}

test('real Permissions mounts admin list, exact UUID filters and pagination without vendor claims',async({page})=>{
 const {calls,unexpected}=await mount(page,{pages:true});const area=center(page);await expect(area.getByText('资源：synthetic-resource',{exact:true})).toBeVisible();await expect(area).toContainText('平台权限尚未核实');await area.getByRole('button',{name:'下一页策略'}).click();await expect(area.getByRole('article',{name:'策略记录 '+second})).toBeVisible();expect(calls[1]!.path).toBe(`/api/v1/permissions/admin/resources?cursor=${second}`);
 await area.getByLabel('目标用户 UUID（可选）',{exact:true}).fill(target);await area.getByLabel('策略记录 UUID（可选）',{exact:true}).fill(id);await area.getByRole('button',{name:'加载策略',exact:true}).click();await expect(area.getByRole('article',{name:'策略记录 '+id})).toBeVisible();expect(calls.at(-1)!.path).toBe(`/api/v1/permissions/admin/resources?targetUserId=${target}&id=${id}`);expect(calls.every(c=>c.method==='GET')).toBe(true);expect(unexpected).toEqual([]);await safe(page);
});

for(const operation of ['renew','revoke'] as const){
 test(`${operation}: cancel sends nothing, explicit confirmation binds target/CAS/CSRF and double click submits once`,async({page})=>{
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const {calls}=await mount(page,{hold});await prepare(page,operation);await center(page).getByRole('button',{name:'取消变更'}).click();expect(calls.filter(c=>c.method==='POST')).toEqual([]);
  await prepare(page,operation);await submit(page,operation).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});await expect.poll(()=>calls.filter(c=>c.method==='POST').length).toBe(1);release();await expect(center(page).getByRole('complementary',{name:'策略变更回执'})).toBeVisible();
  const post=calls.find(c=>c.method==='POST')!;expect(post.path).toBe(`/api/v1/permissions/admin/resources/${id}/${operation}`);expect(post.csrf).toBe('synthetic-csrf');expect(post.origin).toBe('http://127.0.0.1:64702');expect(post.key).toMatch(/^[a-f0-9-]{36}$/);expect(post.body).toEqual({targetUserId:target,version:3,reviewReference:'review-2026:1',...(operation==='renew'?{expiresAt:'2099-01-01T12:00:00.000Z'}:{})});await safe(page);
 });
}

for(const [name,scenario] of [
 ['CAS conflict',{status:409}],['denied',{status:403}],['invalid input',{status:400}],['not found',{status:404}],['unavailable',{status:503}],['network unknown',{abort:true}],
 ['wrong id',{override:(v:ReturnType<typeof receipt>)=>({...v,id:second})}],['wrong target',{override:(v:ReturnType<typeof receipt>)=>({...v,targetUserId:manifest})}],['wrong key',{override:(v:ReturnType<typeof receipt>)=>({...v,requestId:manifest})}],['old receipt',{override:()=>({id,state:'ACTIVE'})}],['malformed',{override:(v:ReturnType<typeof receipt>)=>({...v,platformPermissionsVerified:true})}],['unknown state',{override:(v:ReturnType<typeof receipt>)=>({...v,currentState:'UNKNOWN'})}],['wrong operation',{override:(v:ReturnType<typeof receipt>)=>({...v,state:'REVOKED'})}],
] as const){
 test(`${name}: no success, no automatic resend, no private server text`,async({page})=>{
  const {calls}=await mount(page,scenario);await prepare(page);await submit(page).click();await expect(center(page).getByRole('status')).toContainText(/未确认|未满足|未通过|不可用|未能核实/);await expect(center(page).getByRole('complementary',{name:'策略变更回执'})).toHaveCount(0);await expect(center(page).getByRole('complementary',{name:'确认管理变更'})).toHaveCount(0);await expect(center(page).getByRole('article')).toHaveCount(0);expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

for(const scenario of [{status:401},{override:(v:ReturnType<typeof receipt>)=>({...v,reauthenticationRequired:true})}]){
 test(`session loss ${scenario.status??'receipt'} clears old metadata and invokes original login callback`,async({page})=>{
  const {calls}=await mount(page,scenario);await prepare(page);await submit(page).click();await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();await expect(center(page)).toHaveCount(0);await expect(page.getByText('本人合成功能 · 当前有效',{exact:true})).toHaveCount(0);expect(await page.evaluate(()=>Reflect.get(window,'sessionLosses'))).toBe(1);expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

test('replay separates logical renewal receipt from a currently revoked newer record',async({page})=>{
 await mount(page,{override:v=>({...v,replayed:true,currentVersion:9,currentState:'REVOKED'})});await prepare(page);await submit(page).click();const area=center(page).getByRole('complementary',{name:'策略变更回执'});await expect(area).toContainText('逻辑回执：有效 · 版本 4');await expect(area).toContainText('记录状态：已撤销 · 版本 9');await expect(area).toContainText('不能据此认定当前策略有效');await expect(area).toContainText('平台权限尚未核实');await safe(page);
});

for(const [name,change] of [['unmanaged',{managed:false}],['revoked',{state:'REVOKED'}],['truncated',{resourceTruncated:true}],['incomplete',{descriptorHash:null}]] as const){
 test(`${name} record cannot open a renewal or revocation form`,async({page})=>{await mount(page,{metadata:{...list(),items:[{...item(),...change}]}});await expect(center(page).getByRole('article')).toHaveCount(1);await expect(center(page).getByRole('button',{name:'选择此策略'})).toHaveCount(0);await expect(center(page).getByRole('form',{name:'管理所选策略'})).toHaveCount(0);await safe(page);});
}

for(const [name,scenario] of [['legacy metadata',{metadata:{items:[item()]}}],['malformed list',{metadata:{...list(),items:[{...item(),version:0}]}}],['denied metadata',{listStatus:403}]] as const){
 test(`${name} clears metadata without enabling management`,async({page})=>{await mount(page,scenario);await expect(center(page).getByRole('status')).toContainText(/未能核实|未满足/);await expect(center(page).getByRole('article')).toHaveCount(0);await safe(page);});
}

test('non-admin retains own inspect and withdrawal without fetching admin metadata',async({page})=>{
 const {calls,templateCalls}=await mount(page,{noAdmin:true});await expect(page.getByText('本人合成功能 · 当前有效',{exact:true})).toBeVisible();await expect(center(page)).toHaveCount(0);await expect(templateArea(page)).toHaveCount(0);expect(calls).toEqual([]);expect(templateCalls).toEqual([]);await page.getByRole('button',{name:'重新检查',exact:true}).click();await expect(page.getByRole('complementary',{name:'权限检查结果'})).toContainText('平台状态：尚未核实');await page.getByRole('button',{name:'撤销此资源授权',exact:true}).click();await page.getByRole('button',{name:'保留授权',exact:true}).click();expect(calls.filter(c=>c.path.endsWith('/withdraw'))).toHaveLength(0);await page.getByRole('button',{name:'撤销此资源授权',exact:true}).click();await page.getByRole('button',{name:'确认撤销并重新登录',exact:true}).click();await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();expect(calls.map(c=>c.path)).toEqual([`/api/v1/permissions/resources/${second}/diagnostic`,`/api/v1/permissions/resources/${second}/withdraw`]);await safe(page);
});

for(const lifecycle of ['csrf','role','unmount'] as const){
 test(`${lifecycle} invalidation discards late mutation reply and old confirmation`,async({page})=>{
  let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const fixture=await mount(page,{hold});await prepare(page);await submit(page).click();await expect.poll(()=>fixture.calls.filter(c=>c.method==='POST').length).toBe(1);
  if(lifecycle==='csrf')await page.evaluate(()=>Reflect.get(window,'replacePermissionCsrf')('replacement-csrf'));
  else if(lifecycle==='role'){fixture.revokeRole();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
  else await page.evaluate(()=>Reflect.get(window,'unmountPermissions')());
  release();if(lifecycle==='csrf'){await expect(center(page).getByRole('article')).toHaveCount(1);await expect(center(page).getByRole('complementary',{name:'策略变更回执'})).toHaveCount(0);await expect(center(page).getByRole('complementary',{name:'确认管理变更'})).toHaveCount(0);}else await expect(center(page)).toHaveCount(0);
  expect(fixture.calls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

const roleArea=(page:Page)=>page.getByRole('region',{name:'管理员角色分配',exact:true});
const roleForm=(page:Page,name:string)=>roleArea(page).getByRole('form',{name,exact:true});

test('role administration lists managed bindings with scope metadata and no platform claim',async({page})=>{
 const {unexpected}=await mount(page);const area=roleArea(page);await expect(area.getByRole('article',{name:'角色记录 '+roleId})).toBeVisible();await expect(area).toContainText('动作审批 · 范围：能力');await expect(area).toContainText('范围对象：synthetic.capability');await expect(area).toContainText('平台权限尚未核实');await expect(area.getByRole('button',{name:'选择此角色记录',exact:true})).toBeVisible();expect(unexpected).toEqual([]);await safe(page);
});

test('role assignment binds exact target, scope and one key without automatic resend',async({page})=>{
 const {calls}=await mount(page);const area=roleArea(page),form=roleForm(page,'分配角色');
 await form.getByLabel('目标用户 UUID',{exact:true}).fill(target);await form.getByLabel('可分配角色',{exact:true}).selectOption('SECURITY_OPERATOR');await form.getByLabel('范围类型',{exact:true}).selectOption('TASK');await form.getByLabel('范围对象',{exact:true}).fill(second);await form.getByLabel('到期时间',{exact:true}).fill('2027-06-01T12:00');await form.getByLabel('审核引用',{exact:true}).fill('role-review-1');await area.getByRole('button',{name:'核对分配',exact:true}).click();await expect(area.getByRole('complementary',{name:'确认角色变更'})).toContainText('角色：安全处理 · 范围：任务');
 await area.getByRole('button',{name:'确认分配',exact:true}).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});await expect.poll(()=>calls.filter(c=>c.method==='POST').length).toBe(1);await expect(area.getByRole('complementary',{name:'角色变更回执'})).toContainText('逻辑回执：有效 · 版本 1');
 const post=calls.find(c=>c.method==='POST')!;expect(post.path).toBe('/api/v1/permissions/admin/roles');expect(post.csrf).toBe('synthetic-csrf');expect(post.origin).toBe('http://127.0.0.1:64702');expect(post.key).toMatch(/^[a-f0-9-]{36}$/);expect(post.body).toEqual({targetUserId:target,roleName:'SECURITY_OPERATOR',scopeKind:'TASK',scopeId:second,expiresAt:'2027-06-01T12:00:00.000Z',reviewReference:'role-review-1'});await safe(page);
});

test('role renewal binds the exact record version and cannot be replayed by a second click',async({page})=>{
 const {calls}=await mount(page);const area=roleArea(page);await area.getByRole('button',{name:'选择此角色记录',exact:true}).click();const form=roleForm(page,'管理所选角色');await form.getByLabel('角色操作',{exact:true}).selectOption('renew');await form.getByLabel('新到期时间',{exact:true}).fill('2027-06-01T12:00');await form.getByLabel('审核引用',{exact:true}).fill('role-renew-1');await area.getByRole('button',{name:'核对变更',exact:true}).click();await expect(area.getByRole('complementary',{name:'确认角色变更'})).toContainText('预期记录版本：2');
 await area.getByRole('button',{name:'确认续期',exact:true}).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});await expect.poll(()=>calls.filter(c=>c.method==='POST').length).toBe(1);await expect(area.getByRole('complementary',{name:'角色变更回执'})).toContainText('逻辑回执：有效 · 版本 3');
 const post=calls.find(c=>c.method==='POST')!;expect(post.path).toBe(`/api/v1/permissions/admin/roles/${roleId}/renew`);expect(post.body).toEqual({targetUserId:target,version:2,expiresAt:'2027-06-01T12:00:00.000Z',reviewReference:'role-renew-1'});await safe(page);
});

test('role revocation submits the selected version and shows both receipt and current state',async({page})=>{
 const {calls}=await mount(page);const area=roleArea(page);await area.getByRole('button',{name:'选择此角色记录',exact:true}).click();const form=roleForm(page,'管理所选角色');await form.getByLabel('角色操作',{exact:true}).selectOption('revoke');await form.getByLabel('审核引用',{exact:true}).fill('role-revoke-1');await area.getByRole('button',{name:'核对变更',exact:true}).click();await area.getByRole('button',{name:'确认撤销角色',exact:true}).click();await expect(area.getByRole('complementary',{name:'角色变更回执'})).toContainText('逻辑回执：已撤销 · 版本 3');
 const post=calls.find(c=>c.method==='POST')!;expect(post.path).toBe(`/api/v1/permissions/admin/roles/${roleId}/revoke`);expect(post.body).toEqual({targetUserId:target,version:2,reviewReference:'role-revoke-1'});await safe(page);
});

for(const [name,scenario] of [['conflict',{roleStatus:409}],['wrong target',{roleOverride:(v:ReturnType<typeof roleReceiptFor>)=>({...v,targetUserId:manifest})}],['malformed',{roleOverride:(v:ReturnType<typeof roleReceiptFor>)=>({...v,platformPermissionsVerified:true})}]] as const){
 test(`role ${name}: no success, no private server text and no automatic retry`,async({page})=>{
  const {calls}=await mount(page,scenario);const area=roleArea(page);await area.getByRole('button',{name:'选择此角色记录',exact:true}).click();const form=roleForm(page,'管理所选角色');await form.getByLabel('角色操作',{exact:true}).selectOption('renew');await form.getByLabel('新到期时间',{exact:true}).fill('2027-06-01T12:00');await form.getByLabel('审核引用',{exact:true}).fill('role-renew-1');await area.getByRole('button',{name:'核对变更',exact:true}).click();await area.getByRole('button',{name:'确认续期',exact:true}).click();await expect(area.getByRole('status')).toContainText(/冲突|未能核实/);await expect(area.getByRole('complementary',{name:'角色变更回执'})).toHaveCount(0);await expect(area.getByRole('complementary',{name:'确认角色变更'})).toHaveCount(0);expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

const templateArea=(page:Page)=>page.getByRole('region',{name:'管理员数据模板',exact:true});
const templateForm=(page:Page,name:string)=>templateArea(page).getByRole('form',{name,exact:true});

test('data template registry shows local certification and rollback binds the exact active revision',async({page})=>{
 const {templateCalls,unexpected}=await mount(page);const area=templateArea(page);
 await expect(area.getByRole('article',{name:'模板版本 '+templateKey+'@1.0.0'})).toBeVisible();
 await expect(area).toContainText('本地认证版本登记');
 await expect(area).toContainText('平台认证与真实数据尚未核实');
 await expect(area.getByRole('article',{name:'模板版本 '+templateKey+'@1.1.0'})).toContainText('当前生效 · 记录版本 4');
 await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();
 const form=templateForm(page,'回退数据模板');await expect(form).toContainText('当前生效：1.1.0 · 记录版本 4');await form.getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();
 await expect(area.getByRole('complementary',{name:'确认数据模板变更'})).toContainText('预期记录版本：4');await area.getByRole('button',{name:'取消变更',exact:true}).click();expect(templateCalls.filter(c=>c.method==='POST')).toHaveLength(0);
 await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();await templateForm(page,'回退数据模板').getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();await area.getByRole('button',{name:'确认回退',exact:true}).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});
 await expect.poll(()=>templateCalls.filter(c=>c.method==='POST').length).toBe(1);await expect(area.getByRole('complementary',{name:'数据模板变更回执'})).toContainText('逻辑回执生效版本：1.0.0 · 记录版本 5');
 const post=templateCalls.find(c=>c.method==='POST')!;expect(post.path).toBe('/api/v1/data/templates/rollback');expect(post.csrf).toBe('synthetic-csrf');expect(post.origin).toBe('http://127.0.0.1:64702');expect(post.key).toMatch(/^[a-f0-9-]{36}$/);expect(post.body).toEqual({templateKey,templateVersion:'1.0.0',expectedRevision:4,reviewReference:'template-rollback-1'});expect(unexpected).toEqual([]);await safe(page);
});

test('data template publish sends the reviewed key and version with one fixed idempotency key',async({page})=>{
 const {templateCalls}=await mount(page);const area=templateArea(page),form=templateForm(page,'发布数据模板');
 await form.getByLabel('模板标识',{exact:true}).fill(templateKey);await form.getByLabel('模板版本',{exact:true}).fill('1.2.0');await form.getByLabel('审核引用',{exact:true}).fill('template-publish-1');await area.getByRole('button',{name:'核对发布',exact:true}).click();
 await expect(area.getByRole('complementary',{name:'确认数据模板变更'})).toContainText('模板：payments.success_rate_daily · 版本：1.2.0');await area.getByRole('button',{name:'确认发布',exact:true}).evaluate(b=>{(b as HTMLButtonElement).click();(b as HTMLButtonElement).click();});
 await expect.poll(()=>templateCalls.filter(c=>c.method==='POST').length).toBe(1);await expect(area.getByRole('complementary',{name:'数据模板变更回执'})).toContainText('操作：发布');
 const post=templateCalls.find(c=>c.method==='POST')!;expect(post.path).toBe('/api/v1/data/templates/publish');expect(post.csrf).toBe('synthetic-csrf');expect(post.origin).toBe('http://127.0.0.1:64702');expect(post.key).toMatch(/^[a-f0-9-]{36}$/);expect(post.body).toEqual({templateKey,templateVersion:'1.2.0',reviewReference:'template-publish-1'});await safe(page);
});

for(const [name,scenario] of [['conflict',{templateStatus:409}],['wrong version',{templateOverride:(v:ReturnType<typeof templateReceiptFor>)=>({...v,templateVersion:'1.0.1'})}],['uncertified claim',{templateOverride:(v:ReturnType<typeof templateReceiptFor>)=>({...v,platformCertification:'PLATFORM_CERTIFIED'})}],['network unknown',{templateAbort:true}]] as const){
 test(`data template ${name}: no success, no private server text and no automatic retry`,async({page})=>{
  const {templateCalls}=await mount(page,scenario);const area=templateArea(page);await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();await templateForm(page,'回退数据模板').getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();await area.getByRole('button',{name:'确认回退',exact:true}).click();
  await expect(area.getByRole('status')).toContainText(/冲突|未能核实/);await expect(area.getByRole('complementary',{name:'数据模板变更回执'})).toHaveCount(0);await expect(area.getByRole('complementary',{name:'确认数据模板变更'})).toHaveCount(0);await expect(area.getByRole('article')).toHaveCount(0);expect(templateCalls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
 });
}

test('data template session loss clears the registry and invokes the original login callback',async({page})=>{
 const {templateCalls}=await mount(page,{templateStatus:401});const area=templateArea(page);await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();await templateForm(page,'回退数据模板').getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();await area.getByRole('button',{name:'确认回退',exact:true}).click();
 await expect(page.getByText('需要重新登录',{exact:true})).toBeVisible();await expect(templateArea(page)).toHaveCount(0);await expect(page.getByText('本人合成功能 · 当前有效',{exact:true})).toHaveCount(0);expect(await page.evaluate(()=>Reflect.get(window,'sessionLosses'))).toBe(1);expect(templateCalls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
});

test('data template replay separates the logical receipt from a newer active version',async({page})=>{
 await mount(page,{templateOverride:v=>({...v,replayed:true,currentActiveVersion:'1.1.0',currentActiveRevision:9})});const area=templateArea(page);await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();await templateForm(page,'回退数据模板').getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();await area.getByRole('button',{name:'确认回退',exact:true}).click();
 const receipt=area.getByRole('complementary',{name:'数据模板变更回执'});await expect(receipt).toContainText('逻辑回执生效版本：1.0.0 · 记录版本 5');await expect(receipt).toContainText('这是历史操作意图的重放回执，不能据此认定当前生效版本。');await expect(receipt).toContainText('当前生效版本：1.1.0 · 记录版本 9');await expect(receipt).toContainText('平台认证与真实数据尚未核实');await safe(page);
});

test('data template unmount discards a late mutation reply and old confirmation',async({page})=>{
 let release!:()=>void;const hold=new Promise<void>(r=>{release=r;});const fixture=await mount(page,{templateHold:hold});const area=templateArea(page);await area.getByRole('button',{name:'选择回退至此版本',exact:true}).click();await templateForm(page,'回退数据模板').getByLabel('审核引用',{exact:true}).fill('template-rollback-1');await area.getByRole('button',{name:'核对回退',exact:true}).click();await area.getByRole('button',{name:'确认回退',exact:true}).click();
 await expect.poll(()=>fixture.templateCalls.filter(c=>c.method==='POST').length).toBe(1);await page.evaluate(()=>Reflect.get(window,'unmountPermissions')());release();await expect(templateArea(page)).toHaveCount(0);expect(fixture.templateCalls.filter(c=>c.method==='POST')).toHaveLength(1);await safe(page);
});
