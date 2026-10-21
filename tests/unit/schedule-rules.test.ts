import {preview,scheduleRuleSchema,scheduleMisfireSchema} from '../../packages/schedules/src/rules.js';
const base={schemaVersion:1,kind:'RRULE',tz:'America/Los_Angeles',start:{kind:'LOCAL',at:'2026-03-07T02:30:00'},rrule:{frequency:'DAILY'},misfire:{kind:'REMINDER_LATEST'}};
const times=(value:ReturnType<typeof preview>)=>value.occurrences.map(item=>item.utc);

it('T049 skips Los Angeles 2026-03-08 02:30, annotates the gap, and still previews five actual occurrences',()=>{
 const result=preview(base,{now:'2026-03-07T00:00:00Z'});
 expect(times(result)).toEqual(['2026-03-07T10:30:00.000Z','2026-03-09T09:30:00.000Z','2026-03-10T09:30:00.000Z','2026-03-11T09:30:00.000Z','2026-03-12T09:30:00.000Z']);
 expect(result.skipped).toContainEqual({local:'2026-03-08T02:30:00',reason:'DST_GAP'});expect(result.occurrences.every(item=>item.local.endsWith('02:30:00'))).toBe(true);expect(result.complete).toBe(true);expect(result.exhausted).toBe(false);
});
it('T050 chooses only the earlier 08:30Z occurrence for Los Angeles 2026-11-01 01:30',()=>{
 const rule={...base,start:{kind:'LOCAL',at:'2026-11-01T01:30:00'}},result=preview(rule,{now:'2026-10-31T00:00:00Z'});
 expect(result.occurrences[0]).toEqual({utc:'2026-11-01T08:30:00.000Z',local:'2026-11-01T01:30:00',tz:'America/Los_Angeles'});
 expect(times(result)).not.toContain('2026-11-01T09:30:00.000Z');expect(times(result)[1]).toBe('2026-11-02T09:30:00.000Z');
 expect(times(preview(rule,{now:'2026-11-01T09:00:00Z',limit:1}))).toEqual(['2026-11-02T09:30:00.000Z']);
});
it('UTC DTSTART for daily recurrence becomes local wall time, preserving DST semantics',()=>{
 expect(times(preview({...base,start:{kind:'UTC',at:'2026-03-07T10:30:00Z'}},{now:'2026-03-07T00:00:00Z'}))).toEqual(times(preview(base,{now:'2026-03-07T00:00:00Z'})));
 const overlap=preview({...base,start:{kind:'UTC',at:'2026-11-01T09:30:00Z'}},{now:'2026-11-01T00:00:00Z',limit:1});expect(times(overlap)).toEqual(['2026-11-02T09:30:00.000Z']);
});
it('COUNT is global from DTSTART, skipped gaps do not consume it, and now is exclusive',()=>{
 const counted={...base,count:3},result=preview(counted,{now:'2026-03-09T09:30:00Z'});
 expect(times(result)).toEqual(['2026-03-10T09:30:00.000Z']);expect(result.exhausted).toBe(true);
 expect(preview(counted,{now:'2026-03-10T09:30:00Z'}).occurrences).toEqual([]);
 expect(preview({...base,count:6},{now:'2026-03-07T00:00:00Z'}).occurrences).toHaveLength(5);
});
it('UNTIL is inclusive and intersects COUNT without silently extending either limit',()=>{
 expect(times(preview({...base,count:9,until:'2026-03-09T09:30:00Z'},{now:'2026-03-07T00:00:00Z'}))).toEqual(['2026-03-07T10:30:00.000Z','2026-03-09T09:30:00.000Z']);
 expect(times(preview({...base,count:1,until:'2026-03-20T09:30:00Z'},{now:'2026-03-07T00:00:00Z'}))).toEqual(['2026-03-07T10:30:00.000Z']);
 expect(()=>preview({...base,until:'2026-03-06T00:00:00Z'},{now:'2026-03-01T00:00:00Z'})).toThrow('UNTIL_BEFORE_START');
 const overlap=preview({...base,start:{kind:'UTC',at:'2026-11-01T08:45:00Z'},until:'2026-11-01T09:15:00Z'},{now:'2026-11-01T00:00:00Z'});expect(times(overlap)).toEqual(['2026-11-01T08:45:00.000Z']);
});
it('daily Monday-Friday selection does not invent legal workdays and weekly interval uses Monday week boundaries',()=>{
 const weekdays=preview({...base,tz:'Asia/Shanghai',start:{kind:'LOCAL',at:'2026-10-16T09:00:00'},rrule:{frequency:'DAILY',byWeekday:['MO','TU','WE','TH','FR']}},{now:'2026-10-15T00:00:00Z'});
 expect(weekdays.occurrences.map(item=>item.local)).toEqual(['2026-10-16T09:00:00','2026-10-19T09:00:00','2026-10-20T09:00:00','2026-10-21T09:00:00','2026-10-22T09:00:00']);expect(weekdays.notice).toContain('不等于法定调休工作日');
 const weekly=preview({...base,tz:'UTC',start:{kind:'LOCAL',at:'2026-10-12T09:00:00'},rrule:{frequency:'WEEKLY',interval:2,byWeekday:['MO','FR']}},{now:'2026-10-11T00:00:00Z'});
 expect(weekly.occurrences.map(item=>item.local.slice(0,10))).toEqual(['2026-10-12','2026-10-16','2026-10-26','2026-10-30','2026-11-09']);
});
it('weekly defaults to the DTSTART weekday; daily intervals retain their original anchor across old starts',()=>{
 const weekly=preview({...base,tz:'UTC',start:{kind:'LOCAL',at:'2026-10-14T09:00:00'},rrule:{frequency:'WEEKLY'}},{now:'2026-10-14T09:00:00Z',limit:2});expect(times(weekly)).toEqual(['2026-10-21T09:00:00.000Z','2026-10-28T09:00:00.000Z']);
 const daily=preview({...base,tz:'UTC',start:{kind:'UTC',at:'2020-01-01T09:00:00Z'},rrule:{frequency:'DAILY',interval:3}},{now:'2026-01-01T00:00:00Z',limit:2});expect(times(daily)).toEqual(['2026-01-02T09:00:00.000Z','2026-01-05T09:00:00.000Z']);
});
it('fixed INTERVAL uses absolute elapsed seconds, including one-second cadence and both distinct UTC instants in an overlap',()=>{
 const rule={schemaVersion:1,kind:'INTERVAL',tz:'America/Los_Angeles',start:{kind:'UTC',at:'2026-11-01T08:30:00Z'},everySeconds:3600,misfire:{kind:'MONITOR_CURRENT'}};
 const result=preview(rule,{now:'2026-11-01T08:00:00Z',limit:3});expect(times(result)).toEqual(['2026-11-01T08:30:00.000Z','2026-11-01T09:30:00.000Z','2026-11-01T10:30:00.000Z']);expect(result.occurrences.slice(0,2).map(item=>item.local)).toEqual(['2026-11-01T01:30:00','2026-11-01T01:30:00']);
 expect(times(preview({...rule,everySeconds:1,count:3},{now:'2026-11-01T08:30:00.500Z'}))).toEqual(['2026-11-01T08:30:01.000Z','2026-11-01T08:30:02.000Z']);
 expect(()=>preview({...rule,start:{kind:'LOCAL',at:'2026-03-08T02:30:00'}},{now:'2026-03-01T00:00:00Z'})).toThrow('INTERVAL_LOCAL_START_UNRESOLVED');
});
it('ONCE resolves explicit local/UTC inputs without normalizing a nonexistent local time',()=>{
 const rule={schemaVersion:1,kind:'ONCE',tz:'Asia/Kathmandu',start:{kind:'LOCAL',at:'2026-10-18T09:00:00'},misfire:{kind:'RECONFIRM'}};
 expect(times(preview(rule,{now:'2026-10-18T00:00:00Z'}))).toEqual(['2026-10-18T03:15:00.000Z']);
 expect(preview({...rule,tz:'America/Los_Angeles',start:{kind:'LOCAL',at:'2026-03-08T02:30:00'}},{now:'2026-03-01T00:00:00Z'})).toMatchObject({start:{utc:null},occurrences:[],skipped:[{local:'2026-03-08T02:30:00',reason:'DST_GAP'}],exhausted:true});
 expect(preview(rule,{now:'2026-10-18T03:15:00Z'}).occurrences).toEqual([]);
});
it('a date-line gap is skipped as a whole local date rather than silently shifted',()=>{
 const result=preview({...base,tz:'Pacific/Apia',start:{kind:'LOCAL',at:'2011-12-29T09:00:00'}},{now:'2011-12-28T00:00:00Z',limit:3});expect(result.skipped).toContainEqual({local:'2011-12-30T09:00:00',reason:'DST_GAP'});expect(result.occurrences.map(item=>item.local)).toEqual(['2011-12-29T09:00:00','2011-12-31T09:00:00','2012-01-01T09:00:00']);
});
it('versioned business calendars require a provider and are never substituted with remembered holidays',()=>{
 const rule={...base,businessCalendar:{id:'corp-holidays',version:2}};expect(scheduleRuleSchema.parse(rule).businessCalendar).toEqual(rule.businessCalendar);expect(()=>preview(rule,{now:'2026-03-01T00:00:00Z'})).toThrow('BUSINESS_CALENDAR_REQUIRED');
});
it('misfire is explicit typed metadata, preserving the four distinct recovery policies without dispatching anything',()=>{
 expect(scheduleMisfireSchema.parse({kind:'REMINDER_LATEST'})).toEqual({kind:'REMINDER_LATEST',graceSeconds:3600});
 for(const kind of ['REPORT_COALESCE','MONITOR_CURRENT','RECONFIRM'])expect(scheduleMisfireSchema.parse({kind})).toEqual({kind});
 expect(scheduleMisfireSchema.safeParse({kind:'REPLAY_ALL'}).success).toBe(false);expect(scheduleMisfireSchema.safeParse({kind:'REMINDER_LATEST',graceSeconds:9999}).success).toBe(false);
});
it('rejects unsupported RRULE combinations, invalid dates/zones and injected authority rather than approximating',()=>{
 for(const change of [{tz:'Not/A_Zone'},{tz:'+08:00'},{tz:'UTC;fetch("https://example.com")'},{start:{kind:'LOCAL',at:'2026-02-30T09:00:00'}},{start:{kind:'LOCAL',at:'2026-10-18T24:00:00'}},{start:{kind:'LOCAL',at:'2026-10-18T09:00:00Z'}},{start:{kind:'UTC',at:'2026-02-29T09:00:00Z'}},{rrule:'FREQ=DAILY'},{rrule:{frequency:'MONTHLY'}},{rrule:{frequency:'DAILY',byMonth:2}},{rrule:{frequency:'WEEKLY',byWeekday:['1MO']}},{rrule:{frequency:'DAILY',byWeekday:['MO','MO']}},{rrule:{frequency:'DAILY',interval:0}},{dst:{gap:'SHIFT_FORWARD',overlap:'EARLIER'}},{count:0},{actorId:'forged'},{misfire:{kind:'MONITOR_CURRENT',runCode:'evil'}}])expect(scheduleRuleSchema.safeParse({...base,...change}).success).toBe(false);
 expect(()=>preview(base,{now:'2026-02-30T00:00:00Z'})).toThrow();expect(()=>preview(base,{now:'2026-01-01T00:00:00Z',limit:0})).toThrow();
});
it('is deterministic, does not read Date.now, and never mutates the original rule',()=>{
 const rule=structuredClone(base),copy=structuredClone(rule),clock=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('AMBIENT_CLOCK_FORBIDDEN');});
 try{const first=preview(rule,{now:'2026-03-01T00:00:00Z'});expect(preview(rule,{now:'2026-03-01T00:00:00Z'})).toEqual(first);expect(rule).toEqual(copy);}finally{clock.mockRestore();}
});
it('fails explicitly at its search bound rather than returning an approximate or silently truncated sparse preview',()=>{
 expect(()=>preview({...base,tz:'UTC',start:{kind:'LOCAL',at:'2026-10-13T09:00:00'},rrule:{frequency:'DAILY',interval:366,byWeekday:['MO']}},{now:'2026-10-01T00:00:00Z',limit:100})).toThrow('SCHEDULE_SCAN_LIMIT');
});
