import {boundedAgentFetch} from '../../packages/company/src/agent-transport.js';

const endpoint='https://synthetic-enterprise.invalid/mcp';
const setup=(fetcher:typeof fetch,patch:Record<string,number>={})=>boundedAgentFetch(endpoint,new AbortController().signal,{absoluteDeadlineMs:Date.now()+1000,...patch},fetcher);
const post=(transport:ReturnType<typeof setup>)=>transport.fetch(endpoint,{method:'POST',body:'{"jsonrpc":"2.0"}'});
const response=(text:string)=>new Response(text,{headers:{'content-type':'application/json'}});
afterEach(()=>vi.useRealTimers());
it('allows only the exact POST endpoint, forces redirect refusal and denies the optional GET channel',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>response('ok')),t=setup(fetcher);
 try{expect((await t.fetch(endpoint)).status).toBe(405);expect(fetcher).not.toHaveBeenCalled();expect(await(await post(t)).text()).toBe('ok');expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'POST',redirect:'error'});expect(t.usage()).toEqual({bytes:2,chunks:1});}finally{t.close();}
});
it.each(['https://synthetic-enterprise.invalid/other','https://other.invalid/mcp',endpoint+'?secret=hidden'])('rejects an altered destination before fetch',async url=>{
 const fetcher=vi.fn<typeof fetch>(),t=setup(fetcher);try{await expect(t.fetch(url,{method:'POST',body:'{}'})).rejects.toThrow('DESTINATION');expect(fetcher).not.toHaveBeenCalled();}finally{t.close();}
});
it.each(['DELETE','PUT','PATCH'])('does not infer a remote %s operation',async method=>{
 const fetcher=vi.fn<typeof fetch>(),t=setup(fetcher);try{await expect(t.fetch(endpoint,{method,body:'{}'})).rejects.toThrow('METHOD');expect(fetcher).not.toHaveBeenCalled();}finally{t.close();}
});
it.each(['http://synthetic-enterprise.invalid/mcp','https://user:secret@synthetic-enterprise.invalid/mcp',endpoint+'?key=hidden',endpoint+'#fragment'])('rejects unsafe endpoint configuration',url=>{
 expect(()=>boundedAgentFetch(url,new AbortController().signal,{absoluteDeadlineMs:Date.now()+1000})).toThrow();
});
it('rejects a past deadline, more than twenty minutes, and out-of-contract limits',()=>{
 for(const patch of [{absoluteDeadlineMs:Date.now()-1},{absoluteDeadlineMs:Date.now()+1200100},{maxResponseBytes:1048577},{maxTotalBytes:4194305},{maxChunks:8193},{idleTimeoutMs:1200001}])expect(()=>setup(vi.fn(),patch)).toThrow();
});
it.each([undefined,new Uint8Array([1]),'x'.repeat(80001)])('bounds request bodies before fetch',async body=>{
 const fetcher=vi.fn<typeof fetch>(),t=setup(fetcher);try{await expect(t.fetch(endpoint,{method:'POST',...(body===undefined?{}:{body})})).rejects.toThrow('REQUEST_LIMIT');expect(fetcher).not.toHaveBeenCalled();}finally{t.close();}
});
it.each(['200','-1','NaN'])('rejects invalid or over-budget declared content length before SDK parsing (%s)',async length=>{
 let cancelled=false;const t=setup(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':length}}),{maxResponseBytes:100});
 try{await expect(post(t)).rejects.toThrow('RESPONSE_LIMIT');expect(cancelled).toBe(true);}finally{t.close();}
});
it('bounds chunked JSON before the consumer can parse its excessive body',async()=>{
 let cancelled=false,index=0;const t=setup(async()=>new Response(new ReadableStream({pull(c){if(index++<4)c.enqueue(new Uint8Array(40));else c.close();},cancel(){cancelled=true;}})),{maxResponseBytes:100});
 try{await expect((await post(t)).text()).rejects.toThrow('RESPONSE_LIMIT');expect(cancelled).toBe(true);expect(t.usage().bytes).toBe(120);await expect(post(t)).rejects.toThrow('RESPONSE_LIMIT');}finally{t.close();}
});
it('counts progress/error bodies and all discovery responses against one connection budget',async()=>{
 const t=setup(async()=>response('123456'),{maxResponseBytes:10,maxTotalBytes:10});
 try{expect(await(await post(t)).text()).toBe('123456');await expect((await post(t)).text()).rejects.toThrow('RESPONSE_LIMIT');expect(t.usage().bytes).toBe(12);}finally{t.close();}
});
it('bounds chunk count including empty chunks from an endless progress stream',async()=>{
 const t=setup(async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(0));}})),{maxChunks:3});
 try{await expect((await post(t)).text()).rejects.toThrow('RESPONSE_LIMIT');expect(t.usage()).toEqual({bytes:0,chunks:4});}finally{t.close();}
});
it('stops a non-cooperative headers wait at its absolute deadline and never replays',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{})),t=setup(fetcher,{absoluteDeadlineMs:Date.now()+50});
 try{const pending=expect(post(t)).rejects.toThrow(/DEADLINE/);await vi.advanceTimersByTimeAsync(50);await pending;expect(fetcher).toHaveBeenCalledTimes(1);}finally{t.close();}
});
it('stops a stalled body at the idle bound and cancels its raw reader',async()=>{
 vi.useFakeTimers();let cancelled=false;const t=setup(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),{idleTimeoutMs:20});
 try{const body=await post(t),pending=expect(body.text()).rejects.toThrow('IDLE_DEADLINE');await vi.advanceTimersByTimeAsync(20);await pending;expect(cancelled).toBe(true);}finally{t.close();}
});
it('continual progress cannot extend the absolute deadline',async()=>{
 vi.useFakeTimers();let producer:ReadableStreamDefaultController<Uint8Array>|undefined;const t=setup(async()=>new Response(new ReadableStream({start(c){producer=c;}})),{absoluteDeadlineMs:Date.now()+60,idleTimeoutMs:40});
 try{const body=await post(t),pending=expect(body.text()).rejects.toThrow('ABSOLUTE_DEADLINE');for(let n=0;n<5;n++){await vi.advanceTimersByTimeAsync(10);producer!.enqueue(new Uint8Array([1]));}await vi.advanceTimersByTimeAsync(10);await pending;expect(t.usage().bytes).toBe(5);}finally{t.close();}
});
it('parent cancellation and close stop local waiting without claiming remote cancellation',async()=>{
 const parent=new AbortController(),fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{})),t=boundedAgentFetch(endpoint,parent.signal,{absoluteDeadlineMs:Date.now()+1000},fetcher);
 const pending=expect(post(t)).rejects.toThrow('WAIT_CANCELLED');await Promise.resolve();parent.abort();await pending;expect(fetcher).toHaveBeenCalledTimes(1);t.close();await expect(post(t)).rejects.toThrow('CONNECTION_CLOSED');
});
it('disposes late responses after a non-cooperative fetch outlives cancellation',async()=>{
 let release:(r:Response)=>void=()=>{},cancelled=false;const parent=new AbortController(),t=boundedAgentFetch(endpoint,parent.signal,{absoluteDeadlineMs:Date.now()+1000},()=>new Promise(resolve=>{release=resolve;}));
 try{const pending=expect(post(t)).rejects.toThrow('WAIT_CANCELLED');await Promise.resolve();parent.abort();await pending;release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await Promise.resolve();await Promise.resolve();expect(cancelled).toBe(true);}finally{t.close();}
});
it('rejects redirects and oversized response headers without reading SDK data',async()=>{
 for(const output of [new Response(null,{status:302,headers:{location:'https://other.invalid'}}),new Response(null,{headers:{'x-padding':'x'.repeat(65537)}})]){const t=setup(async()=>output);try{await expect(post(t)).rejects.toThrow(/REDIRECT|HEADER_LIMIT/);}finally{t.close();}}
});
it('propagates per-request abort and cancels only that current reader',async()=>{
 let cancelled=false;const t=setup(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))),c=new AbortController();
 try{const r=await t.fetch(endpoint,{method:'POST',body:'{}',signal:c.signal}),pending=expect(r.text()).rejects.toThrow('WAIT_CANCELLED');c.abort();await pending;expect(cancelled).toBe(true);}finally{t.close();}
});
it('close immediately releases an unread stalled raw body',async()=>{
 let cancelled=false;const t=setup(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})));
 await post(t);t.close();await Promise.resolve();expect(cancelled).toBe(true);
});
it('does not POST after a queued microtask crosses the wall-clock deadline before its timer callback',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>(async()=>response('late')),t=setup(fetcher,{absoluteDeadlineMs:Date.now()+20});
 try{const pending=expect(post(t)).rejects.toThrow('ABSOLUTE_DEADLINE');vi.setSystemTime(Date.now()+21);await pending;expect(fetcher).not.toHaveBeenCalled();}finally{t.close();}
});
it('rejects late headers including a null body even when a deadline timer has not fired',async()=>{
 vi.useFakeTimers();const t=setup(async()=>{vi.setSystemTime(Date.now()+21);return new Response(null,{status:202});},{absoluteDeadlineMs:Date.now()+20});
 try{await expect(post(t)).rejects.toThrow('ABSOLUTE_DEADLINE');}finally{t.close();}
});
