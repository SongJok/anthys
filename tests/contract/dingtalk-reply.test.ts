import '../support/isolation.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
const now=1700000000000,signal=()=>new AbortController().signal;
const session='https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',legacy='https://oapi.dingtalk.com/robot/send?access_token=synthetic';
const options={clientId:'synthetic-only',clientSecret:'synthetic-only',robotCode:'synthetic-only',clock:()=>now};
// All fetch functions below are dependency-injected local contract doubles.
// No project environment, real webhook, token or provider network is involved.
it.each([session,legacy])('posts synthetic text only to the exact accepted reply URL %s',async url=>{
 let calls=0;const sender=new DingTalkSender({...options,fetch:async(input,init)=>{calls++;expect(String(input)).toBe(url);expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/json'}});expect(JSON.parse(init!.body as string)).toEqual({msgtype:'text',text:{content:'synthetic reply contract'}});return new Response('{"errcode":0}');}});expect(await sender.sendReply({url,expiresAt:now+60000},'synthetic reply contract',signal())).toEqual({state:'APPLIED_UNVERIFIED'});expect(calls).toBe(1);
});
it.each([session,legacy])('expired reply address makes zero requests for %s',async url=>{
 let calls=0;const sender=new DingTalkSender({...options,fetch:async()=>{calls++;throw Error('EXPIRED_REPLY_MUST_NOT_FETCH');}});expect(await sender.sendReply({url,expiresAt:now},'synthetic',signal())).toEqual({state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'});expect(calls).toBe(0);
});
it.each(['not a URL','//oapi.dingtalk.com/robot/sendBySession?session=synthetic','http://oapi.dingtalk.com/robot/sendBySession?session=synthetic','https://oapi.dingtalk.com.evil.invalid/robot/sendBySession?session=synthetic','https://oapi.dingtalk.com@evil.invalid/robot/sendBySession?session=synthetic','https://u:p@oapi.dingtalk.com/robot/sendBySession?session=synthetic','https://oapi.dingtalk.com:444/robot/sendBySession?session=synthetic','https://oapi.dingtalk.com/robot/sendBySession/extra?session=synthetic','https://oapi.dingtalk.com/robot/sendBySessionExtra?session=synthetic','https://oapi.dingtalk.com/robot/sendBySession/?session=synthetic','https://oapi.dingtalk.com/robot/%73endBySession?session=synthetic'])('malformed or unauthorized reply URL is a controlled failure with zero requests: %s',async url=>{
 let calls=0;const sender=new DingTalkSender({...options,fetch:async()=>{calls++;throw Error('UNAUTHORIZED_REPLY_MUST_NOT_FETCH');}});expect(await sender.sendReply({url,expiresAt:now+60000},'synthetic',signal())).toEqual({state:'FAILED',reason:'INVALID_REPLY_ADDRESS'});expect(calls).toBe(0);
});
it('a redirect refusal stays UNKNOWN and never performs a second request',async()=>{
 let calls=0;const sender=new DingTalkSender({...options,fetch:async(_input,init)=>{calls++;expect(init!.redirect).toBe('error');throw TypeError('synthetic redirect refusal');}});expect(await sender.sendReply({url:session,expiresAt:now+60000},'synthetic',signal())).toEqual({state:'UNKNOWN',reason:'RESPONSE_LOST'});expect(calls).toBe(1);
});
it.each(['PRIVATE_USER','GROUP'] as const)('reply-only rejects %s proactive delivery before token exchange',async kind=>{
 let calls=0;const sender=new DingTalkSender({...options,replyOnly:true,fetch:async()=>{calls++;throw Error('REPLY_ONLY_MUST_NOT_FETCH');}});
 expect(sender.replyOnly).toBe(true);
 expect(await sender.sendProactive({kind,externalId:'synthetic-only'},'synthetic',signal())).toEqual({state:'FAILED',reason:'PROACTIVE_REPLY_ONLY_MODE'});
 await expect(sender.token(signal())).rejects.toThrow('PROACTIVE_REPLY_ONLY_MODE');
 expect(calls).toBe(0);
});
it.each([session,legacy])('reply-only still permits the exact current session URL %s without a token',async url=>{
 let calls=0;const sender=new DingTalkSender({...options,replyOnly:true,fetch:async(input)=>{calls++;expect(String(input)).toBe(url);return new Response('{"errcode":0}');}});
 expect(await sender.sendReply({url,expiresAt:now+60000},'synthetic',signal())).toEqual({state:'APPLIED_UNVERIFIED'});
 expect(calls).toBe(1);
});
it('default mode retains the existing proactive token and provider receipt contract',async()=>{
 const calls:string[]=[];const sender=new DingTalkSender({...options,fetch:async(input,init)=>{calls.push(String(input));expect(init!.redirect).toBe('error');if(calls.length===1)return new Response('{"accessToken":"synthetic-only","expireIn":7200}');expect(init!.headers).toMatchObject({'x-acs-dingtalk-access-token':'synthetic-only'});return new Response('{"processQueryKey":"synthetic-only"}');}});
 expect(sender.replyOnly).toBe(false);
 expect(await sender.sendProactive({kind:'PRIVATE_USER',externalId:'synthetic-only'},'synthetic',signal())).toEqual({state:'APPLIED_UNVERIFIED',externalMessageId:'synthetic-only'});
 expect(calls).toEqual(['https://api.dingtalk.com/v1.0/oauth2/accessToken','https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend']);
});
