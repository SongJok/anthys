import {z} from 'zod';
import type {LoginIdentityProvider} from '../../identity/src/login.js';
export class DingTalkLogin implements LoginIdentityProvider {
 constructor(private options:{clientId:string;clientSecret:string;fetch?:typeof fetch}){}
 async exchange(code:string,signal:AbortSignal):Promise<{corpId?:string;unionId:string}>{
  const fetcher=this.options.fetch??fetch;
  const tokenResponse=await fetcher('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:this.options.clientId,clientSecret:this.options.clientSecret,code,grantType:'authorization_code'}),signal,redirect:'error'});
  if(!tokenResponse.ok){await tokenResponse.body?.cancel();throw Error('LOGIN_TOKEN_EXCHANGE_FAILED');}
  const token=z.object({accessToken:z.string().min(1),expireIn:z.number().positive(),corpId:z.string().optional()}).parse(await tokenResponse.json());
  const identityResponse=await fetcher('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':token.accessToken},signal,redirect:'error'});
  if(!identityResponse.ok){await identityResponse.body?.cancel();throw Error('LOGIN_IDENTITY_QUERY_FAILED');}
  const identity=z.object({unionId:z.string().min(1),visitor:z.boolean().optional()}).parse(await identityResponse.json());if(identity.visitor)throw Error('EXTERNAL_VISITOR_NOT_ALLOWED');
  return {unionId:identity.unionId,...(token.corpId?{corpId:token.corpId}:{})};
 }
}
