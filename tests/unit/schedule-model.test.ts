import {dueReminder,reminderPayload,createScheduleInput,renderReminder,scheduleEtag} from '../../packages/schedules/src/model.js';
import {scheduleRuleSchema} from '../../packages/schedules/src/rules.js';
const base={schemaVersion:1,kind:'RRULE',tz:'America/Los_Angeles',start:{kind:'LOCAL',at:'2026-01-01T09:00:00'},rrule:{frequency:'DAILY',interval:1},misfire:{kind:'REMINDER_LATEST'}};
it('T052 missed daily reminders coalesce to only the latest due occurrence and preserve the original next rule',()=>{
 const rule=scheduleRuleSchema.parse(base),due=dueReminder(rule,'2026-01-01T17:00:00.000Z','2026-01-06T17:30:00.000Z');expect(due).toEqual({scheduledAt:'2026-01-06T17:00:00.000Z',nextDueAt:'2026-01-07T17:00:00.000Z',missed:false});expect(dueReminder(rule,'2026-01-07T17:00:00.000Z','2026-01-06T17:30:00.000Z')).toBeNull();
});
it('absolute interval backlog selects latest valid COUNT/until instant without replaying thousands of missed occurrences',()=>{
 const rule=scheduleRuleSchema.parse({schemaVersion:1,tz:base.tz,misfire:base.misfire,kind:'INTERVAL',everySeconds:1,start:{kind:'UTC',at:'2026-01-01T00:00:00Z'},count:20});
 expect(dueReminder(rule,'2026-01-01T00:00:00.000Z','2026-01-10T00:00:00.000Z')).toEqual({scheduledAt:'2026-01-01T00:00:19.000Z',nextDueAt:null,missed:true});
});
it('ONCE past grace is MISSED and text/identity/rule constraints reject unsupported operation authority',()=>{
 const rule=scheduleRuleSchema.parse({schemaVersion:1,tz:base.tz,misfire:base.misfire,kind:'ONCE',start:{kind:'UTC',at:'2026-01-01T00:00:00Z'}});
 expect(dueReminder(rule,'2026-01-01T00:00:00.000Z','2026-01-01T02:00:00.000Z')?.missed).toBe(true);
 expect(reminderPayload.safeParse({text:'message',rule:{...rule,misfire:{kind:'REPORT_COALESCE'}}}).success).toBe(false);expect(createScheduleInput.safeParse({kind:'PRIVATE_TEXT_REMINDER',text:'message',rule,targetId:'other'}).success).toBe(false);
 expect(scheduleEtag('id',2)).toBe('"schedule-id-r2"');expect(renderReminder('id','text','2026-01-01T00:00:00Z','UTC')).toContain('计划时间：2026-01-01T00:00:00Z（UTC）');
});
it('interval reminders respect UNTIL/count from the actual DTSTART, including the earliest accepted UTC year',()=>{
 const baseRule={schemaVersion:1,kind:'INTERVAL',tz:'UTC',start:{kind:'UTC',at:'0001-01-01T00:00:00Z'},everySeconds:1,misfire:{kind:'REMINDER_LATEST'}};
 expect(dueReminder(scheduleRuleSchema.parse({...baseRule,count:2}),'0001-01-01T00:00:01.000Z','0001-01-01T00:00:02.000Z')).toEqual({scheduledAt:'0001-01-01T00:00:01.000Z',nextDueAt:null,missed:false});
 const rule=scheduleRuleSchema.parse({...baseRule,start:{kind:'UTC',at:'2026-01-01T00:00:00Z'},until:'2026-01-01T00:00:04Z'});expect(dueReminder(rule,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:20.000Z')).toEqual({scheduledAt:'2026-01-01T00:00:04.000Z',nextDueAt:null,missed:false});
});
it('a restored/corrupt due cursor that is not an actual rule occurrence cannot manufacture a reminder',()=>{
 for(const kind of ['ONCE','RRULE','INTERVAL']){const rule=scheduleRuleSchema.parse({schemaVersion:1,kind,tz:'UTC',start:{kind:'UTC',at:'2026-01-01T00:00:00Z'},misfire:{kind:'REMINDER_LATEST'},...(kind==='RRULE'?{rrule:{frequency:'DAILY'}}:kind==='INTERVAL'?{everySeconds:300}:{})});expect(()=>dueReminder(rule,'2026-01-01T00:00:01.000Z','2026-01-01T00:00:20.000Z')).toThrow('SCHEDULE_NEXT_DUE_INVALID');}
});
