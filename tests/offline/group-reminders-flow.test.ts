import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GroupRemindersFlow,GroupRemindersFailure,reminderScheduleActions,reminderDraft,reminderDraftRule,draftFromReminder} from '../../apps/web/src/group-reminders-flow.js';
import {groupReminderRule,type GroupReminderSchedule} from '../../packages/groups/src/reminder-model.js';
import {preview} from '../../packages/schedules/src/rules.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,actor=id(1),now='2026-10-19T00:00:00.000Z';
const rule=groupReminderRule.parse({schemaVersion:1,kind:'ONCE',tz:'UTC',start:{kind:'UTC',at:'2026-10-20T00:00:00Z'},misfire:{kind:'REMINDER_LATEST'}});
const workHours={timezone:'Asia/Shanghai',windows:[{daysOfWeek:[1,2,3,4,5],start:'22:00',end:'02:00'}]},limits={remindersPerCasePerDay:1,summariesPerGroupPerHour:3};
const authorization={id:id(3),contractVersion:2,expiresAt:'2026-12-01T00:00:00Z',workHours,limits};
const schedule=(change:Partial<GroupReminderSchedule>={}):GroupReminderSchedule=>({id:id(4),groupId:'group/a',contractId:id(5),contractVersion:2,authorizationId:id(3),authorizationExpiresAt:authorization.expiresAt,revision:1,generation:1,state:'ACTIVE',rule,workHours,limits,nextDueAt:null,lastError:null,createdAt:now,updatedAt:now,lastOccurrence:null,...change});
const page=(items=[schedule()])=>({items,authorizations:[authorization],asOf:now,nextCursor:null as string|null,coverage:{mode:'MENTION_ONLY',completeChat:false,notice:'只含明确登记事项，不覆盖全部群聊'}});
const shown=(value=rule)=>({rule:value,preview:preview(value,{now}),asOf:now});
const deferred=()=>{let resolve!:(v:unknown)=>void;return {promise:new Promise<unknown>(r=>{resolve=r;}),resolve:(v:unknown)=>resolve(v)};};
const current=(flow:GroupRemindersFlow)=>({page:flow.page,receipt:flow.receipt});

