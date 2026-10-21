import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GroupContractAdminFlow,GroupContractAdminFailure} from '../../apps/web/src/group-contract-admin-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const delegation='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',admin='30000000-0000-4000-8000-000000000001',service='40000000-0000-4000-8000-000000000001',revision='50000000-0000-4000-8000-000000000001',nextRevision='50000000-0000-4000-8000-000000000002',key='60000000-0000-4000-8000-000000000001';
const now=Date.parse('2026-10-18T12:00:00Z');
function snapshot(){return {authority:{id:delegation,groupId:'synthetic-group',administratorId:admin,serviceIdentityId:service,reviewReference:'review-2026-1',validUntil:'2026-12-31T00:00:00+00:00',currency:'CNY',maxAmountMinor:100,authority:'REVIEWED_DELEGATION',platformPermissionsVerified:false},contract:{revisionId:revision,version:3,document:{schemaVersion:1,id,tenantId:'synthetic-tenant',groupId:'synthetic-group',version:3,serviceIdentityId:service,administratorAuthorization:{actorId:admin,evidenceRef:'review-2026-1'},responsibilityScope:['记录明确提交的事项'],sources:{mode:'MENTION_ONLY',entries:[{kind:'MENTION',resourceRef:'synthetic-source'}]},actions:{allowed:['case.record'],prohibited:['case.assign']},workHours:{timezone:'Asia/Shanghai',windows:[{daysOfWeek:[1,2,3,4,5],start:'09:00',end:'18:00'}]},mentionUserIds:[],escalationUserIds:[],validFrom:'2026-10-01T00:00:00Z',expiresAt:'2026-11-01T00:00:00Z',state:'ACTIVE',stateUpdatedAt:'2026-10-01T00:00:00Z',budget:{currency:'CNY',maxAmountMinor:50},revocation:{method:'authenticated administrator'}}},platformPermissionsVerified:false};}
const receipt=(state='PAUSED')=>({id,revisionId:nextRevision,version:4,state,replayed:false,currentVersion:4,currentState:state,platformPermissionsVerified:false});

test('rejects old/malformed/wrong delegation snapshots, clears metadata and sends no state request',async()=>{
 const base=snapshot();
 for(const value of [{contract:base.contract},{...base,platformPermissionsVerified:true},{...base,authority:{...base.authority,id}},{...base,authority:{...base.authority,authority:'GROUP_ADMIN'}},{...base,authority:{...base.authority,validUntil:'2026-10-01T00:00:00Z'}},{...base,contract:{...base.contract,version:2}},{...base,contract:{...base.contract,document:{...base.contract.document,private:'DO_NOT_RENDER'}}}]){
  let calls=0;const flow=new GroupContractAdminFlow(async()=>{calls++;return value;},()=>key,()=>now);assert.equal((await flow.read(delegation))?.ok,false);assert.equal(flow.snapshot,null);assert.equal(flow.prepare('PAUSED').ok,false);assert.equal(await flow.confirm(),null);assert.equal(calls,1);
 }
});

test('cross-checks exact group/admin/service/review, expiry, currency and delegated ceiling',async()=>{
 const base=snapshot(),document=base.contract.document;
 for(const change of [{groupId:'other'},{serviceIdentityId:admin},{administratorAuthorization:{actorId:service,evidenceRef:'review-2026-1'}},{administratorAuthorization:{actorId:admin,evidenceRef:'other'}},{expiresAt:'2027-01-01T00:00:00Z'},{budget:{currency:'USD',maxAmountMinor:1}},{budget:{currency:'CNY',maxAmountMinor:101}}]){
  const flow=new GroupContractAdminFlow(async()=>({...base,contract:{...base.contract,document:{...document,...change}}}),()=>key,()=>now);assert.equal((await flow.read(delegation))?.ok,false);assert.equal(flow.snapshot,null);
 }
});

test('no contract, expired contract and revoked contract remain read-only with no confirm intent',async()=>{
 for(const value of [{...snapshot(),contract:null},{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,expiresAt:'2026-10-10T00:00:00Z'}}},{...snapshot(),contract:{...snapshot().contract,document:{...snapshot().contract.document,state:'REVOKED'}}}]){
  const flow=new GroupContractAdminFlow(async()=>value,()=>key,()=>now);assert.equal((await flow.read(delegation))?.ok,true);assert.equal(flow.canChange('PAUSED'),false);assert.equal(flow.canChange('REVOKED'),false);assert.equal(flow.prepare('REVOKED').ok,false);assert.equal(await flow.confirm(),null);
 }
});

