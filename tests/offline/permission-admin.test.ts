import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PermissionAdminFlow,PermissionAdminFailure,canManage} from '../../apps/web/src/permission-admin-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const id='10000000-0000-4000-8000-000000000001',target='20000000-0000-4000-8000-000000000001',key='30000000-0000-4000-8000-000000000001',manifest='40000000-0000-4000-8000-000000000001';
const now=1800000000000,expiry=new Date(now+86400000).toISOString();
const item=()=>({id,targetUserId:target,capabilityId:'synthetic.read',capabilityVersion:'1.0.0',bindingHash:'a'.repeat(64),manifestId:manifest,descriptorHash:'b'.repeat(64),resourceId:'synthetic-resource',resourceTruncated:false,classificationCeiling:'INTERNAL',expiresAt:new Date(now+3600000).toISOString(),version:3,managed:true,state:'ACTIVE' as const});
const list=()=>({items:[item()],nextCursor:null,scope:'TENANT_POLICY_METADATA_ONLY',platformPermissionsVerified:false});
const receipt=()=>({id,targetUserId:target,version:4,state:'ACTIVE',replayed:false,reauthenticationRequired:false,platformPermissionsVerified:false,requestId:key,currentVersion:4,currentState:'ACTIVE'});

test('rejects old, malformed, overbroad and wrongly filtered lists without retaining metadata',async()=>{
 for(const value of [{...list(),scope:'ALL'}, {...list(),platformPermissionsVerified:true},{...list(),items:[{...item(),targetUserId:id}]},{...list(),items:[{...item(),version:0}]},{...list(),items:[item(),item()]},{...list(),items:Array.from({length:51},()=>item())},{items:[item()]},null]){
  const flow=new PermissionAdminFlow(async()=>value,()=>key,()=>now);const result=await flow.load({targetUserId:target});assert.equal(result?.ok,false);assert.deepEqual(flow.items,[]);assert.equal(flow.selected,null);assert.equal(flow.intent,null);
 }
});

test('only complete managed non-revoked records can be selected for an intent',async()=>{
 const valid=item();assert.equal(canManage(valid),true);
 for(const value of [{...valid,managed:false},{...valid,state:'REVOKED' as const},{...valid,resourceTruncated:true},{...valid,capabilityVersion:null},{...valid,bindingHash:null},{...valid,manifestId:null},{...valid,descriptorHash:null}])assert.equal(canManage(value),false);
 const flow=new PermissionAdminFlow(async()=>({...list(),items:[{...item(),managed:false}]}),()=>key,()=>now);await flow.load();assert.equal(flow.select(id),false);assert.equal(flow.prepare('renew','review-1',expiry).ok,false);
});

test('UUID filters and pagination are exact, invalid filters issue no request',async()=>{
 const paths:string[]=[];const flow=new PermissionAdminFlow(async path=>{paths.push(path);return list();},()=>key,()=>now);
 await flow.load({targetUserId:target,id},manifest);assert.equal(paths[0],`/admin/resources?targetUserId=${target}&id=${id}&cursor=${manifest}`);
 const invalid=await flow.load({targetUserId:'not-uuid'});assert.equal(invalid?.ok,false);assert.match(invalid!.notice,/筛选条件.*未提交变更/);assert.equal(paths.length,1);
});

test('cancel sends no mutation and confirmation consumes one fixed key despite double click',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];let resolve!:(value:unknown)=>void;
 const flow=new PermissionAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?list():new Promise(r=>{resolve=r;});},()=>key,()=>now);
 await flow.load();flow.select(id);assert.equal(flow.prepare('renew','review-1',expiry).ok,true);flow.cancel();assert.equal(calls.length,1);assert.equal(await flow.confirm(),null);
 flow.select(id);flow.prepare('renew','review-1',expiry);const pending=flow.confirm();assert.equal(flow.intent,null);assert.equal(flow.selected,null);assert.equal(await flow.confirm(),null);resolve(receipt());assert.equal((await pending)?.ok,true);
 assert.deepEqual(calls[1],{path:`/admin/resources/${id}/renew`,body:{targetUserId:target,version:3,expiresAt:expiry,reviewReference:'review-1'},key});assert.equal(calls.length,2);
});

