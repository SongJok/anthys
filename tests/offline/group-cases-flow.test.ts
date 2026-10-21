import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GroupCasesFlow,GroupCasesFailure,caseActions,localToday,localWindowInputs,localRegistrationWindow,type GroupCase,type GroupCasesTransport} from '../../apps/web/src/group-cases-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const actor='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',id='20000000-0000-4000-8000-000000000001',id2='20000000-0000-4000-8000-000000000002',key='30000000-0000-4000-8000-000000000001';
const range={from:'2026-10-18T00:00:00.000Z',until:'2026-10-19T00:00:00.000Z'};
const details={title:'核对发布',resourceRef:'release:payments-v2',priority:'NORMAL' as const,dueAt:null};
const item=(change:Partial<GroupCase>={}):GroupCase=>({...details,id,version:1,contractVersion:3,updatedAt:'2026-10-18T01:00:00.000Z',state:'PROPOSED',ownerId:null,createdBy:actor,blockedReason:null,completion:null,sources:[{id:'40000000-0000-4000-8000-000000000001',kind:'CARD',source_event_id:null,submitted_by:actor,created_at:'2026-10-18T01:00:00.000Z'}],...change});
const page=(items=[item()],administrator=true)=>({items,members:[{id:actor,name:'本人'},{id:other,name:'其他成员'}],nextCursor:null as string|null,coverage:{mode:'MENTION_ONLY',completeChat:false,notice:'只含已登记 @ 与明确共享卡片，不含全部群聊。',...range,selection:'CASE_REGISTRATION_TIME'},contractVersion:3,administrator});
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};};
const currentSnapshot=(flow:GroupCasesFlow)=>flow.snapshot;

