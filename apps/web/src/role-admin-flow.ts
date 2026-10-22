export type RoleName='TENANT_ADMIN'|'ACTION_APPROVER'|'SECURITY_OPERATOR';
export type ScopeKind='TENANT'|'CAPABILITY'|'CONNECTOR'|'RESOURCE'|'TASK'|'USER';
export type PolicyState='ACTIVE'|'EXPIRED'|'REVOKED';
export type ManagedRoleBinding={id:string;targetUserId:string;roleName:string;scopeKind:string;scopeId:string;scopeTruncated:boolean;expiresAt:string|null;version:number;managed:boolean;state:PolicyState};
export type RoleAdminReceipt={id:string;targetUserId:string;roleName:RoleName;scopeKind:ScopeKind;scopeId:string;version:number;state:'ACTIVE'|'REVOKED';expiresAt:string;replayed:boolean;reauthenticationRequired:boolean;platformPermissionsVerified:false;requestId:string;currentVersion:number;currentState:PolicyState};
export type RoleFilters={targetUserId?:string;id?:string};
export type RoleAdminOperation='assign'|'renew'|'revoke';
export type AssignInput={targetUserId:string;roleName:RoleName;scopeKind:ScopeKind;scopeId:string;expiresAt:string;reviewReference:string};
type Outcome={ok:boolean;notice:string;sessionLost?:boolean};
type SelectedBody={targetUserId:string;version:number;reviewReference:string;expiresAt?:string};
type Intent={operation:'assign';body:AssignInput;requestId:string}|{operation:'renew'|'revoke';item:ManagedRoleBinding;body:SelectedBody;requestId:string};
export type RoleIntent={operation:'assign';item:null;body:AssignInput}|{operation:'renew'|'revoke';item:ManagedRoleBinding;body:SelectedBody};
export type RoleAdminTransport=(path:string,body?:unknown,requestId?:string)=>Promise<unknown>;
export class RoleAdminFailure extends Error{constructor(readonly status:number){super('ROLE_ADMIN_REQUEST_FAILED');}}
const roleNames:readonly RoleName[]=['TENANT_ADMIN','ACTION_APPROVER','SECURITY_OPERATOR'],scopeKinds:readonly ScopeKind[]=['TENANT','CAPABILITY','CONNECTOR','RESOURCE','TASK','USER'];
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reviewPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_METADATA');return value as Record<string,unknown>;}
export const isRoleAdminUuid=(value:unknown):value is string=>typeof value==='string'&&uuidPattern.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const iso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const state=(value:unknown):value is PolicyState=>value==='ACTIVE'||value==='EXPIRED'||value==='REVOKED';
const isRole=(value:unknown):value is RoleName=>roleNames.includes(value as RoleName);
const isScope=(value:unknown):value is ScopeKind=>scopeKinds.includes(value as ScopeKind);
export function scopeReference(kind:ScopeKind|string,value:string):boolean{
 if(kind==='TENANT'||kind==='TASK'||kind==='USER')return isRoleAdminUuid(value);
 if(kind==='CAPABILITY')return /^[a-z][a-z0-9_.-]{0,127}$/.test(value);
 if(kind==='CONNECTOR')return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
 return value.length<=512&&!value.includes('://')&&/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(value);
}
function parseItem(raw:unknown):ManagedRoleBinding{
 const v=object(raw);
 if(!isRoleAdminUuid(v.id)||!isRoleAdminUuid(v.targetUserId)||!text(v.roleName,128)||!text(v.scopeKind,32)||!text(v.scopeId,512)||typeof v.scopeTruncated!=='boolean'||!(v.expiresAt===null||iso(v.expiresAt))||!version(v.version)||typeof v.managed!=='boolean'||!state(v.state))throw Error('INVALID_METADATA');
 return {id:v.id.toLowerCase(),targetUserId:v.targetUserId.toLowerCase(),roleName:v.roleName,scopeKind:v.scopeKind,scopeId:v.scopeId,scopeTruncated:v.scopeTruncated,expiresAt:v.expiresAt as string|null,version:v.version,managed:v.managed,state:v.state};
}
export function canManageRole(item:ManagedRoleBinding):boolean{
 return item.managed&&item.state!=='REVOKED'&&!item.scopeTruncated&&Number.isSafeInteger(item.version)&&item.version>0&&isRole(item.roleName)&&isScope(item.scopeKind)&&scopeReference(item.scopeKind,item.scopeId);
}
export function canRenewRole(item:ManagedRoleBinding):boolean{return canManageRole(item)&&item.state==='ACTIVE';}
function parseList(raw:unknown,filters:RoleFilters,cursor?:string){
 const value=object(raw);
 if(value.scope!=='TENANT_ROLE_METADATA_ONLY'||value.platformPermissionsVerified!==false||!Array.isArray(value.items)||value.items.length>50||!(value.nextCursor===null||isRoleAdminUuid(value.nextCursor)))throw Error('INVALID_METADATA');
 const items=value.items.map(parseItem),nextCursor=typeof value.nextCursor==='string'?value.nextCursor.toLowerCase():null;
 if(new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>filters.targetUserId&&i.targetUserId!==filters.targetUserId||filters.id&&i.id!==filters.id)||nextCursor&&nextCursor===cursor)throw Error('INVALID_METADATA');
 return {items,nextCursor};
}
function parseReceipt(raw:unknown,intent:Intent):RoleAdminReceipt{
 const v=object(raw),roleName=intent.operation==='assign'?intent.body.roleName:intent.item.roleName,scopeKind=intent.operation==='assign'?intent.body.scopeKind:intent.item.scopeKind,scopeId=intent.operation==='assign'?intent.body.scopeId:intent.item.scopeId,target=intent.operation==='assign'?intent.body.targetUserId:intent.item.targetUserId,expected=intent.operation==='assign'?1:intent.item.version+1;
 if(!isRoleAdminUuid(v.id)||intent.operation!=='assign'&&v.id.toLowerCase()!==intent.item.id||!isRoleAdminUuid(v.targetUserId)||v.targetUserId.toLowerCase()!==target||!isRoleAdminUuid(v.requestId)||v.requestId.toLowerCase()!==intent.requestId||!version(v.version)||v.version!==expected||!isRole(v.roleName)||v.roleName!==roleName||!isScope(v.scopeKind)||v.scopeKind!==scopeKind||v.scopeId!==scopeId||!iso(v.expiresAt)||v.state!==(intent.operation==='revoke'?'REVOKED':'ACTIVE')||typeof v.replayed!=='boolean'||typeof v.reauthenticationRequired!=='boolean'||v.platformPermissionsVerified!==false||!version(v.currentVersion)||v.currentVersion<v.version||!state(v.currentState))throw Error('INVALID_RECEIPT');
 return {id:v.id.toLowerCase(),targetUserId:v.targetUserId.toLowerCase(),roleName:v.roleName,scopeKind:v.scopeKind,scopeId:v.scopeId,version:v.version,state:v.state as 'ACTIVE'|'REVOKED',expiresAt:v.expiresAt,replayed:v.replayed,reauthenticationRequired:v.reauthenticationRequired,platformPermissionsVerified:false,requestId:v.requestId.toLowerCase(),currentVersion:v.currentVersion,currentState:v.currentState};
}
function failure(error:unknown,writing=false):Outcome{
 const status=error instanceof RoleAdminFailure?error.status:0;
 if(!writing&&![401,403,404].includes(status))return {ok:false,notice:status===400?'筛选条件未通过检查，请使用有效 UUID；未提交变更。':'角色资料未能核实，旧资料已清除；请核对筛选条件和访问状态。'};
 const notice=status===401?'会话已失效，请重新登录后核对角色记录。':status===403?'当前管理权限或角色范围条件未满足，已清除旧资料，请核对管理员资格与可分配角色。':status===409?'记录版本、重复分配或最后管理员限制发生冲突，未确认本次变更；请重新查询后核对，不会自动重发。':status===404?'目标用户或角色记录不可用，已清除旧资料，请重新核对目标与范围。':status===400?'提交条件未通过检查，请核对角色范围、有效期和审核引用；不会自动重发。':status===503?'管理服务暂不可用，变更尚未确认；不会自动重发。':'响应未能核实，变更结果可能未知；已清除本次确认，不会自动重发或更换幂等键。';
 return {ok:false,notice,...(status===401?{sessionLost:true}:{})};
}
export class RoleAdminFlow{
 items:ManagedRoleBinding[]=[];
 nextCursor:string|null=null;
 selected:ManagedRoleBinding|null=null;
 receipt:RoleAdminReceipt|null=null;
 private confirmation:Intent|null=null;
 private pending=false;
 private generation=0;
 constructor(private transport:RoleAdminTransport,private newKey:()=>string=()=>crypto.randomUUID(),private now:()=>number=Date.now){}
 get busy(){return this.pending;}
 get intent():RoleIntent|null{
  const c=this.confirmation;
  return c===null?null:c.operation==='assign'?{operation:'assign',item:null,body:c.body}:{operation:c.operation,item:c.item,body:c.body};
 }
 private erase(){this.items=[];this.nextCursor=null;this.selected=null;this.receipt=null;this.confirmation=null;}
 clear(){this.generation++;this.pending=false;this.erase();}
 private window(expiresAt:string){const time=Date.parse(expiresAt);return iso(expiresAt)&&time>this.now()&&time<=this.now()+366*86400000;}
 async load(filters:RoleFilters={},cursor?:string):Promise<Outcome|null>{
  if(this.pending)return null;
  this.erase();this.pending=true;const generation=++this.generation;
  try{
   const query=new URLSearchParams(),normalized:RoleFilters={};
   for(const name of ['targetUserId','id'] as const){const value=filters[name];if(value!==undefined&&value!==''){if(!isRoleAdminUuid(value))throw new RoleAdminFailure(400);normalized[name]=value.toLowerCase();query.set(name,value.toLowerCase());}}
   if(cursor!==undefined){if(!isRoleAdminUuid(cursor))throw new RoleAdminFailure(400);query.set('cursor',cursor.toLowerCase());}
   const raw=await this.transport('/admin/roles'+(query.size?'?'+query.toString():''));if(generation!==this.generation)return null;
   const value=parseList(raw,normalized,cursor);this.items=value.items;this.nextCursor=value.nextCursor;
   return {ok:true,notice:'仅展示企业角色绑定元数据；平台权限与群治理尚未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 select(id:string){if(this.pending)return false;this.confirmation=null;this.receipt=null;const item=this.items.find(i=>i.id===id);this.selected=item&&canManageRole(item)?item:null;return this.selected!==null;}
 cancel(){if(!this.pending){this.confirmation=null;this.selected=null;}}
 prepareAssign(input:AssignInput):Outcome{
  this.confirmation=null;
  if(this.pending||!isRoleAdminUuid(input.targetUserId)||!isRole(input.roleName)||!isScope(input.scopeKind)||!scopeReference(input.scopeKind,input.scopeId)||!this.window(input.expiresAt)||!reviewPattern.test(input.reviewReference))return {ok:false,notice:'请填写有效的目标用户、角色、范围、366 天内的有效期和审核引用。'};
  try{const key=this.newKey();if(!isRoleAdminUuid(key))throw Error('INVALID_KEY');this.confirmation={operation:'assign',body:{...input,targetUserId:input.targetUserId.toLowerCase()},requestId:key.toLowerCase()};return {ok:true,notice:'请核对精确目标、角色和范围；取消不会提交变更。'};}catch{return failure(null);}
 }
 prepare(operation:Exclude<RoleAdminOperation,'assign'>,reviewReference:string,expiresAt?:string):Outcome{
  this.confirmation=null;
  if(this.pending||!this.selected)return {ok:false,notice:'请先选择一条受管角色记录。'};
  const item=this.selected;
  if(!reviewPattern.test(reviewReference)||!canManageRole(item)||(operation==='renew'&&(!canRenewRole(item)||!expiresAt||!this.window(expiresAt)||item.expiresAt!==null&&Date.parse(expiresAt)<=Date.parse(item.expiresAt))))return {ok:false,notice:'请核对所选记录状态，并填写有效的审核引用和更晚的续期时间。'};
  try{const key=this.newKey();if(!isRoleAdminUuid(key))throw Error('INVALID_KEY');this.confirmation={operation,item:{...item},requestId:key.toLowerCase(),body:{targetUserId:item.targetUserId,version:item.version,reviewReference,...(operation==='renew'?{expiresAt:expiresAt!}:{})}};return {ok:true,notice:'请核对精确目标、角色范围及记录版本；取消不会提交变更。'};}catch{return failure(null);}
 }
 async confirm():Promise<Outcome|null>{
  if(this.pending||!this.confirmation)return null;
  const intent=this.confirmation;this.erase();this.pending=true;const generation=++this.generation;
  try{
   const path=intent.operation==='assign'?'/admin/roles':'/admin/roles/'+encodeURIComponent(intent.item.id)+'/'+intent.operation;
   const raw=await this.transport(path,intent.body,intent.requestId);if(generation!==this.generation)return null;
   const receipt=parseReceipt(raw,intent);if(receipt.reauthenticationRequired){this.erase();return {ok:true,sessionLost:true,notice:'角色回执要求重新登录，旧资料已清除，请重新登录后核对。'};}
   this.receipt=receipt;return {ok:true,notice:receipt.replayed?'收到已记录角色操作意图的重放回执；它不代表当前绑定仍然有效。':'角色操作意图回执已核实；请分别核对回执和记录状态，平台权限仍未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
