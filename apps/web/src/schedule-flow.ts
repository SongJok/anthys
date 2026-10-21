import {z} from 'zod';
import {scheduleRuleSchema,preview as rulePreview,type ScheduleRule} from '../../../packages/schedules/src/rules.js';

const uuid=z.uuid(),positive=z.number().int().positive().safe(),instant=z.iso.datetime().refine(v=>Number.isFinite(Date.parse(v)));
const etag=z.string().min(1).max(512).refine(v=>!/[\r\n]/.test(v));
export const reminderRuleSchema=scheduleRuleSchema.refine(v=>(v.kind==='ONCE'||v.kind==='RRULE')&&v.misfire.kind==='REMINDER_LATEST'&&!v.businessCalendar,'PRIVATE_REMINDER_RULE_UNSUPPORTED');
const message=z.string().trim().min(1).max(2000);
const storedReminderRuleSchema=scheduleRuleSchema.refine(v=>v.misfire.kind==='REMINDER_LATEST'&&!v.businessCalendar,'PRIVATE_REMINDER_RULE_UNSUPPORTED');
const occurrenceSchema=z.object({scheduledAt:instant,taskId:uuid.nullable(),deliveryState:z.enum(['PENDING','APPLIED_UNVERIFIED','UNKNOWN','SUPPRESSED','MISSED']),verification:z.literal('UNVERIFIED')}).strict();
export const reminderScheduleSchema=z.object({id:uuid,ownerId:uuid,revision:positive,etag,state:z.enum(['ACTIVE','PAUSED','CANCELLED','COMPLETED','BLOCKED']),text:message,rule:storedReminderRuleSchema,nextDueAt:instant.nullable(),createdAt:instant,updatedAt:instant,lastOccurrence:occurrenceSchema.nullable()}).strict();
export type ReminderSchedule=z.infer<typeof reminderScheduleSchema>;
const stoppedScheduleSchema=z.object({id:uuid,ownerId:uuid,revision:positive,etag,state:z.literal('CANCELLED')}).strict();
const savedResponseSchema=z.object({schedule:reminderScheduleSchema,replayed:z.boolean()}).strict();
const cancelResponseSchema=z.union([z.object({stopped:stoppedScheduleSchema,replayed:z.boolean()}).strict(),savedResponseSchema]);
export type ReminderPreview=ReturnType<typeof rulePreview>;
const previewSchema=z.object({start:z.object({utc:instant.nullable(),local:z.string().min(19).max(19)}).strict(),occurrences:z.array(z.object({utc:instant,local:z.string().length(19),tz:z.string().min(1).max(128)}).strict()).max(5),skipped:z.array(z.object({local:z.string().length(19),reason:z.literal('DST_GAP')}).strict()).max(100000),complete:z.literal(true),exhausted:z.boolean(),notice:z.string().min(1).max(2000)}).strict();
export type ScheduleTransport=(path:string,request:{method:'GET'|'POST'|'PATCH';body?:unknown;key?:string;ifMatch?:string})=>Promise<unknown>;
export type ScheduleOutcome={ok:boolean;notice:string;sessionLost?:boolean};
export class ScheduleFailure extends Error{constructor(readonly status:number){super('SCHEDULE_REQUEST_FAILED');}}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const failure=(error:unknown,writing=false):ScheduleOutcome=>{
 const status=error instanceof ScheduleFailure?error.status:0;
 return {ok:false,notice:status===401?'会话已失效，提醒正文已清除，请重新登录。':status===403?'当前身份或提醒授权不足，旧正文已清除。':status===404?'未找到当前可访问的提醒，旧正文已清除。':status===409||status===412?'提醒版本已变化或请求冲突；请重新读取核对，不会自动重发。':status===400?'提醒内容、时间或规则未通过检查，请修改后再提交。':writing?'保存结果无法核实，可能已经保存；请重新读取核对。不会自动重发，也没有确认投递成功。':'提醒资料无法核实，旧正文已清除，请重新读取。',...(status===401?{sessionLost:true}:{})};
};
export function reminderActions(schedule:ReminderSchedule):('pause'|'resume'|'cancel'|'edit')[]{
 return schedule.state==='ACTIVE'?['edit','pause','cancel']:schedule.state==='PAUSED'?['edit','resume','cancel']:schedule.state==='BLOCKED'||schedule.state==='COMPLETED'&&schedule.lastOccurrence&&['PENDING','UNKNOWN'].includes(schedule.lastOccurrence.deliveryState)?['cancel']:[];
}
export class ScheduleFlow {
 page:{items:ReminderSchedule[];nextCursor:string|null;asOf:string;page:number}|null=null;
 detail:{schedule:ReminderSchedule;preview:ReminderPreview;asOf:string}|null=null;
 draftPreview:{rule:ScheduleRule;preview:ReminderPreview;asOf:string}|null=null;
 receipt:{id:string;revision:number;etag:string;state:ReminderSchedule['state'];replayed:boolean}|null=null;
 private pending=false;
 private pendingPreview=false;
 private generation=0;
 private versions=new Map<string,{revision:number;etag:string}>();
 private cursors=new Set<string>();
 constructor(private transport:ScheduleTransport,readonly actorId:string,private key:()=>string=()=>crypto.randomUUID(),private clock:()=>number=Date.now){}
 get busy(){return this.pending;}
 clear(){this.generation++;this.pending=false;this.pendingPreview=false;this.erase();this.cursors.clear();}
 invalidateDraft(){this.draftPreview=null;if(this.pendingPreview){this.generation++;this.pending=false;this.pendingPreview=false;}}
 private erase(){this.page=null;this.detail=null;this.draftPreview=null;this.receipt=null;}
 private currentVersion(s:Pick<ReminderSchedule,'id'|'ownerId'|'revision'|'etag'>){const prior=this.versions.get(s.id);if(s.ownerId!==this.actorId||prior&&(s.revision<prior.revision||s.revision===prior.revision&&s.etag!==prior.etag))throw Error('STALE_OR_FOREIGN_SCHEDULE');}
 private current(value:unknown){const s=reminderScheduleSchema.parse(value);this.currentVersion(s);return s;}
 private remember(s:Pick<ReminderSchedule,'id'|'revision'|'etag'>){this.versions.set(s.id,{revision:s.revision,etag:s.etag});}
 private asOf(value:string){const stamp=Date.parse(value);if(stamp>this.clock()+5000||stamp<this.clock()-60000)throw Error('STALE_SCHEDULE_READ');}
 private checkedPreview(rule:ScheduleRule,raw:unknown,asOf:string){this.asOf(asOf);const value=previewSchema.parse(raw),expected=rulePreview(rule,{now:asOf});if(!same({...value,notice:expected.notice},expected))throw Error('PREVIEW_MISMATCH');return value;}
 localPreview(rule:unknown){return rulePreview(reminderRuleSchema.parse(rule),{now:new Date(this.clock()).toISOString()});}
 async readList():Promise<ScheduleOutcome|null>{return this.loadList(undefined,1);}
 async next():Promise<ScheduleOutcome|null>{const page=this.page;if(this.pending||!page?.nextCursor)return null;return this.loadList(page.nextCursor,page.page+1);}
 private async loadList(cursor:string|undefined,page:number):Promise<ScheduleOutcome|null>{
  if(this.pending)return null;this.erase();this.pending=true;const generation=++this.generation;
  try{
   if(page===1)this.cursors.clear();if(cursor&&(this.cursors.has(cursor)||!uuid.safeParse(cursor).success))throw Error('INVALID_CURSOR');
   const raw=await this.transport('/schedules?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{method:'GET'});if(generation!==this.generation)return null;
   const data=z.object({items:z.array(reminderScheduleSchema).max(50),nextCursor:uuid.nullable(),asOf:instant}).strict().parse(raw);this.asOf(data.asOf);
   const items=data.items.map(item=>this.current(item));if(new Set(items.map(item=>item.id)).size!==items.length||data.nextCursor&&(data.nextCursor!==items.at(-1)?.id||data.nextCursor===cursor))throw Error('INVALID_PAGE');
   for(const item of items)this.remember(item);if(cursor)this.cursors.add(cursor);this.page={...data,items,page};return {ok:true,notice:data.nextCursor?'已读取当前一页私人提醒，仍有后续页。':'已读取当前一页私人提醒。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 async read(id:string):Promise<ScheduleOutcome|null>{
  if(this.pending)return null;this.erase();this.pending=true;const generation=++this.generation;
  try{
   uuid.parse(id);const raw=await this.transport('/schedules/'+encodeURIComponent(id),{method:'GET'});if(generation!==this.generation)return null;
   const data=z.object({schedule:reminderScheduleSchema,preview:z.unknown(),asOf:instant}).strict().parse(raw),schedule=this.current(data.schedule);if(schedule.id!==id)throw Error('WRONG_SCHEDULE');
   const preview=this.checkedPreview(schedule.rule,data.preview,data.asOf);this.remember(schedule);this.detail={schedule,preview,asOf:data.asOf};return {ok:true,notice:'已重新读取提醒规则与登记状态；未声称消息已送达。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 async preview(rule:unknown):Promise<ScheduleOutcome|null>{
  if(this.pending)return null;this.draftPreview=null;this.pending=true;this.pendingPreview=true;const generation=++this.generation;
  try{
   const parsed=reminderRuleSchema.parse(rule),raw=await this.transport('/schedules/preview',{method:'POST',body:{rule:parsed}});if(generation!==this.generation)return null;
   const data=z.object({rule:reminderRuleSchema,preview:z.unknown(),asOf:instant}).strict().parse(raw);if(!same(parsed,data.rule))throw Error('RULE_CHANGED');
   this.draftPreview={rule:data.rule,preview:this.checkedPreview(data.rule,data.preview,data.asOf),asOf:data.asOf};return {ok:true,notice:'已核对服务端时间预览；尚未保存或投递提醒。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error);}
  finally{if(generation===this.generation){this.pending=false;this.pendingPreview=false;}}
 }
 async create(text:string,rule:unknown):Promise<ScheduleOutcome|null>{
  if(this.pending)return null;let parsed:ScheduleRule,body:string;
  try{parsed=reminderRuleSchema.parse(rule);body=message.parse(text);if(!this.localPreview(parsed).occurrences.length)throw Error('NO_FUTURE_OCCURRENCE');}catch{return {ok:false,notice:'请填写私人提醒文字、有效时区和未来时间；此页面只支持确定性文本提醒。'};}
  return this.write('/schedules',{kind:'PRIVATE_TEXT_REMINDER',text:body,rule:parsed},undefined);
 }
 async edit(id:string,text:string,rule:unknown):Promise<ScheduleOutcome|null>{
  const prior=this.detail?.schedule;if(this.pending||!prior||prior.id!==id||!reminderActions(prior).includes('edit'))return null;
  try{const parsed=reminderRuleSchema.parse(rule),body=message.parse(text);if(!this.localPreview(parsed).occurrences.length)throw Error('NO_FUTURE_OCCURRENCE');return await this.write('/schedules/'+encodeURIComponent(id),{text:body,rule:parsed},prior,'PATCH');}catch{return {ok:false,notice:'提醒文字或未来规则无效，未提交修改。'};}
 }
 async change(id:string,operation:'pause'|'resume'|'cancel'):Promise<ScheduleOutcome|null>{
  const prior=this.detail?.schedule;if(this.pending||!prior||prior.id!==id||!reminderActions(prior).includes(operation))return null;
  return this.write('/schedules/'+encodeURIComponent(id)+'/'+operation,{},prior);
 }
 private async write(path:string,body:unknown,prior:ReminderSchedule|undefined,method:'POST'|'PATCH'='POST'):Promise<ScheduleOutcome|null>{
  this.erase();this.pending=true;const generation=++this.generation;
  try{
   const key=uuid.parse(this.key()),raw=await this.transport(path,{method,body,key,...(prior?{ifMatch:prior.etag}:{})});if(generation!==this.generation)return null;
   const cancelling=!!prior&&path.endsWith('/cancel'),data=(cancelling?cancelResponseSchema:savedResponseSchema).parse(raw),schedule='stopped' in data?data.stopped:this.current(data.schedule);this.currentVersion(schedule);
   if(cancelling&&(schedule.state!=='CANCELLED'||schedule.revision<=prior!.revision))throw Error('INVALID_CANCEL_RECEIPT');
   if(prior&&schedule.id!==prior.id||!data.replayed&&(schedule.revision!==(prior?prior.revision+1:1)||prior&&schedule.etag===prior.etag))throw Error('INVALID_REVISION_RECEIPT');
   if(!data.replayed){
    const operation=path.split('/').at(-1),expected=operation==='pause'?'PAUSED':operation==='resume'?'ACTIVE':operation==='cancel'?'CANCELLED':prior?.state??'ACTIVE';
    if(schedule.state!==expected)throw Error('INVALID_STATE_RECEIPT');
    if(method==='PATCH'||!prior){const requested=body as {text:string;rule:ScheduleRule};if(!('text' in schedule)||schedule.text!==requested.text||!same(schedule.rule,requested.rule))throw Error('INVALID_CONTENT_RECEIPT');}
   }
   this.remember(schedule);this.receipt={id:schedule.id,revision:schedule.revision,etag:schedule.etag,state:schedule.state,replayed:data.replayed};return {ok:true,notice:cancelling?'已收到服务端已取消状态回执，旧正文和详情已清除；无需重新读取计划正文确认本次取消。在途或未知投递仍须核对，不表示已撤回消息。':'已收到持久保存状态回执；这不表示消息已送达。未执行的旧版本应由服务端停止，在途或未知结果仍须核对。'};
  }catch(error){if(generation!==this.generation)return null;this.erase();return failure(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
