export type PolicyState='ACTIVE'|'EXPIRED'|'REVOKED';
export type ManagedResource={id:string;targetUserId:string;capabilityId:string;capabilityVersion:string|null;bindingHash:string|null;manifestId:string|null;descriptorHash:string|null;resourceId:string;resourceTruncated:boolean;classificationCeiling:string;expiresAt:string;version:number;managed:boolean;state:PolicyState};
export type AdminReceipt={id:string;targetUserId:string;version:number;state:'ACTIVE'|'REVOKED';replayed:boolean;reauthenticationRequired:boolean;platformPermissionsVerified:false;requestId:string;currentVersion:number;currentState:PolicyState};
export type AdminFilters={targetUserId?:string;id?:string};
export type AdminOperation='renew'|'revoke';
type Outcome={ok:boolean;notice:string;sessionLost?:boolean};
type Intent={operation:AdminOperation;item:ManagedResource;body:{targetUserId:string;version:number;reviewReference:string;expiresAt?:string};requestId:string};
export type AdminTransport=(path:string,body?:unknown,requestId?:string)=>Promise<unknown>;
export class PermissionAdminFailure extends Error{constructor(readonly status:number){super('PERMISSION_ADMIN_REQUEST_FAILED');}}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_METADATA');return value as Record<string,unknown>;}
export const isAdminUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const iso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const state=(value:unknown):value is PolicyState=>value==='ACTIVE'||value==='EXPIRED'||value==='REVOKED';
function parseItem(raw:unknown):ManagedResource{
 const v=object(raw);
 if(!isAdminUuid(v.id)||!isAdminUuid(v.targetUserId)||!text(v.capabilityId,256)||!(v.capabilityVersion===null||text(v.capabilityVersion,64))||!(v.bindingHash===null||hash(v.bindingHash))||!(v.manifestId===null||isAdminUuid(v.manifestId))||!(v.descriptorHash===null||hash(v.descriptorHash))||!text(v.resourceId,512)||typeof v.resourceTruncated!=='boolean'||!text(v.classificationCeiling,64)||!iso(v.expiresAt)||!version(v.version)||typeof v.managed!=='boolean'||!state(v.state))throw Error('INVALID_METADATA');
 // Project only declared policy metadata; never retain extra response properties.
 return {id:v.id.toLowerCase(),targetUserId:v.targetUserId.toLowerCase(),capabilityId:v.capabilityId,capabilityVersion:v.capabilityVersion as string|null,bindingHash:v.bindingHash as string|null,manifestId:v.manifestId as string|null,descriptorHash:v.descriptorHash as string|null,resourceId:v.resourceId,resourceTruncated:v.resourceTruncated,classificationCeiling:v.classificationCeiling,expiresAt:v.expiresAt,version:v.version,managed:v.managed,state:v.state};
}
export function canManage(item:ManagedResource):boolean{
 return item.managed&&item.state!=='REVOKED'&&!item.resourceTruncated&&!!item.capabilityId&&!!item.resourceId&&!!item.capabilityVersion&&/^\d+\.\d+\.\d+$/.test(item.capabilityVersion)&&hash(item.bindingHash)&&isAdminUuid(item.manifestId)&&hash(item.descriptorHash)&&['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].includes(item.classificationCeiling);
}
function parseList(raw:unknown,filters:AdminFilters,cursor?:string){
 const value=object(raw);
 if(value.scope!=='TENANT_POLICY_METADATA_ONLY'||value.platformPermissionsVerified!==false||!Array.isArray(value.items)||value.items.length>50||!(value.nextCursor===null||isAdminUuid(value.nextCursor)))throw Error('INVALID_METADATA');
 const items=value.items.map(parseItem),nextCursor=typeof value.nextCursor==='string'?value.nextCursor.toLowerCase():null;
 if(new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>filters.targetUserId&&i.targetUserId!==filters.targetUserId||filters.id&&i.id!==filters.id)||nextCursor&&nextCursor===cursor)throw Error('INVALID_METADATA');
 return {items,nextCursor};
}
function parseReceipt(raw:unknown,intent:Intent):AdminReceipt{
 const v=object(raw);
 if(!isAdminUuid(v.id)||v.id.toLowerCase()!==intent.item.id||!isAdminUuid(v.targetUserId)||v.targetUserId.toLowerCase()!==intent.item.targetUserId||!isAdminUuid(v.requestId)||v.requestId.toLowerCase()!==intent.requestId||!version(v.version)||v.version!==intent.item.version+1||v.state!==(intent.operation==='renew'?'ACTIVE':'REVOKED')||typeof v.replayed!=='boolean'||typeof v.reauthenticationRequired!=='boolean'||v.platformPermissionsVerified!==false||!version(v.currentVersion)||v.currentVersion<v.version||!state(v.currentState))throw Error('INVALID_RECEIPT');
 return {id:v.id.toLowerCase(),targetUserId:v.targetUserId.toLowerCase(),version:v.version,state:v.state as 'ACTIVE'|'REVOKED',replayed:v.replayed,reauthenticationRequired:v.reauthenticationRequired,platformPermissionsVerified:false,requestId:v.requestId.toLowerCase(),currentVersion:v.currentVersion,currentState:v.currentState};
}
function failure(error:unknown,writing=false):Outcome{
 const status=error instanceof PermissionAdminFailure?error.status:0;
 if(!writing&&![401,403,404].includes(status))return {ok:false,notice:status===400?'筛选条件未通过检查，请使用有效 UUID；未提交变更。':'策略资料未能核实，旧资料已清除；请核对筛选条件和访问状态。'};
 const notice=status===401?'会话已失效，请重新登录后核对策略记录。':status===403?'当前管理权限或使用条件未满足，已清除旧资料，请核对管理员资格与授权条件。':status===409?'记录版本或请求发生冲突，未确认本次变更；请重新查询后核对，不会自动重发。':status===404?'记录不可用，已清除旧资料，请重新核对目标与权限。':status===400?'提交条件未通过检查，请核对有效期和审核引用；不会自动重发。':status===503?'管理服务暂不可用，变更尚未确认；不会自动重发。':'响应未能核实，变更结果可能未知；已清除本次确认，不会自动重发或更换幂等键。';
 return {ok:false,notice,...(status===401?{sessionLost:true}:{})};
}
export class PermissionAdminFlow{
 items:ManagedResource[]=[];
 nextCursor:string|null=null;
 selected:ManagedResource|null=null;
 receipt:AdminReceipt|null=null;
 private confirmation:Intent|null=null;
 private pending=false;
 private generation=0;
 constructor(private transport:AdminTransport,private newKey:()=>string=()=>crypto.randomUUID(),private now:()=>number=Date.now){}
 get busy(){return this.pending;}
 get intent(){return this.confirmation?{operation:this.confirmation.operation,item:this.confirmation.item,body:this.confirmation.body}:null;}
 private erase(){this.items=[];this.nextCursor=null;this.selected=null;this.receipt=null;this.confirmation=null;}
 clear(){this.generation++;this.pending=false;this.erase();}
 async load(filters:AdminFilters={},cursor?:string):Promise<Outcome|null>{
  if(this.pending)return null;
  this.erase();this.pending=true;const generation=++this.generation;
  try{
   const query=new URLSearchParams(),normalized:AdminFilters={};
   for(const name of ['targetUserId','id'] as const){const value=filters[name];if(value!==undefined&&value!==''){if(!isAdminUuid(value))throw new PermissionAdminFailure(400);normalized[name]=value.toLowerCase();query.set(name,value.toLowerCase());}}
   if(cursor!==undefined){if(!isAdminUuid(cursor))throw new PermissionAdminFailure(400);query.set('cursor',cursor.toLowerCase());}
   const raw=await this.transport('/admin/resources'+(query.size?'?'+query.toString():''));if(generation!==this.generation)return null;
   const value=parseList(raw,normalized,cursor);this.items=value.items;this.nextCursor=value.nextCursor;
   return {ok:true,notice:'仅展示企业策略元数据；平台权限尚未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 select(id:string){if(this.pending)return false;this.confirmation=null;this.receipt=null;const item=this.items.find(i=>i.id===id);this.selected=item&&canManage(item)?item:null;return this.selected!==null;}
 cancel(){if(!this.pending){this.confirmation=null;this.selected=null;}}
 prepare(operation:AdminOperation,reviewReference:string,expiresAt?:string):Outcome{
  this.confirmation=null;
  if(this.pending||!this.selected||!canManage(this.selected)||!['renew','revoke'].includes(operation)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(reviewReference)||operation==='renew'&&(!iso(expiresAt)||Date.parse(expiresAt)<=this.now()))return {ok:false,notice:'请先选择完整的受管记录，并填写有效的审核引用和续期时间。'};
  try{const key=this.newKey();if(!isAdminUuid(key))throw Error('INVALID_KEY');this.confirmation={operation,item:{...this.selected},requestId:key.toLowerCase(),body:{targetUserId:this.selected.targetUserId,version:this.selected.version,reviewReference,...(operation==='renew'?{expiresAt:expiresAt!}:{})}};return {ok:true,notice:'请核对精确目标、记录版本及本次操作；取消不会提交变更。'};}catch{return failure(null);}
 }
 async confirm():Promise<Outcome|null>{
  if(this.pending||!this.confirmation)return null;
  const intent=this.confirmation;this.erase();this.pending=true;const generation=++this.generation;
  try{
   const raw=await this.transport('/admin/resources/'+encodeURIComponent(intent.item.id)+'/'+intent.operation,intent.body,intent.requestId);if(generation!==this.generation)return null;
   const receipt=parseReceipt(raw,intent);if(receipt.reauthenticationRequired){this.erase();return {ok:true,sessionLost:true,notice:'策略回执要求重新登录，旧资料已清除，请重新登录后核对。'};}
   this.receipt=receipt;return {ok:true,notice:receipt.replayed?'收到已记录操作意图的重放回执；它不代表当前策略仍然有效。':'操作意图回执已核实；请分别核对回执和记录状态，平台权限仍未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
