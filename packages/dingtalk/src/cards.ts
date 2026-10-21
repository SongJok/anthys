import {z} from 'zod';
import type {SendResult} from './sender.js';
export type CardResult=SendResult&{retryAfterMs?:number};
export function cardRetryDelay(value:string|null,now:number):number {
 if(!value)return 1500;const raw=value.trim();if(/^\d+(?:\.\d+)?$/.test(raw)){const ms=Number(raw)*1000;return Number.isFinite(ms)?Math.max(750,ms):Number.MAX_SAFE_INTEGER;}
 const deadline=Date.parse(raw);return Number.isFinite(deadline)?Math.max(750,deadline-now):1500;
}
export const cardTemplateSchema=z.object({templateId:z.string().min(1).max(200),statusKey:z.string().min(1).max(100),taskUrlKey:z.string().min(1).max(100),cancelTokenKey:z.string().min(1).max(100)}).strict();
export type CardTemplate=z.infer<typeof cardTemplateSchema>;
export interface CardTransport {
 create(input:{outTrackId:string;target:{kind:'PRIVATE_USER'|'GROUP';externalId:string};data:Record<string,string>},signal:AbortSignal):Promise<CardResult>;
 update(input:{outTrackId:string;guid:string;key:string;content:string;finalize:boolean},signal:AbortSignal):Promise<CardResult>;
}
// Locked @alicloud/dingtalk 2.2.48 card_1_0 contract; acceptance is not delivery verification.
export class DingTalkCards implements CardTransport {
 constructor(private options:{template:CardTemplate;robotCode:string;token:(signal:AbortSignal)=>Promise<string>;fetch?:typeof fetch;clock?:()=>number}){cardTemplateSchema.parse(options.template);}
 private async request(path:string,method:'POST'|'PUT',body:Record<string,unknown>,signal:AbortSignal):Promise<{raw:unknown;requestId?:string}|CardResult>{
  let token:string;try{token=await this.options.token(signal);}catch{return {state:'FAILED',reason:'TOKEN_UNAVAILABLE'};}
  try{const r=await (this.options.fetch??fetch)('https://api.dingtalk.com'+path,{method,headers:{'content-type':'application/json','x-acs-dingtalk-access-token':token},body:JSON.stringify(body),signal,redirect:'error'});
   if(!r.ok){await r.body?.cancel();if(r.status===429)return {state:'FAILED',reason:'RATE_LIMITED',retryAfterMs:cardRetryDelay(r.headers.get('retry-after'),(this.options.clock??Date.now)())};return {state:r.status>=500?'UNKNOWN':'FAILED',reason:`HTTP_${r.status}`};}
   return {raw:await r.json(),...(r.headers.get('x-acs-request-id')?{requestId:r.headers.get('x-acs-request-id')!}:{})};
  }catch{return {state:'UNKNOWN',reason:'RESPONSE_LOST'};}
 }
 async create(input:{outTrackId:string;target:{kind:'PRIVATE_USER'|'GROUP';externalId:string};data:Record<string,string>},signal:AbortSignal):Promise<CardResult>{
  // IDs cannot introduce another card space/recipient through a delimiter.
  if(!/^[A-Za-z0-9_+=\/-]{1,512}$/.test(input.target.externalId))return {state:'FAILED',reason:'INVALID_CARD_RECIPIENT'};
  const group=input.target.kind==='GROUP';
  const r=await this.request('/v1.0/card/instances/createAndDeliver','POST',{cardTemplateId:this.options.template.templateId,outTrackId:input.outTrackId,cardData:{cardParamMap:input.data},callbackType:'STREAM',userIdType:1,openSpaceId:`dtv1.card//${group?'IM_GROUP':'IM_ROBOT'}.${input.target.externalId}`,...(group?{imGroupOpenDeliverModel:{robotCode:this.options.robotCode},imGroupOpenSpaceModel:{supportForward:false}}:{imRobotOpenDeliverModel:{spaceType:'IM_ROBOT',robotCode:this.options.robotCode},imRobotOpenSpaceModel:{supportForward:false}})},signal);
  if('state' in r)return r;
  const parsed=z.object({success:z.boolean(),result:z.object({outTrackId:z.string(),deliverResults:z.array(z.object({spaceId:z.string(),spaceType:z.string(),success:z.boolean(),carrierId:z.string().optional()}))}).optional()}).safeParse(r.raw);
  if(!parsed.success)return {state:'UNKNOWN',reason:'UNRECOGNIZED_CARD_RECEIPT'};
  if(!parsed.data.success)return {state:'FAILED',reason:'CARD_REJECTED'};
  const result=parsed.data.result;if(!result||result.outTrackId!==input.outTrackId||result.deliverResults.length!==1||result.deliverResults[0]?.spaceId!==input.target.externalId||result.deliverResults[0]?.spaceType!==(group?'IM_GROUP':'IM_ROBOT'))return {state:'UNKNOWN',reason:'CARD_RECEIPT_MISMATCH'};
  if(!result.deliverResults[0].success)return {state:'FAILED',reason:'CARD_DELIVERY_REJECTED'};
  return {state:'APPLIED_UNVERIFIED',externalMessageId:input.outTrackId,...(r.requestId?{requestId:r.requestId}:{})};
 }
 async update(input:{outTrackId:string;guid:string;key:string;content:string;finalize:boolean},signal:AbortSignal):Promise<CardResult>{
  const r=await this.request('/v1.0/card/streaming','PUT',{outTrackId:input.outTrackId,guid:input.guid,key:input.key,content:input.content,isFull:true,isFinalize:input.finalize,isError:false},signal);if('state' in r)return r;
  const parsed=z.object({success:z.boolean(),result:z.boolean()}).safeParse(r.raw);if(!parsed.success)return {state:'UNKNOWN',reason:'UNRECOGNIZED_CARD_RECEIPT'};
  return parsed.data.success&&parsed.data.result?{state:'APPLIED_UNVERIFIED',externalMessageId:input.outTrackId,...(r.requestId?{requestId:r.requestId}:{})}:{state:'FAILED',reason:'CARD_UPDATE_REJECTED'};
 }
}
