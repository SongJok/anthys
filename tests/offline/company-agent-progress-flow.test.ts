import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanyAgentProgressFlow,EnterpriseProgressFailure,createEnterpriseProgressTransport,enterpriseStateCopy,enterprisePollLifetimeMs,enterpriseSnapshotLifetimeMs,shouldShowEnterpriseProgress,validEnterpriseTarget,type EnterpriseRequest,type EnterpriseProgressTransport} from '../../apps/web/src/company-agent-progress-flow.js';
const taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',otherTask='44444444-4444-4444-8444-444444444444',otherRun='55555555-5555-4555-8555-555555555555';
const now=Date.parse('2026-10-19T10:00:00Z'),iso=new Date(now).toISOString();
const entry=(patch:Partial<EnterpriseRequest>={}):EnterpriseRequest=>({id,taskId,runId,state:'DISPATCHING',createdAt:iso,updatedAt:iso,deadline:new Date(now+1200000).toISOString(),dispatchStartedAt:iso,localCancellationRequestedAt:null,remoteCancellation:'NOT_REQUESTED',automaticRetry:false,source:{kind:'ENTERPRISE_AGENT_MCP',connectorId:'reviewed-agent',toolName:'chat',verification:'UNVERIFIED'},cost:{enterprise:'UNKNOWN'},reasonCode:null,...patch});
const page=(items:unknown[]=[entry()],asOf=iso)=>({items,asOf});
const receipt=(patch:Record<string,unknown>={})=>({taskId,status:'CANCELLED',deliveryCancellationRequested:true,inFlightExternalActions:'MUST_RECONCILE',...patch});
const transport=(fn:EnterpriseProgressTransport['request']=async(_path,input)=>input.method==='GET'?page():receipt()):EnterpriseProgressTransport=>({request:fn});
const flow=(t=transport(),clock=()=>now)=>new CompanyAgentProgressFlow(t,{taskId,runId},clock);
const signal=()=>new AbortController().signal;
function deferred(){let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const fetchStub=(fn:(path:string,init:RequestInit)=>Response|Promise<Response>)=>((input,init)=>Promise.resolve(fn(String(input),init??{}))) as typeof fetch;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8'}});
test('only an explicit boolean server flag enables UI; invalid targets are never accepted',()=>{
 assert.equal(shouldShowEnterpriseProgress({enterprise_request:true}),true);for(const value of [null,{}, {enterprise_request:'true'},{enterprise_request:1}])assert.equal(shouldShowEnterpriseProgress(value),false);
 assert.equal(validEnterpriseTarget(taskId,runId),true);assert.equal(validEnterpriseTarget('../other',runId),false);assert.throws(()=>new CompanyAgentProgressFlow(transport(),{taskId:'invalid',runId}));
});
test('reads strict local records for the selected task/run and never converts UNKNOWN or replies into success',async()=>{
 const f=flow(transport(async()=>page([entry({state:'UNKNOWN'}),entry({id:otherTask,runId:otherRun,state:'RESPONSE_RECEIVED'})])));assert.equal((await f.read())?.ok,true);assert.deepEqual(f.items.map(item=>item.state),['UNKNOWN']);assert.equal(f.snapshot?.asOf,iso);assert.equal(f.shouldPoll,false);assert.match(enterpriseStateCopy.UNKNOWN.detail,/阻止自动重复/);assert.match(enterpriseStateCopy.RESPONSE_RECEIVED.detail,/不表示事实/);assert.match(enterpriseStateCopy.DISPATCHING.detail,/计算进度不可见/);
});
test('unknown/forged schema fields, states, verified sources, retry flags and malformed times clear old records',async()=>{
 const values:unknown[]=[{...entry(),state:'SUCCEEDED'}, {...entry(),authorized:true}, {...entry(),automaticRetry:true}, {...entry(),source:{...entry().source,verification:'VERIFIED'}}, {...entry(),source:{...entry().source,url:'https://evil.invalid'}}, {...entry(),cost:{enterprise:100}}, {...entry(),reasonCode:'<script>run()</script>'}, {...entry(),id:'bad'}, {...entry(),deadline:'tomorrow'}, {...entry(),updatedAt:new Date(now-1).toISOString()}, {...entry(),dispatchStartedAt:new Date(now-1).toISOString()}, {...entry(),localCancellationRequestedAt:new Date(now+6000).toISOString()}];
 for(const value of values){let read=0;const f=flow(transport(async()=>++read===1?page():page([value])));await f.read();assert.equal((await f.read())?.ok,false);assert.deepEqual(f.items,[]);assert.equal(f.snapshot,null);assert.equal(f.shouldPoll,false);}
});
test('rejects wrong task, duplicate IDs, unknown list fields, future/stale timestamps and excessive items',async()=>{
 for(const value of [page([entry({taskId:otherTask})]),page([entry(),entry()]),{...page(),remoteProgress:50},page([],new Date(now+5001).toISOString()),page([],new Date(now-60001).toISOString()),page(Array.from({length:129},()=>entry()))]){const f=flow(transport(async()=>value));assert.equal((await f.read())?.ok,false);assert.equal(f.snapshot,null);}
});
test('two-second polling is read-only, non-overlapping and capped at 600 attempts/20 minutes',async()=>{
 let clock=now,calls=0;const f=flow(transport(async(_path,input)=>{calls++;assert.equal(input.method,'GET');assert.equal(input.body,undefined);return page([entry({updatedAt:new Date(clock).toISOString()})],new Date(clock).toISOString());}),()=>clock);
 assert.equal((await f.read(true))?.ok,true);assert.equal(f.shouldPoll,false);assert.equal(await f.read(true),null);
 clock+=1999;assert.equal(f.shouldPoll,false);clock++;assert.equal(f.shouldPoll,true);
 for(let i=1;i<600;i++){clock=now+i*2000;await f.read(true);}assert.equal(calls,600);assert.equal(f.pollingLimitReached,true);assert.equal(await f.read(true),null);clock=now+enterprisePollLifetimeMs;assert.equal(f.shouldPoll,false);assert.equal(f.items[0]?.state,'DISPATCHING');
 await f.read();assert.equal(calls,601);assert.equal(f.shouldPoll,false);
});
test('an overdue server deadline and local polling cutoff do not invent EXPIRED or CANCELLED',async()=>{
 let clock=now;const f=flow(transport(async()=>page([entry({deadline:iso})],new Date(clock).toISOString())),()=>clock);await f.read();assert.equal(f.items[0]?.state,'DISPATCHING');clock+=enterprisePollLifetimeMs;await f.read();assert.equal(f.items[0]?.state,'DISPATCHING');assert.equal(f.pollingLimitReached,true);assert.equal(f.shouldPoll,false);
});
test('server terminal records stop auto polling while an empty record set can be read again',async()=>{
 for(const state of ['RESPONSE_RECEIVED','NOT_SENT','UNKNOWN','CANCELLED','BLOCKED','EXPIRED'] as const){let clock=now;const f=flow(transport(async()=>page([entry({state})])),()=>clock);await f.read();assert.equal(f.shouldPoll,false);clock+=enterpriseSnapshotLifetimeMs;f.expire();assert.equal(f.shouldPoll,false);}
 let clock=now;const empty=flow(transport(async()=>page([])),()=>clock);await empty.read(true);clock+=2000;assert.equal(empty.shouldPoll,true);
});
test('stale metadata clears rather than grants authority; backward local clocks also remove visibility',async()=>{
 let clock=now;const f=flow(transport(),()=>clock);await f.read();clock+=enterpriseSnapshotLifetimeMs;assert.deepEqual(f.items,[]);assert.equal(f.canStop,false);assert.equal(f.expire(),true);assert.equal(f.snapshot,null);
 clock=now;await f.read();clock--;assert.deepEqual(f.items,[]);assert.equal(f.expire(),true);
});
test('requires an explicit second confirmation and submits exactly one empty-body local cancel',async()=>{
 const calls:{path:string;input:Parameters<EnterpriseProgressTransport['request']>[1]}[]=[],pending=deferred();const f=flow(transport(async(path,input)=>{calls.push({path,input});return input.method==='POST'?pending.promise:page();}));await f.read();assert.equal(await f.confirmStop(),null);assert.equal(calls.length,1);assert.equal(f.beginStopConfirmation(),true);assert.equal(f.confirmationOpen,true);assert.equal(f.shouldPoll,false);const stopping=f.confirmStop();assert.equal(await f.confirmStop(),null);assert.equal(calls.length,2);assert.equal(calls[1]?.path,`/api/v1/tasks/${taskId}/cancel`);assert.deepEqual(calls[1]?.input.body,{});assert.deepEqual(f.items,[]);pending.resolve(receipt());assert.equal((await stopping)?.ok,true);assert.deepEqual(f.items,[]);assert.equal(f.cancellationAttempted,true);assert.equal(f.beginStopConfirmation(),false);
});
test('dismissed or expired confirmation never sends POST',async()=>{
 let clock=now,writes=0;const f=flow(transport(async(_path,input)=>{if(input.method==='POST')writes++;return page();}),()=>clock);await f.read();f.beginStopConfirmation();f.dismissStopConfirmation();assert.equal(await f.confirmStop(),null);f.beginStopConfirmation();clock+=60000;assert.equal((await f.confirmStop())?.ok,false);assert.equal(writes,0);
});
test('network unknown/mismatched or nonterminal cancel receipts do not forge stop success and never resend',async()=>{
 for(const value of [Error('lost'),new EnterpriseProgressFailure(503),receipt({taskId:otherTask}),receipt({status:'ACTIVE'}),receipt({status:'COMPLETED'}),receipt({deliveryCancellationRequested:false}),{...receipt(),remoteCancellation:'CONFIRMED'}]){let writes=0;const f=flow(transport(async(_path,input)=>{if(input.method==='GET')return page();writes++;if(value instanceof Error)throw value;return value;}));await f.read();f.beginStopConfirmation();assert.equal((await f.confirmStop())?.ok,false);assert.equal(f.cancellationUncertain,true);assert.deepEqual(f.items,[]);await f.read();assert.equal(f.beginStopConfirmation(),false);assert.equal(await f.confirmStop(),null);assert.equal(writes,1);assert.notEqual(f.snapshot?.items[0]?.state,'CANCELLED');}
});
test('a later server CANCELLED record is shown without implying the enterprise platform stopped',async()=>{
 let reads=0;const f=flow(transport(async(_path,input)=>input.method==='POST'?receipt():page([entry(++reads===1?{}:{state:'CANCELLED',localCancellationRequestedAt:iso,remoteCancellation:'UNCONFIRMED'})])));await f.read();f.beginStopConfirmation();await f.confirmStop();await f.read();assert.equal(f.items[0]?.state,'CANCELLED');assert.equal(f.items[0]?.remoteCancellation,'UNCONFIRMED');assert.match(enterpriseStateCopy.CANCELLED.detail,/是否已停未确认/);
});
test('hiding/clearing aborts in-flight reads and ignores old success and old 401 epochs',async()=>{
 for(const reject of [false,true]){const pending=deferred();let first=true,active:AbortSignal|undefined;const f=flow(transport(async(_path,input)=>{active=input.signal;if(first){first=false;return pending.promise;}return page();}));const reading=f.read();f.clear();assert.equal(active?.aborted,true);await f.read();if(reject)pending.reject(new EnterpriseProgressFailure(401));else pending.resolve(page([entry({state:'CANCELLED'})]));assert.equal(await reading,null);assert.equal(f.items[0]?.state,'DISPATCHING');}
});
test('pausing a pending cancel marks uncertainty, clears data, ignores late receipts and cannot repeat',async()=>{
 const pending=deferred();let active:AbortSignal|undefined;const f=flow(transport(async(_path,input)=>{if(input.method==='GET')return page();active=input.signal;return pending.promise;}));await f.read();f.beginStopConfirmation();const stopping=f.confirmStop();assert.match(f.pause().notice,/服务端结果仍待核对/);assert.equal(active?.aborted,true);assert.equal(f.cancellationUncertain,true);assert.equal(f.snapshot,null);pending.resolve(receipt());assert.equal(await stopping,null);await f.read();assert.equal(f.beginStopConfirmation(),false);
});
test('401 and access/network errors remove previous data and stop automatic polling',async()=>{
 for(const status of [401,403,404,503]){let count=0;const f=flow(transport(async()=>{if(++count===1)return page();throw new EnterpriseProgressFailure(status);}));await f.read();const outcome=await f.read();assert.equal(outcome?.ok,false);assert.equal(outcome?.sessionLost,status===401?true:undefined);assert.equal(f.snapshot,null);assert.equal(f.shouldPoll,false);}
});
test('fetch transport uses only fixed same-origin GET and CSRF POST {}, with standard data unwrap',async()=>{
 const calls:{path:string;init:RequestInit}[]=[],t=createEnterpriseProgressTransport('csrf-value',fetchStub((path,init)=>{calls.push({path,init});return json({data:init.method==='POST'?receipt():page()});})),active=signal();assert.deepEqual(await t.request(`/api/v1/tasks/${taskId}/enterprise-requests`,{method:'GET',signal:active}),page());assert.deepEqual(await t.request(`/api/v1/tasks/${taskId}/cancel`,{method:'POST',signal:active,body:{}}),receipt());
 for(const call of calls){assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.mode,'same-origin');assert.equal(call.init.redirect,'error');assert.equal(call.init.cache,'no-store');assert.equal(call.init.signal,active);}assert.equal(calls[0]?.init.body,undefined);assert.equal(calls[1]?.init.body,'{}');assert.equal(new Headers(calls[1]?.init.headers).get('x-csrf-token'),'csrf-value');assert.equal(new Headers(calls[1]?.init.headers).has('idempotency-key'),false);
});
test('transport rejects arbitrary paths, wrong methods/bodies/CSRF and pre-aborted work before fetch',async()=>{
 let calls=0;const fn=fetchStub(()=>{calls++;return json({data:page()});}),t=createEnterpriseProgressTransport('csrf',fn),get=`/api/v1/tasks/${taskId}/enterprise-requests`,post=`/api/v1/tasks/${taskId}/cancel`;
 for(const path of ['https://evil.invalid'+get,'//evil.invalid/x','/etc/passwd',get+'?ask=again',`/api/v1/tasks/${taskId}/chat`])await assert.rejects(t.request(path,{method:'GET',signal:signal()}));
 await assert.rejects(t.request(get,{method:'POST',body:{},signal:signal()}));await assert.rejects(t.request(post,{method:'GET',signal:signal()}));await assert.rejects(t.request(get,{method:'GET',body:{},signal:signal()}));await assert.rejects(t.request(post,{method:'POST',body:{message:'ask'} as unknown as Record<string,never>,signal:signal()}));await assert.rejects(createEnterpriseProgressTransport('',fn).request(post,{method:'POST',body:{},signal:signal()}));const c=new AbortController();c.abort();await assert.rejects(t.request(get,{method:'GET',signal:c.signal}));assert.equal(calls,0);
});
test('transport refuses invalid JSON/envelopes, content type, UTF8, oversized stream, redirects and HTTP errors',async()=>{
 const responses=[json({}),json(page()),json({data:page(),extra:true}),new Response('<html>',{headers:{'content-type':'text/html'}}),new Response('{bad',{headers:{'content-type':'application/json'}}),new Response(Uint8Array.from([0xff]),{headers:{'content-type':'application/json'}}),json({data:'x'.repeat(524289)}),new Response('{}',{headers:{'content-type':'application/json','content-length':'524289'}}),json({},401)];
 for(const response of responses){const t=createEnterpriseProgressTransport('csrf',fetchStub(()=>response));await assert.rejects(t.request(`/api/v1/tasks/${taskId}/enterprise-requests`,{method:'GET',signal:signal()}));}
 const redirected=json({data:page()});Object.defineProperty(redirected,'redirected',{value:true});await assert.rejects(createEnterpriseProgressTransport('csrf',fetchStub(()=>redirected)).request(`/api/v1/tasks/${taskId}/enterprise-requests`,{method:'GET',signal:signal()}));
});
