import {randomBytes,randomUUID} from 'node:crypto';
import {connectCompanyAgent,agentConnectionPinSchema,type AgentConnectionPin} from '../../packages/company/src/agent-connection.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {hash} from '../../packages/storage/src/crypto.js';
const endpoint='https://synthetic-enterprise.invalid/mcp',token=randomBytes(32).toString('hex');
const schema={type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}};
const pin:AgentConnectionPin={connectorId:'synthetic-enterprise',endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(endpoint),credentialHash:hash(token),server:{name:'synthetic-agent',version:'1'},toolName:'chat',inputSchemaHash:agentChatInputSchemaHash(schema)};
const environment={AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token};
const context=()=>({signal:new AbortController().signal,absoluteDeadlineMs:Date.now()+10000});
function synthetic(options:{serverVersion?:string;toolSchema?:unknown;outputSchema?:Record<string,unknown>;call?:()=>Promise<Response|undefined>}={}){
 const methods:string[]=[],argumentsSeen:unknown[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  expect(String(input)).toBe(endpoint);expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);
  const request=JSON.parse(init?.body as string);methods.push(request.method);
  if(request.method==='notifications/initialized'||request.method==='notifications/cancelled')return new Response(null,{status:202});
  if(request.method==='tools/call'){argumentsSeen.push(request.params.arguments);const output=await options.call?.();if(output)return output;}
  const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-agent',version:options.serverVersion??'1'}}:request.method==='tools/list'?{tools:[{name:'chat',inputSchema:options.toolSchema??schema,...(options.outputSchema?{outputSchema:options.outputSchema}:{})}]}:request.method==='tools/call'?{content:[{type:'text',text:'SYNTHETIC received; no facts certified'}]}:null;
  if(!result)throw Error('UNEXPECTED_SYNTHETIC_REQUEST');return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 };
 return {fetcher,methods,argumentsSeen};
}
const ask=(connection:Awaited<ReturnType<typeof connectCompanyAgent>>,ctx:ReturnType<typeof context>)=>connection.chat.request({...ctx,localRequestId:randomUUID(),message:'SYNTHETIC code/log/data question',maxWaitMs:10000,beforeDispatch:async()=>{}});
it('connects actual SDK through the bounded raw transport and receives beyond the old two-second ceiling, once',async()=>{
 const fixture=synthetic({call:async()=>{await new Promise(r=>setTimeout(r,3100));return undefined;}}),ctx=context(),connection=await connectCompanyAgent(pin,ctx,environment,fixture.fetcher);
 try{const started=Date.now();expect(await ask(connection,ctx)).toMatchObject({status:'RESPONSE_RECEIVED',source:{verification:'UNVERIFIED'}});expect(Date.now()-started).toBeGreaterThanOrEqual(3000);expect(fixture.methods.filter(m=>m==='tools/call')).toHaveLength(1);expect(fixture.methods).not.toContain('notifications/cancelled');expect(fixture.argumentsSeen).toEqual([{message:'SYNTHETIC code/log/data question'}]);expect(connection.usage().bytes).toBeGreaterThan(0);}finally{await connection.close();}
},10000);
it.each(['endpoint','token','missing','extra-field'] as const)('refuses changed %s configuration before an HTTP call',async mode=>{
 const fixture=synthetic(),env={...environment},review={...pin};
 if(mode==='endpoint')env.AIDER_AI_DD_CHAT_MCP=endpoint+'/changed';if(mode==='token')env.AIDER_AI_DD_MCP_TOKEN=randomBytes(32).toString('hex');if(mode==='missing')env.AIDER_AI_DD_MCP_TOKEN='';
 await expect(connectCompanyAgent(mode==='extra-field'?{...review,endpoint:'https://other.invalid'} as AgentConnectionPin:review,context(),env,fixture.fetcher)).rejects.toThrow();expect(fixture.methods).toEqual([]);
});
it('refuses server drift after initialize with no tools/call',async()=>{
 const fixture=synthetic({serverVersion:'changed'});await expect(connectCompanyAgent(pin,context(),environment,fixture.fetcher)).rejects.toThrow('AGENT_SERVER_CHANGED');expect(fixture.methods).not.toContain('tools/call');
});
it('refuses schema drift during actual rediscovery before host dispatch',async()=>{
 const fixture=synthetic({toolSchema:{...schema,required:['conversationId']}}),ctx=context(),connection=await connectCompanyAgent(pin,ctx,environment,fixture.fetcher);
 try{expect(await ask(connection,ctx)).toMatchObject({status:'NOT_SENT',reason:'SCHEMA_CHANGED'});expect(fixture.methods).not.toContain('tools/call');}finally{await connection.close();}
});
it('refuses an unreviewed output schema before SDK compilation despite an unchanged reviewed input schema',async()=>{
 // No expensive regular expression is executed: the public SDK hook rejects
 // the schema before a validator is built or business content is requested.
 const fixture=synthetic({outputSchema:{type:'object',properties:{x:{type:'string',pattern:'(a+)+$'}}}}),ctx=context(),connection=await connectCompanyAgent(pin,ctx,environment,fixture.fetcher);
 try{expect(await ask(connection,ctx)).toMatchObject({status:'NOT_SENT',reason:'DISCOVERY_FAILED'});expect(fixture.methods).not.toContain('tools/call');}finally{await connection.close();}
});
it('raw oversized reply aborts the connection and remains UNKNOWN without a repeated tools/call',async()=>{
 let cancelled=false;const fixture=synthetic({call:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})}),ctx=context(),connection=await connectCompanyAgent(pin,ctx,environment,fixture.fetcher);
 try{expect(await ask(connection,ctx)).toMatchObject({status:'UNKNOWN',remoteCancellation:'UNCONFIRMED'});expect(cancelled).toBe(true);expect(fixture.methods.filter(m=>m==='tools/call')).toHaveLength(1);}finally{await connection.close();}
});
it('aborts an in-flight non-cooperative fetch locally and does not claim the upstream stopped',async()=>{
 let began=()=>{};const entered=new Promise<void>(resolve=>{began=resolve;}),fixture=synthetic({call:async()=>{began();return new Promise(()=>{});}}),c=new AbortController(),ctx={...context(),signal:c.signal},connection=await connectCompanyAgent(pin,ctx,environment,fixture.fetcher);
 try{const pending=ask(connection,ctx);await entered;c.abort();expect(await pending).toMatchObject({status:'UNKNOWN',remoteCancellation:'UNCONFIRMED',localCancellationRequested:true});expect(fixture.methods.filter(m=>m==='tools/call')).toHaveLength(1);}finally{await connection.close();}
});
it('initialization has its own two-second limit and cannot become a business dispatch',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{})),ctx=context();
 try{const pending=expect(connectCompanyAgent(pin,ctx,environment,fetcher)).rejects.toThrow('AGENT_CONNECTION_TIMEOUT');await vi.advanceTimersByTimeAsync(2000);await pending;expect(fetcher).toHaveBeenCalledTimes(1);}finally{vi.useRealTimers();}
});
it('the same connection deadline also bounds a stalled initialized notification POST after successful initialize',async()=>{
 vi.useFakeTimers();const fixture=synthetic(),methods:string[]=[],fetcher:typeof fetch=async(input,init)=>{const request=JSON.parse(init?.body as string);methods.push(request.method);if(request.method==='notifications/initialized')return new Promise(()=>{});return fixture.fetcher(input,init);};
 try{const pending=expect(connectCompanyAgent(pin,context(),environment,fetcher)).rejects.toThrow('AGENT_CONNECTION_TIMEOUT');await vi.advanceTimersByTimeAsync(0);expect(methods).toEqual(['initialize','notifications/initialized']);await vi.advanceTimersByTimeAsync(2000);await pending;expect(methods).not.toContain('tools/call');}finally{vi.useRealTimers();}
});
it('rejects a late initialized receipt even before the connection timer callback runs',async()=>{
 vi.useFakeTimers();const fixture=synthetic(),fetcher:typeof fetch=async(input,init)=>{const result=await fixture.fetcher(input,init);if(JSON.parse(init?.body as string).method==='notifications/initialized')vi.setSystemTime(Date.now()+2001);return result;};
 try{await expect(connectCompanyAgent(pin,context(),environment,fetcher)).rejects.toThrow('AGENT_CONNECTION_TIMEOUT');expect(fixture.methods).not.toContain('tools/call');}finally{vi.useRealTimers();}
});

