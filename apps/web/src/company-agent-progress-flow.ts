import {z} from 'zod';
const uuid=z.uuid().transform(value=>value.toLowerCase()),instant=z.iso.datetime({offset:true});
const targetSchema=z.object({taskId:uuid,runId:uuid}).strict();
const entrySchema=z.object({id:uuid,taskId:uuid,runId:uuid,state:z.enum(['QUEUED','DISPATCHING','RESPONSE_RECEIVED','NOT_SENT','UNKNOWN','CANCELLED','BLOCKED','EXPIRED']),createdAt:instant,updatedAt:instant,deadline:instant,dispatchStartedAt:instant.nullable(),localCancellationRequestedAt:instant.nullable(),remoteCancellation:z.enum(['NOT_REQUESTED','UNCONFIRMED']),automaticRetry:z.literal(false),source:z.object({kind:z.literal('ENTERPRISE_AGENT_MCP'),connectorId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),toolName:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),verification:z.literal('UNVERIFIED')}).strict(),cost:z.object({enterprise:z.enum(['NOT_DISPATCHED','UNKNOWN'])}).strict(),reasonCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).nullable()}).strict();
const pageSchema=z.object({items:z.array(entrySchema).max(128),asOf:instant}).strict();
const cancelSchema=z.object({taskId:uuid,status:z.enum(['OPEN','ACTIVE','PAUSED','COMPLETED','CANCELLED','EXPIRED']),deliveryCancellationRequested:z.boolean(),inFlightExternalActions:z.literal('MUST_RECONCILE')}).strict();
export type EnterpriseRequest=z.infer<typeof entrySchema>;
export type EnterpriseRequestState=EnterpriseRequest['state'];
export type EnterpriseProgressTarget=z.infer<typeof targetSchema>;
export type EnterpriseProgressOutcome={ok:boolean;notice:string;sessionLost?:boolean};
export interface EnterpriseProgressTransport{request:(path:string,input:{method:'GET'|'POST';signal:AbortSignal;body?:Record<string,never>})=>Promise<unknown>}
export class EnterpriseProgressFailure extends Error{constructor(readonly status:number){super('ENTERPRISE_PROGRESS_REQUEST_FAILED');}}
export const enterprisePollIntervalMs=2000,enterprisePollLifetimeMs=1200000,enterpriseSnapshotLifetimeMs=60000;
export const enterpriseStateCopy:Record<EnterpriseRequestState,{label:string;detail:string}>={
 QUEUED:{label:'等待派发',detail:'请求已记入本地队列，尚不能确认企业底座已接收。'},
 DISPATCHING:{label:'正在等待回复',detail:'本地已开始请求并等待回复；企业底座的计算进度不可见。'},
 RESPONSE_RECEIVED:{label:'已收到上游回复',detail:'回复已收到，等待任务结果处理；这不表示事实、根因或外部动作已核验。'},
 NOT_SENT:{label:'本次请求未发送',detail:'本地记录显示本次请求尚未开始发送，不会自动重问。'},
 UNKNOWN:{label:'远端结果不明',detail:'无法确认企业底座是否已完成，已阻止自动重复提问。请先核对这次请求。'},
 CANCELLED:{label:'本地等待已停止',detail:'服务端已记录停止本任务本地等待；企业底座是否已停未确认，不会重问。'},
 BLOCKED:{label:'请求已暂停',detail:'当前条件未满足，请先核对任务。没有自动重复提问。'},
 EXPIRED:{label:'服务端已记录到期',detail:'服务端已记录等待期限到期；远端状态仍需核对，不会自动重问。'},
};
export const validEnterpriseTarget=(taskId:unknown,runId:unknown)=>targetSchema.safeParse({taskId,runId}).success;
export const shouldShowEnterpriseProgress=(run:unknown)=>!!run&&typeof run==='object'&&Reflect.get(run,'enterprise_request')===true;
const csrfSafe=(value:string)=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value);
async function jsonBytes(response:Response,signal:AbortSignal):Promise<Uint8Array>{
 const max=524288,length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>max)){await response.body?.cancel().catch(()=>{});throw new EnterpriseProgressFailure(0);}
 if(!response.body)throw new EnterpriseProgressFailure(0);
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>max)throw new EnterpriseProgressFailure(0);chunks.push(chunk.value);}signal.throwIfAborted();const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}return bytes;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Same-origin local status/cancel API only. No enterprise query endpoint exists here. */
export function createEnterpriseProgressTransport(csrf:string,fetcher:typeof fetch=fetch):EnterpriseProgressTransport{
 return {async request(path,input){
  const match=/^\/api\/v1\/tasks\/([a-f0-9-]+)\/(enterprise-requests|cancel)$/.exec(path);
  if(!match||!uuid.safeParse(match[1]).success||!['GET','POST'].includes(input.method)||input.method!==(match[2]==='cancel'?'POST':'GET')||input.method==='GET'&&input.body!==undefined||input.method==='POST'&&(!csrfSafe(csrf)||!z.object({}).strict().safeParse(input.body).success))throw new EnterpriseProgressFailure(0);
  input.signal.throwIfAborted();
  const response=await fetcher(path,{method:input.method,signal:input.signal,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',headers:{accept:'application/json',...(input.method==='POST'?{'content-type':'application/json','x-csrf-token':csrf}:{})},...(input.method==='POST'?{body:'{}'}:{})});
  if(response.redirected||!response.ok){await response.body?.cancel().catch(()=>{});throw new EnterpriseProgressFailure(response.redirected?0:response.status);}
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json'){await response.body?.cancel().catch(()=>{});throw new EnterpriseProgressFailure(0);}
  const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await jsonBytes(response,input.signal))) as unknown;
  const envelope=z.object({data:z.unknown()}).strict().parse(value);if(!Object.hasOwn(envelope,'data'))throw new EnterpriseProgressFailure(0);return envelope.data;
 }};
}
function failure(error:unknown,write=false):EnterpriseProgressOutcome{
 const status=error instanceof EnterpriseProgressFailure?error.status:0;
 return {ok:false,notice:status===401?'登录已失效，企业请求记录已清除，请重新登录。':status===403||status===404?'当前请求记录无法读取，旧数据已清除，请核对权限。':write?'停止请求的结果尚未确认；企业底座是否已停未确认。不会重复提交或重问，请只重新读取状态核对。':'请求状态暂时无法核实，旧记录已清除，已暂停自动更新。请手动重新读取。',...(status===401?{sessionLost:true}:{})};
}
/** Display freshness/epochs only. The server establishes live authority and states. */
export class CompanyAgentProgressFlow{
 snapshot:{items:EnterpriseRequest[];asOf:string;receivedAt:number}|null=null;
 private generation=0;
 private controller:AbortController|null=null;
 private pending=false;
 private operation:'read'|'stop'|null=null;
 private autoSuspended=false;
 private automaticReads=0;
 private lastAutomaticAt=-Infinity;
 private readonly pollUntil:number;
 private stopAttempted=false;
 private stopUnknown=false;
 private confirming=false;
 readonly target:EnterpriseProgressTarget;
 constructor(private transport:EnterpriseProgressTransport,target:EnterpriseProgressTarget,private now:()=>number=Date.now){this.target=targetSchema.parse(target);this.pollUntil=now()+enterprisePollLifetimeMs;}
 get busy(){return this.pending;}
 get confirmationOpen(){return this.confirming;}
 get cancellationUncertain(){return this.stopUnknown;}
 get cancellationAttempted(){return this.stopAttempted;}
 get pollingLimitReached(){return this.now()>=this.pollUntil||this.automaticReads>=600;}
 get expiresAt(){return this.snapshot?Math.min(this.snapshot.receivedAt+enterpriseSnapshotLifetimeMs,Date.parse(this.snapshot.asOf)+enterpriseSnapshotLifetimeMs):null;}
 get fresh(){return this.snapshot!==null&&this.now()>=this.snapshot.receivedAt&&this.now()<this.expiresAt!;}
 get items(){return this.fresh?this.snapshot!.items:[];}
 get shouldPoll(){return !this.pending&&!this.confirming&&!this.autoSuspended&&!this.pollingLimitReached&&this.now()>=this.lastAutomaticAt+enterprisePollIntervalMs&&(!this.fresh||this.items.length===0||this.items.some(item=>['QUEUED','DISPATCHING'].includes(item.state)));}
 get canStop(){return !this.pending&&!this.confirming&&!this.stopAttempted&&this.fresh&&this.items.some(item=>!item.localCancellationRequestedAt&&['QUEUED','DISPATCHING','RESPONSE_RECEIVED','UNKNOWN'].includes(item.state));}
 private erase(){this.snapshot=null;this.confirming=false;}
 clear(){if(this.pending&&this.operation==='stop')this.stopUnknown=true;this.generation++;this.controller?.abort();this.controller=null;this.pending=false;this.operation=null;this.erase();}
 pause():EnterpriseProgressOutcome{const write=this.operation==='stop';this.clear();this.autoSuspended=true;return {ok:false,notice:write?'已停止等待停止回执并清除记录；服务端结果仍待核对，不会重复提交或重问，请只重新读取。':'已暂停本页更新并清除记录；没有因此向企业底座发送新问题或任务停止请求。'};}
 expire(){if(this.snapshot&&!this.fresh){this.clear();return true;}return false;}
 beginStopConfirmation(){if(!this.canStop)return false;this.confirming=true;return true;}
 dismissStopConfirmation(){this.confirming=false;}
 private begin(operation:'read'|'stop'){this.pending=true;this.operation=operation;this.controller=new AbortController();return {epoch:++this.generation,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(10000)])};}
 private finish(epoch:number){if(epoch===this.generation){this.pending=false;this.controller=null;this.operation=null;}}
 async read(automatic=false):Promise<EnterpriseProgressOutcome|null>{
  if(this.pending||automatic&&!this.shouldPoll)return null;
  if(automatic){this.automaticReads++;this.lastAutomaticAt=this.now();}
  this.confirming=false;const current=this.begin('read');
  try{
   const raw=await this.transport.request('/api/v1/tasks/'+this.target.taskId+'/enterprise-requests',{method:'GET',signal:current.signal});
   if(current.epoch!==this.generation)return null;current.signal.throwIfAborted();
   const page=pageSchema.parse(raw),now=this.now(),stamp=Date.parse(page.asOf),ids=new Set<string>();
   if(stamp>now+5000||stamp<now-enterpriseSnapshotLifetimeMs)throw Error('ENTERPRISE_STALE_PAGE');
   for(const item of page.items){if(item.taskId!==this.target.taskId||ids.has(item.id)||Date.parse(item.createdAt)>Date.parse(item.updatedAt)||Date.parse(item.updatedAt)>stamp+5000||Date.parse(item.deadline)<Date.parse(item.createdAt)||item.dispatchStartedAt!==null&&(Date.parse(item.dispatchStartedAt)<Date.parse(item.createdAt)||Date.parse(item.dispatchStartedAt)>Date.parse(item.updatedAt)+5000)||item.localCancellationRequestedAt!==null&&(Date.parse(item.localCancellationRequestedAt)<Date.parse(item.createdAt)||Date.parse(item.localCancellationRequestedAt)>Date.parse(item.updatedAt)+5000))throw Error('ENTERPRISE_PAGE_MISMATCH');ids.add(item.id);}
   const matching=page.items.filter(item=>item.runId===this.target.runId);this.snapshot={items:matching,asOf:page.asOf,receivedAt:now};this.autoSuspended=matching.length>0&&!matching.some(item=>['QUEUED','DISPATCHING'].includes(item.state));
   return {ok:true,notice:this.stopUnknown?'已重新读取服务端记录。上次停止回执仍未确认，不会重复提交或重问。':'已读取本次运行的本地请求记录，不表示上游计算进度或事实已核验。'};
  }catch(error){if(current.epoch!==this.generation)return null;this.erase();this.autoSuspended=true;return failure(error);}finally{this.finish(current.epoch);}
 }
 async confirmStop():Promise<EnterpriseProgressOutcome|null>{
  if(this.pending||!this.confirming||this.stopAttempted)return null;
  if(!this.fresh){this.erase();return {ok:false,notice:'状态记录已过期，请重新读取后再确认。'};}
  this.confirming=false;this.stopAttempted=true;this.erase();const current=this.begin('stop');
  try{
   const raw=await this.transport.request('/api/v1/tasks/'+this.target.taskId+'/cancel',{method:'POST',body:{},signal:current.signal});
   if(current.epoch!==this.generation)return null;current.signal.throwIfAborted();
   const receipt=cancelSchema.parse(raw);if(receipt.taskId!==this.target.taskId)throw Error('ENTERPRISE_CANCEL_MISMATCH');
   const confirmed=receipt.status==='CANCELLED'&&receipt.deliveryCancellationRequested;this.stopUnknown=!confirmed;this.autoSuspended=false;
   return {ok:confirmed,notice:receipt.status==='CANCELLED'&&receipt.deliveryCancellationRequested?'服务端已记录任务取消；企业底座是否已停未确认，不会重问。请重新读取请求状态。':'已收到服务端回执，尚未确认任务停止；企业底座是否已停未确认，不会重问。请只重新读取核对。'};
  }catch(error){if(current.epoch!==this.generation)return null;this.stopUnknown=true;this.autoSuspended=true;return failure(error,true);}finally{this.finish(current.epoch);}
 }
}
