import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
const opts={clientId:'synthetic',clientSecret:'synthetic',robotCode:'synthetic-robot'};
it('T009 expired reply URLs are rejected before network; active send uses explicit robot identity',async()=>{
 const calls:{url:string;body:Record<string,unknown>}[]=[];
 const sender=new DingTalkSender({...opts,clock:()=>100,fetch:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init!.body as string) as Record<string,unknown>});return new Response(JSON.stringify(String(url).includes('accessToken')?{accessToken:'synthetic-token',expireIn:7200}:{processQueryKey:'synthetic-receipt'}));}});
 expect((await sender.sendReply({url:'https://oapi.dingtalk.com/robot/send?access_token=synthetic',expiresAt:99},'test',new AbortController().signal)).reason).toBe('REPLY_ADDRESS_EXPIRED');expect(calls).toHaveLength(0);
 expect((await sender.sendProactive({kind:'PRIVATE_USER',externalId:'alice'},'test',new AbortController().signal)).state).toBe('APPLIED_UNVERIFIED');expect(calls[1]?.body['robotCode']).toBe('synthetic-robot');expect(calls[1]?.body['userIds']).toEqual(['alice']);
});
it('business HTTP200 errors, rejected recipients and lost responses are never success',async()=>{
 for(const raw of [{errcode:403},{invalidStaffIdList:['alice'],processQueryKey:'synthetic'},{code:'Forbidden'},{}]) {
  const sender=new DingTalkSender({...opts,fetch:async url=>new Response(JSON.stringify(String(url).includes('accessToken')?{accessToken:'synthetic',expireIn:7200}:raw))});expect((await sender.sendProactive({kind:'PRIVATE_USER',externalId:'alice'},'test',new AbortController().signal)).state).not.toBe('APPLIED_UNVERIFIED');
 }
 const sender=new DingTalkSender({...opts,fetch:async url=>{if(String(url).includes('accessToken'))return new Response('{"accessToken":"synthetic","expireIn":7200}');throw Error('lost');}});expect((await sender.sendProactive({kind:'GROUP',externalId:'group'},'test',new AbortController().signal)).state).toBe('UNKNOWN');
});
it('rejects forged reply hosts before attempting any network request',async()=>{
 let count=0;const sender=new DingTalkSender({...opts,fetch:async()=>{count++;throw Error('unexpected');}});
 for(const url of ['http://oapi.dingtalk.com/robot/send','https://oapi.dingtalk.com.evil.invalid/robot/send','https://127.0.0.1/robot/send','https://oapi.dingtalk.com:8443/robot/send']) expect((await sender.sendReply({url,expiresAt:Date.now()+1000},'test',new AbortController().signal)).state).toBe('FAILED');expect(count).toBe(0);
});
