import {z} from 'zod';
import {preview,scheduleRuleSchema,type ScheduleRule} from './rules.js';
export class ScheduleError extends Error {constructor(readonly code:string,readonly status=403,options?:ErrorOptions){super(code,options);}}
export const reminderPayload=z.object({text:z.string().trim().min(1).max(2000),rule:scheduleRuleSchema}).strict().refine(v=>v.rule.misfire.kind==='REMINDER_LATEST'&&!v.rule.businessCalendar,'PRIVATE_REMINDER_RULE_REQUIRED');
export const createScheduleInput=reminderPayload.safeExtend({kind:z.literal('PRIVATE_TEXT_REMINDER')});
export const scheduleListInput=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.uuid().optional()}).strict();
export function scheduleEtag(id:string,revision:number){return `"schedule-${id}-r${revision}"`;}
export function renderReminder(id:string,text:string,scheduledAt:string,tz:string){return `私人提醒 ${id}\n计划时间：${scheduledAt}（UTC）；时区：${tz}\n\n${text}`;}
/** Latest eligible occurrence only: older missed reminders never cause a flood. */
export function dueReminder(rule:ScheduleRule,nextDue:string,now:string){
 const end=Date.parse(now),from=Date.parse(nextDue);if(from>end)return null;
 const first=preview(rule,{now:new Date(from-1).toISOString(),limit:1});
 if(first.occurrences[0]?.utc!==nextDue)throw new ScheduleError('SCHEDULE_NEXT_DUE_INVALID',503);
 const future=preview(rule,{now,limit:1}).occurrences[0]?.utc??null;
 let latest=nextDue;
 if(rule.kind==='INTERVAL'){
  const origin=first.start.utc;if(origin===null)throw new ScheduleError('SCHEDULE_NEXT_DUE_INVALID',503);
  const bound=Math.min(end,rule.until?Date.parse(rule.until):end),step=rule.everySeconds*1000;
  const n=Math.min(Math.floor((bound-Date.parse(origin))/step),(rule.count??Infinity)-1);
  latest=new Date(Date.parse(origin)+n*step).toISOString();
 }else{
  let cursor=new Date(from-1).toISOString(),finished=false;
  for(let page=0;page<1000&&!finished;page++){
   const batch=preview(rule,{now:cursor,limit:100});
   for(const item of batch.occurrences){if(Date.parse(item.utc)>end){finished=true;break;}latest=item.utc;cursor=item.utc;}
   if(batch.exhausted)finished=true;
   if(page===999&&!finished)throw new ScheduleError('SCHEDULE_BACKLOG_SCAN_LIMIT',503);
  }
 }
 return {scheduledAt:latest,nextDueAt:future,missed:end-Date.parse(latest)>3600000};
}
/** Final check for a persisted occurrence: its own instant must still be an
 * exact candidate of the current rule and inside the misfire grace. A newer
 * persisted candidate is checked separately so fast intervals can deliver. */
export function exactReminderCandidate(rule:ScheduleRule,scheduledAt:string,now:string){
 const from=Date.parse(scheduledAt),at=Date.parse(now);
 if(!Number.isFinite(from)||!Number.isFinite(at)||from>at)return false;
 const grace=(rule.misfire.kind==='REMINDER_LATEST'?rule.misfire.graceSeconds:3600)*1000;
 if(at-from>grace)return false;
 try{const instant=new Date(from).toISOString();return dueReminder(rule,instant,instant)?.scheduledAt===instant;}catch{return false;}
}
