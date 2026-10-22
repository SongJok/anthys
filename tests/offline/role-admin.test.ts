import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RoleAdminFlow,RoleAdminFailure,canManageRole,canRenewRole} from '../../apps/web/src/role-admin-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const id='10000000-0000-4000-8000-000000000001',target='20000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002',key='30000000-0000-4000-8000-000000000001',otherKey='30000000-0000-4000-8000-000000000002';
const now=1800000000000,expiry=new Date(now+7200000).toISOString();
const item=()=>({id,targetUserId:target,roleName:'ACTION_APPROVER',scopeKind:'CAPABILITY',scopeId:'synthetic.capability',scopeTruncated:false,expiresAt:new Date(now+3600000).toISOString(),version:3,managed:true,state:'ACTIVE' as const});
const list=()=>({items:[item()],nextCursor:null,scope:'TENANT_ROLE_METADATA_ONLY',platformPermissionsVerified:false});
const assignInput=()=>({targetUserId:target,roleName:'ACTION_APPROVER' as const,scopeKind:'CAPABILITY' as const,scopeId:'synthetic.capability',expiresAt:expiry,reviewReference:'review-1'});
const receipt=(requestId=key,operation:'assign'|'renew'|'revoke'='renew')=>({id,targetUserId:target,roleName:'ACTION_APPROVER',scopeKind:'CAPABILITY',scopeId:'synthetic.capability',version:operation==='assign'?1:4,state:operation==='revoke'?'REVOKED':'ACTIVE',expiresAt:expiry,replayed:false,reauthenticationRequired:false,platformPermissionsVerified:false,requestId,currentVersion:operation==='assign'?1:4,currentState:operation==='revoke'?'REVOKED':'ACTIVE'});

test('rejects malformed or overbroad role lists without retaining metadata',async()=>{
 for(const value of [{...list(),scope:'ALL'},{...list(),platformPermissionsVerified:true},{...list(),items:[{...item(),targetUserId:second}]},{...list(),items:[{...item(),version:0}]},{...list(),items:[item(),item()]},{...list(),items:Array.from({length:51},()=>item())},{items:[item()]},null]){
  const flow=new RoleAdminFlow(async()=>value,()=>key,()=>now);const result=await flow.load({targetUserId:target});assert.equal(result?.ok,false);assert.deepEqual(flow.items,[]);assert.equal(flow.selected,null);assert.equal(flow.intent,null);
 }
});

test('only complete managed non-revoked bindings can be selected, and only active ones renewed',async()=>{
 const valid=item();assert.equal(canManageRole(valid),true);assert.equal(canRenewRole(valid),true);
 for(const value of [{...valid,managed:false},{...valid,state:'REVOKED' as const},{...valid,scopeTruncated:true},{...valid,roleName:'GROUP_ADMIN'},{...valid,scopeKind:'GROUP'},{...valid,scopeKind:'TASK',scopeId:'not-a-uuid'},{...valid,scopeKind:'RESOURCE',scopeId:'https://private'},{...valid,version:0}])assert.equal(canManageRole(value),false);
 assert.equal(canRenewRole({...valid,state:'EXPIRED' as const}),false);assert.equal(canManageRole({...valid,state:'EXPIRED' as const}),true);
 const flow=new RoleAdminFlow(async()=>({...list(),items:[{...item(),managed:false}]}),()=>key,()=>now);await flow.load();assert.equal(flow.select(id),false);assert.equal(flow.prepare('renew','review-1',expiry).ok,false);
});

test('UUID filters and pagination are exact, invalid filters issue no request',async()=>{
 const paths:string[]=[];const flow=new RoleAdminFlow(async path=>{paths.push(path);return list();},()=>key,()=>now);
 await flow.load({targetUserId:target,id},second);assert.equal(paths[0],`/admin/roles?targetUserId=${target}&id=${id}&cursor=${second}`);
 const invalid=await flow.load({targetUserId:'not-uuid'});assert.equal(invalid?.ok,false);assert.match(invalid!.notice,/筛选条件.*未提交变更/);assert.equal(paths.length,1);
});

test('assignment validates role, scope and 366-day expiry, then sends one fixed key with no resend',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];const flow=new RoleAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?list():receipt(requestKey,'assign');},()=>key,()=>now);
 await flow.load();
 for(const input of [{...assignInput(),targetUserId:'bad'},{...assignInput(),roleName:'GROUP_ADMIN' as never},{...assignInput(),scopeKind:'GROUP' as never},{...assignInput(),scopeId:''},{...assignInput(),expiresAt:new Date(now-1000).toISOString()},{...assignInput(),expiresAt:new Date(now+400*86400000).toISOString()},{...assignInput(),reviewReference:'private url https://invalid'}])assert.equal(flow.prepareAssign(input).ok,false);
 assert.equal(calls.length,1);assert.equal(flow.intent,null);
 assert.equal(flow.prepareAssign(assignInput()).ok,true);const intent=flow.intent!;assert.equal(intent.operation,'assign');assert.equal(intent.item,null);
 const pending=flow.confirm();assert.equal(await flow.confirm(),null);const result=await pending;assert.equal(result?.ok,true);assert.equal(flow.receipt?.state,'ACTIVE');
 assert.deepEqual(calls[1],{path:'/admin/roles',body:assignInput(),key});assert.equal(calls.length,2);
});