test('explicit read URL, cancel, synchronous lock and exact single-key transition body',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];let finish!:(v:unknown)=>void;
 const flow=new GroupContractAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?snapshot():new Promise(r=>{finish=r;});},()=>key,()=>now);
 await flow.read(delegation);assert.equal(calls[0]!.path,`/group-contracts?delegationId=${delegation}`);flow.prepare('PAUSED');flow.cancel();assert.equal(await flow.confirm(),null);assert.equal(calls.length,1);
 flow.prepare('PAUSED');const pending=flow.confirm();assert.equal(flow.intent,null);assert.equal(flow.snapshot,null);assert.equal(await flow.confirm(),null);assert.equal(flow.prepare('REVOKED').ok,false);finish(receipt());assert.equal((await pending)?.ok,true);
 assert.deepEqual(calls[1],{path:`/group-contracts/${id}/state`,body:{delegationId:delegation,expectedVersion:3,state:'PAUSED'},key});assert.equal(calls.length,2);
});

test('paused records allow explicit restoration or revocation, active records cannot be activated again',async()=>{
 for(const target of ['ACTIVE','REVOKED'] as const){
  const base=snapshot();base.contract.document.state='PAUSED';const flow=new GroupContractAdminFlow(async(_p,body)=>body===undefined?base:receipt(target),()=>key,()=>now);await flow.read(delegation);assert.equal(flow.canChange('PAUSED'),false);assert.equal(flow.canChange('REVOKED'),true);assert.equal(flow.canChange('ACTIVE'),true);assert.equal(flow.prepare(target).ok,true);assert.equal((await flow.confirm())?.ok,true);
 }
 const flow=new GroupContractAdminFlow(async()=>snapshot(),()=>key,()=>now);await flow.read(delegation);assert.equal(flow.prepare('ACTIVE').ok,false);
});

test('restoration has exact immutable intent, cancellation and a single in-flight request',async()=>{
 const base=snapshot();base.contract.document.state='PAUSED';let calls=0,finish!:(v:unknown)=>void;let submitted:unknown;
 const flow=new GroupContractAdminFlow(async(_p,body,requestKey)=>{calls++;if(body===undefined)return base;submitted={body,key:requestKey};return new Promise(r=>{finish=r;});},()=>key,()=>now);
 await flow.read(delegation);flow.prepare('ACTIVE');flow.cancel();assert.equal(await flow.confirm(),null);assert.equal(calls,1);
 flow.prepare('ACTIVE');const pending=flow.confirm();assert.equal(await flow.confirm(),null);assert.equal(flow.prepare('ACTIVE').ok,false);assert.deepEqual(submitted,{body:{delegationId:delegation,expectedVersion:3,state:'ACTIVE'},key});finish(receipt('ACTIVE'));assert.equal((await pending)?.ok,true);assert.equal(calls,2);assert.equal(flow.receipt?.state,'ACTIVE');
});

test('restoration cannot revive revoked, expired or future contracts or survive expiry before confirmation',async()=>{
 for(const change of [{state:'REVOKED'},{state:'EXPIRED'},{expiresAt:'2026-10-10T00:00:00Z'},{validFrom:'2026-10-20T00:00:00Z'}]){
  const base=snapshot();Object.assign(base.contract.document,{state:'PAUSED'},change);let calls=0;const flow=new GroupContractAdminFlow(async()=>{calls++;return base;},()=>key,()=>now);await flow.read(delegation);assert.equal(flow.prepare('ACTIVE').ok,false);assert.equal(await flow.confirm(),null);assert.equal(calls,1);
 }
 const base=snapshot();base.contract.document.state='PAUSED';let time=now,calls=0;const flow=new GroupContractAdminFlow(async()=>{calls++;return base;},()=>key,()=>time);await flow.read(delegation);flow.prepare('ACTIVE');time=Date.parse(base.contract.document.expiresAt);assert.equal((await flow.confirm())?.ok,false);assert.equal(calls,1);
});

