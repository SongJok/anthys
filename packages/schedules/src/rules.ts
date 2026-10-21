import {z} from 'zod';

export class ScheduleRuleError extends Error {constructor(readonly code:string){super(code);}}
const weekdays=['MO','TU','WE','TH','FR','SA','SU'] as const;
const wholeLocal=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
function localValid(value:string){const stamp=Date.parse(value+'Z');return wholeLocal.test(value)&&value.slice(0,4)!=='0000'&&Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,19)===value;}
const localSchema=z.string().max(19).refine(localValid,'INVALID_LOCAL_DATE');
const utcSchema=z.string().max(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).refine(value=>{
 const stamp=Date.parse(value);if(!Number.isFinite(stamp)||value.startsWith('0000'))return false;
 return new Date(stamp).toISOString().slice(0,19)===value.slice(0,19);
},'INVALID_UTC_DATE').transform(value=>new Date(value).toISOString());
const zoneSchema=z.string().max(128).refine(value=>{
 if(!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(value))return false;
 try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
},'INVALID_IANA_TIMEZONE');
export const scheduleMisfireSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('REMINDER_LATEST'),graceSeconds:z.literal(3600).default(3600)}).strict(),
 z.object({kind:z.literal('REPORT_COALESCE')}).strict(),
 z.object({kind:z.literal('MONITOR_CURRENT')}).strict(),
 z.object({kind:z.literal('RECONFIRM')}).strict(),
]);
const base={
 schemaVersion:z.literal(1),tz:zoneSchema,
 start:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('LOCAL'),at:localSchema}).strict(),
  z.object({kind:z.literal('UTC'),at:utcSchema.refine(value=>new Date(value).getUTCMilliseconds()===0,'START_REQUIRES_WHOLE_SECONDS')}).strict(),
 ]),
 until:utcSchema.optional(),count:z.number().int().positive().max(100000).optional(),
 businessCalendar:z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),version:z.number().int().positive().safe()}).strict().optional(),
 dst:z.object({overlap:z.literal('EARLIER'),gap:z.literal('SKIP')}).strict().default({overlap:'EARLIER',gap:'SKIP'}),
 misfire:scheduleMisfireSchema,
};
/** Deliberately restricted structured RRULE representation; not an RFC string parser. */
export const scheduleRuleSchema=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('ONCE')}).strict().refine(value=>value.count===undefined||value.count===1,'ONCE_COUNT_MUST_BE_ONE'),
 z.object({...base,kind:z.literal('RRULE'),rrule:z.object({frequency:z.enum(['DAILY','WEEKLY']),interval:z.number().int().min(1).max(366).default(1),byWeekday:z.array(z.enum(weekdays)).min(1).max(7).refine(value=>new Set(value).size===value.length,'DUPLICATE_WEEKDAY').optional()}).strict()}).strict(),
 z.object({...base,kind:z.literal('INTERVAL'),everySeconds:z.number().int().min(1).max(Math.floor(Number.MAX_SAFE_INTEGER/1000))}).strict(),
]);
export type ScheduleRule=z.infer<typeof scheduleRuleSchema>;
export type ScheduleOccurrence={utc:string;local:string;tz:string};
export type SchedulePreview={start:{utc:string|null;local:string};occurrences:ScheduleOccurrence[];skipped:{local:string;reason:'DST_GAP'}[];complete:true;exhausted:boolean;notice:string};
const dayMs=86400000,maxScannedDays=100000;
function formatter(tz:string){return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}
function wall(format:Intl.DateTimeFormat,utc:number):string{
 const p=Object.fromEntries(format.formatToParts(utc).map(part=>[part.type,part.value]));
 return `${p.year!.padStart(4,'0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function naive(local:string){const value=Date.parse(local+'Z');if(!Number.isFinite(value))throw new ScheduleRuleError('SCHEDULE_DATE_RANGE_EXCEEDED');return value;}
/** Enumerate nearby IANA offsets, then round-trip every candidate; never normalize a gap. */
function resolve(local:string,format:Intl.DateTimeFormat):number|null{
 const center=naive(local),offsets=new Set<number>();
 for(let hours=-48;hours<=48;hours+=6){const probe=center+hours*3600000;offsets.add(naive(wall(format,probe))-probe);}
 const matches=[...offsets].map(offset=>center-offset).filter(candidate=>wall(format,candidate)===local);
 return matches.length?Math.min(...matches):null;
}
function midnight(local:string){return naive(local.slice(0,10)+'T00:00:00');}
function weekday(day:number){return (new Date(day).getUTCDay()+6)%7;}

/** Pure future preview. now is exclusive; until is inclusive; skipped gaps do not consume COUNT. */
export function preview(raw:unknown,options:{now:string;limit?:number}):SchedulePreview {
 const rule=scheduleRuleSchema.parse(raw),input=z.object({now:utcSchema,limit:z.number().int().min(1).max(100).default(5)}).strict().parse(options);
 if(rule.businessCalendar)throw new ScheduleRuleError('BUSINESS_CALENDAR_REQUIRED');
 const now=Date.parse(input.now),until=rule.until?Date.parse(rule.until):Infinity,format=formatter(rule.tz),startLocal=rule.start.kind==='LOCAL'?rule.start.at:wall(format,Date.parse(rule.start.at)),startUtc=rule.start.kind==='UTC'?Date.parse(rule.start.at):resolve(startLocal,format);
 if(startUtc!==null?until<startUtc:Number.isFinite(until)&&wall(format,until)<startLocal)throw new ScheduleRuleError('UNTIL_BEFORE_START');
 const result:SchedulePreview={start:{utc:startUtc===null?null:new Date(startUtc).toISOString(),local:startLocal},occurrences:[],skipped:[],complete:true,exhausted:false,notice:'仅规则预览，不表示已持久保存、排队、授权或执行。周一至周五不等于法定调休工作日。'};
 const add=(utc:number,local:string)=>result.occurrences.push({utc:new Date(utc).toISOString(),local,tz:rule.tz});
 if(rule.kind==='ONCE'){
  if(startUtc===null){if(startLocal>wall(format,now))result.skipped.push({local:startLocal,reason:'DST_GAP'});}
  else if(startUtc>now&&startUtc<=until)add(startUtc,startLocal);
  result.exhausted=true;return result;
 }
 if(rule.kind==='INTERVAL'){
  if(startUtc===null)throw new ScheduleRuleError('INTERVAL_LOCAL_START_UNRESOLVED');
  const step=rule.everySeconds*1000,index=Math.max(0,Math.floor((now-startUtc)/step)+1),count=rule.count??Infinity;
  for(let n=index;n<count&&result.occurrences.length<input.limit+1;n++){
   const utc=startUtc+n*step;if(!Number.isSafeInteger(utc)||!Number.isFinite(new Date(utc).getTime()))throw new ScheduleRuleError('SCHEDULE_DATE_RANGE_EXCEEDED');
   if(utc>until)break;add(utc,wall(format,utc));
  }
  result.exhausted=result.occurrences.length<=input.limit;if(!result.exhausted)result.occurrences.pop();return result;
 }
 const anchor=midnight(startLocal),time=startLocal.slice(10),weekAnchor=anchor-weekday(anchor)*dayMs,nowLocal=wall(format,now),endLocal=Number.isFinite(until)?wall(format,until):null;
 const selected=rule.rrule.byWeekday??(rule.rrule.frequency==='WEEKLY'?[weekdays[weekday(anchor)]!]:undefined);
 let day=rule.count?anchor:Math.max(anchor,midnight(nowLocal)-2*dayMs),accepted=0,scanned=0;
 for(;;day+=dayMs){
  if(++scanned>maxScannedDays)throw new ScheduleRuleError('SCHEDULE_SCAN_LIMIT');
  const iso=new Date(day).toISOString();if(iso.length!==24)throw new ScheduleRuleError('SCHEDULE_DATE_RANGE_EXCEEDED');
  const local=iso.slice(0,10)+time;
  if(endLocal&&local.slice(0,10)>endLocal.slice(0,10)){result.exhausted=true;break;}
  const dayIndex=Math.round((day-anchor)/dayMs),weekIndex=Math.floor((day-weekAnchor)/dayMs/7),match=(rule.rrule.frequency==='DAILY'?dayIndex%rule.rrule.interval===0:weekIndex%rule.rrule.interval===0)&&(!selected||selected.includes(weekdays[weekday(day)]!));
  if(!match)continue;
  const utc=resolve(local,format);
  if(utc===null){if(local>nowLocal)result.skipped.push({local,reason:'DST_GAP'});continue;}
  if(startUtc!==null&&utc<startUtc)continue;
  if(utc>until){result.exhausted=true;break;}
  accepted++;if(utc>now)add(utc,local);
  if(rule.count!==undefined&&accepted>=rule.count){result.exhausted=true;break;}
  if(result.occurrences.length>input.limit){result.occurrences.pop();break;}
 }
 if(result.occurrences.length>input.limit){result.occurrences.pop();result.exhausted=false;}
 return result;
}
