export type DataTemplateVersion={templateKey:string;templateVersion:string;templateHash:string;certificationReference:string;publishedAt:string;active:boolean;activeVersion:string|null;activeRevision:number|null};
export type DataTemplateAdminReceipt={templateKey:string;templateVersion:string;activeVersion:string;activeRevision:number;operation:'PUBLISH'|'ROLLBACK';replayed:boolean;requestId:string;platformCertification:'LOCAL_GOLDEN_ONLY';liveVerified:false;currentActiveVersion?:string;currentActiveRevision?:number};
type PublishBody={templateKey:string;templateVersion:string;reviewReference:string};
type RollbackBody={templateKey:string;templateVersion:string;expectedRevision:number;reviewReference:string};
export type DataTemplateAdminIntent={operation:'publish';item:null;body:PublishBody}|{operation:'rollback';item:DataTemplateVersion;body:RollbackBody};
type Intent={operation:'publish';body:PublishBody;requestId:string}|{operation:'rollback';item:DataTemplateVersion;body:RollbackBody;requestId:string};
type Outcome={ok:boolean;notice:string;sessionLost?:boolean};
export type DataTemplateAdminTransport=(path:string,body?:unknown,requestId?:string)=>Promise<unknown>;
export class DataTemplateAdminFailure extends Error{constructor(readonly status:number){super('DATA_TEMPLATE_ADMIN_REQUEST_FAILED');}}
const keyPattern=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/,versionPattern=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/,hashPattern=/^[a-f0-9]{64}$/,reviewPattern=/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,254}$/,uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_TEMPLATE_METADATA');return value as Record<string,unknown>;}
const isKey=(value:unknown):value is string=>typeof value==='string'&&keyPattern.test(value);
const isVersion=(value:unknown):value is string=>typeof value==='string'&&versionPattern.test(value);
const isHash=(value:unknown):value is string=>typeof value==='string'&&hashPattern.test(value);
const isReview=(value:unknown):value is string=>typeof value==='string'&&reviewPattern.test(value);
const isRevision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const isIso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
function parseItem(raw:unknown):DataTemplateVersion{
 const v=object(raw);
 if(!isKey(v.templateKey)||!isVersion(v.templateVersion)||!isHash(v.templateHash)||!isReview(v.certificationReference)||!isIso(v.publishedAt)||typeof v.active!=='boolean'||!(v.activeVersion===null||isVersion(v.activeVersion))||!(v.activeRevision===null||isRevision(v.activeRevision))||(v.activeVersion===null)!==(v.activeRevision===null)||(v.active&&v.activeVersion!==v.templateVersion)||(!v.active&&v.activeVersion===v.templateVersion))throw Error('INVALID_TEMPLATE_METADATA');
 return {templateKey:v.templateKey,templateVersion:v.templateVersion,templateHash:v.templateHash,certificationReference:v.certificationReference,publishedAt:v.publishedAt,active:v.active,activeVersion:v.activeVersion,activeRevision:v.activeRevision};
}
function parseList(raw:unknown){
 const v=object(raw);
 if(v.platformCertification!=='LOCAL_GOLDEN_ONLY'||v.liveVerified!==false||typeof v.truncated!=='boolean'||!Array.isArray(v.items)||v.items.length>200)throw Error('INVALID_TEMPLATE_METADATA');
 const items=v.items.map(parseItem);
 if(new Set(items.map(item=>item.templateKey+'@'+item.templateVersion)).size!==items.length)throw Error('INVALID_TEMPLATE_METADATA');
 return {items,truncated:v.truncated};
}
export function canRollbackTemplate(item:DataTemplateVersion):boolean{
 return item.activeVersion!==null&&item.activeRevision!==null&&item.activeVersion!==item.templateVersion;
}
function parseReceipt(raw:unknown,intent:Intent):DataTemplateAdminReceipt{
 const v=object(raw),expected=intent.operation==='publish'?'PUBLISH':'ROLLBACK',currentVersion=v.currentActiveVersion,currentRevision=v.currentActiveRevision,hasCurrent=currentVersion!==undefined||currentRevision!==undefined;
 if(!isKey(v.templateKey)||v.templateKey!==intent.body.templateKey||!isVersion(v.templateVersion)||v.templateVersion!==intent.body.templateVersion||v.operation!==expected||!isVersion(v.activeVersion)||v.activeVersion!==v.templateVersion||!isRevision(v.activeRevision)||typeof v.replayed!=='boolean'||typeof v.requestId!=='string'||v.requestId.toLowerCase()!==intent.requestId||v.platformCertification!=='LOCAL_GOLDEN_ONLY'||v.liveVerified!==false)throw Error('INVALID_TEMPLATE_RECEIPT');
 if(intent.operation==='rollback'&&v.activeRevision!==intent.body.expectedRevision+1)throw Error('INVALID_TEMPLATE_RECEIPT');
 if(v.replayed){
  if(!hasCurrent||!isVersion(currentVersion)||!isRevision(currentRevision)||currentRevision<v.activeRevision)throw Error('INVALID_TEMPLATE_RECEIPT');
 }else if(hasCurrent)throw Error('INVALID_TEMPLATE_RECEIPT');
 return {templateKey:v.templateKey,templateVersion:v.templateVersion,activeVersion:v.activeVersion,activeRevision:v.activeRevision,operation:v.operation as 'PUBLISH'|'ROLLBACK',replayed:v.replayed,requestId:v.requestId.toLowerCase(),platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false,...(v.replayed?{currentActiveVersion:currentVersion as string,currentActiveRevision:currentRevision as number}:{})};
}
function failure(error:unknown,writing=false):Outcome{
 const status=error instanceof DataTemplateAdminFailure?error.status:0;
 if(!writing)return status===401?{ok:false,sessionLost:true,notice:'会话已失效，请重新登录后核对数据模板登记。'}:status===403?{ok:false,notice:'当前管理资格未满足，数据模板登记未展示；请核对管理员角色与范围。'}:status===503?{ok:false,notice:'数据模板管理服务暂不可用，登记尚未核实。'}:{ok:false,notice:'数据模板登记未能核实，旧资料已清除；请重新加载。'};
 const notice=status===401?'会话已失效，请重新登录后核对模板变更结果。':status===403?'当前管理资格或模板认证条件未满足，未确认本次变更；不会自动重发。':status===409?'模板版本、重复发布或当前生效记录发生冲突，未确认本次变更；请重新加载后核对，不会自动重发。':status===404?'模板版本不在本地认证登记中，或当前生效记录不可用；不会自动重发。':status===400?'提交条件未通过检查，请核对模板标识、版本和审核引用；不会自动重发。':status===503?'模板管理服务暂不可用，变更尚未确认；不会自动重发。':'响应未能核实，变更结果可能未知；已清除本次确认，不会自动重发或更换幂等键。';
 return {ok:false,notice,...(status===401?{sessionLost:true}:{})};
}
export class DataTemplateAdminFlow{
 items:DataTemplateVersion[]=[];
 truncated=false;
 selected:DataTemplateVersion|null=null;
 receipt:DataTemplateAdminReceipt|null=null;
 private confirmation:Intent|null=null;
 private pending=false;
 private generation=0;
 constructor(private transport:DataTemplateAdminTransport,private newKey:()=>string=()=>crypto.randomUUID()){}
 get busy(){return this.pending;}
 get intent():DataTemplateAdminIntent|null{const c=this.confirmation;return c===null?null:c.operation==='publish'?{operation:'publish',item:null,body:c.body}:{operation:'rollback',item:c.item,body:c.body};}
 private erase(){this.items=[];this.truncated=false;this.selected=null;this.receipt=null;this.confirmation=null;}
 clear(){this.generation++;this.pending=false;this.erase();}
 async load():Promise<Outcome|null>{
  if(this.pending)return null;
  this.erase();this.pending=true;const generation=++this.generation;
  try{
   const raw=await this.transport('/data/templates');if(generation!==this.generation)return null;
   const value=parseList(raw);this.items=value.items;this.truncated=value.truncated;
   return {ok:true,notice:'仅展示企业本地认证版本登记；平台认证与真实数据尚未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 select(templateKey:string,templateVersion:string){
  if(this.pending)return false;this.confirmation=null;this.receipt=null;
  const item=this.items.find(value=>value.templateKey===templateKey&&value.templateVersion===templateVersion);
  this.selected=item&&canRollbackTemplate(item)?item:null;return this.selected!==null;
 }
 cancel(){if(!this.pending){this.confirmation=null;this.selected=null;}}
 preparePublish(input:PublishBody):Outcome{
  this.confirmation=null;
  if(this.pending||!isKey(input.templateKey)||!isVersion(input.templateVersion)||!isReview(input.reviewReference))return {ok:false,notice:'请填写有效的已认证模板标识、版本和至少 8 位的审核引用。'};
  if(this.items.some(item=>item.templateKey===input.templateKey&&item.templateVersion===input.templateVersion))return {ok:false,notice:'该模板版本已在企业登记中；请重新加载后选择回退或其他已认证版本。'};
  try{const key=this.newKey();if(!uuidPattern.test(key))throw Error('INVALID_KEY');this.confirmation={operation:'publish',body:{...input},requestId:key.toLowerCase()};return {ok:true,notice:'请核对精确模板标识、版本和本地认证登记；取消不会提交变更。'};}catch{return failure(null);}
 }
 prepareRollback(reviewReference:string):Outcome{
  this.confirmation=null;
  if(this.pending||!this.selected||!canRollbackTemplate(this.selected)||!isReview(reviewReference))return {ok:false,notice:'请先选择一条可回退的已登记版本，并填写至少 8 位的审核引用。'};
  const item=this.selected;
  try{const key=this.newKey();if(!uuidPattern.test(key))throw Error('INVALID_KEY');this.confirmation={operation:'rollback',item:{...item},requestId:key.toLowerCase(),body:{templateKey:item.templateKey,templateVersion:item.templateVersion,expectedRevision:item.activeRevision!,reviewReference}};return {ok:true,notice:'请核对目标版本、当前生效记录版本与审核引用；取消不会提交变更。'};}catch{return failure(null);}
 }
 async confirm():Promise<Outcome|null>{
  if(this.pending||!this.confirmation)return null;
  const intent=this.confirmation;this.erase();this.pending=true;const generation=++this.generation;
  try{
   const path=intent.operation==='publish'?'/data/templates/publish':'/data/templates/rollback';
   const raw=await this.transport(path,intent.body,intent.requestId);if(generation!==this.generation)return null;
   const receipt=parseReceipt(raw,intent);this.receipt=receipt;
   return {ok:true,notice:receipt.replayed?'收到已记录模板操作意图的重放回执；它不代表当前生效版本仍然如此。':'模板操作回执已核实；请分别核对回执与当前生效记录，平台认证与真实数据仍未核实。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
