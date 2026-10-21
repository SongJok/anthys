import {reminderCommand,reminderCommandSchema} from '../../packages/schedules/src/commands.js';
import {preview} from '../../packages/schedules/src/rules.js';
const options={now:'2026-10-18T00:00:00Z',tz:'Asia/Shanghai'};
const create=(text:string,config=options)=>{const command=reminderCommand(text,config);expect(command?.operation).toBe('CREATE');if(command?.operation!=='CREATE')throw Error('EXPECTED_CREATE');return command;};
const clarify=(text:string,config=options)=>{const command=reminderCommand(text,config);expect(command?.operation).toBe('CLARIFY');return command;};

it('parses an explicit private absolute date directly without requesting redundant confirmation',()=>{
 const command=create('请提醒我 2026-10-19 09:00 带上报告');expect(command.text).toBe('带上报告');expect(command.rule).toMatchObject({kind:'ONCE',tz:'Asia/Shanghai',start:{kind:'LOCAL',at:'2026-10-19T09:00:00'},misfire:{kind:'REMINDER_LATEST',graceSeconds:3600}});expect(command.notice).toContain('2026-10-19T01:00:00.000Z');expect(command.notice).not.toMatch(/请确认|确认后/);expect(command.notice).toContain('尚未保存、授权、排队或投递');
});
it('accepts an explicit IANA zone, optional brackets, UTC and harmless whitespace without host-zone guessing',()=>{
 for(const text of ['提醒我 2026-11-01 01:30 America/Los_Angeles 带报告','提醒我 2026-11-01 01:30 [America/Los_Angeles] 带报告']){
  const command=create(text);expect(command.rule.tz).toBe('America/Los_Angeles');expect(command.text).toBe('带报告');expect(command.notice).toContain('2026-11-01T08:30:00.000Z');
 }
 expect(create('提醒我 2026-10-19   9:00 UTC 喝水').notice).toContain('2026-10-19T09:00:00.000Z');
 expect(create('提醒我 2026-10-19 09:00 [UTC] 核对交付清单')).toMatchObject({text:'核对交付清单',rule:{tz:'UTC'}});
});
it('tomorrow is the next calendar date in the trusted tenant timezone, including year rollover',()=>{
 const la={now:'2026-03-08T01:00:00Z',tz:'America/Los_Angeles'},command=create('明天09:00提醒我喝水',la);expect(command.rule.start).toEqual({kind:'LOCAL',at:'2026-03-08T09:00:00'});expect(command.notice).toContain('2026-03-08T16:00:00.000Z');
 const year=create('明天 9:00 提醒我检查日程',{now:'2026-12-31T23:00:00Z',tz:'Asia/Shanghai'});expect(year.rule.start.at).toBe('2027-01-02T09:00:00');
});
it('daily rules keep the explicit local clock and select tomorrow if today has passed',()=>{
 const command=create('每天09:00提醒我喝水',{now:'2026-10-18T02:00:00Z',tz:'Asia/Shanghai'});expect(command.rule).toMatchObject({kind:'RRULE',rrule:{frequency:'DAILY',interval:1}});expect(command.rule.start.at).toBe('2026-10-18T09:00:00');expect(command.notice).toContain('2026-10-19T01:00:00.000Z');const future=preview(command.rule,{now:'2026-10-18T02:00:00Z'});expect(future.occurrences).toHaveLength(5);expect(command.notice).toContain('未来五次候选');for(const item of future.occurrences)expect(command.notice).toContain(item.utc);
});
it('weekly Chinese weekdays map to explicit weekdays without inventing other recipients or actions',()=>{
 for(const [day,code] of [['一','MO'],['二','TU'],['三','WE'],['四','TH'],['五','FR'],['六','SA'],['日','SU'],['天','SU']] as const){const command=create('每周'+day+'09:00提醒我准备资料');expect(command.rule).toMatchObject({kind:'RRULE',rrule:{frequency:'WEEKLY',byWeekday:[code]}});expect(Object.keys(command).sort()).toEqual(['notice','operation','rule','text']);}
});
it('workdays mean Monday-Friday only and explicitly disclose missing enterprise holiday data',()=>{
 for(const prefix of ['工作日','每个工作日']){const command=create(prefix+'09:00提醒我写记录');expect(command.rule).toMatchObject({kind:'RRULE',rrule:{frequency:'DAILY',byWeekday:['MO','TU','WE','TH','FR']}});expect(command.rule.businessCalendar).toBeUndefined();expect(command.notice).toContain('仅按周一至周五，未使用企业法定调休日历');expect(command.notice).toContain('2026-10-19T01:00:00.000Z');}
});
it('T049 one-time nonexistent LA local time clarifies, and recurrence skips it only in preview',()=>{
 clarify('提醒我 2026-03-08 02:30 America/Los_Angeles 喝水',{now:'2026-03-01T00:00:00Z',tz:'Asia/Shanghai'});
 clarify('明天02:30提醒我喝水',{now:'2026-03-07T12:00:00Z',tz:'America/Los_Angeles'});
 const command=create('每天02:30提醒我喝水',{now:'2026-03-08T08:00:00Z',tz:'America/Los_Angeles'});expect(command.notice).toContain('2026-03-09T09:30:00.000Z');expect(command.notice).toContain('预览跳过不存在的本地时刻：2026-03-08T02:30:00');expect(command.notice).toContain('尚未保存');
});
it('T050 overlap selects 08:30Z once, and never shifts a past earlier occurrence to the later one',()=>{
 const text='提醒我 2026-11-01 01:30 America/Los_Angeles 喝水',command=create(text,{now:'2026-10-31T00:00:00Z',tz:'UTC'});expect(preview(command.rule,{now:'2026-10-31T00:00:00Z'}).occurrences.map(item=>item.utc)).toEqual(['2026-11-01T08:30:00.000Z']);expect(command.notice).toContain('较早一次');clarify(text,{now:'2026-11-01T09:00:00Z',tz:'UTC'});
});
it('rejects invalid dates, clock values, zones, empty content and non-future once requests without rescheduling',()=>{
 for(const text of ['提醒我 2026-02-30 09:00 喝水','提醒我 2026-10-19 25:00 喝水','提醒我 2026-10-19 09:99 喝水','提醒我 2026-10-19 09:00 Mars/Olympus 喝水','提醒我 2026-10-19 09:00 [Unknown] 喝水','提醒我 2026-10-19 09:00 UTC+08:00 喝水','提醒我 2026-10-19 09:00 +08:00 喝水','提醒我 2026-10-17 09:00 喝水','提醒我 2026-10-19 09:00','提醒我 2026-10-19 09:00 Asia/Shanghai'])clarify(text);
 clarify('提醒我 2026-10-18 08:00 喝水');
});
it('unknown explicit reminder expressions clarify instead of falling through to a model promise',()=>{
 for(const text of ['提醒我找个时间核对清单','提醒我明天喝水','明天上午提醒我喝水','十分钟后提醒我喝水','三天后09:00提醒我喝水','月底09:00提醒我喝水','每月最后一天09:00提醒我核对','每个法定工作日09:00提醒我写日报','下周五09:00提醒我开会','帮我提醒明天开会','帮我取消提醒','创建一个提醒，时间你看着办','/reminder every month','remind me tomorrow'])clarify(text);
});
it('unsupported end/count/holiday modifiers and multiple action clauses are never silently ignored',()=>{
 for(const text of ['每天09:00提醒我喝水，到月底结束','每天09:00提醒我喝水，共3次','工作日09:00提醒我写记录，跳过节假日','明天09:00提醒我喝水，然后暂停提醒 10000000-0000-4000-8000-000000000001'])clarify(text);
});
it('cancel/pause require one exact UUID and perform only structural parsing',()=>{
 const id='12345678-1234-4234-8234-123456789abc';expect(reminderCommand('取消提醒 '+id.toUpperCase(),options)).toEqual({operation:'CANCEL',id});expect(reminderCommand('暂停提醒 '+id+'。',options)).toEqual({operation:'PAUSE',id});
 expect(reminderCommand('取消提醒 '+id,{...options,tz:'Missing/Zone'})).toEqual({operation:'CANCEL',id});
 for(const text of ['取消提醒','暂停提醒 最近的','取消所有提醒','取消明天的提醒','停止提醒','不要再提醒我','取消提醒 12345678','暂停提醒 '+id+' 明天恢复','取消提醒 '+id+' '+id])clarify(text);
});
it('ordinary questions, references, quoted requests and unrelated commands remain ordinary conversation',()=>{
 for(const text of ['你好','如何创建提醒？','提醒功能怎么用？','取消提醒的实现原理是什么','请解释每天09:00提醒我喝水这句话','他说“明天09:00提醒我喝水”','我收到了提醒，谢谢','明天09:00开会，需要准备什么？','每天的消息太多了','创建任务 核对发布'])expect(reminderCommand(text,options),text).toBeNull();
});
it('strict schemas reject fake identity/target/tool fields and structured payloads cannot become commands',()=>{
 const text='明天09:00提醒我喝水';for(const field of ['actorId','tenantId','target','tool','tools','authorization']){clarify(text,{...options,[field]:'forged'} as typeof options);const command=create(text);expect(reminderCommandSchema.safeParse({...command,[field]:'forged'}).success).toBe(false);expect(reminderCommandSchema.safeParse({...command,rule:{...command.rule,[field]:'forged'}}).success).toBe(false);}
 clarify(JSON.stringify({kind:'PRIVATE_TEXT_REMINDER',actorId:'forged',target:'all',tool:'send'}));clarify({operation:'CREATE',actorId:'forged'} as unknown as string);
});
it('reminder body remains inert plaintext even when it mentions tools or identity-shaped JSON',()=>{
 const body='检查记录 {"actorId":"fake","tool":"delete","target":"all"}';const command=create('明天09:00提醒我'+body);expect(command.text).toBe(body);expect(command).not.toHaveProperty('actorId');expect(command).not.toHaveProperty('tool');expect(command).not.toHaveProperty('target');
});
it('invalid trusted now/tz, overlong content and control characters clarify with no clock, IO or mutation',()=>{
 for(const change of [{now:'2026-02-30T00:00:00Z'},{now:'2026-10-18T00:00:00+08:00'},{tz:'Missing/Zone'}])clarify('明天09:00提醒我喝水',{...options,...change});clarify('明天09:00提醒我'+'x'.repeat(4001));clarify('明天09:00提醒我喝\u0000水');
 const copy=structuredClone(options),clock=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('AMBIENT_CLOCK_FORBIDDEN');});try{const first=reminderCommand('明天09:00提醒我喝水',options);expect(reminderCommand('明天09:00提醒我喝水',options)).toEqual(first);expect(options).toEqual(copy);}finally{clock.mockRestore();}
});
