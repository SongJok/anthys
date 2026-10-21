import {createHash} from 'node:crypto';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';

export type SyntheticGroupReplyRequest=Readonly<{targetHash:string;bodyHash:string;method:'POST';sequence:number}>;
const digest=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
function check(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
/** Exercises the real reply sender against one exact synthetic HTTP target.
 * Diagnostics retain hashes only. A swallowed fetch failure remains observable
 * through either accessor as well as the sender's non-APPLIED outcome. */
export function syntheticCompanyAgentGroupSender(options:{robotCode:string;expectedReplyUrl:string;expectedText:string}):{sender:DingTalkSender;readonly requests:ReadonlyArray<SyntheticGroupReplyRequest>;replyCount:()=>number}{
 const {robotCode,expectedReplyUrl,expectedText}=options;
 check(typeof robotCode==='string'&&robotCode.trim().length>0,'SYNTHETIC_REPLY_ROBOT_INVALID');
 check(typeof expectedReplyUrl==='string'&&typeof expectedText==='string','SYNTHETIC_REPLY_CONFIGURATION_INVALID');
 let approved:URL;try{approved=new URL(expectedReplyUrl);}catch{throw Error('SYNTHETIC_REPLY_CONFIGURATION_INVALID');}
 check(approved.href===expectedReplyUrl&&approved.protocol==='https:'&&approved.hostname==='oapi.dingtalk.com'&&!approved.username&&!approved.password&&!approved.port&&['/robot/send','/robot/sendBySession'].includes(approved.pathname),'SYNTHETIC_REPLY_CONFIGURATION_INVALID');
 const records:SyntheticGroupReplyRequest[]=[];let failure:Error|undefined;
 const healthy=()=>{if(failure)throw failure;};
 const fetcher:typeof fetch=async(input,init)=>{
  try{
   healthy();check(typeof input==='string'||input instanceof URL,'SYNTHETIC_REPLY_TARGET_INVALID');
   check(String(input)===expectedReplyUrl,'SYNTHETIC_REPLY_TARGET_MISMATCH');
   check(init?.method==='POST','SYNTHETIC_REPLY_METHOD_INVALID');
   check(init.redirect==='error','SYNTHETIC_REPLY_REDIRECT_INVALID');
   check(init.signal instanceof AbortSignal&&!init.signal.aborted,'SYNTHETIC_REPLY_SIGNAL_INVALID');
   const headers=new Headers(init.headers);
   check(headers.get('content-type')==='application/json'&&[...headers].length===1,'SYNTHETIC_REPLY_HEADERS_INVALID');
   check(typeof init.body==='string','SYNTHETIC_REPLY_BODY_INVALID');
   let body:unknown;try{body=JSON.parse(init.body);}catch{throw Error('SYNTHETIC_REPLY_JSON_INVALID');}
   check(body!==null&&typeof body==='object'&&!Array.isArray(body),'SYNTHETIC_REPLY_BODY_INVALID');
   const object=body as Record<string,unknown>,text=object['text'];
   check(Object.keys(object).length===2&&Object.hasOwn(object,'msgtype')&&Object.hasOwn(object,'text')&&object['msgtype']==='text'&&text!==null&&typeof text==='object'&&!Array.isArray(text),'SYNTHETIC_REPLY_BODY_INVALID');
   const content=text as Record<string,unknown>;
   check(Object.keys(content).length===1&&Object.hasOwn(content,'content')&&content['content']===expectedText,'SYNTHETIC_REPLY_CONTENT_MISMATCH');
   records.push(Object.freeze({targetHash:digest(expectedReplyUrl),bodyHash:digest(init.body),method:'POST',sequence:records.length+1}));
   return new Response(JSON.stringify({errcode:0}),{status:200,headers:{'content-type':'application/json'}});
  }catch(error){const code=error instanceof Error&&/^SYNTHETIC_REPLY_[A-Z_]+$/.test(error.message)?error.message:'SYNTHETIC_REPLY_FIXTURE_FAILED';failure=Error(code);throw failure;}
 };
 const sender=new DingTalkSender({clientId:'SYNTHETIC_REPLY_ONLY',clientSecret:'SYNTHETIC_UNUSED',robotCode,replyOnly:true,fetch:fetcher});
 return {sender,get requests(){healthy();return Object.freeze([...records]);},replyCount:()=>{healthy();return records.length;}};
}
