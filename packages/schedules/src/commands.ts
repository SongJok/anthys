import {z} from 'zod';
import {scheduleRuleSchema,preview,type ScheduleRule} from './rules.js';

const privateRule=scheduleRuleSchema.refine(rule=>(rule.kind==='ONCE'||rule.kind==='RRULE')&&rule.misfire.kind==='REMINDER_LATEST'&&!rule.businessCalendar,'PRIVATE_REMINDER_ONLY');
export const reminderCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('CREATE'),text:z.string().trim().min(1).max(2000),rule:privateRule,notice:z.string().min(1).max(4000).nullable()}).strict(),
 z.object({operation:z.literal('CANCEL'),id:z.uuid()}).strict(),
 z.object({operation:z.literal('PAUSE'),id:z.uuid()}).strict(),
 z.object({operation:z.literal('CLARIFY'),notice:z.string().min(1).max(4000)}).strict(),
]);
export type ReminderCommand=z.infer<typeof reminderCommandSchema>;
const utc=z.string().max(24).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19));
const optionsSchema=z.object({now:utc,tz:z.string().min(1).max(128)}).strict();
const weekdays=['MO','TU','WE','TH','FR','SA','SU'] as const;
const clarify=(notice='请提供明确的私人提醒日期、时分和提醒文字，例如“提醒我 2026-10-20 09:00 Asia/Shanghai 带上报告”；周期可写“每天09:00提醒我喝水”。不支持的日期或规则不会自动改期。'):ReminderCommand=>({operation:'CLARIFY',notice});

function hasIntent(text:string){
 if(/^(?:如何|怎么|什么是|为什么|请解释|请介绍|介绍一下|有没有)|^提醒(?:功能)?(?:是什么|怎么|如何|有什么)|^(?:取消|暂停)提醒(?:的(?:实现|原理|设计)|怎么|如何|有什么)/u.test(text))return false;
 return /^(?:提醒|帮我提醒|取消提醒|暂停提醒|停止提醒|不要(?:再)?提醒|别(?:再)?提醒|\/remind(?:er)?\b)/iu.test(text)
  ||/^(?:设置|设定|创建|新增|安排|设个|设一个|帮我设置|帮我创建|帮我安排|帮我提醒|给我设置)[\s\S]{0,40}提醒/u.test(text)
  ||/^(?:明天|今天|后天|每天|每周|每星期|工作日|每个工作日|法定工作日|节假日|下周|下个月|月底|每月|每年|今晚|明早|稍后|一会儿|周[一二三四五六日天]|星期[一二三四五六日天]|\d+(?:分钟|小时|天)后)[\s\S]{0,150}提醒我/u.test(text)
  ||/^(?:每|[一二三四五六七八九十两百\d]+(?:分钟|小时|天|周|个月|月)后|本周|本月|今年|明年|下个|过一会儿|等会儿|周末|早上|下午|上午|晚上|中午|傍晚|取消|暂停|停止)[\s\S]{0,150}提醒/u.test(text)
  ||/^remind\s+me\b/iu.test(text)
  ||/^(?:帮我|为我|给我)[\s\S]{0,80}提醒/u.test(text)
  ||/^\{[\s\S]*(?:PRIVATE_TEXT_REMINDER|"reminder"|提醒)/iu.test(text);
}
function dateAt(instant:string,tz:string){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
 return `${parts.year!.padStart(4,'0')}-${parts.month}-${parts.day}`;
}
function nextDate(date:string){return new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);}
function local(date:string,time:string){const [hour,minute]=time.split(':');return `${date}T${hour!.padStart(2,'0')}:${minute}:00`;}
function explicitTail(tail:string,defaultZone:string){
 const zone=/^(\[[^\]\s]+\]|[A-Za-z][A-Za-z0-9_+.-]*\/[^\s]+|(?:UTC|GMT)[+-][^\s]+|[+-]\d{2}:?\d{2}|UTC)(?:\s+([\s\S]+))?$/iu.exec(tail);
 return zone?{tz:zone[1]!.replace(/^\[|\]$/g,''),text:(zone[2]??'').trim()}:{tz:defaultZone,text:tail.trim()};
}

