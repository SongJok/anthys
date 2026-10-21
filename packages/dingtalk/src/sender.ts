import {z} from 'zod';
export interface SendResult {state:'APPLIED_UNVERIFIED'|'FAILED'|'UNKNOWN';externalMessageId?:string;requestId?:string;reason?:string}
export class DingTalkSender {
 private cached:{value:string;until:number}|null=null;
 constructor(private options:{clientId:string;clientSecret:string;robotCode:string;fetch?:typeof fetch;clock?:()=>number;replyOnly?:boolean}) {}
 get replyOnly():boolean {return this.options.replyOnly===true;}
 private now():number {return (this.options.clock??Date.now)();}
 async token(signal:AbortSignal):Promise<string> {
  if(this.replyOnly)throw Error('PROACTIVE_REPLY_ONLY_MODE');
  if(this.cached&&this.cached.until>this.now()) return this.cached.value;
  const r=await (this.options.fetch??fetch)('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appKey:this.options.clientId,appSecret:this.options.clientSecret}),signal,redirect:'error'});
  if(!r.ok) throw Error('TOKEN_UNAVAILABLE');
  const t=z.object({accessToken:z.string().min(1),expireIn:z.number().positive()}).parse(await r.json());this.cached={value:t.accessToken,until:this.now()+Math.max(0,t.expireIn-60)*1000};return t.accessToken;
 }
 async sendProactive(target:{kind:'PRIVATE_USER'|'GROUP';externalId:string},text:string,signal:AbortSignal,beforePhysical?:()=>Promise<boolean>):Promise<SendResult> {
  if(this.replyOnly)return {state:'FAILED',reason:'PROACTIVE_REPLY_ONLY_MODE'};
  let token:string;try{token=await this.token(signal);}catch{return {state:'FAILED',reason:'TOKEN_UNAVAILABLE'};}
  // Token acquisition can wait on the network. Current source/authority must
  // be rechecked after it completes, immediately before the message request.
  try{signal.throwIfAborted();if(beforePhysical&&!await beforePhysical())return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};signal.throwIfAborted();}catch{return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};}
  const path=target.kind==='PRIVATE_USER'?'oToMessages/batchSend':'groupMessages/send';
  const body={robotCode:this.options.robotCode,msgKey:'sampleText',msgParam:JSON.stringify({content:text}),...(target.kind==='PRIVATE_USER'?{userIds:[target.externalId]}:{openConversationId:target.externalId})};
  try {
   const r=await (this.options.fetch??fetch)(`https://api.dingtalk.com/v1.0/robot/${path}`,{method:'POST',headers:{'content-type':'application/json','x-acs-dingtalk-access-token':token},body:JSON.stringify(body),signal,redirect:'error'});
   if(!r.ok) {await r.body?.cancel();return {state:r.status>=500?'UNKNOWN':'FAILED',reason:`HTTP_${r.status}`};}
   const raw=await r.json() as Record<string,unknown>;
   if((typeof raw['code']==='string'&&raw['code']!=='0')||(raw['errcode']!==undefined&&raw['errcode']!==0)) return {state:'FAILED',reason:'PROVIDER_BUSINESS_ERROR'};
   if(['invalidStaffIdList','flowControlledStaffIdList','filteredStaffIdList'].some(k=>Array.isArray(raw[k])&&(raw[k] as unknown[]).length>0)) return {state:'FAILED',reason:'RECIPIENT_REJECTED'};
   const id=z.string().min(1).safeParse(raw['processQueryKey']);if(!id.success) return {state:'UNKNOWN',reason:'MISSING_PROVIDER_RECEIPT'};
   return {state:'APPLIED_UNVERIFIED',externalMessageId:id.data,...(r.headers.get('x-acs-request-id')?{requestId:r.headers.get('x-acs-request-id')!}:{})};
  } catch {return {state:'UNKNOWN',reason:'RESPONSE_LOST'};}
 }
 async sendReply(reply:{url:string;expiresAt:number},text:string,signal:AbortSignal,beforePhysical?:()=>Promise<boolean>):Promise<SendResult> {
  let url:URL;try{url=new URL(reply.url);}catch{return {state:'FAILED',reason:'INVALID_REPLY_ADDRESS'};}
  if(url.protocol!=='https:'||url.hostname!=='oapi.dingtalk.com'||url.username||url.password||url.port||!['/robot/send','/robot/sendBySession'].includes(url.pathname)) return {state:'FAILED',reason:'INVALID_REPLY_ADDRESS'};
  if(reply.expiresAt<=this.now()) return {state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'};
  try{signal.throwIfAborted();if(beforePhysical&&!await beforePhysical())return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};signal.throwIfAborted();if(reply.expiresAt<=this.now())return {state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'};}catch{return {state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'};}
  try {
   const r=await (this.options.fetch??fetch)(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content:text}}),signal,redirect:'error'});
   if(!r.ok) {await r.body?.cancel();return {state:r.status>=500?'UNKNOWN':'FAILED',reason:`HTTP_${r.status}`};}
   const result=z.object({errcode:z.number()}).safeParse(await r.json());if(!result.success) return {state:'UNKNOWN',reason:'UNRECOGNIZED_REPLY_RESPONSE'};return result.data.errcode===0?{state:'APPLIED_UNVERIFIED'}:{state:'FAILED',reason:'PROVIDER_BUSINESS_ERROR'};
  } catch {return {state:'UNKNOWN',reason:'RESPONSE_LOST'};}
 }
}
