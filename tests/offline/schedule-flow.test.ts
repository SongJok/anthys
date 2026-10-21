import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ScheduleFlow,ScheduleFailure,reminderRuleSchema,reminderActions,type ReminderSchedule,type ScheduleTransport} from '../../apps/web/src/schedule-flow.js';
import {preview} from '../../packages/schedules/src/rules.js';
assert.equal(Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const actor='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',id='20000000-0000-4000-8000-000000000001',id2='20000000-0000-4000-8000-000000000002',key='30000000-0000-4000-8000-000000000001',asOf='2026-10-18T00:00:00.000Z',now=()=>Date.parse(asOf);
const rule=reminderRuleSchema.parse({schemaVersion:1,kind:'ONCE',tz:'Asia/Shanghai',start:{kind:'LOCAL',at:'2026-10-19T09:00:00'},misfire:{kind:'REMINDER_LATEST'}});
const schedule=(change:Partial<ReminderSchedule>={}):ReminderSchedule=>({id,ownerId:actor,revision:1,etag:'"opaque-revision-one"',state:'ACTIVE',text:'带上报告',rule,nextDueAt:'2026-10-19T01:00:00.000Z',createdAt:asOf,updatedAt:asOf,lastOccurrence:null,...change});
const detail=(value=schedule())=>({schedule:value,preview:preview(value.rule,{now:asOf}),asOf});
const page=(items=[schedule()])=>({items,nextCursor:null as string|null,asOf});
const flow=(transport:ScheduleTransport)=>new ScheduleFlow(transport,actor,()=>key,now);
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};};