test('real transport binds exact group, roster-free authority and non-complete coverage',async()=>{
 const paths:string[]=[],flow=new GroupRemindersFlow(async path=>{paths.push(path);return page();},actor,()=>id(9));
 assert.equal((await flow.read('group/a'))?.ok,true);assert.equal(paths[0],'/groups/group%2Fa/reminder-schedules?limit=20');
 assert.equal(flow.page?.coverage.completeChat,false);assert.deepEqual(flow.page?.authorizations[0]?.workHours,workHours);
});
test('create requires an existing unexpired authorization, matching real preview and distinct preparation',async()=>{
 const calls:{path:string;request:unknown}[]=[],flow=new GroupRemindersFlow(async(path,request)=>{calls.push({path,request});return path.endsWith('/preview')?shown():request.method==='GET'?page():{schedule:schedule(),replayed:false};},actor,()=>id(9));
 await flow.read('group/a');assert.equal(await flow.create(),null);assert.equal(flow.prepareCreate(id(999)),false);assert.equal(flow.prepareCreate(authorization.id),false);
 await flow.preview(rule);assert.equal(flow.prepareCreate(id(999)),false);assert.equal(flow.prepareCreate(authorization.id),true);
 assert.equal((await flow.create())?.ok,true);assert.equal(flow.page,null);assert.equal(flow.draftPreview,null);
 assert.deepEqual(calls[2],{path:'/groups/group%2Fa/reminder-schedules',request:{method:'POST',key:id(9),body:{authorizationId:id(3),contractVersion:2,rule,confirmGroupNotifications:true}}});
 assert.deepEqual(flow.receipt,{id:id(4),revision:1,state:'ACTIVE',replayed:false});
 const expired=new GroupRemindersFlow(async path=>path.endsWith('/preview')?shown():{...page(),authorizations:[{...authorization,expiresAt:now}]},actor);
 await expired.read('group/a');await expired.preview(rule);assert.equal(expired.prepareCreate(authorization.id),false);
 const none=new GroupRemindersFlow(async()=>({...page(),authorizations:[]}),actor);await none.read('group/a');assert.equal(none.prepareCreate(id(3)),false);
});
test('draft changes invalidate both server preview and explicit confirmation without granting permissions',async()=>{
 const flow=new GroupRemindersFlow(async path=>path.endsWith('/preview')?shown():page(),actor);await flow.read('group/a');await flow.preview(rule);assert.equal(flow.prepareCreate(id(3)),true);flow.invalidateDraft();assert.equal(flow.draftPreview,null);assert.equal(flow.prepared,null);assert.equal(await flow.create(),null);
});
test('actual server preview must match rule, full five-time projection and asOf',async()=>{
 const base=shown();for(const response of [{...base,preview:{...base.preview,notice:'fake'}},{...base,rule:{...rule,tz:'Asia/Shanghai'}},{...base,asOf:'2026-10-18T00:00:00Z'},{...base,approved:true}]){
  const flow=new GroupRemindersFlow(async path=>path.endsWith('/preview')?response:page(),actor);await flow.read('group/a');assert.equal((await flow.preview(rule))?.ok,false);assert.equal(flow.page,null);assert.equal(flow.draftPreview,null);
 }
});
test('unknown/denied/conflicting mutations clear all data and never auto-retry',async()=>{
 for(const status of [401,403,409,503,0]){let count=0;const flow=new GroupRemindersFlow(async(_path,r)=>{count++;if(r.method==='GET')return page();throw new GroupRemindersFailure(status);},actor,()=>id(9));await flow.read('group/a');assert.equal((await flow.transition(id(4),'pause'))?.ok,false);assert.equal(flow.page,null);assert.equal(flow.receipt,null);assert.equal(await flow.transition(id(4),'pause'),null);assert.equal(count,2);}
});
test('double clicking sends only once with stable key and exact expectedRevision',async()=>{
 const delayed=deferred(),requests:unknown[]=[],flow=new GroupRemindersFlow(async(_path,r)=>{requests.push(r);return r.method==='GET'?page():delayed.promise;},actor,()=>id(9));await flow.read('group/a');const pending=flow.transition(id(4),'pause');assert.equal(await flow.transition(id(4),'pause'),null);assert.equal(flow.busy,true);assert.equal(flow.page,null);
 assert.deepEqual(requests[1],{method:'POST',key:id(9),body:{expectedRevision:1}});delayed.resolve({schedule:schedule({revision:2,state:'PAUSED'}),replayed:false});assert.equal((await pending)?.ok,true);assert.equal(flow.receipt?.revision,2);assert.equal(requests.length,2);
});
test('state controls preserve ACTIVE nextDueAt null, metadata blocked cancellation and no blocked resume',()=>{
 assert.deepEqual(reminderScheduleActions(schedule()),['edit','pause','cancel']);assert.deepEqual(reminderScheduleActions(schedule({state:'PAUSED'})),['edit','resume','cancel']);assert.deepEqual(reminderScheduleActions(schedule({state:'BLOCKED'})),['cancel']);assert.deepEqual(reminderScheduleActions(schedule({state:'COMPLETED',lastOccurrence:null})),['cancel']);assert.deepEqual(reminderScheduleActions(schedule({state:'CANCELLED'})),[]);
});
test('edit requires matching preview and posts complete rule bound to current revision',async()=>{
 const edited=groupReminderRule.parse({...rule,count:1}),requests:unknown[]=[],flow=new GroupRemindersFlow(async(path,r)=>{requests.push({path,...r});return r.method==='GET'?page():path.endsWith('/preview')?shown(edited):{schedule:schedule({rule:edited,revision:2}),replayed:false};},actor,()=>id(9));
 await flow.read('group/a');assert.equal(await flow.edit(id(4),edited),null);await flow.preview(edited);assert.equal(await flow.edit(id(4),rule),null);assert.equal((await flow.edit(id(4),edited))?.ok,true);
 assert.deepEqual(requests[2],{path:'/groups/group%2Fa/reminder-schedules/'+id(4),method:'PATCH',key:id(9),body:{expectedRevision:1,rule:edited}});
});
test('malformed/cross-group/wrong-ID/stale receipts are rejected as unknown',async()=>{
 for(const change of [{groupId:'other'},{id:id(99)},{authorizationId:id(99)},{revision:1},{state:'ACTIVE' as const}]){const flow=new GroupRemindersFlow(async(_path,r)=>r.method==='GET'?page():{schedule:schedule({revision:2,state:'PAUSED',...change}),replayed:false},actor,()=>id(9));await flow.read('group/a');assert.equal((await flow.transition(id(4),'pause'))?.ok,false);assert.equal(flow.receipt,null);}
});
test('late read, preview and mutation cannot restore a changed group or hidden view',async()=>{
 for(const kind of ['read','preview','write']){const late=deferred();let calls=0;const flow=new GroupRemindersFlow(async()=>{calls++;if(calls===2)return late.promise;return {...page(),items:[schedule({groupId:calls===1?'group/a':'new'})]};},actor,()=>id(9));await flow.read('group/a');const first=kind==='read'?flow.read('group/a'):kind==='preview'?flow.preview(rule):flow.transition(id(4),'pause');flow.clear();assert.equal((await flow.read('new'))?.ok,true);late.resolve(kind==='read'?page():kind==='preview'?shown():{schedule:schedule({revision:2,state:'PAUSED'}),replayed:false});assert.equal(await first,null);assert.equal(current(flow).page?.groupId,'new');assert.equal(flow.draftPreview,null);assert.equal(flow.receipt,null);}
});
test('pagination stays in the same group, marks partial pages and rejects looping or duplicate data',async()=>{
 let calls=0;const paths:string[]=[],flow=new GroupRemindersFlow(async path=>{paths.push(path);return {...page([schedule({id:++calls===1?id(4):id(6)})]),nextCursor:calls===1?id(4):null};},actor);await flow.read('group/a');assert.equal((await flow.next())?.ok,true);assert.equal(flow.page?.page,2);assert.ok(paths[1]?.endsWith('&cursor='+id(4)));
 for(const value of [{...page(),items:[schedule(),schedule()]},{...page(),authorizations:[authorization,authorization]},{...page(),items:[schedule({groupId:'other'})]},{...page(),nextCursor:id(99)},{...page(),coverage:{...page().coverage,completeChat:true}}]){const bad=new GroupRemindersFlow(async()=>value,actor);assert.equal((await bad.read('group/a'))?.ok,false);assert.equal(bad.page,null);}
});
test('structured editor round-trips supported once, RRULE combinations and absolute intervals without silent simplification',()=>{
 const inputs=[rule,groupReminderRule.parse({...rule,kind:'RRULE',rrule:{frequency:'WEEKLY',interval:2,byWeekday:['MO','FR']},count:7,until:'2026-12-01T00:00:00Z'}),groupReminderRule.parse({...rule,kind:'INTERVAL',everySeconds:3600})];
 for(const input of inputs)assert.deepEqual(reminderDraftRule(draftFromReminder(input)),input);
 const draft={...reminderDraft('America/Los_Angeles'),start:'2026-11-01T01:30',kind:'DAILY' as const,days:['MO','TU','WE','TH','FR']};assert.deepEqual(reminderDraftRule(draft).dst,{overlap:'EARLIER',gap:'SKIP'});
 assert.throws(()=>reminderDraftRule({...draft,tz:'Moon/Base'}));assert.throws(()=>reminderDraftRule({...draft,start:'2026-02-30T09:00'}));
});
test('UNKNOWN and APPLIED_UNVERIFIED remain unverified observation states without retry commands',async()=>{
 for(const deliveryState of ['UNKNOWN','APPLIED_UNVERIFIED'] as const){const item=schedule({lastOccurrence:{id:id(8),scheduledAt:now,deliveryState,verification:'UNVERIFIED',itemCount:2}}),flow=new GroupRemindersFlow(async()=>page([item]),actor);await flow.read('group/a');assert.equal(flow.page?.items[0]?.lastOccurrence?.verification,'UNVERIFIED');assert.equal('retry' in flow,false);assert.equal(flow.receipt,null);}
});
test('invalidated in-flight preview cannot revive prepared create, and no-future preview cannot prepare',async()=>{
 const late=deferred(),flow=new GroupRemindersFlow(async path=>path.endsWith('/preview')?late.promise:page(),actor,()=>id(9));await flow.read('group/a');const pending=flow.preview(rule);flow.invalidateDraft();late.resolve(shown());assert.equal(await pending,null);assert.equal(flow.draftPreview,null);assert.equal(flow.prepareCreate(id(3)),false);
 const past=groupReminderRule.parse({...rule,start:{kind:'UTC',at:'2026-10-18T00:00:00Z'}}),empty=new GroupRemindersFlow(async path=>path.endsWith('/preview')?shown(past):page(),actor,()=>id(9));await empty.read('group/a');await empty.preview(past);assert.equal(empty.draftPreview?.preview.occurrences.length,0);assert.equal(empty.prepareCreate(id(3)),false);
});
test('blocked plan may only cancel and stale replay revision cannot fabricate a successful transition',async()=>{
 let requests=0;const flow=new GroupRemindersFlow(async(_p,r)=>{requests++;return r.method==='GET'?page([schedule({state:'BLOCKED'})]):{schedule:schedule({state:'CANCELLED',revision:2}),replayed:false};},actor,()=>id(9));await flow.read('group/a');assert.equal(await flow.transition(id(4),'resume'),null);assert.equal(requests,1);assert.equal((await flow.transition(id(4),'cancel'))?.ok,true);
 const stale=new GroupRemindersFlow(async(_p,r)=>r.method==='GET'?page():{schedule:schedule({state:'PAUSED',revision:1}),replayed:true},actor,()=>id(9));await stale.read('group/a');assert.equal((await stale.transition(id(4),'pause'))?.ok,false);assert.equal(stale.receipt,null);
 const completed=new GroupRemindersFlow(async(_p,r)=>r.method==='GET'?page([schedule({state:'COMPLETED',lastOccurrence:null})]):{schedule:schedule({state:'CANCELLED',revision:2}),replayed:false},actor,()=>id(9));await completed.read('group/a');assert.equal(await completed.transition(id(4),'resume'),null);assert.equal((await completed.transition(id(4),'cancel'))?.ok,true);
});
test('create rejects an authorization receipt that silently raises approved limits or changes work hours',async()=>{
 for(const change of [{limits:{remindersPerCasePerDay:2,summariesPerGroupPerHour:6}},{workHours:{...workHours,timezone:'UTC'}},{contractVersion:3}]){
  const flow=new GroupRemindersFlow(async(path,r)=>path.endsWith('/preview')?shown():r.method==='GET'?page():{schedule:schedule(change),replayed:false},actor,()=>id(9));await flow.read('group/a');await flow.preview(rule);flow.prepareCreate(id(3));assert.equal((await flow.create())?.ok,false);assert.equal(flow.receipt,null);
 }
});
test('permission failures on read or preview clear retained data and paging never loops',async()=>{
 for(const kind of ['read','preview']){const flow=new GroupRemindersFlow(async()=>page(),actor,()=>id(9));await flow.read('group/a');const denied=new GroupRemindersFlow(async path=>path.endsWith('/preview')?Promise.reject(new GroupRemindersFailure(403)):page(),actor,()=>id(9));await denied.read('group/a');if(kind==='preview'){assert.equal((await denied.preview(rule))?.ok,false);assert.equal(denied.page,null);}else{const bad=new GroupRemindersFlow(async()=>{throw new GroupRemindersFailure(401);},actor);assert.equal((await bad.read('group/a'))?.ok,false);assert.equal(bad.page,null);}}
 const looping=new GroupRemindersFlow(async()=>({...page(),nextCursor:id(4)}),actor);await looping.read('group/a');assert.equal((await looping.next())?.ok,false);assert.equal(looping.page,null);
});