test('today is browser-local midnight through next local midnight, with explicit ISO instants',()=>{
 const date=new Date(2026,9,18,16,30),window=localToday(date);
 assert.equal(window.from,new Date(2026,9,18).toISOString());assert.equal(window.until,new Date(2026,9,19).toISOString());
});
test('reads the exact encoded group and registration window without merging similar titles or different resources',async()=>{
 const calls:{path:string;request:unknown}[]=[],flow=new GroupCasesFlow(async(path,request)=>{calls.push({path,request});return page([item(),item({id:id2,resourceRef:'release:another-resource'})]);},actor,()=>key);
 assert.equal((await flow.read('cid/a?b==',range))?.ok,true);
 assert.equal(calls[0]!.path,'/groups/cid%2Fa%3Fb%3D%3D/cases?from=2026-10-18T00%3A00%3A00.000Z&until=2026-10-19T00%3A00%3A00.000Z&limit=50');
 assert.deepEqual(calls[0]!.request,{method:'GET'});assert.equal(flow.snapshot?.items.length,2);assert.equal(flow.snapshot?.coverage.completeChat,false);assert.equal(flow.snapshot?.items[0]?.ownerId,null);assert.equal(flow.snapshot?.items[0]?.dueAt,null);
});
test('explicit sharing and valid exact resources are mandatory before a create request',async()=>{
 let requests=0;const flow=new GroupCasesFlow(async()=>{requests++;return page();},actor,()=>key);await flow.read('group',range);
 assert.equal((await flow.create(details,false))?.ok,false);assert.equal((await flow.create({...details,resourceRef:''},true))?.ok,false);assert.equal(requests,1);assert.ok(flow.snapshot);
});
test('create clears the old bodies, uses one immutable key, blocks double clicks, and keeps only a logical receipt',async()=>{
 const pending=deferred(),calls:{path:string;request:Parameters<GroupCasesTransport>[1]}[]=[];
 const flow=new GroupCasesFlow(async(path,request)=>{calls.push({path,request});return request.method==='GET'?page():pending.promise;},actor,()=>key);await flow.read('group',range);
 const first=flow.create(details,true);assert.equal(flow.busy,true);assert.equal(flow.snapshot,null);assert.equal(await flow.create(details,true),null);
 assert.deepEqual(calls[1],{path:'/groups/group/cases',request:{method:'POST',key,body:{contractVersion:3,details,source:{kind:'CARD',shareWithGroup:true}}}});
 pending.resolve({case:item(),replayed:false,duplicate:false});assert.equal((await first)?.ok,true);assert.deepEqual(flow.receipt,{id,version:1,state:'PROPOSED',replayed:false});assert.equal(flow.snapshot,null);assert.equal(calls.length,2);
});
test('actions follow administrator, owner and creator boundaries, including independent confirmation',()=>{
 assert.deepEqual(caseActions(item(),actor,false),['CANCEL']);assert.deepEqual(caseActions(item(),other,false),[]);
 assert.deepEqual(caseActions(item(),other,true),['OPEN','CANCEL']);
 const assigned=item({state:'ASSIGNED',ownerId:actor});assert.deepEqual(caseActions(assigned,actor,false),['START','BLOCK','CLAIM_COMPLETE','CANCEL']);assert.deepEqual(caseActions(assigned,other,true),['ASSIGN','CANCEL']);
 assert.equal(caseActions(item({state:'WAITING_CONFIRMATION',ownerId:actor}),actor,true).includes('CONFIRM'),false);assert.equal(caseActions(item({state:'WAITING_CONFIRMATION',ownerId:actor}),other,true).includes('CONFIRM'),true);
 for(const state of ['CLOSED','CANCELLED'] as const)assert.deepEqual(caseActions(item({state}),actor,true),[]);
});
test('updates bind contract and item versions, constrain assignment to the current member list and block duplicate commands',async()=>{
 const pending=deferred(),calls:Parameters<GroupCasesTransport>[1][]=[],flow=new GroupCasesFlow(async(_path,request)=>{calls.push(request);return request.method==='GET'?page([item({state:'OPEN',version:4})]):pending.promise;},actor,()=>key);await flow.read('group',range);
 assert.equal((await flow.command(id,{operation:'ASSIGN',ownerId:id2}))?.ok,false);assert.equal(calls.length,1);
 const first=flow.command(id,{operation:'ASSIGN',ownerId:other});assert.equal(await flow.command(id,{operation:'ASSIGN',ownerId:other}),null);assert.equal(flow.snapshot,null);
 assert.deepEqual(calls[1],{method:'PATCH',key,body:{contractVersion:3,expectedVersion:4,command:{operation:'ASSIGN',ownerId:other}}});
 pending.resolve({case:item({state:'ASSIGNED',ownerId:other,version:5}),replayed:false});assert.equal((await first)?.ok,true);assert.equal(calls.length,2);
});
test('revoked access, lost session, conflict and unknown writes erase bodies without automatic retries',async()=>{
 for(const status of [401,403,409,503]){
  let calls=0;const flow=new GroupCasesFlow(async(_path,request)=>{calls++;if(request.method==='GET')return page();throw new GroupCasesFailure(status);},actor,()=>key);await flow.read('group',range);
  const result=await flow.command(id,{operation:'OPEN'});assert.equal(result?.ok,false);assert.equal(result?.sessionLost,status===401?true:undefined);assert.equal(flow.snapshot,null);assert.equal(flow.receipt,null);assert.equal(await flow.command(id,{operation:'OPEN'}),null);assert.equal(calls,2);
 }
});
test('late read and mutation responses cannot restore hidden bodies or overwrite a newly selected group',async()=>{
 const read=deferred(),flow=new GroupCasesFlow(async(path)=>path.includes('/old/')?read.promise:page([item({id:id2})]),actor,()=>key),first=flow.read('old',range);
 flow.clear();assert.equal((await flow.read('new',range))?.ok,true);read.resolve(page());assert.equal(await first,null);assert.equal(flow.snapshot?.groupId,'new');assert.equal(flow.snapshot?.items[0]?.id,id2);
 const write=deferred(),writes=new GroupCasesFlow(async(_path,request)=>request.method==='GET'?page():write.promise,actor,()=>key);await writes.read('old',range);const changing=writes.command(id,{operation:'OPEN'});writes.clear();await writes.read('new',range);write.resolve({case:item({state:'OPEN',version:2}),replayed:false});assert.equal(await changing,null);assert.equal(writes.receipt,null);assert.equal(writes.snapshot?.groupId,'new');
});
test('pagination replaces the current page and preserves explicit coverage without claiming a complete chat',async()=>{
 const requests:string[]=[],flow=new GroupCasesFlow(async(path)=>{requests.push(path);if(requests.length===1)return {...page(),nextCursor:id};return page([item({id:id2})]);},actor,()=>key);
 assert.equal((await flow.read('group',range))?.ok,true);assert.equal((await flow.next())?.ok,true);assert.equal(flow.snapshot?.page,2);assert.deepEqual(flow.snapshot?.items.map(i=>i.id),[id2]);assert.ok(requests[1]?.endsWith('&cursor='+id));assert.equal(await flow.next(),null);assert.equal(flow.snapshot?.coverage.completeChat,false);
});
test('rejects malformed coverage, duplicate identities, wrong windows, repeated cursors and stale versions',async()=>{
 const base=page();for(const value of [{...base,coverage:{...base.coverage,completeChat:true}},{...base,coverage:{...base.coverage,from:range.until}},{...base,items:[item(),item()]},{...base,members:[base.members[0],base.members[0]]},{...base,nextCursor:id2},{...base,items:[item({contractVersion:4})]}]){
  const flow=new GroupCasesFlow(async()=>value,actor,()=>key);assert.equal((await flow.read('group',range))?.ok,false);assert.equal(flow.snapshot,null);
 }
 let n=0;const stale=new GroupCasesFlow(async()=>page([item({version:++n===1?4:3})]),actor,()=>key);assert.equal((await stale.read('group',range))?.ok,true);stale.clear();assert.equal((await stale.read('group',range))?.ok,false);
 const looping=new GroupCasesFlow(async()=>({...page(),nextCursor:id}),actor,()=>key);await looping.read('group',range);assert.equal((await looping.next())?.ok,false);assert.equal(looping.snapshot,null);
});
test('malformed or mismatched receipts are unknown, not optimistic success',async()=>{
 for(const value of [{case:item({id:id2,state:'OPEN',version:2}),replayed:false},{case:item({state:'OPEN',version:1}),replayed:false},{case:item({state:'OPEN',version:2}),replayed:'yes'}]){
  const flow=new GroupCasesFlow(async(_path,request)=>request.method==='GET'?page():value,actor,()=>key);await flow.read('group',range);assert.equal((await flow.command(id,{operation:'OPEN'}))?.ok,false);assert.equal(flow.snapshot,null);assert.equal(flow.receipt,null);
 }
});

