import {DingTalkLogin} from '../../packages/dingtalk/src/login.js';
it('uses official code exchange and current-user contract without trusting client supplied identity',async()=>{
 const calls:{url:string;body:unknown}[]=[];
 const login=new DingTalkLogin({clientId:'synthetic-app',clientSecret:'synthetic-secret',fetch:async(url,init)=>{calls.push({url:String(url),body:init?.body?JSON.parse(init.body as string):null});return new Response(JSON.stringify(String(url).includes('userAccessToken')?{accessToken:'synthetic-user-token',expireIn:7200,corpId:'TENANT_A'}:{unionId:'synthetic-union',visitor:false}));}});
 expect(await login.exchange('synthetic-code',new AbortController().signal)).toEqual({corpId:'TENANT_A',unionId:'synthetic-union'});expect(calls[0]!.body).toMatchObject({grantType:'authorization_code',code:'synthetic-code'});expect(calls[1]!.url).toBe('https://api.dingtalk.com/v1.0/contact/users/me');
});
it('rejects provider errors and external visitors without producing a login identity',async()=>{
 for(const failure of ['token','identity','visitor']){
  const login=new DingTalkLogin({clientId:'synthetic',clientSecret:'synthetic',fetch:async url=>{
   if(String(url).includes('userAccessToken'))return new Response(JSON.stringify({accessToken:'synthetic',expireIn:7200}),{status:failure==='token'?403:200});
   return new Response(JSON.stringify({unionId:'synthetic',visitor:failure==='visitor'}),{status:failure==='identity'?403:200});
  }});await expect(login.exchange('synthetic',new AbortController().signal)).rejects.toThrow();
 }
});