test('wrong id/target/key, old, malformed and contradictory receipts cannot show success or retry',async()=>{
 for(const value of [{...receipt(),id:manifest},{...receipt(),targetUserId:id},{...receipt(),requestId:id},{...receipt(),platformPermissionsVerified:true},{...receipt(),version:3},{...receipt(),version:5,currentVersion:5},{...receipt(),currentVersion:0},{...receipt(),currentState:'UNKNOWN'},{...receipt(),state:'REVOKED'},{...receipt(),reauthenticationRequired:undefined},{id},null]){
  let calls=0;const flow=new PermissionAdminFlow(async(_p,body)=>{calls++;return body===undefined?list():value;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('renew','review-1',expiry);
  assert.equal((await flow.confirm())?.ok,false);assert.equal(flow.receipt,null);assert.equal(flow.intent,null);assert.deepEqual(flow.items,[]);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('HTTP conflict, denial, input failure, unavailability and network unknown erase intent without automatic resend',async()=>{
 for(const error of [new PermissionAdminFailure(409),new PermissionAdminFailure(403),new PermissionAdminFailure(400),new PermissionAdminFailure(404),new PermissionAdminFailure(503),new Error('SYNTHETIC_PRIVATE_DRIVER_ERROR')]){
  let calls=0;const flow=new PermissionAdminFlow(async(_p,body)=>{calls++;if(body===undefined)return list();throw error;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('revoke','review-2');const result=await flow.confirm();assert.equal(result?.ok,false);assert.doesNotMatch(result!.notice,/SYNTHETIC_PRIVATE_DRIVER_ERROR/);assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('replayed logical receipt is separate from latest record state',async()=>{
 const flow=new PermissionAdminFlow(async(_p,body)=>body===undefined?list():{...receipt(),replayed:true,currentVersion:9,currentState:'REVOKED'},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('renew','review-1',expiry);assert.equal((await flow.confirm())?.ok,true);assert.equal(flow.receipt?.state,'ACTIVE');assert.equal(flow.receipt?.currentState,'REVOKED');assert.equal(flow.receipt?.replayed,true);
});

test('reauthentication and 401 discard every old datum and request original session-lost handling',async()=>{
 for(const value of [{...receipt(),reauthenticationRequired:true},new PermissionAdminFailure(401)]){
  const flow=new PermissionAdminFlow(async(_p,body)=>{if(body===undefined)return list();if(value instanceof Error)throw value;return value;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('renew','review-1',expiry);const result=await flow.confirm();assert.equal(result?.sessionLost,true);assert.deepEqual(flow.items,[]);assert.equal(flow.receipt,null);assert.equal(flow.selected,null);
 }
});

test('clear suppresses late list and write replies; invalid review/expiry never starts a mutation',async()=>{
 let resolve!:(value:unknown)=>void;const flow=new PermissionAdminFlow(async()=>new Promise(r=>{resolve=r;}),()=>key,()=>now);const pending=flow.load();flow.clear();resolve(list());assert.equal(await pending,null);assert.deepEqual(flow.items,[]);
 let finish!:(value:unknown)=>void;const live=new PermissionAdminFlow(async(_p,body)=>body===undefined?list():new Promise(r=>{finish=r;}),()=>key,()=>now);await live.load();live.select(id);assert.equal(live.prepare('renew','private url https://invalid',expiry).ok,false);assert.equal(live.prepare('renew','review-1',new Date(now).toISOString()).ok,false);live.prepare('renew','review-1',expiry);const write=live.confirm();live.clear();finish(receipt());assert.equal(await write,null);assert.equal(live.receipt,null);
});
