import {describe,expect,it,vi} from 'vitest';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';

type Route='reply'|'private'|'group';
type Outcome='OK'|'HTTP_503'|'RESPONSE_LOST';
const replyUrl='https://oapi.dingtalk.com/robot/sendBySession?session=SYNTHETIC';
const text='SYNTHETIC final text';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(route:Route,outcome:Outcome='OK'){
 let now=1000,robotPosts=0,tokenPosts=0;
 const errors:unknown[]=[],tokenStarted=deferred();let tokenWait:Promise<void>=Promise.resolve();
 const transport:typeof fetch=vi.fn(async(input,init)=>{
  try{
   const url=String(input);expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('content-type')).toBe('application/json');expect(init?.signal).toBeInstanceOf(AbortSignal);
   if(url==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){
    tokenPosts++;expect(route).not.toBe('reply');tokenStarted.resolve();await tokenWait;
    return Response.json({accessToken:'SYNTHETIC_TOKEN',expireIn:3600});
   }
   const expected=route==='reply'?replyUrl:route==='private'?'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend':'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
   expect(url).toBe(expected);expect(init?.signal?.aborted).toBe(false);
   const body:unknown=JSON.parse(String(init?.body));
   if(route==='reply'){expect(body).toEqual({msgtype:'text',text:{content:text}});expect(new Headers(init?.headers).has('x-acs-dingtalk-access-token')).toBe(false);}
   else{expect(new Headers(init?.headers).get('x-acs-dingtalk-access-token')).toBe('SYNTHETIC_TOKEN');expect(body).toEqual({robotCode:'SYNTHETIC_ROBOT',msgKey:'sampleText',msgParam:JSON.stringify({content:text}),...(route==='private'?{userIds:['SYNTHETIC_USER']}:{openConversationId:'SYNTHETIC_GROUP'})});}
   robotPosts++;
  }catch(error){errors.push(error);throw error;}
  if(outcome==='RESPONSE_LOST')throw Error('SYNTHETIC_RESPONSE_LOST');
  if(outcome==='HTTP_503')return new Response('SYNTHETIC_FAILURE',{status:503});
  return Response.json(route==='reply'?{errcode:0}:{processQueryKey:'SYNTHETIC_RECEIPT'});
 });
 const sender=new DingTalkSender({clientId:'SYNTHETIC_CLIENT',clientSecret:'SYNTHETIC_SECRET',robotCode:'SYNTHETIC_ROBOT',fetch:transport,clock:()=>now,replyOnly:route==='reply'});
 const send=(signal:AbortSignal,beforePhysical?:()=>Promise<boolean>,expiresAt=2000)=>route==='reply'?sender.sendReply({url:replyUrl,expiresAt},text,signal,beforePhysical):sender.sendProactive({kind:route==='private'?'PRIVATE_USER':'GROUP',externalId:route==='private'?'SYNTHETIC_USER':'SYNTHETIC_GROUP'},text,signal,beforePhysical);
 return {sender,send,tokenStarted,setTokenWait:(wait:Promise<void>)=>{tokenWait=wait;},setNow:(value:number)=>{now=value;},counts:()=>({robotPosts,tokenPosts}),healthy:()=>expect(errors).toEqual([])};
}

// Counts are actual robot fetch invocations, independent of callback invocations.
for(const route of ['reply','private'] as const){
 describe(route+' physical authorization boundary',()=>{
  it.each(['DENY','THROW'] as const)('%s callback yields no robot POST',async mode=>{
   const f=fixture(route),callback=vi.fn(async()=>{if(mode==='THROW')throw Error('SYNTHETIC_HOST_FAILURE');return false;});
   expect(await f.send(new AbortController().signal,callback)).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});
   expect(callback).toHaveBeenCalledTimes(1);expect(f.counts()).toEqual({robotPosts:0,tokenPosts:route==='reply'?0:1});f.healthy();
  });
  it('pre-aborted physical stage never calls callback or robot',async()=>{
   const f=fixture(route),controller=new AbortController(),callback=vi.fn(async()=>true);
   if(route==='private')await f.sender.token(controller.signal);
   controller.abort();expect(await f.send(controller.signal,callback)).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});
   expect(callback).not.toHaveBeenCalled();expect(f.counts().robotPosts).toBe(0);f.healthy();
  });
  it('abort while awaiting host callback prevents the physical POST',async()=>{
   const f=fixture(route),controller=new AbortController(),entered=deferred(),finish=deferred();
   const callback=vi.fn(async()=>{entered.resolve();await finish.promise;return true;});
   const pending=f.send(controller.signal,callback);await entered.promise;expect(f.counts().robotPosts).toBe(0);controller.abort();finish.resolve();
   expect(await pending).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(callback).toHaveBeenCalledTimes(1);expect(f.counts().robotPosts).toBe(0);f.healthy();
  });
  it.each(['HTTP_503','RESPONSE_LOST'] as const)('%s stays UNKNOWN with exactly one physical attempt and no automatic retry',async outcome=>{
   const f=fixture(route,outcome),callback=vi.fn(async()=>true);
   expect(await f.send(new AbortController().signal,callback)).toEqual({state:'UNKNOWN',reason:outcome==='HTTP_503'?'HTTP_503':'RESPONSE_LOST'});
   await Promise.resolve();expect(callback).toHaveBeenCalledTimes(1);expect(f.counts()).toEqual({robotPosts:1,tokenPosts:route==='reply'?0:1});f.healthy();
  });
 });
}