test('custom browser-local endpoints convert to explicit UTC without guessing an offset',()=>{
 const before=process.env['TZ'];process.env['TZ']='Asia/Shanghai';
 try{
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone,'Asia/Shanghai');
  assert.deepEqual(localWindowInputs(new Date('2026-10-18T12:30:00Z')),{from:'2026-10-18T00:00',until:'2026-10-19T00:00'});
  assert.deepEqual(localRegistrationWindow('2026-10-18T00:00','2026-10-19T00:00'),{from:'2026-10-17T16:00:00.000Z',until:'2026-10-18T16:00:00.000Z'});
 }finally{if(before===undefined)delete process.env['TZ'];else process.env['TZ']=before;}
});
test('custom windows reject rollover, incomplete, reversed, equal, injected and over-31-day input',()=>{
 for(const [from,until] of [['2026-02-30T00:00','2026-03-02T00:00'],['2026-10-18','2026-10-19T00:00'],
  ['2026-10-19T00:00','2026-10-18T00:00'],['2026-10-18T00:00','2026-10-18T00:00'],
  ['2026-10-18T24:00','2026-10-20T00:00'],['2026-10-18T00:00Z','2026-10-19T00:00'],
  ['2026-10-01T00:00','2026-11-02T00:00'],['0000-01-01T00:00','0001-01-01T00:00']]){
  assert.throws(()=>localRegistrationWindow(from!,until!));
 }
});
test('DST gap is rejected, repeated local time resolves earlier, and 31-day maximum uses elapsed UTC',()=>{
 const before=process.env['TZ'];process.env['TZ']='America/Los_Angeles';
 try{
  assert.throws(()=>localRegistrationWindow('2026-03-08T02:30','2026-03-08T04:00'));
  assert.deepEqual(localRegistrationWindow('2026-11-01T01:30','2026-11-01T02:30'),{from:'2026-11-01T08:30:00.000Z',until:'2026-11-01T10:30:00.000Z'});
  const spring=localRegistrationWindow('2026-03-08T00:00','2026-03-09T00:00');
  assert.equal(Date.parse(spring.until)-Date.parse(spring.from),23*3600000);
  const fall=localRegistrationWindow('2026-11-01T00:00','2026-11-02T00:00');
  assert.equal(Date.parse(fall.until)-Date.parse(fall.from),25*3600000);
  assert.throws(()=>localRegistrationWindow('2026-10-15T00:00','2026-11-15T00:00'));
  assert.doesNotThrow(()=>localRegistrationWindow('2026-10-15T00:00','2026-11-14T23:00'));
 }finally{if(before===undefined)delete process.env['TZ'];else process.env['TZ']=before;}
});
test('custom pagination sends identical UTC bounds even after a new local day',async()=>{
 const custom={from:'2026-09-20T14:30:00.000Z',until:'2026-09-22T08:15:00.000Z'},paths:string[]=[];
 const flow=new GroupCasesFlow(async path=>{paths.push(path);return {...page([item({id:paths.length===1?id:id2})]),nextCursor:paths.length===1?id:null,coverage:{...page().coverage,...custom}};},actor,()=>key);
 assert.equal((await flow.read('group',custom))?.ok,true);assert.equal((await flow.next())?.ok,true);
 for(const path of paths){const url=new URL(path,'http://local.invalid');assert.equal(url.searchParams.get('from'),custom.from);assert.equal(url.searchParams.get('until'),custom.until);assert.equal(url.searchParams.get('limit'),'50');}
 assert.equal(flow.snapshot?.page,2);assert.deepEqual(flow.snapshot?.coverage.from,custom.from);
});
test('changing window clears receipt and invalidates late prior read, page and write responses',async()=>{
 const custom={from:'2026-10-17T00:00:00.000Z',until:'2026-10-18T00:00:00.000Z'};
 for(const operation of ['read','next','write'] as const){
  const delayed=deferred();let calls=0;
  const flow=new GroupCasesFlow(async()=>{calls++;if(calls===1)return {...page(),nextCursor:id};if(calls===2)return delayed.promise;return {...page([item({id:id2})]),coverage:{...page().coverage,...custom}};},actor,()=>key);
  await flow.read('group',range);
  const old=operation==='read'?flow.read('group',range):operation==='next'?flow.next():flow.command(id,{operation:'OPEN'});
  flow.clear();assert.equal(flow.snapshot,null);assert.equal(flow.receipt,null);assert.equal(flow.busy,false);
  assert.equal((await flow.read('group',custom))?.ok,true);
  delayed.resolve(operation==='write'?{case:item({state:'OPEN',version:2}),replayed:false}:page());
  assert.equal(await old,null);assert.equal(flow.receipt,null);assert.equal(currentSnapshot(flow)?.coverage.from,custom.from);assert.equal(currentSnapshot(flow)?.items[0]?.id,id2);
 }
 const receipts=new GroupCasesFlow(async(_path,request)=>request.method==='GET'?page():{case:item({state:'OPEN',version:2}),replayed:false},actor,()=>key);
 await receipts.read('group',range);await receipts.command(id,{operation:'OPEN'});assert.ok(receipts.receipt);receipts.clear();assert.equal(receipts.receipt,null);
});
test('invalid UTC window never reaches transport and cannot leave previous bodies or receipt',async()=>{
 let calls=0;const flow=new GroupCasesFlow(async()=>{calls++;return page();},actor,()=>key);await flow.read('group',range);
 for(const bad of [{from:range.until,until:range.from},{from:range.from,until:'2026-11-19T00:00:00Z'},{...range,role:'ADMIN'}]){
  assert.equal((await flow.read('group',bad))?.ok,false);assert.equal(flow.snapshot,null);assert.equal(flow.receipt,null);
 }
 assert.equal(calls,1);
});
