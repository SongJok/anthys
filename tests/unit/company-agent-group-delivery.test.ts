import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {syntheticCompanyAgentGroupSender} from '../support/company-agent-group-delivery.js';
const url='https://oapi.dingtalk.com/robot/send?access_token=SYNTHETIC_REPLY_TOKEN';
const text='SYNTHETIC group receipt：UNVERIFIED / UNKNOWN，不证明企业规则。';
const fresh=()=>syntheticCompanyAgentGroupSender({robotCode:'synthetic-robot',expectedReplyUrl:url,expectedText:text});
const reply=()=>({url,expiresAt:Date.now()+60000});
const signal=()=>new AbortController().signal;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
it('uses the actual reply-only sender and retains only immutable request digests',async()=>{
 const f=fresh(),network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('NO_REAL_NETWORK');});
 try{
  expect(f.sender.replyOnly).toBe(true);expect(await f.sender.sendReply(reply(),text,signal())).toEqual({state:'APPLIED_UNVERIFIED'});
  const snapshot=f.requests;expect(snapshot).toEqual([{targetHash:hash(url),bodyHash:hash(JSON.stringify({msgtype:'text',text:{content:text}})),method:'POST',sequence:1}]);expect(f.replyCount()).toBe(1);
  expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot[0])).toBe(true);expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_REPLY_TOKEN');expect(JSON.stringify(snapshot)).not.toContain(text);expect(JSON.stringify(snapshot)).not.toContain('https:');
  expect(await f.sender.sendReply(reply(),text,signal())).toEqual({state:'APPLIED_UNVERIFIED'});expect(f.replyCount()).toBe(2);expect(f.requests.map(r=>r.sequence)).toEqual([1,2]);expect(snapshot).toHaveLength(1);expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();}
});
it('refuses OAuth and both proactive targets without making a physical request',async()=>{
 const f=fresh();await expect(f.sender.token(signal())).rejects.toThrow('PROACTIVE_REPLY_ONLY_MODE');
 for(const kind of ['GROUP','PRIVATE_USER'] as const)expect(await f.sender.sendProactive({kind,externalId:'SYNTHETIC_OTHER'},text,signal())).toEqual({state:'FAILED',reason:'PROACTIVE_REPLY_ONLY_MODE'});
 expect(f.replyCount()).toBe(0);expect(f.requests).toEqual([]);
});
it('rejects a different valid reply URL and makes the swallowed fixture failure visible without leaking the URL',async()=>{
 const f=fresh();expect(await f.sender.sendReply({...reply(),url:url+'-WRONG_TARGET'},text,signal())).toEqual({state:'UNKNOWN',reason:'RESPONSE_LOST'});
 expect(()=>f.replyCount()).toThrow('SYNTHETIC_REPLY_TARGET_MISMATCH');expect(()=>f.requests).toThrow('SYNTHETIC_REPLY_TARGET_MISMATCH');
 try{f.replyCount();}catch(error){expect(String(error)).not.toContain('SYNTHETIC_REPLY_TOKEN');expect(String(error)).not.toContain('https:');}
});
it('rejects altered physical content with a fixed diagnostic and no raw text',async()=>{
 const f=fresh();expect(await f.sender.sendReply(reply(),text+'SYNTHETIC_PRIVATE_CANARY',signal())).toEqual({state:'UNKNOWN',reason:'RESPONSE_LOST'});
 expect(()=>f.requests).toThrow('SYNTHETIC_REPLY_CONTENT_MISMATCH');try{f.replyCount();}catch(error){expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_CANARY');expect(String(error)).not.toContain(text);}
});
it('rejects a reply cancelled before dispatch with zero physical requests and no synthetic acceptance',async()=>{
 const f=fresh(),controller=new AbortController();controller.abort();expect(await f.sender.sendReply(reply(),text,controller.signal)).toEqual({state:'FAILED',reason:'AUTHORIZATION_UNVERIFIED_BEFORE_SEND'});expect(f.replyCount()).toBe(0);expect(f.requests).toEqual([]);
});
it('keeps cancellation after an actual loopback POST UNKNOWN when the provider response is lost, without a second request',async()=>{
 let received!:(value:{method:string|undefined;path:string|undefined;bodyHash:string})=>void,rejectReceived!:(error:Error)=>void,physical=0,fetches=0;
 const arrived=new Promise<{method:string|undefined;path:string|undefined;bodyHash:string}>((resolve,reject)=>{received=resolve;rejectReceived=reject;}),controller=new AbortController();
 const server=createServer((req,res)=>{void(async()=>{const parts:Buffer[]=[];let bytes=0;for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>4096)throw Error('SYNTHETIC_REQUEST_LIMIT');parts.push(b);}physical++;received({method:req.method,path:req.url,bodyHash:hash(Buffer.concat(parts).toString('utf8'))});
  // Deliberately withhold the response after receiving the complete POST. The
  // local provider has observed the request, so cancellation cannot prove loss.
 })().catch(()=>{res.destroy();rejectReceived(Error('SYNTHETIC_LOOPBACK_REQUEST_FAILED'));});});
 const timeout=setTimeout(()=>{controller.abort();rejectReceived(Error('SYNTHETIC_LOOPBACK_TIMEOUT'));},5000);
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(52339,'127.0.0.1',resolve);});
  const sender=new DingTalkSender({clientId:'SYNTHETIC_UNUSED',clientSecret:'SYNTHETIC_UNUSED',robotCode:'SYNTHETIC',replyOnly:true,fetch:async(input,init)=>{fetches++;expect(String(input)).toBe(url);expect(init).toMatchObject({method:'POST',redirect:'error'});return fetch('http://127.0.0.1:52339/reply',init);}});
  const pending=sender.sendReply(reply(),text,controller.signal);expect(await arrived).toEqual({method:'POST',path:'/reply',bodyHash:hash(JSON.stringify({msgtype:'text',text:{content:text}}))});controller.abort();
  expect(await pending).toEqual({state:'UNKNOWN',reason:'RESPONSE_LOST'});expect(physical).toBe(1);expect(fetches).toBe(1);
 }finally{clearTimeout(timeout);controller.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);
it('keeps the actual sender address and expiry refusals at zero physical requests',async()=>{
 const f=fresh();expect(await f.sender.sendReply({...reply(),url:'https://synthetic.invalid/robot/send'},text,signal())).toEqual({state:'FAILED',reason:'INVALID_REPLY_ADDRESS'});expect(await f.sender.sendReply({...reply(),expiresAt:Date.now()-1},text,signal())).toEqual({state:'FAILED',reason:'REPLY_ADDRESS_EXPIRED'});expect(f.replyCount()).toBe(0);expect(f.requests).toEqual([]);
});
it('rejects fixture misconfiguration without reflecting an arbitrary URL',()=>{
 for(const expectedReplyUrl of ['not a URL','https://synthetic.invalid/robot/send','https://oapi.dingtalk.com:443/robot/send'])expect(()=>syntheticCompanyAgentGroupSender({robotCode:'synthetic-robot',expectedReplyUrl,expectedText:text})).toThrow('SYNTHETIC_REPLY_CONFIGURATION_INVALID');
 expect(()=>syntheticCompanyAgentGroupSender({robotCode:' ',expectedReplyUrl:url,expectedText:text})).toThrow('SYNTHETIC_REPLY_ROBOT_INVALID');
});