test('renew and revoke bind the exact record, version and key; cancellation sends nothing',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];const flow=new RoleAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?list():receipt(requestKey,path.endsWith('/revoke')?'revoke':'renew');},()=>key,()=>now);
 await flow.load();assert.equal(flow.select(id),true);flow.prepare('renew','review-1',expiry);flow.cancel();assert.equal(calls.length,1);assert.equal(await flow.confirm(),null);
 flow.select(id);assert.equal(flow.prepare('renew','review-1',new Date(now+1800000).toISOString()).ok,false);
 assert.equal(flow.prepare('renew','review-1',expiry).ok,true);const pending=flow.confirm();assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);assert.equal((await pending)?.ok,true);
 assert.deepEqual(calls[1],{path:`/admin/roles/${id}/renew`,body:{targetUserId:target,version:3,expiresAt:expiry,reviewReference:'review-1'},key});
 await flow.load();flow.select(id);assert.equal(flow.prepare('revoke','review-2').ok,true);assert.equal((await flow.confirm())?.ok,true);assert.equal(flow.receipt?.state,'REVOKED');
 assert.deepEqual(calls[3],{path:`/admin/roles/${id}/revoke`,body:{targetUserId:target,version:3,reviewReference:'review-2'},key});
});

test('wrong, old, contradictory or unattributed receipts cannot show success or retry',async()=>{
 for(const value of [{...receipt(),id:second},{...receipt(),targetUserId:second},{...receipt(),requestId:otherKey},{...receipt(),roleName:'SECURITY_OPERATOR'},{...receipt(),scopeKind:'RESOURCE'},{...receipt(),scopeId:'other'},{...receipt(),platformPermissionsVerified:true},{...receipt(),version:3},{...receipt(),version:5,currentVersion:5},{...receipt(),currentVersion:0},{...receipt(),currentState:'UNKNOWN'},{...receipt(),state:'REVOKED'},{...receipt(key,'assign'),version:2,currentVersion:2},{...receipt(),reauthenticationRequired:undefined},{id},null]){
  let calls=0;const flow=new RoleAdminFlow(async(_p,body)=>{calls++;return body===undefined?list():value;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('renew','review-1',expiry);
  assert.equal((await flow.confirm())?.ok,false);assert.equal(flow.receipt,null);assert.equal(flow.intent,null);assert.deepEqual(flow.items,[]);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('HTTP conflict, denial, invalid input, missing local records, unavailability and unknown network erase intent',async()=>{
 for(const error of [new RoleAdminFailure(409),new RoleAdminFailure(403),new RoleAdminFailure(400),new RoleAdminFailure(404),new RoleAdminFailure(503),new Error('SYNTHETIC_PRIVATE_ROLE_DRIVER_ERROR')]){
  let calls=0;const flow=new RoleAdminFlow(async(_p,body)=>{calls++;if(body===undefined)return list();throw error;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('revoke','review-2');const result=await flow.confirm();assert.equal(result?.ok,false);assert.doesNotMatch(result!.notice,/SYNTHETIC_PRIVATE_ROLE_DRIVER_ERROR/);assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('reauthentication and 401 discard every old datum and request session-lost handling',async()=>{
 for(const value of [{...receipt(),reauthenticationRequired:true},new RoleAdminFailure(401)]){
  const flow=new RoleAdminFlow(async(_p,body)=>{if(body===undefined)return list();if(value instanceof Error)throw value;return value;},()=>key,()=>now);await flow.load();flow.select(id);flow.prepare('renew','review-1',expiry);const result=await flow.confirm();assert.equal(result?.sessionLost,true);assert.deepEqual(flow.items,[]);assert.equal(flow.receipt,null);assert.equal(flow.selected,null);
 }
});

test('replayed logical receipt stays separate from the latest binding state and clear suppresses late replies',async()=>{
 const replay=new RoleAdminFlow(async(_p,body)=>body===undefined?list():{...receipt(),replayed:true,currentVersion:9,currentState:'REVOKED'},()=>key,()=>now);await replay.load();replay.select(id);replay.prepare('renew','review-1',expiry);assert.equal((await replay.confirm())?.ok,true);assert.equal(replay.receipt?.state,'ACTIVE');assert.equal(replay.receipt?.currentState,'REVOKED');assert.equal(replay.receipt?.replayed,true);
 let resolve!:(value:unknown)=>void;const flow=new RoleAdminFlow(async()=>new Promise(r=>{resolve=r;}),()=>key,()=>now);const pending=flow.load();flow.clear();resolve(list());assert.equal(await pending,null);assert.deepEqual(flow.items,[]);
 let finish!:(value:unknown)=>void;const live=new RoleAdminFlow(async(_p,body)=>body===undefined?list():new Promise(r=>{finish=r;}),()=>key,()=>now);await live.load();live.select(id);live.prepare('renew','review-1',expiry);const write=live.confirm();live.clear();finish(receipt());assert.equal(await write,null);assert.equal(live.receipt,null);
});