/** Structural parsing only. No persistence, authorization, tool call, timer or send occurs. */
export function reminderCommand(text:string,options:{now:string;tz:string}):ReminderCommand|null {
 if(typeof text!=='string')return clarify('提醒命令必须是文字，不能提交身份、目标或工具对象。');
 const input=text.trim().replace(/^请\s*/u,'');if(!hasIntent(input))return null;
 if(input.length>8192||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input))return clarify('提醒命令过长或含无效控制字符，请重新填写明确文字。');
 const config=optionsSchema.safeParse(options);if(!config.success)return clarify('服务端时间或时区设置无效，不能采信额外身份、工具或目标字段；请先核对设置。');
 try{
  const control=/^(取消|暂停)提醒\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})[。.!！]?$/iu.exec(input);
  if(control)return reminderCommandSchema.parse({operation:control[1]==='取消'?'CANCEL':'PAUSE',id:control[2]!.toLowerCase()});
  if(/^(?:(?:取消|暂停|停止)[\s\S]{0,80}提醒|(?:不要(?:再)?|别(?:再)?)提醒)/u.test(input))return clarify('请明确提供要停止的提醒 UUID，使用“取消提醒 <完整UUID>”或“暂停提醒 <完整UUID>”；不会猜测当前或最近一条提醒。');
  // A structural stop does not depend on timezone conversion. Creation does.
  scheduleRuleSchema.parse({schemaVersion:1,kind:'ONCE',tz:config.data.tz,start:{kind:'UTC',at:config.data.now.slice(0,19)+'Z'},misfire:{kind:'REMINDER_LATEST'}});
  const today=dateAt(config.data.now,config.data.tz);
  let candidate:unknown,body='',workday=false;
  const absolute=/^提醒我\s+(\d{4}-\d{2}-\d{2})(?:\s+|T)(\d{1,2}:\d{2})\s+([\s\S]+)$/u.exec(input);
  const tomorrow=/^明天\s*(\d{1,2}:\d{2})\s*提醒我\s*([\s\S]+)$/u.exec(input);
  const recurring=/^(每天|每周[一二三四五六日天]|工作日|每个工作日)\s*(\d{1,2}:\d{2})\s*提醒我\s*([\s\S]+)$/u.exec(input);
  const base={schemaVersion:1,tz:config.data.tz,misfire:{kind:'REMINDER_LATEST'}};
  if(absolute){const tail=explicitTail(absolute[3]!,config.data.tz);body=tail.text;candidate={...base,tz:tail.tz,kind:'ONCE',start:{kind:'LOCAL',at:local(absolute[1]!,absolute[2]!)}};}
  else if(tomorrow){body=tomorrow[2]!.trim();candidate={...base,kind:'ONCE',start:{kind:'LOCAL',at:local(nextDate(today),tomorrow[1]!)}};}
  else if(recurring){
   body=recurring[3]!.trim();const kind=recurring[1]!,weekly=kind.startsWith('每周');workday=kind.includes('工作日');
   const day=weekly?'一二三四五六日天'.indexOf(kind.slice(2)):0;
   candidate={...base,kind:'RRULE',start:{kind:'LOCAL',at:local(today,recurring[2]!)},rrule:{frequency:weekly?'WEEKLY':'DAILY',...(weekly?{byWeekday:[weekdays[day===7?6:day]!]}:workday?{byWeekday:['MO','TU','WE','TH','FR']}:{})}};
  }else return clarify();
  if(!body||body.length>2000)return clarify('请提供1至2000字的私人提醒文字。');
  if(/(?:[；;，,。\n]|然后|并且)\s*(?:取消提醒|暂停提醒|提醒我\s+\d{4}-|(?:明天|每天)\s*\d{1,2}:\d{2}\s*提醒我)/u.test(body))return clarify('一次请只提交一条明确提醒命令；多个创建或停止动作不会被合并或猜测执行。');
  // Explicit rule modifiers are not silently reclassified as an unlimited reminder body.
  if(/(?:直到|截至|截止到|到月底|月底(?:停止|结束)|(?:重复|执行|共|仅)\s*\d+\s*次|持续\s*\d+\s*天|按法定|遇(?:节假日|调休)|跳过节假日)/u.test(body))return clarify('这句话包含结束、次数或企业调休日历条件，当前文字入口尚不支持；请在提醒页面明确设置规则，不会忽略条件创建无限周期。');
  const rule:ScheduleRule=privateRule.parse(candidate),future=preview(rule,{now:config.data.now});
  if(!future.occurrences.length)return clarify(future.start.utc===null?'该时区的本地时刻不存在，默认跳过且不会自动顺延。请提供有效的一次性时间。':'一次性提醒时间必须在当前时间之后；不会自动改成明天或其他日期。');
  const first=future.occurrences[0]!,skips=future.skipped.length?`预览跳过不存在的本地时刻：${future.skipped.map(item=>item.local).join('、')}。`:'',upcoming=rule.kind==='RRULE'?`未来五次候选（仅预览）：${future.occurrences.map(item=>`${item.local}（UTC ${item.utc}）`).join('；')}。`:'';
  const notice=(workday?'“工作日”仅按周一至周五，未使用企业法定调休日历。':'')+`按时区 ${rule.tz} 解析，首次候选为 ${first.local}（UTC ${first.utc}）。${upcoming}重复时刻只取较早一次。${skips}仅完成结构与规则预览，尚未保存、授权、排队或投递。`;
  return reminderCommandSchema.parse({operation:'CREATE',text:body,rule,notice});
 }catch{return clarify('日期、时间或 IANA 时区无效，或规则不能明确解析。请提供有效的绝对日期与时分；不会猜测、改期或声称已经保存。');}
}
