import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadBackFlow, readBackNotice} from '../../apps/web/src/read-back-flow.js';
assert.equal(Reflect.get(globalThis, Symbol.for('open_aider.testNetworkGuard')), true);
assert.deepEqual(Object.keys(process.env).filter(k => /(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)), []);
const action={id:'10000000-0000-4000-8000-000000000001',capability_id:'synthetic.journal',state:'UNKNOWN' as const};
const id='20000000-0000-4000-8000-000000000001', now=1800000000000;
const session=()=>({id,nonce:'synthetic-once',argsHash:'a'.repeat(64),expiresAt:new Date(now+300000).toISOString(),action:{id:action.id,capability:action.capability_id,state:'UNKNOWN'},verification:'NO_AUTOMATIC_READ_BACK',retryAllowed:false});
const receipt=(state='VERIFIED_APPLIED')=>({id,state,verification:state==='INCONCLUSIVE'?'INCONCLUSIVE':'CERTIFIED_JOURNAL',retryAllowed:false,actionState:'UNKNOWN'});

test('rejects old, expired, malformed and wrongly bound sessions before any read-back',async()=>{
 for(const change of [{verification:undefined},{retryAllowed:true},{expiresAt:new Date(now).toISOString()},{argsHash:'bad'},{action:{id:'other',capability:action.capability_id,state:'UNKNOWN'}},{action:{id:action.id,capability:'wrong',state:'UNKNOWN'}}]){
  const calls:string[]=[];const flow=new ReadBackFlow(async path=>{calls.push(path);return {...session(),...change};},()=>now);
  assert.equal((await flow.begin(action))?.ok,false);
  assert.equal(flow.review,null);assert.equal(await flow.readBack(),null);assert.equal(calls.length,1);
 }
});

test('consumes shared nonce once and binds exact read-back request',async()=>{
 const calls:{path:string;body:unknown}[]=[];let resolve!:(value:unknown)=>void;
 const flow=new ReadBackFlow(async(path,body)=>{calls.push({path,body});return calls.length===1?session():new Promise(r=>{resolve=r;});},()=>now);
 await flow.begin(action);const first=flow.readBack();assert.equal(flow.review,null);assert.equal(flow.busy,true);
 assert.equal(await flow.readBack(),null);assert.equal(await flow.attest('APPLIED','synthetic evidence'),null);
 resolve(receipt());assert.equal((await first)?.ok,true);
 assert.deepEqual(calls,[{path:`/actions/${action.id}/reconciliation-sessions`,body:{}},{path:`/reconciliations/${id}/read-back`,body:{nonce:'synthetic-once',argsHash:'a'.repeat(64)}}]);
 assert.equal(await flow.readBack(),null);assert.equal(calls.length,2);
});

test('three outcomes preserve unknown action and never imply retry permission',async()=>{
 for(const state of ['VERIFIED_APPLIED','VERIFIED_NOT_APPLIED','INCONCLUSIVE'] as const){
  const flow=new ReadBackFlow(async path=>path.endsWith('sessions')?session():receipt(state),()=>now);
  await flow.begin(action);const result=await flow.readBack();assert.equal(result?.ok,true);assert.match(result!.notice,/业务动作仍待核对.*任务不会恢复.*未获得重试许可/);
  assert.equal(result!.notice,readBackNotice(state));
 }
 assert.match(readBackNotice('VERIFIED_APPLIED'),/认证日志确认已发生/);
 assert.match(readBackNotice('VERIFIED_NOT_APPLIED'),/认证日志确认未发生/);
 assert.match(readBackNotice('INCONCLUSIVE'),/认证读回未能确定结果/);
});

test('wrong/old/malformed receipts and transport failures discard nonce without retry',async()=>{
 for(const value of [null,{}, {...receipt(),id:action.id},{...receipt(),retryAllowed:true},{...receipt(),verification:'UNVERIFIED'},{...receipt(),state:'COMPLETED'},{...receipt(),actionState:'APPLIED'}, {...receipt('INCONCLUSIVE'),verification:'CERTIFIED_JOURNAL'},new Error('private server response')]){
  let calls=0;const flow=new ReadBackFlow(async()=>{if(++calls===1)return session();if(value instanceof Error)throw value;return value;},()=>now);
  await flow.begin(action);const result=await flow.readBack();assert.equal(result?.ok,false);assert.doesNotMatch(result!.notice,/private server response|认证日志确认/);
  assert.equal(flow.review,null);assert.equal(await flow.attest('NOT_APPLIED','evidence'),null);assert.equal(await flow.readBack(),null);assert.equal(calls,2);
 }
});

test('session expiry and lifecycle clear suppress pending results and erase review',async()=>{
 let time=now,calls=0;const flow=new ReadBackFlow(async()=>{calls++;return session();},()=>time);
 await flow.begin(action);time=now+300000;assert.equal((await flow.readBack())?.ok,false);assert.equal(calls,1);
 let resolve!:(value:unknown)=>void;const stale=new ReadBackFlow(async()=>new Promise(r=>{resolve=r;}),()=>now);
 const pending=stale.begin(action);stale.clear();resolve(session());assert.equal(await pending,null);assert.equal(stale.review,null);
 let resolveResult!:(value:unknown)=>void;let n=0;const inFlight=new ReadBackFlow(async()=>++n===1?session():new Promise(r=>{resolveResult=r;}),()=>now);
 await inFlight.begin(action);const request=inFlight.readBack();inFlight.clear();resolveResult(receipt());assert.equal(await request,null);assert.equal(inFlight.review,null);
});

test('manual attestation is distinct and consumes the same nonce',async()=>{
 const bodies:unknown[]=[];const flow=new ReadBackFlow(async(path,body)=>{bodies.push(body);return path.endsWith('sessions')?session():{id,state:'MANUAL_APPLIED_UNVERIFIED',actionState:'APPLIED_UNVERIFIED',verification:'UNVERIFIED',retryAllowed:false};},()=>now);
 await flow.begin(action);const result=await flow.attest('APPLIED','synthetic evidence');assert.equal(result?.ok,true);assert.match(result!.notice,/人工声明.*尚未核验/);assert.doesNotMatch(result!.notice,/认证日志确认/);
 assert.equal(await flow.readBack(),null);assert.deepEqual(bodies[1],{nonce:'synthetic-once',argsHash:'a'.repeat(64),claim:'APPLIED',evidence:'synthetic evidence'});
});

test('a response received after expiry cannot display certification',async()=>{
 let time=now,n=0;let resolve!:(value:unknown)=>void;
 const flow=new ReadBackFlow(async()=>++n===1?session():new Promise(r=>{resolve=r;}),()=>time);
 await flow.begin(action);const pending=flow.readBack();time=now+300000;resolve(receipt());
 const result=await pending;assert.equal(result?.ok,false);assert.doesNotMatch(result!.notice,/认证日志确认/);assert.equal(flow.review,null);assert.equal(n,2);
});
