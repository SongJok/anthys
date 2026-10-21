import {evaluateGroupContract,type GroupContract} from '../../../packages/groups/src/contract-model.js';
export const groupContractRequestLifetimeMs=15000;
export type StopState='PAUSED'|'REVOKED';
export type ContractChange=StopState|'ACTIVE';
export type ContractState='ACTIVE'|'PAUSED'|'REVOKED'|'EXPIRED';
export type GroupAuthority={id:string;groupId:string;administratorId:string;serviceIdentityId:string;reviewReference:string;validUntil:string;currency:'CNY'|'USD';maxAmountMinor:number;authority:'REVIEWED_DELEGATION';platformPermissionsVerified:false};
export type GroupSnapshot={authority:GroupAuthority;contract:{document:GroupContract;version:number;revisionId:string}|null;platformPermissionsVerified:false};
export type GroupReceipt={id:string;revisionId:string;version:number;state:'ACTIVE'|'PAUSED'|'REVOKED';replayed:boolean;currentVersion:number;currentState:ContractState;platformPermissionsVerified:false};
type Outcome={ok:boolean;notice:string;sessionLost?:boolean};
type Intent={snapshot:GroupSnapshot;state:ContractChange;key:string};
export type GroupAdminTransport=(path:string,body?:unknown,key?:string)=>Promise<unknown>;
export class GroupContractAdminFailure extends Error{constructor(readonly status:number){super('GROUP_CONTRACT_REQUEST_FAILED');}}
export const groupAdminUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.values(Object.getOwnPropertyDescriptors(value)).some(v=>!('value' in v)))throw Error('INVALID_CONTRACT_DATA');return value as Record<string,unknown>;};
const exact=(value:Record<string,unknown>,keys:string[])=>{if(Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw Error('INVALID_CONTRACT_DATA');};
const text=(value:unknown,max=512):value is string=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const positive=(value:unknown):value is number=>integer(value)&&value>0;
const instant=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
function parseSnapshot(raw:unknown,delegationId:string,now:number):GroupSnapshot{
 const value=record(raw);exact(value,['authority','contract','platformPermissionsVerified']);const a=record(value.authority);
 exact(a,['id','groupId','administratorId','serviceIdentityId','reviewReference','validUntil','currency','maxAmountMinor','authority','platformPermissionsVerified']);
 if(value.platformPermissionsVerified!==false||a.platformPermissionsVerified!==false||a.authority!=='REVIEWED_DELEGATION'||!groupAdminUuid(a.id)||a.id.toLowerCase()!==delegationId||!text(a.groupId)||!groupAdminUuid(a.administratorId)||!groupAdminUuid(a.serviceIdentityId)||!text(a.reviewReference)||!instant(a.validUntil)||Date.parse(a.validUntil)<=now||!['CNY','USD'].includes(a.currency as string)||!integer(a.maxAmountMinor))throw Error('INVALID_AUTHORITY');
 const authority:GroupAuthority={id:a.id.toLowerCase(),groupId:a.groupId,administratorId:a.administratorId,serviceIdentityId:a.serviceIdentityId,reviewReference:a.reviewReference,validUntil:a.validUntil,currency:a.currency as 'CNY'|'USD',maxAmountMinor:a.maxAmountMinor,authority:'REVIEWED_DELEGATION',platformPermissionsVerified:false};
 if(value.contract===null)return {authority,contract:null,platformPermissionsVerified:false};
 const c=record(value.contract);exact(c,['document','version','revisionId']);const d=record(c.document);
 if(!positive(c.version)||!groupAdminUuid(c.revisionId)||!groupAdminUuid(d.id))throw Error('INVALID_CONTRACT');
 const check=evaluateGroupContract(d,{tenantId:d.tenantId,groupId:authority.groupId,contractId:d.id,serviceIdentityId:authority.serviceIdentityId,currentVersion:c.version,now});
 if(check.gaps.some(g=>!['INACTIVE_CONTRACT','EXPIRED','NOT_YET_VALID'].includes(g.code)))throw Error('INVALID_CONTRACT');
 const document=structuredClone(d) as unknown as GroupContract;
 if(document.administratorAuthorization.actorId!==authority.administratorId||document.administratorAuthorization.evidenceRef!==authority.reviewReference||document.budget.currency!==authority.currency||document.budget.maxAmountMinor>authority.maxAmountMinor||Date.parse(document.expiresAt)>Date.parse(authority.validUntil)||(document.sources.mode??'MENTION_ONLY')!=='MENTION_ONLY'||document.sources.enhanced!==undefined)throw Error('CONTRACT_AUTHORITY_MISMATCH');
 return {authority,contract:{document,version:c.version,revisionId:c.revisionId},platformPermissionsVerified:false};
}
function eligible(snapshot:GroupSnapshot|null,state:ContractChange,now:number):boolean{
 const c=snapshot?.contract;if(!snapshot||!c||!['ACTIVE','PAUSED','REVOKED'].includes(state)||c.version>=Number.MAX_SAFE_INTEGER||Date.parse(snapshot.authority.validUntil)<=now||Date.parse(c.document.expiresAt)<=now)return false;
 if(state==='ACTIVE')return c.document.state==='PAUSED'&&Date.parse(c.document.validFrom)<=now;
 return state==='PAUSED'?c.document.state==='ACTIVE':['ACTIVE','PAUSED'].includes(c.document.state);
}
function parseReceipt(raw:unknown,intent:Intent):GroupReceipt{
 const v=record(raw),c=intent.snapshot.contract!;exact(v,['id','revisionId','version','state','replayed','currentVersion','currentState','platformPermissionsVerified']);
 if(v.id!==c.document.id||!groupAdminUuid(v.revisionId)||v.revisionId===c.revisionId||v.version!==c.version+1||v.state!==intent.state||typeof v.replayed!=='boolean'||!positive(v.currentVersion)||v.currentVersion<(v.version as number)||!['ACTIVE','PAUSED','REVOKED','EXPIRED'].includes(v.currentState as string)||v.currentVersion===v.version&&v.currentState!==v.state&&v.currentState!=='EXPIRED'||v.platformPermissionsVerified!==false)throw Error('INVALID_RECEIPT');
 return {id:c.document.id,revisionId:v.revisionId,version:v.version as number,state:intent.state,replayed:v.replayed,currentVersion:v.currentVersion,currentState:v.currentState as ContractState,platformPermissionsVerified:false};
}
function failed(error:unknown,writing=false):Outcome{
 const status=error instanceof GroupContractAdminFailure?error.status:0;
 return {ok:false,notice:status===401?'会话已失效，旧资料已清除，请重新登录。':status===403?'群合同委托或访问条件未满足，旧资料已清除；应用角色不等于已审核群授权。':status===409?'合同版本或请求发生冲突，变更未确认；请重新读取后核对，不会自动重发。':status===404?'未找到可访问的群合同，旧资料已清除。':status===400?'委托编号或合同条件未通过检查，未确认变更。':writing?'状态变更响应无法核实，结果可能未知；不会自动重发、更换幂等键或转为其他动作。':'群合同资料无法核实，旧资料已清除；请核对委托编号、期限和访问条件。',...(status===401?{sessionLost:true}:{})};
}
export class GroupContractAdminFlow{
 snapshot:GroupSnapshot|null=null;
 receipt:GroupReceipt|null=null;
 private confirmation:Intent|null=null;
 private pending=false;
 private generation=0;
 private observedVersions=new Map<string,number>();
 constructor(private transport:GroupAdminTransport,private newKey:()=>string=()=>crypto.randomUUID(),private now:()=>number=Date.now){}
 get busy(){return this.pending;}
 get intent(){return this.confirmation?{snapshot:this.confirmation.snapshot,state:this.confirmation.state}:null;}
 private erase(){this.snapshot=null;this.receipt=null;this.confirmation=null;}
 clear(){this.generation++;this.pending=false;this.erase();this.observedVersions.clear();}
 canChange(state:ContractChange){return !this.pending&&eligible(this.snapshot,state,this.now());}
 async read(delegationId:string):Promise<Outcome|null>{
  if(this.pending)return null;this.erase();this.pending=true;const generation=++this.generation;
  try{
   if(!groupAdminUuid(delegationId))throw new GroupContractAdminFailure(400);
   const id=delegationId.toLowerCase(),raw=await this.transport('/group-contracts?delegationId='+encodeURIComponent(id));if(generation!==this.generation)return null;
   const value=parseSnapshot(raw,id,this.now()),contract=value.contract;
   if(contract){if(contract.version<(this.observedVersions.get(contract.document.id)??0))throw Error('STALE_CONTRACT');this.observedVersions.set(contract.document.id,contract.version);}
   this.snapshot=value;return {ok:true,notice:contract?'已读取已有合同与审核委托；平台权限仍未核实。':'已读取审核委托，但尚无合同；没有状态变更入口。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failed(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 prepare(state:ContractChange):Outcome{
  if(this.pending||!eligible(this.snapshot,state,this.now()))return {ok:false,notice:'当前合同或委托条件不支持该状态变更，请重新读取后核对。'};
  try{const key=this.newKey();if(!groupAdminUuid(key))throw Error('INVALID_KEY');this.confirmation={snapshot:structuredClone(this.snapshot!),state,key};return {ok:true,notice:state==='ACTIVE'?'请确认恢复此暂停合同的精确群、服务身份、委托及版本；后端将重新核对当前授权。恢复不补发旧动作，不更改职责、期限或额度。':'请确认精确群、服务身份、委托及合同版本；取消不会提交变更。'};}catch{return failed(null);}
 }
 cancel(){if(!this.pending)this.confirmation=null;}
 async confirm():Promise<Outcome|null>{
  if(this.pending||!this.confirmation)return null;
  const intent=this.confirmation;this.erase();this.pending=true;const generation=++this.generation;
  try{
   if(!eligible(intent.snapshot,intent.state,this.now()))throw new GroupContractAdminFailure(400);
   const c=intent.snapshot.contract!,body={delegationId:intent.snapshot.authority.id,expectedVersion:c.version,state:intent.state};
   const raw=await this.transport('/group-contracts/'+encodeURIComponent(c.document.id)+'/state',body,intent.key);if(generation!==this.generation)return null;
   const receipt=parseReceipt(raw,intent);if(Date.parse(intent.snapshot.authority.validUntil)<=this.now()||receipt.currentVersion<(this.observedVersions.get(receipt.id)??0))throw Error('STALE_RECEIPT');
   this.observedVersions.set(receipt.id,receipt.currentVersion);this.receipt=receipt;
   return {ok:true,notice:receipt.replayed?'收到历史状态变更回执，请以回执时的较新记录状态核对。':'状态变更回执已核实；在途或结果未知的动作仍需独立核对，不会补发。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failed(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
