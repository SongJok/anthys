import {z} from 'zod';

const uuid=z.uuid(),positive=z.number().int().positive().safe(),instant=z.iso.datetime({offset:true});
export const groupCaseStates=['PROPOSED','OPEN','ASSIGNED','IN_PROGRESS','BLOCKED','WAITING_CONFIRMATION','RESOLVED','CLOSED','CANCELLED'] as const;
export const groupCaseDetails=z.object({title:z.string().trim().min(1).max(300),resourceRef:z.string().trim().min(1).max(512),priority:z.enum(['LOW','NORMAL','HIGH','URGENT']),dueAt:instant.nullable()}).strict();
const commandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('OPEN')}).strict(),z.object({operation:z.literal('ASSIGN'),ownerId:uuid}).strict(),
 z.object({operation:z.literal('START')}).strict(),z.object({operation:z.literal('BLOCK'),reason:z.string().trim().min(1).max(2000)}).strict(),
 z.object({operation:z.literal('CLAIM_COMPLETE'),statement:z.string().trim().min(1).max(2000)}).strict(),z.object({operation:z.literal('CONFIRM'),statement:z.string().trim().min(1).max(2000)}).strict(),
 z.object({operation:z.literal('CLOSE')}).strict(),z.object({operation:z.literal('CANCEL')}).strict(),
]);
const itemSchema=groupCaseDetails.extend({id:uuid,version:positive,contractVersion:positive,updatedAt:instant,state:z.enum(groupCaseStates),ownerId:uuid.nullable(),createdBy:uuid,blockedReason:z.string().max(2000).nullable(),completion:z.object({method:z.enum(['UNVERIFIED','OWNER_REPORTED','ADMIN_CONFIRMED']),actorId:uuid,statement:z.string().min(1).max(2000)}).strict().nullable(),sources:z.array(z.object({id:uuid,kind:z.enum(['MENTION','CARD']),source_event_id:uuid.nullable(),submitted_by:uuid,created_at:instant}).strict()).max(1000)}).strict();
const pageSchema=z.object({items:z.array(itemSchema).max(50),members:z.array(z.object({id:uuid,name:z.string().min(1).max(1000)}).strict()).max(10000),nextCursor:uuid.nullable(),coverage:z.object({mode:z.literal('MENTION_ONLY'),completeChat:z.literal(false),notice:z.string().min(1).max(2000),from:instant,until:instant,selection:z.literal('CASE_REGISTRATION_TIME')}).strict(),contractVersion:positive,administrator:z.boolean()}).strict();
const windowSchema=z.object({from:instant,until:instant}).strict().refine(v=>Date.parse(v.from)<Date.parse(v.until)&&Date.parse(v.until)-Date.parse(v.from)<=31*86400000);
export type GroupCase= z.infer<typeof itemSchema>;
export type GroupCaseCommand=z.infer<typeof commandSchema>;
export type GroupCaseDetails=z.infer<typeof groupCaseDetails>;
export type GroupCasePage=z.infer<typeof pageSchema>&{groupId:string;page:number};
export type GroupCasesTransport=(path:string,request:{method:'GET'|'POST'|'PATCH';body?:unknown;key?:string})=>Promise<unknown>;
export class GroupCasesFailure extends Error{constructor(readonly status:number){super('GROUP_CASE_REQUEST_FAILED');}}
export type GroupCaseOutcome={ok:boolean;notice:string;sessionLost?:boolean};
export function localToday(now=new Date()){
 const from=new Date(now.getFullYear(),now.getMonth(),now.getDate()),until=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
 return {from:from.toISOString(),until:until.toISOString()};
}
export function localWindowInputs(now=new Date()){
 const text=(date:Date)=>`${String(date.getFullYear()).padStart(4,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
 return {from:text(new Date(now.getFullYear(),now.getMonth(),now.getDate())),until:text(new Date(now.getFullYear(),now.getMonth(),now.getDate()+1))};
}
/** Browser-local wall times only. Reject invalid dates and DST gaps rather than rolling forward. */
export function localRegistrationWindow(from:string,until:string){
 const parse=(value:string)=>{
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if(!match)throw new Error('INVALID_LOCAL_WINDOW');
  const [year=NaN,month=NaN,day=NaN,hour=NaN,minute=NaN]=match.slice(1).map(Number);
  if(year<1||year>9999)throw new Error('INVALID_LOCAL_WINDOW');
  const date=new Date(0);date.setFullYear(year,month-1,day);date.setHours(hour,minute,0,0);
  if(date.getFullYear()!==year||date.getMonth()+1!==month||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute)throw new Error('INVALID_LOCAL_WINDOW');
  return date.toISOString();
 };
 return windowSchema.parse({from:parse(from),until:parse(until)});
}
export function caseActions(item:GroupCase,actorId:string,administrator:boolean):GroupCaseCommand['operation'][] {
 if(['CLOSED','CANCELLED'].includes(item.state))return [];
 const actions:GroupCaseCommand['operation'][]=[],owner=item.ownerId===actorId;
 if(administrator&&item.state==='PROPOSED')actions.push('OPEN');
 if(administrator&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED','WAITING_CONFIRMATION'].includes(item.state))actions.push('ASSIGN');
 if(owner&&['ASSIGNED','BLOCKED'].includes(item.state))actions.push('START');
 if(owner&&['ASSIGNED','IN_PROGRESS'].includes(item.state))actions.push('BLOCK');
 if(owner&&['ASSIGNED','IN_PROGRESS','BLOCKED'].includes(item.state))actions.push('CLAIM_COMPLETE');
 if(administrator&&!owner&&item.state==='WAITING_CONFIRMATION')actions.push('CONFIRM');
 if(administrator&&item.state==='RESOLVED')actions.push('CLOSE');
 if(administrator||item.createdBy===actorId)actions.push('CANCEL');
 return actions;
}
const failure=(error:unknown,write=false):GroupCaseOutcome=>{
 const status=error instanceof GroupCasesFailure?error.status:0;
 return {ok:false,notice:status===401?'会话已失效，事项正文已清除，请重新登录。':status===403?'当前群授权或操作权限不足，事项正文已清除，请核对授权。':status===409?'事项或合同版本冲突，结果未确认；请重新读取核对，不会自动重发。':status===404?'未找到当前可访问的群或事项，旧正文已清除。':status===400?'群标识或事项条件无效，请检查后重新读取。':write?'提交结果无法核实，可能已经保存；请重新读取核对，不要重复登记。不会自动重发。':'事项资料无法核实，旧正文已清除，请重新读取。',...(status===401?{sessionLost:true}:{})};
};
/** This is a UI concurrency boundary. The server establishes actual authority. */
export class GroupCasesFlow {
 snapshot:GroupCasePage|null=null;
 receipt:{id:string;version:number;state:GroupCase['state'];replayed:boolean}|null=null;
 private pending=false;
 private generation=0;
 private observed=new Map<string,number>();
 private contracts=new Map<string,number>();
 private cursors=new Set<string>();
 constructor(private transport:GroupCasesTransport,readonly actorId:string,private key:()=>string=()=>crypto.randomUUID()){}
 get busy(){return this.pending;}
 clear(){this.generation++;this.pending=false;this.snapshot=null;this.receipt=null;this.cursors.clear();}
 can(id:string,operation:GroupCaseCommand['operation']){const p=this.snapshot,item=p?.items.find(i=>i.id===id);return !this.pending&&!!p&&!!item&&caseActions(item,this.actorId,p.administrator).includes(operation);}
 private path(group:string){return '/groups/'+encodeURIComponent(group)+'/cases';}
 async read(groupId:string,range=localToday()):Promise<GroupCaseOutcome|null>{return this.load(groupId,range,undefined,1);}
 async next():Promise<GroupCaseOutcome|null>{const p=this.snapshot;if(this.pending||!p?.nextCursor)return null;return this.load(p.groupId,{from:p.coverage.from,until:p.coverage.until},p.nextCursor,p.page+1);}
 private async load(groupId:string,range:{from:string;until:string},cursor:string|undefined,page:number):Promise<GroupCaseOutcome|null>{
  if(this.pending)return null;this.snapshot=null;this.receipt=null;this.pending=true;const generation=++this.generation;
  try{
   if(!groupId||groupId.trim()!==groupId||groupId.length>512||/[\u0000-\u001f]/.test(groupId))throw new GroupCasesFailure(400);
   const window=windowSchema.parse(range);if(page===1)this.cursors.clear();if(cursor&&this.cursors.has(cursor))throw Error('REPEATED_CURSOR');
   const params=new URLSearchParams({...window,limit:'50',...(cursor?{cursor}:{})}),raw=await this.transport(this.path(groupId)+'?'+params,{method:'GET'});if(generation!==this.generation)return null;
   const value=pageSchema.parse(raw);
   if(Date.parse(value.coverage.from)!==Date.parse(window.from)||Date.parse(value.coverage.until)!==Date.parse(window.until)||new Set(value.items.map(i=>i.id)).size!==value.items.length||new Set(value.members.map(m=>m.id)).size!==value.members.length||value.nextCursor&&(value.nextCursor!==value.items.at(-1)?.id||value.nextCursor===cursor)||value.contractVersion<(this.contracts.get(groupId)??0)||value.items.some(i=>i.version<(this.observed.get(groupId+':'+i.id)??0)||i.contractVersion>value.contractVersion))throw Error('STALE_OR_INVALID_PAGE');
   this.contracts.set(groupId,value.contractVersion);for(const item of value.items)this.observed.set(groupId+':'+item.id,item.version);if(cursor)this.cursors.add(cursor);
   this.snapshot={...value,groupId,page};return {ok:true,notice:value.nextCursor?'已读取当前一页，仍有后续页；不代表全部群聊。':'已读取当前登记时间范围内的这一页；不代表全部群聊。'};
  }catch(error){if(generation!==this.generation)return null;this.snapshot=null;return failure(error);}
  finally{if(generation===this.generation)this.pending=false;}
 }
 async create(details:GroupCaseDetails,shareWithGroup:boolean):Promise<GroupCaseOutcome|null>{
  const page=this.snapshot;if(this.pending||!page)return null;
  try{if(shareWithGroup!==true)throw Error('SHARING_REQUIRED');const parsed=groupCaseDetails.parse(details);return await this.write(page,{method:'POST',body:{contractVersion:page.contractVersion,details:parsed,source:{kind:'CARD',shareWithGroup:true}}});}
  catch{return {ok:false,notice:'请填写标题和精确资源，并明确勾选共享给本群；未提交。'};}
 }
 async command(id:string,command:GroupCaseCommand):Promise<GroupCaseOutcome|null>{
  const page=this.snapshot,item=page?.items.find(i=>i.id===id);if(this.pending||!page||!item)return null;
  try{const parsed=commandSchema.parse(command);if(!this.can(id,parsed.operation)||parsed.operation==='ASSIGN'&&!page.members.some(m=>m.id===parsed.ownerId))throw Error('ACTION_UNAVAILABLE');return await this.write(page,{method:'PATCH',id,body:{contractVersion:page.contractVersion,expectedVersion:item.version,command:parsed}});}
  catch{return {ok:false,notice:'当前身份、状态或输入不支持此操作；未提交，请重新读取核对。'};}
 }
 private async write(page:GroupCasePage,request:{method:'POST'|'PATCH';id?:string;body:unknown}):Promise<GroupCaseOutcome|null>{
  this.snapshot=null;this.receipt=null;this.pending=true;const generation=++this.generation;
  try{
   const key=uuid.parse(this.key()),raw=await this.transport(this.path(page.groupId)+(request.id?'/'+encodeURIComponent(request.id):''),{method:request.method,body:request.body,key});if(generation!==this.generation)return null;
   const receipt=z.object({case:itemSchema,replayed:z.boolean(),duplicate:z.boolean().optional()}).strict().parse(raw);
   if(request.id&&receipt.case.id!==request.id||receipt.case.contractVersion!==page.contractVersion||receipt.case.version<(this.observed.get(page.groupId+':'+receipt.case.id)??0))throw Error('INVALID_RECEIPT');
   if(!receipt.replayed&&!receipt.duplicate){
    if(request.method==='POST'){
     const details=(request.body as {details:GroupCaseDetails}).details;
     if(receipt.case.version!==1||receipt.case.state!=='PROPOSED'||receipt.case.createdBy!==this.actorId||receipt.case.ownerId!==null||Object.entries(details).some(([field,value])=>receipt.case[field as keyof GroupCase]!==value))throw Error('INVALID_CREATE_RECEIPT');
    }else if(receipt.case.version!==(request.body as {expectedVersion:number}).expectedVersion+1)throw Error('INVALID_UPDATE_RECEIPT');
   }
   this.observed.set(page.groupId+':'+receipt.case.id,receipt.case.version);this.receipt={id:receipt.case.id,version:receipt.case.version,state:receipt.case.state,replayed:receipt.replayed};
   return {ok:true,notice:'已收到事项保存回执。这是群内登记状态，不是外部执行或自动验证；请重新读取当前记录。'};
  }catch(error){if(generation!==this.generation)return null;this.receipt=null;return failure(error,true);}
  finally{if(generation===this.generation)this.pending=false;}
 }
}
