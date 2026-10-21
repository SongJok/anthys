import {z} from 'zod';
import {groupReminderPage,groupReminderReceipt,groupReminderCreate,groupReminderEdit,groupReminderTransition,groupReminderRule,
 groupReminderSchedule,type GroupReminderPage,type GroupReminderSchedule,type GroupReminderRule} from '../../../packages/groups/src/reminder-model.js';
import {preview,type SchedulePreview} from '../../../packages/schedules/src/rules.js';

export type GroupRemindersTransport=(path:string,request:{method:'GET'|'POST'|'PATCH';body?:unknown;key?:string})=>Promise<unknown>;
export class GroupRemindersFailure extends Error{constructor(readonly status:number){super('GROUP_REMINDERS_REQUEST_FAILED');}}
export type GroupRemindersOutcome={ok:boolean;notice:string};
export interface GroupReminderDraft {tz:string;startKind:'LOCAL'|'UTC';start:string;kind:'ONCE'|'DAILY'|'WEEKLY'|'INTERVAL';interval:string;days:string[];seconds:string;until:string;count:string}
export function reminderDraft(tz:string):GroupReminderDraft{return {tz,startKind:'LOCAL',start:'',kind:'ONCE',interval:'1',days:[],seconds:'3600',until:'',count:''};}
export function reminderDraftRule(d:GroupReminderDraft):GroupReminderRule{
 const seconds=(s:string)=>s.length===16?s+':00':s;
 return groupReminderRule.parse({schemaVersion:1,tz:d.tz,start:{kind:d.startKind,at:seconds(d.start)+(d.startKind==='UTC'?'Z':'')},
  kind:d.kind==='ONCE'?'ONCE':d.kind==='INTERVAL'?'INTERVAL':'RRULE',misfire:{kind:'REMINDER_LATEST'},
  ...(d.kind==='INTERVAL'?{everySeconds:Number(d.seconds)}:d.kind==='ONCE'?{}:{rrule:{frequency:d.kind,interval:Number(d.interval),...(d.days.length?{byWeekday:d.days}:{})}}),
  ...(d.until?{until:seconds(d.until)+'Z'}:{}),...(d.count?{count:Number(d.count)}:{})});
}
export function draftFromReminder(rule:GroupReminderRule):GroupReminderDraft{return {tz:rule.tz,startKind:rule.start.kind,start:rule.start.at.slice(0,19),kind:rule.kind==='RRULE'?rule.rrule.frequency:rule.kind,interval:rule.kind==='RRULE'?String(rule.rrule.interval):'1',days:rule.kind==='RRULE'?[...rule.rrule.byWeekday??[]]:[],seconds:rule.kind==='INTERVAL'?String(rule.everySeconds):'3600',until:rule.until?.slice(0,19)??'',count:rule.count===undefined?'':String(rule.count)};}
const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
export const reminderScheduleActions=(s:GroupReminderSchedule):('edit'|'pause'|'resume'|'cancel')[]=>s.state==='ACTIVE'?['edit','pause','cancel']:s.state==='PAUSED'?['edit','resume','cancel']:s.state==='BLOCKED'||s.state==='COMPLETED'?['cancel']:[];
const failure=(e:unknown,write=false):GroupRemindersOutcome=>{const status=e instanceof GroupRemindersFailure?e.status:0;return {ok:false,notice:status===401?'会话已失效，群催办资料已清除，请重新登录。':status===403?'当前群授权不足或已撤销，旧资料已清除。':status===409?'合同或计划版本冲突，旧资料已清除；请重新读取，不会自动重发。':status===503&&!write?'当前服务或授权资料无法核实，旧资料已清除；不会自动重发。':write?'提交结果未知，可能已保存；请重新读取核对，不能自动重发。':'资料无法核实，旧资料已清除，请重新读取。'};};
type Page=GroupReminderPage&{groupId:string;page:number};
export class GroupRemindersFlow {
 page:Page|null=null;
 draftPreview:{rule:GroupReminderRule;preview:SchedulePreview;asOf:string}|null=null;
 receipt:{id:string;revision:number;state:GroupReminderSchedule['state'];replayed:boolean}|null=null;
 prepared:{authorizationId:string;contractVersion:number;rule:GroupReminderRule}|null=null;
 private generation=0;private pending=false;private previewPending=false;
 private revisions=new Map<string,number>();private cursors=new Set<string>();
 constructor(private transport:GroupRemindersTransport,readonly actorId:string,private key:()=>string=()=>crypto.randomUUID()){}
 get busy(){return this.pending;}
 clear(){this.generation++;this.pending=false;this.previewPending=false;this.page=null;this.draftPreview=null;this.receipt=null;this.prepared=null;this.cursors.clear();}
 invalidateDraft(){this.draftPreview=null;this.prepared=null;this.receipt=null;if(this.previewPending){this.generation++;this.pending=false;this.previewPending=false;}}
 private path(group:string){return '/groups/'+encodeURIComponent(group)+'/reminder-schedules';}
 async read(group:string){return this.load(group,undefined,1);}
 async next(){const p=this.page;if(!p?.nextCursor||this.pending)return null;return this.load(p.groupId,p.nextCursor,p.page+1);}
 private async load(group:string,cursor:string|undefined,number:number):Promise<GroupRemindersOutcome|null>{
  if(this.pending)return null;this.page=null;this.draftPreview=null;this.receipt=null;this.prepared=null;this.pending=true;const generation=++this.generation;
  try{
   if(!group||group.trim()!==group||group.length>512||/[\u0000-\u001f]/.test(group))throw Error('GROUP_INVALID');
   if(number===1)this.cursors.clear();if(cursor&&this.cursors.has(cursor))throw Error('CURSOR_REPEATED');
   const value=groupReminderPage.parse(await this.transport(this.path(group)+'?'+new URLSearchParams({limit:'20',...(cursor?{cursor}:{})}),{method:'GET'}));if(generation!==this.generation)return null;
   if(new Set(value.items.map(i=>i.id)).size!==value.items.length||new Set(value.authorizations.map(a=>a.id)).size!==value.authorizations.length||value.items.some(i=>i.groupId!==group||i.revision<(this.revisions.get(group+':'+i.id)??0))||value.nextCursor&&(value.nextCursor===cursor||value.nextCursor!==value.items.at(-1)?.id))throw Error('PAGE_INVALID');
   for(const item of value.items)this.revisions.set(group+':'+item.id,item.revision);if(cursor)this.cursors.add(cursor);
   this.page={...value,groupId:group,page:number};return {ok:true,notice:'已读取当前群的计划与审核授权；列表不授予新权限。'};
  }catch(e){if(generation!==this.generation)return null;this.clear();return failure(e);}finally{if(generation===this.generation)this.pending=false;}
 }
 async preview(rule:unknown):Promise<GroupRemindersOutcome|null>{
  const p=this.page;if(!p||this.pending)return null;this.invalidateDraft();this.pending=true;this.previewPending=true;const generation=++this.generation;
  try{
   const input=groupReminderRule.parse(rule),raw=await this.transport(this.path(p.groupId)+'/preview',{method:'POST',body:{rule:input},key:z.uuid().parse(this.key())});if(generation!==this.generation)return null;
   const response=z.object({rule:groupReminderRule,preview:z.unknown(),asOf:z.iso.datetime({offset:true})}).strict().parse(raw);
   const computed=preview(response.rule,{now:response.asOf});
   if(canonical(input)!==canonical(response.rule)||canonical(response.preview)!==canonical(computed)||Date.parse(response.asOf)<Date.parse(p.asOf))throw Error('PREVIEW_INVALID');
   this.draftPreview={rule:response.rule,preview:computed,asOf:response.asOf};return {ok:true,notice:'服务端时间预览已核对；尚未启用，也不代表发送权限。'};
  }catch(e){if(generation!==this.generation)return null;this.clear();return failure(e);}finally{if(generation===this.generation){this.pending=false;this.previewPending=false;}}
 }
 prepareCreate(authorizationId:string){
  const p=this.page,shown=this.draftPreview,a=p?.authorizations.find(a=>a.id===authorizationId);
  if(this.pending||!p||!a||!shown?.preview.occurrences.length||Date.parse(a.expiresAt)<=Date.parse(shown.asOf)||Date.parse(a.expiresAt)<=Date.parse(p.asOf))return false;
  this.prepared={authorizationId:a.id,contractVersion:a.contractVersion,rule:shown.rule};return true;
 }
 async create():Promise<GroupRemindersOutcome|null>{
  const p=this.page,prepared=this.prepared;if(this.pending||!p||!prepared||!this.draftPreview||canonical(prepared.rule)!==canonical(this.draftPreview.rule)||!p.authorizations.some(a=>a.id===prepared.authorizationId&&a.contractVersion===prepared.contractVersion))return null;
  const body=groupReminderCreate.parse({...prepared,confirmGroupNotifications:true});
  return this.write(p,{method:'POST',body,expected:0,authorizationId:body.authorizationId,rule:body.rule,operation:'create'});
 }
 async edit(id:string,rule:unknown):Promise<GroupRemindersOutcome|null>{
  const p=this.page,item=p?.items.find(i=>i.id===id);if(this.pending||!p||!item||!reminderScheduleActions(item).includes('edit')||!this.draftPreview)return null;
  try{const body=groupReminderEdit.parse({expectedRevision:item.revision,rule});if(canonical(body.rule)!==canonical(this.draftPreview.rule)||!this.draftPreview.preview.occurrences.length)return null;return this.write(p,{method:'PATCH',id,body,expected:item.revision,authorizationId:item.authorizationId,rule:body.rule,operation:'edit'});}catch{return {ok:false,notice:'规则无效，未提交。'};}
 }
 async transition(id:string,operation:'pause'|'resume'|'cancel'):Promise<GroupRemindersOutcome|null>{
  const p=this.page,item=p?.items.find(i=>i.id===id);if(this.pending||!p||!item||!reminderScheduleActions(item).includes(operation))return null;
  return this.write(p,{method:'POST',id,suffix:operation,body:groupReminderTransition.parse({expectedRevision:item.revision}),expected:item.revision,authorizationId:item.authorizationId,operation});
 }
 private async write(p:Page,input:{method:'POST'|'PATCH';id?:string;suffix?:string;body:unknown;expected:number;authorizationId:string;rule?:GroupReminderRule;operation:string}):Promise<GroupRemindersOutcome|null>{
  this.page=null;this.draftPreview=null;this.prepared=null;this.receipt=null;this.pending=true;const generation=++this.generation;
  try{
   const key=z.uuid().parse(this.key()),r=groupReminderReceipt.parse(await this.transport(this.path(p.groupId)+(input.id?'/'+encodeURIComponent(input.id):'')+(input.suffix?'/'+input.suffix:''),{method:input.method,body:input.body,key}));if(generation!==this.generation)return null;
   const s='schedule' in r?r.schedule:r.control,expectedState=input.operation==='pause'?'PAUSED':input.operation==='cancel'?'CANCELLED':input.operation==='resume'||input.operation==='create'?'ACTIVE':p.items.find(i=>i.id===input.id)?.state;
   if('control' in r&&!['pause','cancel'].includes(input.operation))throw Error('CONTROL_RECEIPT_UNEXPECTED');
   if(s.groupId!==p.groupId||input.id&&s.id!==input.id||s.authorizationId!==input.authorizationId||s.revision<=input.expected||s.revision<(this.revisions.get(p.groupId+':'+s.id)??0)||!r.replayed&&s.revision!==input.expected+1||expectedState&&s.state!==expectedState||input.rule&&(!('rule' in s)||canonical(input.rule)!==canonical(s.rule)))throw Error('RECEIPT_INVALID');
   if(input.operation==='create'&&(!('contractVersion' in s)||s.contractVersion!==(input.body as {contractVersion:number}).contractVersion))throw Error('CONTRACT_MISMATCH');
   if(input.operation==='create'){const full=groupReminderSchedule.parse(s),a=p.authorizations.find(a=>a.id===input.authorizationId)!;if(canonical(full.workHours)!==canonical(a.workHours)||canonical(full.limits)!==canonical(a.limits)||Date.parse(full.authorizationExpiresAt)!==Date.parse(a.expiresAt))throw Error('AUTHORIZATION_MISMATCH');}
   this.revisions.set(p.groupId+':'+s.id,s.revision);this.receipt={id:s.id,revision:s.revision,state:s.state,replayed:r.replayed};return {ok:true,notice:'已收到计划状态回执；不表示消息送达或事项完成。暂停／取消只阻止后续，不能撤回在途或未知发送。请重新读取。'};
  }catch(e){if(generation!==this.generation)return null;this.clear();return failure(e,true);}finally{if(generation===this.generation)this.pending=false;}
 }
}
