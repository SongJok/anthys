import {z} from 'zod';
// Wire pin mirrored intentionally: importing the server contract would bundle node:crypto.
export const groupEscalationUiNotice='仅为已登记事项的同群升级申请；事实仍未核验，入队不表示送达或问题解决，不改变负责人和完成状态。';
const uuid=z.uuid().transform(s=>s.toLowerCase()),positive=z.number().int().positive().safe(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const text=(max:number)=>z.string().min(1).max(max).refine(v=>v.trim()===v&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(v));
export const escalationUiTarget=z.object({groupId:text(512),caseId:uuid,caseVersion:positive,contractVersion:positive}).strict();
const intent=z.object({caseId:uuid,expectedCaseVersion:positive,expectedContractVersion:positive,reason:text(1000)}).strict(),reference=z.object({proposalId:uuid,previewHash:sha}).strict(),hashBody=z.object({previewHash:sha}).strict();
export const escalationUiPreview=z.object({proposalId:uuid,contextHash:sha,intent,intentHash:sha,groupId:text(512),case:z.object({id:uuid,version:positive,title:text(300),resourceRef:text(512),state:z.enum(['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED']),ownerId:uuid.nullable(),dueAt:instant.nullable()}).strict(),contract:z.object({id:uuid,version:positive,hash:sha}).strict(),targets:z.array(z.object({id:uuid,name:text(100)}).strict()).min(1).max(20),coverage:z.object({mode:z.literal('MENTION_ONLY'),completeChat:z.literal(false)}).strict(),verification:z.literal('UNVERIFIED'),asOf:instant,expiresAt:instant,notice:z.literal(groupEscalationUiNotice)}).strict().superRefine((v,c)=>{if(v.case.id!==v.intent.caseId||v.case.version!==v.intent.expectedCaseVersion||v.contract.version!==v.intent.expectedContractVersion||new Set(v.targets.map(t=>t.id)).size!==v.targets.length||Date.parse(v.expiresAt)<=Date.parse(v.asOf)||Date.parse(v.expiresAt)-Date.parse(v.asOf)>60000||v.case.state!=='BLOCKED'&&(v.case.dueAt===null||Date.parse(v.case.dueAt)>Date.parse(v.asOf)))c.addIssue({code:'custom',message:'ESCALATION_PREVIEW_INVALID'});});
export const escalationUiReceipt=z.object({proposalId:uuid,previewHash:sha,contextHash:sha,groupId:text(512),caseId:uuid,caseVersion:positive,contractVersion:positive,verification:z.literal('UNVERIFIED'),asOf:instant,replayed:z.boolean()}).strict();
const denied=z.object({kind:z.literal('DENIED'),code:z.enum(['GROUP_ESCALATION_DENIED','GROUP_ESCALATION_SOURCE_CHANGED','GROUP_ESCALATION_NOT_FOUND','GROUP_ESCALATION_EXPIRED','GROUP_ESCALATION_LIMIT','GROUP_ESCALATION_CANCELLED','GROUP_ESCALATION_INPUT_INVALID'])}).strict(),unknown=z.object({kind:z.literal('UNKNOWN'),code:z.enum(['GROUP_ESCALATION_RESULT_UNKNOWN','GROUP_ESCALATION_RECONCILE_REQUIRED'])}).strict();
const prepared=z.object({kind:z.literal('PREPARED'),preview:escalationUiPreview,previewHash:sha}).strict(),queued=z.object({kind:z.literal('QUEUED'),receipt:escalationUiReceipt}).strict(),cancelled=z.object({kind:z.literal('CANCELLED_LOCAL'),receipt:escalationUiReceipt}).strict(),reconcile=z.object({kind:z.literal('RECONCILE_REQUIRED'),receipt:escalationUiReceipt}).strict();
export const groupEscalationDeliveryUiNotice='记录仅描述本地投递和提供方回执，不证明接收方已收到或阅读；UNKNOWN 不重发。';
export const escalationUiDelivery=z.object({kind:z.literal('DELIVERY_STATUS'),receipt:escalationUiReceipt,delivery:z.object({state:z.enum(['PENDING','SENDING','APPLIED_UNVERIFIED','FAILED','UNKNOWN','SUPPRESSED']),verification:z.literal('UNVERIFIED'),method:z.enum(['PROVIDER_ACCEPTANCE_ONLY','NO_PROVIDER_RECEIPT']),physicalDeliveryVerified:z.literal(false),asOf:instant,notice:z.literal(groupEscalationDeliveryUiNotice)}).strict()}).strict();
export const escalationUiPreparation=z.discriminatedUnion('kind',[prepared,denied,unknown]),escalationUiRead=z.discriminatedUnion('kind',[prepared,queued,cancelled,reconcile,escalationUiDelivery,denied,unknown]),escalationUiEnqueue=z.discriminatedUnion('kind',[queued,denied,unknown]),escalationUiCancellation=z.discriminatedUnion('kind',[cancelled,reconcile,denied,unknown]);
export const escalationUiRequestLifetimeMs=15000;
export type EscalationUiTarget=z.infer<typeof escalationUiTarget>;
export type EscalationUiPrepared=z.infer<typeof prepared>;
export type EscalationUiStatus=z.infer<typeof queued>|z.infer<typeof cancelled>|z.infer<typeof reconcile>|z.infer<typeof escalationUiDelivery>;
export type EscalationUiOutcome={ok:boolean;notice:string;sessionLost?:boolean};
export type EscalationUiTransport=(path:string,input:{method:'GET'|'POST';signal:AbortSignal;body?:unknown;key?:string})=>Promise<unknown>;
export class EscalationUiFailure extends Error{constructor(readonly status:number){super('ESCALATION_REQUEST_FAILED');}}
const base=(target:EscalationUiTarget)=>'/api/v1/groups/'+encodeURIComponent(target.groupId)+'/case-escalations';
function sameIntent(target:EscalationUiTarget,value:z.infer<typeof intent>){return value.caseId===target.caseId&&value.expectedCaseVersion===target.caseVersion&&value.expectedContractVersion===target.contractVersion;}
/** Browser JSON hashing only. These digests never establish identity or source ACL. */
export async function escalationUiHash(value:unknown){
 const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
 const data=new TextEncoder().encode(canonical(value));if(data.byteLength>131072)throw Error('ESCALATION_RESPONSE_INVALID');const digest=await crypto.subtle.digest('SHA-256',data);return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
async function jsonData(response:Response,signal:AbortSignal){
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>131072)){await response.body?.cancel().catch(()=>{});throw new EscalationUiFailure(0);}
 if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'||!response.body){await response.body?.cancel().catch(()=>{});throw new EscalationUiFailure(0);}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>131072)throw new EscalationUiFailure(0);chunks.push(part.value);}signal.throwIfAborted();const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}const envelope=z.object({data:z.unknown()}).strict().parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)));if(!Object.hasOwn(envelope,'data'))throw new EscalationUiFailure(0);return envelope.data;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createEscalationUiTransport(csrf:string,rawTarget:EscalationUiTarget,fetcher:typeof fetch=fetch):EscalationUiTransport{
 const target=escalationUiTarget.parse(rawTarget),prefix=base(target),csrfValid=typeof csrf==='string'&&csrf.trim().length>0&&csrf.length<=4096&&!/[\x00-\x1f\x7f]/.test(csrf);
 return async(path,input)=>{
  input.signal.throwIfAborted();let body:unknown;
  if(path===prefix+'/preview'&&input.method==='POST'){body=intent.parse(input.body);if(!sameIntent(target,body as z.infer<typeof intent>))throw new EscalationUiFailure(0);}
  else{if(!path.startsWith(prefix+'/'))throw new EscalationUiFailure(0);const tail=path.slice(prefix.length+1).split('/');if(!uuid.safeParse(tail[0]).success)throw new EscalationUiFailure(0);if(input.method==='GET'&&tail.length===1){if(input.body!==undefined||input.key!==undefined)throw new EscalationUiFailure(0);}else if(input.method==='POST'&&tail.length===2&&['confirm','cancel'].includes(tail[1]!))body=hashBody.parse(input.body);else throw new EscalationUiFailure(0);}
  if(input.method==='POST'&&(!csrfValid||!uuid.safeParse(input.key).success))throw new EscalationUiFailure(0);
  const response=await fetcher(path,{method:input.method,signal:input.signal,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',headers:{accept:'application/json',...(input.method==='POST'?{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':input.key!}:{})},...(input.method==='POST'?{body:JSON.stringify(body)}:{})});
  if(response.redirected||!response.ok){await response.body?.cancel().catch(()=>{});throw new EscalationUiFailure(response.redirected?0:response.status);}return jsonData(response,input.signal);
 };
}
function failure(error:unknown,write=false):EscalationUiOutcome{const s=error instanceof EscalationUiFailure?error.status:0;return {ok:false,notice:s===401?'登录已失效，升级预览已清除，请重新登录。':[403,404,409].includes(s)?'当前事项、合同或权限依据无法核实，旧预览已清除；请返回事项列表重新核对。':write?'本次提交结果尚未确认，可能已经登记；预览已清除，不会自动重发，请核对原申请。':'申请状态无法核实，旧预览已清除，请重新核对。',...(s===401?{sessionLost:true}:{})};}
/** Local UI freshness/epochs only. Every host operation still requires current server authority. */
export class GroupEscalationsFlow {
 prepared:EscalationUiPrepared|null=null;
 status:EscalationUiStatus|null=null;
 private ref:z.infer<typeof reference>|null=null;
 private contextHash:string|null=null;
 private controller:AbortController|null=null;
 private generation=0;
 private pending=false;
 private operation:'preview'|'read'|'confirm'|'cancel'|null=null;
 private observedAt:number|null=null;
 private uncertain=false;
 private confirmAttempted=false;
 private cancelAttempted=false;
 readonly target:EscalationUiTarget;
 constructor(private transport:EscalationUiTransport,target:EscalationUiTarget,private key:()=>string=()=>crypto.randomUUID(),private now:()=>number=Date.now){this.target=Object.freeze(escalationUiTarget.parse(target));}
 get busy(){return this.pending;}
 get resultUnknown(){return this.uncertain;}
 get hasReference(){return this.ref!==null;}
 get expiresAt(){const asOf=this.prepared?.preview.asOf??(this.status?.kind==='DELIVERY_STATUS'?this.status.delivery.asOf:this.status?.receipt.asOf);return asOf&&this.observedAt!==null?Math.min(Date.parse(asOf)+60000,this.status?Date.parse(this.status.receipt.asOf)+60000:Infinity,this.observedAt+60000,this.prepared?Date.parse(this.prepared.preview.expiresAt):Infinity):null;}
 get fresh(){return this.observedAt!==null&&this.now()>=this.observedAt&&this.expiresAt!==null&&this.now()<this.expiresAt;}
 get canPreview(){return !this.busy&&!this.uncertain&&!this.ref;}
 get canConfirm(){return !this.busy&&!this.uncertain&&!this.confirmAttempted&&this.fresh&&this.prepared!==null;}
 get canCancel(){return !this.busy&&!!this.ref&&!this.cancelAttempted&&this.status?.kind!=='CANCELLED_LOCAL'&&(this.status?.kind!=='DELIVERY_STATUS'||['PENDING','SENDING'].includes(this.status.delivery.state));}
 private erase(all=false){this.prepared=null;this.status=null;this.observedAt=null;if(all){this.ref=null;this.contextHash=null;}}
 clear(){if(this.pending&&this.operation!=='read')this.uncertain=true;this.generation++;this.controller?.abort();this.controller=null;this.pending=false;this.operation=null;this.erase(true);}
 expire(){if(this.expiresAt===null||this.fresh)return false;this.erase();return true;}
 private begin(operation:NonNullable<GroupEscalationsFlow['operation']>){this.erase();this.pending=true;this.operation=operation;this.controller=new AbortController();return {epoch:++this.generation,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(escalationUiRequestLifetimeMs)])};}
 private end(epoch:number){if(epoch===this.generation){this.pending=false;this.operation=null;this.controller=null;}}
 private time(asOf:string){const value=Date.parse(asOf),now=this.now();if(!Number.isFinite(now)||value>now+5000||value<now-60000)throw Error('ESCALATION_STALE');}
 private async checkPrepared(value:EscalationUiPrepared,reason?:string){const p=value.preview;this.time(p.asOf);if(p.groupId!==this.target.groupId||!sameIntent(this.target,p.intent)||p.case.id!==this.target.caseId||p.case.version!==this.target.caseVersion||p.contract.version!==this.target.contractVersion||Date.parse(p.expiresAt)<=this.now()||p.intentHash!==await escalationUiHash(p.intent)||value.previewHash!==await escalationUiHash(p)||reason!==undefined&&p.intent.reason!==reason||this.contextHash!==null&&p.contextHash!==this.contextHash||this.ref!==null&&(p.proposalId!==this.ref.proposalId||value.previewHash!==this.ref.previewHash))throw Error('ESCALATION_MISMATCH');if(Date.parse(p.expiresAt)<=this.now())throw Error('ESCALATION_STALE');}
 private checkReceipt(value:EscalationUiStatus,ref:z.infer<typeof reference>){const p=value.receipt;this.time(p.asOf);if(value.kind==='DELIVERY_STATUS')this.time(value.delivery.asOf);if(p.proposalId!==ref.proposalId||p.previewHash!==ref.previewHash||p.contextHash!==this.contextHash||p.groupId!==this.target.groupId||p.caseId!==this.target.caseId||p.caseVersion!==this.target.caseVersion||p.contractVersion!==this.target.contractVersion)throw Error('ESCALATION_MISMATCH');}
 private acceptPrepared(value:EscalationUiPrepared){this.prepared=value;this.ref=reference.parse({proposalId:value.preview.proposalId,previewHash:value.previewHash});this.contextHash=value.preview.contextHash;this.observedAt=this.now();}
 private acceptStatus(value:EscalationUiStatus){this.status=value;this.observedAt=this.now();if(value.kind==='DELIVERY_STATUS'){this.confirmAttempted=true;if(value.delivery.state==='UNKNOWN')this.uncertain=true;}if(value.kind==='RECONCILE_REQUIRED')this.uncertain=true;}
 async preview(reason:unknown):Promise<EscalationUiOutcome|null>{
  if(!this.canPreview)return null;let body:z.infer<typeof intent>,key:string;try{body=intent.parse({caseId:this.target.caseId,expectedCaseVersion:this.target.caseVersion,expectedContractVersion:this.target.contractVersion,reason:typeof reason==='string'?reason.trim():reason});key=uuid.parse(this.key());}catch{return {ok:false,notice:'请填写明确的升级理由（最多1000字），本次没有发送申请。'};}
  const c=this.begin('preview');try{const value=escalationUiPreparation.parse(await this.transport(base(this.target)+'/preview',{method:'POST',body,key,signal:c.signal}));if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();if(value.kind==='PREPARED'){await this.checkPrepared(value,body.reason);if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();this.acceptPrepared(value);return {ok:true,notice:'请核对服务端当前事项、升级对象和理由，再明确确认。尚未发送通知。'};}this.uncertain=value.kind==='UNKNOWN';this.erase(true);return {ok:false,notice:value.kind==='UNKNOWN'?'申请结果尚未确认；不会自动再建申请，请先联系管理员核对。':'服务端拒绝了本次申请，未提供可确认的预览。'};}catch(error){if(c.epoch!==this.generation)return null;this.uncertain=!(error instanceof EscalationUiFailure&&[401,403,404,409].includes(error.status));this.erase(true);return failure(error,true);}finally{this.end(c.epoch);}
 }
 async read():Promise<EscalationUiOutcome|null>{
  if(this.busy||!this.ref)return null;const ref={...this.ref},c=this.begin('read');try{const value=escalationUiRead.parse(await this.transport(base(this.target)+'/'+ref.proposalId,{method:'GET',signal:c.signal}));if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();if(value.kind==='PREPARED'){await this.checkPrepared(value);if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();this.acceptPrepared(value);}else if('receipt'in value){this.checkReceipt(value,ref);this.acceptStatus(value);}else{this.erase(value.kind==='DENIED');if(value.kind==='UNKNOWN')this.uncertain=true;return {ok:false,notice:value.kind==='UNKNOWN'?'申请状态仍不明，不会自动重发，请继续核对。':'服务端当前拒绝读取，旧预览已清除。'};}return {ok:true,notice:'已读取本申请的当前本地状态，仍不代表通知送达或事项完成。'};}catch(error){if(c.epoch!==this.generation)return null;this.erase(true);return failure(error);}finally{this.end(c.epoch);}
 }
 async confirm():Promise<EscalationUiOutcome|null>{
  if(!this.canConfirm||!this.prepared||!this.ref)return null;const ref={...this.ref},deadline=Date.parse(this.prepared.preview.expiresAt);let key:string;try{key=uuid.parse(this.key());}catch{return {ok:false,notice:'本次确认条件无效，没有提交。'};}this.confirmAttempted=true;const c=this.begin('confirm');try{const value=escalationUiEnqueue.parse(await this.transport(base(this.target)+'/'+ref.proposalId+'/confirm',{method:'POST',body:{previewHash:ref.previewHash},key,signal:c.signal}));if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();if(value.kind==='QUEUED'){if(this.now()>=deadline)throw Error('ESCALATION_EXPIRED_ACK');this.checkReceipt(value,ref);this.acceptStatus(value);return {ok:true,notice:'服务端已登记入队；尚不能确认通知送达或问题解决。'};}this.uncertain=value.kind==='UNKNOWN';this.erase(value.kind==='DENIED');return {ok:false,notice:value.kind==='UNKNOWN'?'确认结果尚未核实，可能已入队；不会重复确认，请只重新读取本申请。':'服务端拒绝确认，旧预览已清除，请返回事项列表核对。'};}catch(error){if(c.epoch!==this.generation)return null;this.uncertain=true;this.erase(error instanceof EscalationUiFailure);return failure(error,true);}finally{this.end(c.epoch);}
 }
 async cancel():Promise<EscalationUiOutcome|null>{
  if(!this.canCancel||!this.ref)return null;const ref={...this.ref};let key:string;try{key=uuid.parse(this.key());}catch{return {ok:false,notice:'本次停止条件无效，没有提交。'};}this.cancelAttempted=true;const c=this.begin('cancel');try{const value=escalationUiCancellation.parse(await this.transport(base(this.target)+'/'+ref.proposalId+'/cancel',{method:'POST',body:{previewHash:ref.previewHash},key,signal:c.signal}));if(c.epoch!==this.generation)return null;c.signal.throwIfAborted();if('receipt'in value){this.checkReceipt(value,ref);this.acceptStatus(value);return {ok:true,notice:value.kind==='CANCELLED_LOCAL'?'服务端已记录停止未派发后续；不能撤回已发送的通知。':'已有在途或不明状态，需人工核对；不保证撤回，也不会自动重发。'};}this.uncertain=value.kind==='UNKNOWN';this.erase(value.kind==='DENIED');return {ok:false,notice:value.kind==='UNKNOWN'?'停止结果尚未确认，不会重复提交；请重新读取本申请核对。':'服务端拒绝停止请求，旧预览已清除，请核对当前权限。'};}catch(error){if(c.epoch!==this.generation)return null;this.uncertain=true;this.erase(error instanceof EscalationUiFailure);return failure(error,true);}finally{this.end(c.epoch);}
 }
}