test('private reminder schema accepts only explicit reminder kinds and rejects monitoring/report/high-risk/calendar substitutions',()=>{
 for(const change of [{kind:'INTERVAL',everySeconds:300},{misfire:{kind:'REPORT_COALESCE'}},{misfire:{kind:'MONITOR_CURRENT'}},{misfire:{kind:'RECONFIRM'}},{businessCalendar:{id:'corp',version:1}},{target:{kind:'GROUP',id:'other'}},{actorId:other}])assert.equal(reminderRuleSchema.safeParse({...rule,...change}).success,false);
});
test('reads only the actor-owned list and detail with absolute UTC, timezone, revision and opaque ETag',async()=>{
 const requests:{path:string;request:unknown}[]=[],f=flow(async(path,request)=>{requests.push({path,request});return path.includes('?')?page():detail();});assert.equal((await f.readList())?.ok,true);assert.deepEqual(requests[0],{path:'/schedules?limit=50',request:{method:'GET'}});assert.equal((await f.read(id))?.ok,true);assert.equal(f.detail?.schedule.etag,'"opaque-revision-one"');assert.equal(f.detail?.preview.occurrences[0]?.utc,'2026-10-19T01:00:00.000Z');assert.equal(f.detail?.preview.occurrences[0]?.tz,'Asia/Shanghai');
});
test('server preview is real transport, explicitly unsaved, and never a required second approval before create',async()=>{
 const calls:Parameters<ScheduleTransport>[1][]=[],f=flow(async(_path,request)=>{calls.push(request);return {rule,preview:preview(rule,{now:asOf}),asOf};});assert.equal((await f.preview(rule))?.ok,true);assert.deepEqual(calls,[{method:'POST',body:{rule}}]);assert.equal(f.receipt,null);assert.equal(f.draftPreview?.asOf,asOf);f.invalidateDraft();assert.equal(f.draftPreview,null);
 const direct=flow(async()=>({schedule:schedule(),replayed:false}));assert.equal((await direct.create('带上报告',rule))?.ok,true);
});
test('create is one request with fixed private kind, no target/actor input, one key and a minimal unsent receipt',async()=>{
 const pending=deferred(),calls:{path:string;request:Parameters<ScheduleTransport>[1]}[]=[],f=flow(async(path,request)=>{calls.push({path,request});return pending.promise;});const first=f.create('带上报告',rule);assert.equal(f.busy,true);assert.equal(await f.create('带上报告',rule),null);assert.deepEqual(calls,[{path:'/schedules',request:{method:'POST',body:{kind:'PRIVATE_TEXT_REMINDER',text:'带上报告',rule},key}}]);pending.resolve({schedule:schedule(),replayed:false});assert.equal((await first)?.ok,true);assert.deepEqual(f.receipt,{id,revision:1,etag:'"opaque-revision-one"',state:'ACTIVE',replayed:false});assert.equal(f.detail,null);assert.equal(f.page,null);
});
test('PATCH submits the complete text/rule and current opaque If-Match, then requires a strictly newer revision',async()=>{
 const calls:{path:string;request:Parameters<ScheduleTransport>[1]}[]=[],changed=schedule({text:'新的提醒',revision:2,etag:'W/"totally-opaque-two"'}),f=flow(async(path,request)=>{calls.push({path,request});return request.method==='GET'?detail():{schedule:changed,replayed:false};});await f.read(id);assert.equal((await f.edit(id,'新的提醒',rule))?.ok,true);assert.deepEqual(calls[1],{path:'/schedules/'+id,request:{method:'PATCH',body:{text:'新的提醒',rule},key,ifMatch:'"opaque-revision-one"'}});assert.equal(f.receipt?.revision,2);assert.equal(await f.edit(id,'repeat',rule),null);
});
test('pause, resume, cancel retain revision preconditions; BLOCKED cannot be bypassed or resumed',async()=>{
 for(const [before,operation,after] of [['ACTIVE','pause','PAUSED'],['PAUSED','resume','ACTIVE'],['BLOCKED','cancel','CANCELLED']] as const){
  const calls:Parameters<ScheduleTransport>[1][]=[],f=flow(async(_path,request)=>{calls.push(request);return request.method==='GET'?detail(schedule({state:before})):{schedule:schedule({state:after,revision:2,etag:'"two"'}),replayed:false};});await f.read(id);assert.equal((await f.change(id,operation))?.ok,true);assert.deepEqual(calls[1],{method:'POST',body:{},key,ifMatch:'"opaque-revision-one"'});
 }
 const blocked=flow(async()=>detail(schedule({state:'BLOCKED'})));await blocked.read(id);assert.equal(await blocked.change(id,'resume'),null);assert.equal(await blocked.edit(id,'text',rule),null);assert.deepEqual(reminderActions(schedule({state:'CANCELLED'})),[]);
});
test('UNKNOWN, MISSED and unverified submission never become a client claim of successful delivery',async()=>{
 for(const deliveryState of ['UNKNOWN','MISSED','APPLIED_UNVERIFIED'] as const){const value=schedule({lastOccurrence:{scheduledAt:asOf,taskId:null,deliveryState,verification:'UNVERIFIED'}}),f=flow(async()=>detail(value));assert.equal((await f.read(id))?.ok,true);assert.equal(f.detail?.schedule.lastOccurrence?.verification,'UNVERIFIED');}
 const invalid={...schedule(),lastOccurrence:{scheduledAt:asOf,taskId:id2,deliveryState:'VERIFIED',verification:'VERIFIED'}},f=flow(async()=>({...detail(),schedule:invalid}));assert.equal((await f.read(id))?.ok,false);assert.equal(f.detail,null);
});
test('an ACTIVE one-time reminder with no future rule time still supports pausing its pending occurrence',async()=>{
 const queuedRule=reminderRuleSchema.parse({...rule,start:{kind:'UTC',at:'2026-10-17T23:59:59Z'}}),value=schedule({rule:queuedRule,nextDueAt:null,lastOccurrence:{scheduledAt:'2026-10-17T23:59:59.000Z',taskId:null,deliveryState:'PENDING',verification:'UNVERIFIED'}}),f=flow(async(_path,request)=>request.method==='GET'?detail(value):{schedule:{...value,state:'PAUSED',revision:2,etag:'"paused-two"'},replayed:false});
 assert.equal((await f.read(id))?.ok,true);assert.equal(f.detail?.schedule.nextDueAt,null);assert.deepEqual(f.detail?.preview.occurrences,[]);assert.ok(reminderActions(f.detail!.schedule).includes('pause'));assert.equal((await f.change(id,'pause'))?.ok,true);assert.equal(f.receipt?.state,'PAUSED');
});
test('permission/session/conflict/unknown failures clear private bodies and never repeat a write automatically',async()=>{
 for(const status of [401,403,409,412,503]){let calls=0;const f=flow(async(_path,request)=>{calls++;if(request.method==='GET')return detail();throw new ScheduleFailure(status);});await f.read(id);const result=await f.change(id,'pause');assert.equal(result?.ok,false);assert.equal(result?.sessionLost,status===401?true:undefined);assert.equal(f.detail,null);assert.equal(f.receipt,null);assert.equal(await f.change(id,'pause'),null);assert.equal(calls,2);}
});
test('hidden/obsolete GET, preview and mutation responses cannot restore private bodies or overwrite a newer selection',async()=>{
 const old=deferred(),f=flow(async(path)=>path.endsWith(id)?old.promise:detail(schedule({id:id2}))),first=f.read(id);f.clear();await f.read(id2);old.resolve(detail());assert.equal(await first,null);assert.equal(f.detail?.schedule.id,id2);
 const pending=deferred(),p=flow(async()=>pending.promise),peeking=p.preview(rule);p.invalidateDraft();pending.resolve({rule,preview:preview(rule,{now:asOf}),asOf});assert.equal(await peeking,null);assert.equal(p.draftPreview,null);assert.equal(p.busy,false);
 const writing=deferred(),w=flow(async(_path,request)=>request.method==='GET'?detail(schedule({id:id2})):writing.promise),creating=w.create('带上报告',rule);w.clear();await w.read(id2);writing.resolve({schedule:schedule(),replayed:false});assert.equal(await creating,null);assert.equal(w.receipt,null);assert.equal(w.detail?.schedule.id,id2);
});
test('forged owner, stale revision/ETag, wrong preview and old server clock fail closed',async()=>{
 for(const data of [detail(schedule({ownerId:other})),{...detail(),preview:{...preview(rule,{now:asOf}),occurrences:[]}},{...detail(),asOf:'2026-10-17T00:00:00.000Z'}]){const f=flow(async()=>data);assert.equal((await f.read(id))?.ok,false);assert.equal(f.detail,null);}
 let n=0;const f=flow(async()=>detail(schedule(++n===1?{revision:2,etag:'"two"'}:{revision:1})));await f.read(id);f.clear();assert.equal((await f.read(id))?.ok,false);
 let e=0;const opaque=flow(async()=>detail(schedule({etag:++e===1?'"one"':'"changed-without-revision"'})));await opaque.read(id);assert.equal((await opaque.read(id))?.ok,false);
});
test('pagination remains explicit, replaces the page and rejects duplicated identities or cursor loops',async()=>{
 let n=0;const f=flow(async()=>++n===1?{...page(),nextCursor:id}:page([schedule({id:id2})]));await f.readList();assert.equal((await f.next())?.ok,true);assert.equal(f.page?.page,2);assert.deepEqual(f.page?.items.map(item=>item.id),[id2]);assert.equal(await f.next(),null);
 const duplicates=flow(async()=>page([schedule(),schedule()]));assert.equal((await duplicates.readList())?.ok,false);
 const loop=flow(async()=>({...page(),nextCursor:id}));await loop.readList();assert.equal((await loop.next())?.ok,false);
});
test('invalid/past local times and malformed state/revision/content receipts never produce optimistic saved status',async()=>{
 let calls=0;const noCalls=flow(async()=>{calls++;return null;});assert.equal((await noCalls.create('text',{...rule,start:{kind:'LOCAL',at:'2026-02-30T01:00:00'}}))?.ok,false);assert.equal((await noCalls.create('text',{...rule,start:{kind:'LOCAL',at:'2026-10-01T01:00:00'}}))?.ok,false);assert.equal(calls,0);
 for(const value of [schedule({revision:2}),schedule({ownerId:other}),schedule({text:'different'}),schedule({state:'COMPLETED'})]){const f=flow(async()=>({schedule:value,replayed:false}));assert.equal((await f.create('带上报告',rule))?.ok,false);assert.equal(f.receipt,null);}
});
test('persisted interval reminders remain readable and cancellable without weakening the form creation subset',async()=>{
 const interval={schemaVersion:1 as const,kind:'INTERVAL' as const,tz:'UTC',start:{kind:'UTC' as const,at:'2026-10-19T00:00:00.000Z'},everySeconds:300,dst:{overlap:'EARLIER' as const,gap:'SKIP' as const},misfire:{kind:'REMINDER_LATEST' as const,graceSeconds:3600 as const}},value={...schedule(),rule:interval};
 const f=flow(async(_path,request)=>request.method==='GET'?{schedule:value,preview:preview(interval,{now:asOf}),asOf}:{schedule:{...value,state:'CANCELLED',revision:2,etag:'"cancelled-interval"'},replayed:false});
 assert.equal((await f.read(id))?.ok,true);assert.equal(f.detail?.schedule.rule.kind,'INTERVAL');assert.equal((await f.change(id,'cancel'))?.ok,true);assert.equal(reminderRuleSchema.safeParse(interval).success,false);
});
test('an exhausted rule with a queued or unknown delivery still exposes a local cancel rather than hiding the stop control',()=>{
 for(const deliveryState of ['PENDING','UNKNOWN'] as const)assert.deepEqual(reminderActions(schedule({state:'COMPLETED',lastOccurrence:{scheduledAt:asOf,taskId:id2,deliveryState,verification:'UNVERIFIED'}})),['cancel']);
});
test('metadata-only cancel succeeds after payload damage, clears bodies and never rereads the damaged plan',async()=>{
 const pending=deferred(),calls:{path:string;request:Parameters<ScheduleTransport>[1]}[]=[];let damaged=false;
 const f=flow(async(path,request)=>{calls.push({path,request});if(request.method==='GET'){if(damaged)throw new ScheduleFailure(503);return detail();}return pending.promise;});
 await f.read(id);damaged=true;const cancelling=f.change(id,'cancel');assert.equal(f.detail,null);assert.equal(f.page,null);assert.equal(f.draftPreview,null);assert.equal(await f.change(id,'cancel'),null);
 pending.resolve({stopped:{id,ownerId:actor,revision:2,etag:'"metadata-stop-two"',state:'CANCELLED'},replayed:false});const result=await cancelling;
 assert.equal(result?.ok,true);assert.match(result!.notice,/已取消/);assert.match(result!.notice,/无需重新读取/);
 assert.deepEqual(f.receipt,{id,revision:2,etag:'"metadata-stop-two"',state:'CANCELLED',replayed:false});assert.equal(f.detail,null);assert.equal(f.page,null);
 assert.deepEqual(calls,[{path:'/schedules/'+id,request:{method:'GET'}},{path:'/schedules/'+id+'/cancel',request:{method:'POST',body:{},key,ifMatch:'"opaque-revision-one"'}}]);assert.equal(await f.change(id,'cancel'),null);assert.equal(calls.length,2);
});
test('cancel metadata rejects foreign owner/id, malformed state, stale revision/etag and injected body fields',async()=>{
 const stopped={id,ownerId:actor,revision:2,etag:'"stop-two"',state:'CANCELLED'};
 for(const change of [{ownerId:other},{id:id2},{state:'ACTIVE'},{revision:1},{revision:0},{etag:'"opaque-revision-one"'},{etag:'bad\nheader'},{text:'untrusted old body'}]){
  let calls=0;const f=flow(async(_path,request)=>{calls++;return request.method==='GET'?detail():{stopped:{...stopped,...change},replayed:false};});await f.read(id);assert.equal((await f.change(id,'cancel'))?.ok,false);assert.equal(f.receipt,null);assert.equal(f.detail,null);assert.equal(f.page,null);assert.equal(calls,2);
 }
 const replay=flow(async(_path,request)=>request.method==='GET'?detail():{stopped,replayed:true});await replay.read(id);assert.equal((await replay.change(id,'cancel'))?.ok,true);assert.equal(replay.receipt?.replayed,true);
});
test('unknown cancel results never trigger a second write or a confirmation read of damaged payload',async()=>{
 for(const error of [new Error('RESPONSE_LOST'),new ScheduleFailure(503),new ScheduleFailure(409)]){
  let calls=0;const f=flow(async(_path,request)=>{calls++;if(request.method==='GET')return detail();throw error;});await f.read(id);const result=await f.change(id,'cancel');assert.equal(result?.ok,false);assert.match(result!.notice,/不会自动重发/);assert.equal(f.receipt,null);assert.equal(f.detail,null);assert.equal(f.page,null);assert.equal(await f.change(id,'cancel'),null);assert.equal(calls,2);
 }
});
test('obsolete metadata cancellation cannot overwrite a newer selection after privacy clearing',async()=>{
 const pending=deferred(),f=flow(async(path,request)=>request.method==='GET'?detail(schedule(path.endsWith(id2)?{id:id2}:{})):pending.promise);await f.read(id);const cancelling=f.change(id,'cancel');f.clear();await f.read(id2);pending.resolve({stopped:{id,ownerId:actor,revision:2,etag:'"stop-two"',state:'CANCELLED'},replayed:false});assert.equal(await cancelling,null);assert.equal(f.receipt,null);assert.equal(f.detail?.schedule.id,id2);
});
