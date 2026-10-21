// This flow validates UI evidence only. Authority and certification remain server decisions.
export type ReconcileAction={id:string;capability_id:string;state:'UNKNOWN'};
export type ReadBackState='VERIFIED_APPLIED'|'VERIFIED_NOT_APPLIED'|'INCONCLUSIVE';
export type Claim='APPLIED'|'NOT_APPLIED'|'INCONCLUSIVE';
type Session={id:string;nonce:string;argsHash:string;expiresAt:string;capability:string};
type Result={ok:boolean;notice:string};
type Request=(path:string,body:unknown)=>Promise<unknown>;
const failure='核验未完成，请重新核对权限、有效期和动作状态。当前会话已清除；不会自动重试或转为人工声明。';
const unchanged='原业务动作仍待核对，任务不会恢复，未获得重试许可。';
export function readBackNotice(state:ReadBackState):string{
 return ({VERIFIED_APPLIED:'认证日志确认已发生；',VERIFIED_NOT_APPLIED:'认证日志确认未发生；',INCONCLUSIVE:'认证读回未能确定结果；'}[state])+unchanged;
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_RECONCILIATION');return value as Record<string,unknown>;}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function parseSession(value:unknown,action:ReconcileAction,now:number):Session{
 const v=record(value),a=record(v.action),expires=typeof v.expiresAt==='string'?Date.parse(v.expiresAt):NaN;
 if(!uuid(v.id)||!uuid(action.id)||a.id!==action.id||a.capability!==action.capability_id||a.state!=='UNKNOWN'||action.state!=='UNKNOWN'||v.verification!=='NO_AUTOMATIC_READ_BACK'||v.retryAllowed!==false||typeof v.nonce!=='string'||!v.nonce.length||v.nonce.length>2048||typeof v.argsHash!=='string'||!/^[a-f0-9]{64}$/.test(v.argsHash)||!Number.isFinite(expires)||expires<=now||expires>now+305000)throw Error('INVALID_RECONCILIATION');
 return {id:v.id,nonce:v.nonce,argsHash:v.argsHash,expiresAt:v.expiresAt as string,capability:action.capability_id};
}
function parseReadBack(value:unknown,id:string):ReadBackState{
 const v=record(value);
 if(v.id!==id||v.retryAllowed!==false||(v.actionState!==undefined&&v.actionState!=='UNKNOWN'))throw Error('INVALID_RECONCILIATION');
 if(v.state==='INCONCLUSIVE'&&v.verification==='INCONCLUSIVE')return v.state;
 if((v.state==='VERIFIED_APPLIED'||v.state==='VERIFIED_NOT_APPLIED')&&v.verification==='CERTIFIED_JOURNAL')return v.state;
 throw Error('INVALID_RECONCILIATION');
}
function parseAttestation(value:unknown,id:string,claim:Claim):string{
 const v=record(value),applied=claim==='APPLIED';
 if(v.id!==id||v.retryAllowed!==false||v.verification!=='UNVERIFIED'||v.state!==(applied?'MANUAL_APPLIED_UNVERIFIED':'INCONCLUSIVE')||v.actionState!==(applied?'APPLIED_UNVERIFIED':'UNKNOWN'))throw Error('INVALID_RECONCILIATION');
 return applied?'人工声明已记录为已发生、尚未核验，任务仅部分完成；没有获得重试许可。':'人工声明已保存，结果仍待核对；任务不会恢复，没有获得重试许可。';
}
export class ReadBackFlow{
 private session:Session|null=null;
 private pending=false;
 private generation=0;
 constructor(private request:Request,private now:()=>number=Date.now){}
 get busy(){return this.pending;}
 get review(){return this.session?{capability:this.session.capability,expiresAt:this.session.expiresAt}:null;}
 clear(){this.generation++;this.session=null;this.pending=false;}
 async begin(action:ReconcileAction):Promise<Result|null>{
  if(this.pending)return null;
  this.session=null;this.pending=true;const generation=++this.generation;
  try{
   if(!uuid(action.id))throw Error('INVALID_RECONCILIATION');
   const value=await this.request('/actions/'+encodeURIComponent(action.id)+'/reconciliation-sessions',{});
   if(generation!==this.generation)return null;
   this.session=parseSession(value,action,this.now());
   return {ok:true,notice:'请选择认证只读核验或人工声明；两种操作共用一次性会话，人工声明不等于认证证据。'};
  }catch{return generation===this.generation?{ok:false,notice:failure}:null;}
  finally{if(generation===this.generation)this.pending=false;}
 }
 readBack(){return this.consume('read-back');}
 attest(claim:Claim,evidence:string){return this.consume('attestation',claim,evidence);}
 private async consume(mode:'read-back'|'attestation',claim:Claim='INCONCLUSIVE',evidence=''):Promise<Result|null>{
  if(this.pending||!this.session)return null;
  // Discard before dispatch: a lost response must never reuse a potentially consumed nonce.
  const session=this.session;this.session=null;this.pending=true;const generation=++this.generation;
  try{
   if(Date.parse(session.expiresAt)<=this.now()||mode==='attestation'&&(!evidence.trim()||evidence.length>8192))throw Error('INVALID_RECONCILIATION');
   const body={nonce:session.nonce,argsHash:session.argsHash,...(mode==='attestation'?{claim,evidence}:{})};
   const value=await this.request('/reconciliations/'+encodeURIComponent(session.id)+'/'+mode,body);
   if(generation!==this.generation)return null;
   if(Date.parse(session.expiresAt)<=this.now())throw Error('INVALID_RECONCILIATION');
   return {ok:true,notice:mode==='read-back'?readBackNotice(parseReadBack(value,session.id)):parseAttestation(value,session.id,claim)};
  }catch{return generation===this.generation?{ok:false,notice:failure}:null;}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