test('restoration denial, stale version and lost response never become success or an automatic retry',async()=>{
 for(const error of [new GroupContractAdminFailure(401),new GroupContractAdminFailure(403),new GroupContractAdminFailure(409),new Error('synthetic lost reply')]){
  const base=snapshot();base.contract.document.state='PAUSED';let calls=0;const flow=new GroupContractAdminFlow(async(_p,body)=>{calls++;if(body===undefined)return base;throw error;},()=>key,()=>now);await flow.read(delegation);flow.prepare('ACTIVE');assert.equal((await flow.confirm())?.ok,false);assert.equal(await flow.confirm(),null);assert.equal(flow.receipt,null);assert.equal(flow.snapshot,null);assert.equal(calls,2);
 }
});

test('rejects wrong contract/revision/version/state and malformed receipt without guessing success',async()=>{
 for(const value of [{...receipt(),id:admin},{...receipt(),revisionId:revision},{...receipt(),version:3},{...receipt(),version:5},{...receipt(),state:'REVOKED'},{...receipt(),currentVersion:2},{...receipt(),currentState:'ACTIVE'},{...receipt(),platformPermissionsVerified:true},{id,state:'PAUSED'},null]){
  let calls=0;const flow=new GroupContractAdminFlow(async(_p,body)=>{calls++;return body===undefined?snapshot():value;},()=>key,()=>now);await flow.read(delegation);flow.prepare('PAUSED');assert.equal((await flow.confirm())?.ok,false);assert.equal(flow.receipt,null);assert.equal(flow.snapshot,null);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('historical receipt is distinct from newer current state and blocks stale later reads',async()=>{
 const flow=new GroupContractAdminFlow(async(_p,body)=>body===undefined?snapshot():{...receipt(),replayed:true,currentVersion:9,currentState:'REVOKED'},()=>key,()=>now);await flow.read(delegation);flow.prepare('PAUSED');assert.equal((await flow.confirm())?.ok,true);assert.equal(flow.receipt?.state,'PAUSED');assert.equal(flow.receipt?.currentState,'REVOKED');assert.equal(flow.receipt?.currentVersion,9);assert.equal((await flow.read(delegation))?.ok,false);assert.equal(flow.snapshot,null);
});

test('HTTP denial/conflict and network unknown discard confirmation, never resend or leak errors',async()=>{
 for(const error of [new GroupContractAdminFailure(401),new GroupContractAdminFailure(403),new GroupContractAdminFailure(409),new GroupContractAdminFailure(503),new Error('PRIVATE_DRIVER_DETAILS')]){
  let calls=0;const flow=new GroupContractAdminFlow(async(_p,body)=>{calls++;if(body===undefined)return snapshot();throw error;},()=>key,()=>now);await flow.read(delegation);flow.prepare('REVOKED');const result=await flow.confirm();assert.equal(result?.ok,false);assert.equal(!!result?.sessionLost,error instanceof GroupContractAdminFailure&&error.status===401);assert.doesNotMatch(result!.notice,/PRIVATE_DRIVER_DETAILS/);assert.equal(flow.snapshot,null);assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('expiry before confirmation and lifecycle invalidation suppress all stale results',async()=>{
 let time=now,calls=0;const expiring=new GroupContractAdminFlow(async()=>{calls++;return snapshot();},()=>key,()=>time);await expiring.read(delegation);expiring.prepare('PAUSED');time=Date.parse(snapshot().contract.document.expiresAt);assert.equal((await expiring.confirm())?.ok,false);assert.equal(calls,1);
 let readReply!:(v:unknown)=>void;const stale=new GroupContractAdminFlow(async()=>new Promise(r=>{readReply=r;}),()=>key,()=>now);const read=stale.read(delegation);stale.clear();readReply(snapshot());assert.equal(await read,null);assert.equal(stale.snapshot,null);
 let writeReply!:(v:unknown)=>void;const pending=new GroupContractAdminFlow(async(_p,body)=>body===undefined?snapshot():new Promise(r=>{writeReply=r;}),()=>key,()=>now);await pending.read(delegation);pending.prepare('PAUSED');const write=pending.confirm();pending.clear();writeReply(receipt());assert.equal(await write,null);assert.equal(pending.receipt,null);
});