it('the actual SDK resolves an omitted endpoint key to CHAT despite another configured endpoint, with unchanged exact pins',async()=>{
 const raw={...pin} as Partial<AgentConnectionPin>;delete raw.endpointKey;const reviewed=agentConnectionPinSchema.parse(raw),fixture=synthetic(),ctx=context(),connection=await connectCompanyAgent(reviewed,ctx,{...environment,AIDER_AI_DD_MCP:'https://synthetic-unreviewed-other.invalid/mcp'},fixture.fetcher);try{expect(await ask(connection,ctx)).toMatchObject({status:'RESPONSE_RECEIVED'});expect(reviewed.endpointKey).toBe('AIDER_AI_DD_CHAT_MCP');expect(fixture.methods.filter(m=>m==='tools/call')).toHaveLength(1);}finally{await connection.close();}
});
it('a missing default CHAT key is named safely before any SDK HTTP, never falling back to MCP',async()=>{
 const raw={...pin} as Partial<AgentConnectionPin>;delete raw.endpointKey;const fixture=synthetic();await expect(connectCompanyAgent(agentConnectionPinSchema.parse(raw),context(),{AIDER_AI_DD_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token},fixture.fetcher)).rejects.toThrow('AGENT_CONNECTION_MISSING_AIDER_AI_DD_CHAT_MCP');expect(fixture.methods).toEqual([]);
});
