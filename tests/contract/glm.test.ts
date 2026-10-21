import {collectSse} from '../../packages/provider-glm/src/sse.js';
import {GlmProvider,ProviderError,glmRequestBody} from '../../packages/provider-glm/src/client.js';
import {redact} from '../../packages/observability/src/index.js';
const tool='cap_123456abcdef';
const encode=(d:unknown)=>`data: ${JSON.stringify(d)}\r\n\r\n`;
const raw=()=>': heartbeat\r\n\r\n'+encode({id:'synthetic-request',choices:[{index:0,delta:{content:'你好',reasoning_content:'opaque 原文'}}]})+encode({choices:[{index:0,delta:{tool_calls:[{index:0,id:'a',type:'function',function:{name:tool,arguments:'{"x":'}},{index:1,id:'b',type:'function',function:{name:tool,arguments:'{"x":2}'}}]}}]})+encode({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]})+encode({choices:[],usage:{total_tokens:13}})+'data: [DONE]\r\n\r\n';
async function* split(text:string,n:number){const b=new TextEncoder().encode(text);for(let i=0;i<b.length;i+=n) yield b.slice(i,i+n);}
it('T011 UTF-8, CRLF, SSE JSON and tool argument fragments survive every chunk boundary',async()=>{
 for(const n of [1,2,3,5,11,37,1000]) {const r=await collectSse(split(raw(),n));expect(r.message.content).toBe('你好');expect(r.message.reasoning_content).toBe('opaque 原文');expect(r.message.tool_calls?.map(c=>JSON.parse(c.function.arguments))).toEqual([{x:1},{x:2}]);expect(r.usage?.['total_tokens']).toBe(13);}
});
it('T015 rejects partial streams, invalid finish and incomplete arguments before execution',async()=>{
 for(const text of [raw().split('data: [DONE]')[0]!,encode({choices:[{index:0,delta:{content:'partial'},finish_reason:'length'}]})+'data: [DONE]\n\n',raw().replace('1}','1')]) await expect(collectSse(split(text,7))).rejects.toThrow();
});
it('rejects duplicate IDs, multiple choices, gaps and resource overflow',async()=>{
 await expect(collectSse(split(raw().replace('"id":"b"','"id":"a"'),3))).rejects.toThrow('INVALID_TOOL_ID_OR_NAME');
 await expect(collectSse(split(raw().replace('"index":1','"index":2'),5))).rejects.toThrow('INVALID_TOOL_ID_OR_NAME');
 await expect(collectSse(split(raw().replace('"index":0','"index":1'),9))).rejects.toThrow('MULTIPLE_CHOICES');
 await expect(collectSse(split(raw(),2),undefined,10)).rejects.toThrow('STREAM_SIZE_LIMIT');
});
it('T019 preserves model/protocol config, handles HTTP errors and Retry-After without model fallback',async()=>{
 const observed:Record<string,unknown>[]=[];
 const provider=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn/api/paas/v4',reasoningEffort:'high',fetch:async(_url,init)=>{observed.push(JSON.parse(init!.body as string) as Record<string,unknown>);return new Response(raw(),{headers:{'content-type':'text/event-stream'}});}});
 await provider.complete([{role:'user',content:'test'}],[],new AbortController().signal);expect(observed[0]).toMatchObject({model:'glm-5.3-flash',thinking:{type:'enabled',clear_thinking:false},stream:true,tool_stream:true});
 for(const status of [401,429,400,500]) {
  const p=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn/api/paas/v4',reasoningEffort:'high',fetch:async()=>new Response('',{status,headers:{'retry-after':'2'}})});
  const e=await p.complete([],[],new AbortController().signal).catch(e=>e as ProviderError);expect(e).toBeInstanceOf(ProviderError);expect((e as ProviderError).retryable).toBe(status===429||status>=500);expect((e as ProviderError).retryAfterMs).toBe(2000);
 }
});
it('T014 observable fields redact reasoning, credentials and bearer URLs',()=>{
 const r=JSON.stringify(redact({reasoning_content:'private',nested:{authorization:'Bearer private',refreshToken:'private',secret:'private'},url:'https://example.com/?token=private',requestId:'safe-id'}));expect(r).not.toContain('private');expect(r).toContain('safe-id');
});
it('T007 progress observer receives ordered counts only, preserving native reasoning/tools exclusively in the completed turn',async()=>{
 const progress:unknown[]=[];const result=await collectSse(split(raw(),1),undefined,2*1024*1024,async item=>{progress.push(item);});
 expect(progress).toEqual([{sequence:1,contentFragments:1,toolFragments:0},{sequence:2,contentFragments:1,toolFragments:1},{sequence:3,contentFragments:1,toolFragments:2}]);expect(JSON.stringify(progress)).not.toContain('opaque');expect(JSON.stringify(progress)).not.toContain(tool);expect(JSON.stringify(progress)).not.toContain('你好');expect(result.message.reasoning_content).toBe('opaque 原文');expect(result.message.tool_calls).toHaveLength(2);
 await expect(collectSse(split(raw(),7),undefined,2*1024*1024,async()=>{throw Error('synthetic progress authority revoked');})).rejects.toThrow('synthetic progress authority revoked');
});
it('supports standard CR-only SSE lines and a final event without trailing newline',async()=>{
 const stream=encode({choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]';
 expect((await collectSse(split(stream.replace(/\r\n/g,'\r'),1))).message.content).toBe('ok');
 expect((await collectSse(split(stream,1))).usage).toBeNull();
});
it('rejects provider errors, data after completion, unsupported choices and excessive tool indices',async()=>{
 const stop=encode({choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]}),end='data: [DONE]\n\n';
 const cases:[string,string][]=[
  [encode({choices:[],error:{code:'synthetic-error'}})+end,'PROVIDER_STREAM_ERROR'],
  [stop+end+encode({choices:[],usage:{total_tokens:1}}),'DATA_AFTER_DONE'],
  [stop+end+end,'DATA_AFTER_DONE'],
  [stop+encode({choices:[{index:0,delta:{content:'later'}}]})+end,'DELTA_AFTER_FINISH'],
  [stop+encode({choices:[{index:0,delta:{},finish_reason:'stop'}]})+end,'DUPLICATE_FINISH'],
  [encode({choices:[{index:0,delta:{}},{index:1,delta:{}}]})+end,'MULTIPLE_CHOICES_UNSUPPORTED'],
  [encode({choices:[{index:0,delta:{tool_calls:[{index:24,id:'too-many',function:{name:tool,arguments:'{}'}}]}}]})+end,'TOO_MANY_TOOLS'],
  [encode({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+end,'TOOL_FINISH_MISMATCH'],
  ['data: broken-json\n\n'+end,'INVALID_EVENT_JSON'],
 ];
 for(const [text,error] of cases)await expect(collectSse(split(text,3))).rejects.toThrow(error);
});
it('requires complete tool identity and argument JSON before accepting a tool turn',async()=>{
 for(const item of [{index:0,function:{name:tool,arguments:'{}'}},{index:0,id:'missing-function'},{index:0,id:'invalid-name',function:{name:'shell',arguments:'{}'}},{index:0,id:'invalid-args',function:{name:tool,arguments:'{'}}]){
  const text=encode({choices:[{index:0,delta:{tool_calls:[item]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';await expect(collectSse(split(text,4))).rejects.toThrow();
 }
});
it('cancels both an active stream and a stream completing after cancellation; invalid UTF-8 fails closed',async()=>{
 const controller=new AbortController();controller.abort();await expect(collectSse(split(raw(),2),controller.signal)).rejects.toThrow();
 const later=new AbortController();async function* cancelAtEnd(){yield new TextEncoder().encode(encode({choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]\n\n');later.abort();}
 await expect(collectSse(cancelAtEnd(),later.signal)).rejects.toThrow();
 async function* invalid(){yield new Uint8Array([0xff]);}await expect(collectSse(invalid())).rejects.toThrow();
});
it('local credential, limit and pre-send cancellation failures carry definitive NOT_SENT proof and never invoke transport',async()=>{
 expect(()=>new GlmProvider({apiKey:'',baseUrl:'https://open.bigmodel.cn',reasoningEffort:'high'})).toThrow('BLOCKED_EXTERNAL:GLM_API_KEY');expect(()=>new GlmProvider({apiKey:'synthetic',baseUrl:'http://example.com',reasoningEffort:'high'})).toThrow('GLM_HTTPS_REQUIRED');
 let calls=0;const provider=new GlmProvider({apiKey:'synthetic',baseUrl:'http://127.0.0.1',reasoningEffort:'high',fetch:async()=>{calls++;throw Error('must not send');}}),controller=new AbortController();controller.abort();await expect(provider.complete([],[],controller.signal)).rejects.toMatchObject({requestState:'NOT_SENT'});
 for(const maxOutputTokens of [0,8193,1.5,NaN]){expect(()=>glmRequestBody([],[],'high',{maxOutputTokens})).toThrow('INVALID_OUTPUT_BUDGET');await expect(provider.complete([],[],new AbortController().signal,undefined,{maxOutputTokens})).rejects.toMatchObject({code:'INVALID_OUTPUT_BUDGET',requestState:'NOT_SENT'});}expect(calls).toBe(0);
});
it('native dispatch uses exactly the reserved output limit while preserving tools and opaque fields',async()=>{
 const messages=[{role:'assistant' as const,content:null,reasoning_content:'exact opaque quota fixture'}],tools=[{type:'function' as const,function:{name:tool,description:'synthetic',parameters:{type:'object'}}}];let sent:unknown;
 const provider=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn',reasoningEffort:'max',fetch:async(_url,init)=>{sent=JSON.parse(init!.body as string);return new Response(raw(),{headers:{'content-type':'text/event-stream'}});}});await provider.complete(messages,tools,new AbortController().signal,undefined,{maxOutputTokens:7});expect(sent).toEqual(provider.describeRequest(messages,tools,{maxOutputTokens:7}));expect(sent).toMatchObject({max_tokens:7,reasoning_effort:'max',messages,tools});
});
it('HTTP and malformed stream responses close their bodies and retain UNKNOWN charge state',async()=>{
 for(const retry of [undefined,'invalid',new Date(Date.now()+60000).toUTCString()]){let closed=0;const provider=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn',reasoningEffort:'high',fetch:async()=>new Response(new ReadableStream({cancel(){closed++;}}),{status:503,headers:retry?{'retry-after':retry}:{}})});const error=await provider.complete([],[],new AbortController().signal).catch(e=>e as ProviderError);expect(error).toMatchObject({code:'PROVIDER_HTTP_ERROR',requestState:'UNKNOWN',retryable:true});if(retry&&retry!=='invalid'){expect((error as ProviderError).retryAfterMs).toBeGreaterThan(0);expect((error as ProviderError).retryAfterMs).toBeLessThanOrEqual(60000);}else expect((error as ProviderError).retryAfterMs).toBeNull();expect(closed).toBe(1);}
 for(const body of [null,'body']){let closed=0;const provider=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn',reasoningEffort:'high',fetch:async()=>new Response(body===null?null:new ReadableStream({cancel(){closed++;}}),{headers:{'content-type':'application/json'}})});await expect(provider.complete([],[],new AbortController().signal)).rejects.toMatchObject({code:'INVALID_STREAM_RESPONSE',requestState:'UNKNOWN'});expect(closed).toBe(body===null?0:1);}
});
