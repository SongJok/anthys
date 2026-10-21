import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ListToolsRequestSchema,CallToolRequestSchema,type CallToolRequest,type CallToolResult,type ListToolsResult,type ListToolsRequest} from '@modelcontextprotocol/sdk/types.js';
import {CompanyAgentChat,agentChatInputSchemaHash,type AgentChatRequest} from '../../packages/company/src/agent-chat.js';
const tool={name:'chat',inputSchema:{type:'object' as const,properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}}};
const pin={toolName:tool.name,inputSchemaHash:agentChatInputSchemaHash(tool.inputSchema)};
const plain=(text='SYNTHETIC upstream text'):CallToolResult=>({content:[{type:'text',text}]});
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const request=(patch:Partial<AgentChatRequest>={}):AgentChatRequest=>({localRequestId:randomUUID(),message:'合成问题：代码、日志和数据说明',absoluteDeadlineMs:Date.now()+60000,maxWaitMs:60000,signal:new AbortController().signal,beforeDispatch:async()=>{},...patch});
async function fixture(options:{list?:(params:ListToolsRequest['params'])=>Promise<ListToolsResult>;call?:(params:CallToolRequest['params'],signal:AbortSignal,progress:(value:number)=>Promise<void>)=>Promise<CallToolResult>}={}){
 const client=new Client({name:'synthetic-agent-test',version:'1'},{capabilities:{}}),server=new Server({name:'synthetic-enterprise-agent',version:'1'},{capabilities:{tools:{}}}),[a,b]=InMemoryTransport.createLinkedPair();
 let lists=0,calls=0,cancelNotifications=0,remoteSawCancellation=false;const args:unknown[]=[];
 const send=a.send.bind(a);a.send=async(message,extra)=>{if('method' in message&&message.method==='notifications/cancelled')cancelNotifications++;return send(message,extra);};
 server.setRequestHandler(ListToolsRequestSchema,async req=>{lists++;return options.list?options.list(req.params):{tools:[tool]};});
 server.setRequestHandler(CallToolRequestSchema,async(req,extra)=>{calls++;args.push(structuredClone(req.params.arguments));extra.signal.addEventListener('abort',()=>{remoteSawCancellation=true;},{once:true});return options.call?options.call(req.params,extra.signal,value=>extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta!.progressToken!,progress:value}})):plain();});
 client.onerror=()=>{};server.onerror=()=>{};await server.connect(b);await client.connect(a);
 return {client,server,adapter:new CompanyAgentChat(client,pin),args,counts:()=>({lists,calls,cancelNotifications,remoteSawCancellation}),close:async()=>{await client.close();await server.close();}};
}
afterEach(()=>{vi.useRealTimers();});
it('waits for an actual result after three seconds, calls once, and preserves arbitrary JSON only as UNVERIFIED text',async()=>{
 const text='{"conversationId":123,"authorized":true,"verification":"VERIFIED","rootCause":"untrusted assertion"}',w=await fixture({call:async()=>{await wait(3100);return plain(text);}});
 try{const started=Date.now(),summaries:unknown[]=[],result=await w.adapter.request(request({maxWaitMs:6000,absoluteDeadlineMs:started+6000,beforeDispatch:async summary=>{summaries.push(summary);expect(w.counts().calls).toBe(0);}}));
  expect(Date.now()-started).toBeGreaterThanOrEqual(3000);expect(result).toMatchObject({status:'RESPONSE_RECEIVED',text,source:{protocol:'MCP',verification:'UNVERIFIED'}});expect(result).not.toHaveProperty('evidenceIds');expect(summaries).toHaveLength(1);expect(summaries[0]).not.toHaveProperty('message');expect(summaries[0]).toMatchObject({messageSha256:expect.stringMatching(/^[a-f0-9]{64}$/),messageBytes:Buffer.byteLength('合成问题：代码、日志和数据说明','utf8')});expect(w.counts().calls).toBe(1);expect(w.args).toEqual([{message:'合成问题：代码、日志和数据说明'}]);
 }finally{await w.close();}
},10000);
it.each([60000,1200000])('receives just before the %i ms virtual business boundary',async budget=>{
 vi.useFakeTimers();const w=await fixture({call:async()=>{await wait(budget-1);return plain('at budget - 1');}});
 try{const running=w.adapter.request(request({maxWaitMs:budget,absoluteDeadlineMs:Date.now()+budget}));await vi.advanceTimersByTimeAsync(0);expect(w.counts().calls).toBe(1);await vi.advanceTimersByTimeAsync(budget-1);expect(await running).toMatchObject({status:'RESPONSE_RECEIVED',text:'at budget - 1'});expect(w.counts().calls).toBe(1);}finally{await w.close();}
});
it.each([60000,1200000])('stops at the %i ms absolute boundary despite progress and does not re-question',async budget=>{
 vi.useFakeTimers();let timer:ReturnType<typeof setInterval>|undefined;const w=await fixture({call:async(_params,_signal,progress)=>{let value=0;timer=setInterval(()=>{void progress(++value);},10000);await wait(budget+1);return plain('too late');}});
 try{const running=w.adapter.request(request({maxWaitMs:1200000,absoluteDeadlineMs:Date.now()+budget}));await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(budget);expect(await running).toMatchObject({status:'UNKNOWN',reason:'DEADLINE_EXCEEDED',remoteCancellation:'UNCONFIRMED',localCancellationRequested:true});expect(w.counts()).toMatchObject({calls:1,cancelNotifications:1,remoteSawCancellation:true});await vi.advanceTimersByTimeAsync(1);expect(w.counts().calls).toBe(1);}finally{clearInterval(timer);await w.close();}
});
it('uses maxWaitMs as a hard cap even when the host absolute deadline is later',async()=>{
 vi.useFakeTimers();const w=await fixture({call:async()=>{await wait(1200000);return plain();}});
 try{const running=w.adapter.request(request({maxWaitMs:60000,absoluteDeadlineMs:Date.now()+1200000}));await vi.advanceTimersByTimeAsync(60000);expect(await running).toMatchObject({status:'UNKNOWN',reason:'DEADLINE_EXCEEDED'});expect(w.counts().calls).toBe(1);}finally{await w.close();}
});
it('pre-dispatch callback rejection, cancellation, and control timeout never call chat',async()=>{
 const w=await fixture();try{
  expect(await w.adapter.request(request({beforeDispatch:async()=>{throw Error('SYNTHETIC persistence rejected');}}))).toMatchObject({status:'NOT_SENT',reason:'HOST_REJECTED'});
  const c=new AbortController();expect(await w.adapter.request(request({signal:c.signal,beforeDispatch:async()=>{c.abort();}}))).toMatchObject({status:'NOT_SENT',reason:'CANCELLED'});
  const short=new CompanyAgentChat(w.client,pin,{controlTimeoutMs:20});expect(await short.request(request({beforeDispatch:async()=>new Promise(()=>{})}))).toMatchObject({status:'NOT_SENT',reason:'CONTROL_TIMEOUT'});expect(w.counts().calls).toBe(0);
 }finally{await w.close();}
});
it('an expired host callback cannot dispatch later when its underlying promise eventually resolves',async()=>{
 vi.useFakeTimers();let release:()=>void=()=>{};const w=await fixture();try{const running=w.adapter.request(request({absoluteDeadlineMs:Date.now()+50,beforeDispatch:async()=>new Promise<void>(resolve=>{release=resolve;})}));await vi.advanceTimersByTimeAsync(50);expect(await running).toMatchObject({status:'NOT_SENT',reason:'DEADLINE_EXCEEDED'});release();await vi.advanceTimersByTimeAsync(1);expect(w.counts().calls).toBe(0);}finally{await w.close();}
});
it('already dispatched cancellation is UNKNOWN even when the SDK sends and the server sees a cancel notification',async()=>{
 const c=new AbortController(),w=await fixture({call:async()=>{c.abort();return new Promise(()=>{});}});
 try{expect(await w.adapter.request(request({signal:c.signal}))).toMatchObject({status:'UNKNOWN',reason:'CANCELLED',remoteCancellation:'UNCONFIRMED'});expect(w.counts()).toMatchObject({calls:1,cancelNotifications:1,remoteSawCancellation:true});}finally{await w.close();}
});
it('a transport disconnect after tools/call is UNKNOWN without a replay',async()=>{
 const w=await fixture({call:async()=>{await w.server.close();return new Promise(()=>{});}});
 try{expect(await w.adapter.request(request())).toMatchObject({status:'UNKNOWN',reason:'TRANSPORT_OR_PROTOCOL_ERROR',remoteCancellation:'UNCONFIRMED'});expect(w.counts().calls).toBe(1);}finally{await w.close();}
});
it.each([{isError:true,content:[{type:'text',text:'denied'}]}, {content:[]}, {content:[{type:'text',text:'   '}]}, {content:[{type:'image',data:'AA==',mimeType:'image/png'}]}] as CallToolResult[])('unusable or error MCP replies are UNKNOWN (%j)',async reply=>{
 const w=await fixture({call:async()=>reply});try{expect(await w.adapter.request(request())).toMatchObject({status:'UNKNOWN',remoteCancellation:'UNCONFIRMED'});expect(w.counts().calls).toBe(1);}finally{await w.close();}
});
it('bounds the entire reply and text block count after SDK decoding',async()=>{
 for(const [reply,limits] of [[plain('x'.repeat(100)),{maxResponseBytes:80}],[{content:[{type:'text',text:'a'},{type:'text',text:'b'}]},{maxTextBlocks:1}]] as const){const w=await fixture({call:async()=>reply as CallToolResult});try{expect(await new CompanyAgentChat(w.client,pin,limits).request(request())).toMatchObject({status:'UNKNOWN',reason:'RESPONSE_LIMIT'});}finally{await w.close();}}
});
it('never reuses conversation IDs returned by a prior successful call',async()=>{
 const w=await fixture({call:async()=>plain('{"conversationId":42,"text":"SYNTHETIC"}')});try{expect((await w.adapter.request(request())).status).toBe('RESPONSE_RECEIVED');expect((await w.adapter.request(request())).status).toBe('RESPONSE_RECEIVED');expect(w.args).toHaveLength(2);expect(w.args.every(args=>Object.keys(args as object).join(',')==='message')).toBe(true);}finally{await w.close();}
});
it.each(['missing','drift','duplicate','loop','truncated','required-conversation'] as const)('refuses %s discovery before dispatch',async mode=>{
 const changed={...tool,inputSchema:{type:'object' as const,properties:{message:{type:'string'},conversationId:{type:'integer'}},required:['conversationId']}};
 const tools=mode==='missing'?[]:mode==='duplicate'?[tool,tool]:mode==='drift'||mode==='required-conversation'?[changed]:[tool];
 const w=await fixture({list:async()=>({tools,...(mode==='loop'?{nextCursor:'repeat'}:mode==='truncated'?{nextCursor:randomUUID()}:{} )})});
 try{const approved=mode==='required-conversation'?{toolName:'chat',inputSchemaHash:agentChatInputSchemaHash(changed.inputSchema)}:pin;expect((await new CompanyAgentChat(w.client,approved).request(request())).status).toBe('NOT_SENT');expect(w.counts().calls).toBe(0);expect(w.counts().lists).toBeLessThanOrEqual(4);}finally{await w.close();}
});
it('uses one discovery deadline for every page and refuses a changed schema on a later request',async()=>{
 vi.useFakeTimers();const w=await fixture({list:async()=>{await wait(750);return {tools:[],nextCursor:randomUUID()};}});
 try{const running=w.adapter.request(request());await vi.advanceTimersByTimeAsync(2000);expect(await running).toMatchObject({status:'NOT_SENT',reason:'DISCOVERY_FAILED'});expect(w.counts()).toMatchObject({calls:0,lists:3});}finally{await w.close();}
 vi.useRealTimers();let changed=false;const other=await fixture({list:async()=>({tools:changed?[]:[tool]})});try{expect((await other.adapter.request(request())).status).toBe('RESPONSE_RECEIVED');changed=true;expect(await other.adapter.request(request())).toMatchObject({status:'NOT_SENT',reason:'TOOL_NOT_FOUND'});expect(other.counts().calls).toBe(1);}finally{await other.close();}
});
it('accepts a later page only after complete discovery and copies the reviewed tool pin',async()=>{
 const w=await fixture({list:async params=>params?.cursor?{tools:[tool]}:{tools:[{name:'other',inputSchema:{type:'object'}}],nextCursor:'second'}});
 try{const mutable={...pin},adapter=new CompanyAgentChat(w.client,mutable);mutable.toolName='other';mutable.inputSchemaHash='0'.repeat(64);expect((await adapter.request(request())).status).toBe('RESPONSE_RECEIVED');expect(w.counts()).toMatchObject({lists:2,calls:1});}finally{await w.close();}
});
it('works through the actual SDK Streamable HTTP transport using a synthetic fetch with no sockets or credentials',async()=>{
 const methods:string[]=[],argumentsSeen:unknown[]=[];
 const syntheticFetch:typeof fetch=async(input,init)=>{
  expect(String(input)).toBe('https://synthetic.invalid/mcp');expect(new Headers(init?.headers).has('authorization')).toBe(false);
  if(init?.method==='GET')return new Response(null,{status:405});if(init?.method==='DELETE')return new Response(null,{status:200});
  const body=JSON.parse(init?.body as string) as {id?:number;method:string;params?:{protocolVersion?:string;arguments?:unknown}};methods.push(body.method);
  if(body.method==='notifications/initialized'||body.method==='notifications/cancelled')return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:body.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-agent',version:'1'}}:body.method==='tools/list'?{tools:[tool]}:body.method==='tools/call'?(argumentsSeen.push(body.params?.arguments),plain('SYNTHETIC HTTP reply')):null;
  if(!result)throw Error('unexpected synthetic method');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
 };
 const client=new Client({name:'synthetic-http-agent',version:'1'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL('https://synthetic.invalid/mcp'),{fetch:syntheticFetch,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1,maxReconnectionDelay:1,reconnectionDelayGrowFactor:1}});
 try{await client.connect(transport as Transport);expect(await new CompanyAgentChat(client,pin).request(request())).toMatchObject({status:'RESPONSE_RECEIVED',text:'SYNTHETIC HTTP reply',source:{verification:'UNVERIFIED'}});expect(methods.filter(v=>v==='tools/call')).toHaveLength(1);expect(argumentsSeen).toEqual([{message:'合成问题：代码、日志和数据说明'}]);}finally{await client.close();}
});

it('rejects control or discovery work past its absolute deadline even before a delayed timer callback runs',async()=>{
 vi.useFakeTimers();const w=await fixture({list:async()=>{vi.setSystemTime(Date.now()+2001);return {tools:[tool]};}});
 try{expect(await w.adapter.request(request())).toMatchObject({status:'NOT_SENT',reason:'DISCOVERY_FAILED'});expect(w.counts().calls).toBe(0);}finally{await w.close();}
 const other=await fixture();try{expect(await other.adapter.request(request({beforeDispatch:async()=>{vi.setSystemTime(Date.now()+2001);}}))).toMatchObject({status:'NOT_SENT',reason:'CONTROL_TIMEOUT'});expect(other.counts().calls).toBe(0);}finally{await other.close();}
});