it.each(['not a URL','http://oapi.dingtalk.com/robot/send','https://example.invalid/robot/send','https://user:pass@oapi.dingtalk.com/robot/send','https://oapi.dingtalk.com:444/robot/send','https://oapi.dingtalk.com/other'])('invalid reply address is rejected before slot callback: %s',async url=>{
 const f=fixture('reply'),callback=vi.fn(async()=>true);
 expect(await f.sender.sendReply({url,expiresAt:2000},text,new AbortController().signal,callback)).toEqual({state:'FAILED',reason:'INVALID_REPLY_ADDRESS'});
 expect(callback).not.toHaveBeenCalled();expect(f.counts()).toEqual({robotPosts:0,tokenPosts:0});f.healthy();
});
it.each([999,1000])('expired reply at %i is rejected without burning slot',async expiresAt=>{
 const f=fixture('reply'),callback=vi.fn(async()=>true);
 expect(await f.send(new AbortController().signal,callback,expiresAt)).toEqual({state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'});
 expect(callback).not.toHaveBeenCalled();expect(f.counts()).toEqual({robotPosts:0,tokenPosts:0});f.healthy();
});
it('reply expiry is checked again after asynchronous host authorization',async()=>{
 const f=fixture('reply'),entered=deferred(),finish=deferred(),callback=vi.fn(async()=>{entered.resolve();await finish.promise;return true;});
 const pending=f.send(new AbortController().signal,callback);await entered.promise;f.setNow(2000);finish.resolve();
 expect(await pending).toEqual({state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'});expect(callback).toHaveBeenCalledTimes(1);expect(f.counts().robotPosts).toBe(0);f.healthy();
});
it('cold OAuth completion rechecks current authority rather than sending after revocation',async()=>{
 const f=fixture('private'),tokenReady=deferred();f.setTokenWait(tokenReady.promise);let allowed=true;
 const callback=vi.fn(async()=>allowed),pending=f.send(new AbortController().signal,callback);
 await f.tokenStarted.promise;expect(callback).not.toHaveBeenCalled();expect(f.counts()).toEqual({tokenPosts:1,robotPosts:0});allowed=false;tokenReady.resolve();
 expect(await pending).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(callback).toHaveBeenCalledTimes(1);expect(f.counts()).toEqual({tokenPosts:1,robotPosts:0});f.healthy();
});
it('abort during cold OAuth cannot reach the robot even when synthetic token fetch resolves',async()=>{
 const f=fixture('private'),tokenReady=deferred(),controller=new AbortController(),callback=vi.fn(async()=>true);f.setTokenWait(tokenReady.promise);
 const pending=f.send(controller.signal,callback);await f.tokenStarted.promise;controller.abort();tokenReady.resolve();
 expect(await pending).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(callback).not.toHaveBeenCalled();expect(f.counts()).toEqual({tokenPosts:1,robotPosts:0});f.healthy();
});
it.each(['reply','private','group'] as const)('%s success is one real synthetic robot POST, provider acceptance only',async route=>{
 const f=fixture(route),callback=vi.fn(async()=>true),result=await f.send(new AbortController().signal,callback);
 expect(result).toEqual(route==='reply'?{state:'APPLIED_UNVERIFIED'}:{state:'APPLIED_UNVERIFIED',externalMessageId:'SYNTHETIC_RECEIPT'});
 expect(callback).toHaveBeenCalledTimes(1);expect(f.counts()).toEqual({robotPosts:1,tokenPosts:route==='reply'?0:1});f.healthy();
});
