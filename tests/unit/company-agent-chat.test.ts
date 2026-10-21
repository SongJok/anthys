import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CompanyAgentChat,agentChatInputSchemaHash,type AgentChatRequest} from '../../packages/company/src/agent-chat.js';
const schema={type:'object' as const,properties:{message:{type:'string'}}};
const pin={toolName:'chat',inputSchemaHash:agentChatInputSchemaHash(schema)};
const request=():AgentChatRequest=>({localRequestId:randomUUID(),message:'synthetic only',absoluteDeadlineMs:Date.now()+60000,maxWaitMs:60000,signal:new AbortController().signal,beforeDispatch:async()=>{}});
const client=()=>new Client({name:'synthetic-unit',version:'1'},{capabilities:{}});
it('schema hash sorts object keys without changing arrays, and does not reuse the scoped proxy hash',()=>{
 expect(agentChatInputSchemaHash(schema)).toBe(agentChatInputSchemaHash({properties:{message:{type:'string'}},type:'object'}));
 expect(agentChatInputSchemaHash({required:['a','b']})).not.toBe(agentChatInputSchemaHash({required:['b','a']}));
 expect(agentChatInputSchemaHash(schema)).toMatch(/^[a-f0-9]{64}$/);
});
it.each([undefined,NaN,Infinity,()=>{},new Date()])('rejects non-JSON schema values without interpreting them',value=>{expect(()=>agentChatInputSchemaHash({value})).toThrow();});
it('rejects cyclic, deep, large and overly wide schema inputs',()=>{
 const cycle:Record<string,unknown>={};cycle['self']=cycle;
 expect(()=>agentChatInputSchemaHash(cycle)).toThrow(/LIMIT/);
 expect(()=>agentChatInputSchemaHash({description:'x'.repeat(65536)})).toThrow(/LIMIT/);
 expect(()=>agentChatInputSchemaHash(Array.from({length:4096},()=>null))).toThrow(/LIMIT/);
});
it.each([{maxWaitMs:0},{maxWaitMs:1200001},{absoluteDeadlineMs:Infinity},{message:' '},{message:'中'.repeat(22000)},{conversationId:123},{images:[]},{tenantId:randomUUID()},{beforeDispatch:undefined}])('rejects invalid or unapproved request fields before an SDK call (%j)',async patch=>{
 const c=client(),call=vi.spyOn(c,'callTool');const result=await new CompanyAgentChat(c,pin).request({...request(),...patch} as AgentChatRequest);
 expect(result).toMatchObject({status:'NOT_SENT',reason:'INVALID_REQUEST'});expect(call).not.toHaveBeenCalled();
});
it('returns no unbounded echo for an invalid local request ID',async()=>{
 expect(await new CompanyAgentChat(client(),pin).request({...request(),localRequestId:'not-a-uuid'})).toEqual({status:'NOT_SENT',localRequestId:null,reason:'INVALID_REQUEST'});
});
it.each([{discoveryTimeoutMs:2001},{controlTimeoutMs:2001},{maxResponseBytes:262145},{maxTextBlocks:65},{unknown:true}])('rejects invalid component limits before discovery (%j)',async limits=>{
 const c=client(),list=vi.spyOn(c,'listTools');expect(await new CompanyAgentChat(c,pin,limits).request(request())).toMatchObject({status:'NOT_SENT',reason:'INVALID_CONFIGURATION'});expect(list).not.toHaveBeenCalled();
});
it('copies its reviewed snapshot so caller mutation cannot change the selected tool',async()=>{
 const mutable={...pin},adapter=new CompanyAgentChat(client(),mutable);mutable.toolName='other';
 // A disconnected real SDK client has no tool capability and is not dispatched.
 expect(await adapter.request(request())).toMatchObject({status:'NOT_SENT',reason:'TOOL_NOT_FOUND'});
});
it('pre-cancelled and already expired requests are provably not started',async()=>{
 const c=client(),calls=vi.spyOn(c,'callTool'),controller=new AbortController();controller.abort();
 expect(await new CompanyAgentChat(c,pin).request({...request(),signal:controller.signal})).toMatchObject({status:'NOT_SENT',reason:'CANCELLED'});
 expect(await new CompanyAgentChat(c,pin).request({...request(),absoluteDeadlineMs:Date.now()-1})).toMatchObject({status:'NOT_SENT',reason:'DEADLINE_EXCEEDED'});expect(calls).not.toHaveBeenCalled();
});
it('a separate roster observation follows discovery and precedes the unchanged local dispatch gate',async()=>{
 const c=client(),order:string[]=[];vi.spyOn(c,'getServerCapabilities').mockReturnValue({tools:{}});vi.spyOn(c,'listTools').mockImplementation(async()=>{order.push('discovery');return {tools:[{name:'chat',inputSchema:schema}]};});vi.spyOn(c,'callTool').mockImplementation(async()=>{order.push('business');return {content:[{type:'text',text:'synthetic unverified'}]};});
 const result=await new CompanyAgentChat(c,pin).request({...request(),prepareDispatch:async()=>{order.push('roster');},beforeDispatch:async()=>{order.push('local-commit');}});expect(result.status).toBe('RESPONSE_RECEIVED');expect(order).toEqual(['discovery','roster','local-commit','business']);
});
it.each(['refusal','business-deadline','observation-deadline','local-gate'] as const)('bounded roster preparation %s cannot extend the local gate or send an enterprise question',async mode=>{
 vi.useFakeTimers();try{
  const c=client(),commit=vi.fn(async()=>{if(mode==='local-gate')await new Promise<void>(()=>{});});vi.spyOn(c,'getServerCapabilities').mockReturnValue({tools:{}});vi.spyOn(c,'listTools').mockResolvedValue({tools:[{name:'chat',inputSchema:schema}]});const call=vi.spyOn(c,'callTool');
  const job=new CompanyAgentChat(c,pin).request({...request(),absoluteDeadlineMs:Date.now()+(mode==='business-deadline'?50:60000),prepareDispatch:async()=>{if(mode==='refusal')throw Error('SYNTHETIC_ROSTER_DENIED');if(mode!=='local-gate')await new Promise<void>(()=>{});},beforeDispatch:commit});
  await vi.advanceTimersByTimeAsync(mode==='business-deadline'?51:mode==='observation-deadline'?12001:2001);const result=await job;expect(result.status).toBe('NOT_SENT');expect(call).not.toHaveBeenCalled();expect(commit).toHaveBeenCalledTimes(mode==='local-gate'?1:0);
 }finally{vi.useRealTimers();}
});
