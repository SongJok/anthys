import {z} from 'zod';
import {caseDetails,caseCommand} from './case-model.js';

const version=z.number().int().positive().safe();
const instant=z.iso.datetime({offset:true}).refine(value=>/(?:Z|[+-]\d{2}:\d{2})$/.test(value),'EXPLICIT_OFFSET_REQUIRED');
export const groupCaseCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('TODAY'),limit:z.literal(50)}).strict(),
 z.object({operation:z.literal('CLARIFY'),notice:z.string().min(1).max(1000)}).strict(),
 z.object({operation:z.literal('CREATE'),contractVersion:version,details:caseDetails}).strict(),
 z.object({operation:z.literal('UPDATE'),id:z.uuid(),contractVersion:version,expectedVersion:version,command:caseCommand}).strict(),
 z.object({operation:z.literal('LIST'),from:instant,until:instant,cursor:z.uuid().optional(),limit:z.number().int().min(1).max(200)}).strict().refine(value=>Date.parse(value.from)<Date.parse(value.until)&&Date.parse(value.until)-Date.parse(value.from)<=31*86400000,'INVALID_REGISTRATION_WINDOW'),
]);
export type GroupCaseCommand=z.infer<typeof groupCaseCommandSchema>;
const updates={开始事项:'START',阻塞事项:'BLOCK',事项已完成:'CLAIM_COMPLETE',确认事项:'CONFIRM',关闭事项:'CLOSE',取消事项:'CANCEL',指派事项:'ASSIGN',开放事项:'OPEN'} as const;
const heads=['登记事项','列出事项',...Object.keys(updates)];
const notice='请重述完整事项指令：登记须有标题、资源、优先级、截止和合同版本；更新须有精确事项 UUID、事项版本和合同版本，指派另需负责人 UUID，阻塞/完成声明/确认另需说明；列表须有明确带时区的登记起止时间（最多31天）。不猜事项、权限或时间，尚未执行。';
const clarify=():GroupCaseCommand=>({operation:'CLARIFY',notice});
function fields(value:string,allowed:readonly string[],required:readonly string[]):Map<string,string>|null{
 const result=new Map<string,string>();
 for(const segment of value.split(/[；;]/)){
  const match=/^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(segment);
  if(!match||!allowed.includes(match[1]!)||!match[2]||result.has(match[1]!))return null;
  result.set(match[1]!,match[2]!);
 }
 return required.every(key=>result.has(key))?result:null;
}
function integer(value:string|undefined){return value&&/^[1-9]\d*$/.test(value)?Number(value):NaN;}
const suspicious=/(?:我是|自称|作为|以)(?:本群|群)?管理员|跳过(?:授权|权限|审核)|(?:actorId|tenantId|sessionId|tool|target|role|administrator)["']?\s*[=:：]/i;

/** A bounded grammar only. Current group, actor, roles and authority come from the trusted caller. */
export function groupCaseCommand(raw:string):GroupCaseCommand|null{
 if(typeof raw!=='string')return null;
 const text=raw.trim();
 if(/^(?:汇总|列出)今日事项[。！!]?$/u.test(text))return {operation:'TODAY',limit:50};
 if(/^(?:好了|已经好了|事项好了)[。！!]?$/u.test(text))return clarify();
 const head=heads.find(value=>text.startsWith(value)&&(!text[value.length]||/[\s:：]/.test(text[value.length]!)));
 if(!head)return null;
 if(/^\s+(?:是什么|怎么|如何|为什么|是否|需要|能否|可以|有什么|有何)/.test(text.slice(head.length)))return null;
 if(text.length>8000||/[\u0000-\u001f\u007f]/.test(text)||suspicious.test(text))return clarify();
 let candidate:unknown;
 if(head==='登记事项'){
  const match=/^登记事项[：:]\s*(.+)$/.exec(text),data=match?fields(match[1]!,['标题','资源','优先级','截止','合同版本'],['标题','资源','优先级','截止','合同版本']):null;
  if(!data)return clarify();
  const due=data.get('截止')!;
  if(due!=='未设置'&&!instant.safeParse(due).success)return clarify();
  candidate={operation:'CREATE',contractVersion:integer(data.get('合同版本')),details:{title:data.get('标题'),resourceRef:data.get('资源'),priority:data.get('优先级'),dueAt:due==='未设置'?null:due}};
 }else if(head==='列出事项'){
  const match=/^列出事项[：:]\s*(.+)$/.exec(text),data=match?fields(match[1]!,['起始','结束','数量','游标'],['起始','结束']):null;
  if(!data)return clarify();
  candidate={operation:'LIST',from:data.get('起始'),until:data.get('结束'),limit:data.has('数量')?integer(data.get('数量')):50,...(data.has('游标')?{cursor:data.get('游标')!.toLowerCase()}:{})};
 }else{
  const rest=text.slice(head.length),match=/^\s+([^\s；;]+)\s*[；;]\s*(.+)$/.exec(rest);
  if(!match)return clarify();
  const operation=updates[head as keyof typeof updates],extra=operation==='ASSIGN'?'负责人':['BLOCK','CLAIM_COMPLETE','CONFIRM'].includes(operation)?'说明':null;
  const required=['事项版本','合同版本',...(extra?[extra]:[])],data=fields(match[2]!,required,required);
  if(!data)return clarify();
  const command=operation==='ASSIGN'?{operation,ownerId:data.get('负责人')!.toLowerCase()}:operation==='BLOCK'?{operation,reason:data.get('说明')}:['CLAIM_COMPLETE','CONFIRM'].includes(operation)?{operation,statement:data.get('说明')}:{operation};
  candidate={operation:'UPDATE',id:match[1]!.toLowerCase(),contractVersion:integer(data.get('合同版本')),expectedVersion:integer(data.get('事项版本')),command};
 }
 const parsed=groupCaseCommandSchema.safeParse(candidate);
 return parsed.success?parsed.data:clarify();
}
