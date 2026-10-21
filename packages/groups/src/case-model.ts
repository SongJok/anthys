import {z} from 'zod';

export const caseStates=['PROPOSED','OPEN','ASSIGNED','IN_PROGRESS','BLOCKED','WAITING_CONFIRMATION','RESOLVED','CLOSED','CANCELLED'] as const;
export const caseState=z.enum(caseStates);
export const caseDetails=z.object({
 title:z.string().trim().min(1).max(300),
 resourceRef:z.string().trim().min(1).max(512),
 priority:z.enum(['LOW','NORMAL','HIGH','URGENT']),
 dueAt:z.iso.datetime({offset:true}).nullable(),
}).strict();
export const caseCommand=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('OPEN')}).strict(),
 z.object({operation:z.literal('ASSIGN'),ownerId:z.uuid()}).strict(),
 z.object({operation:z.literal('START')}).strict(),
 z.object({operation:z.literal('BLOCK'),reason:z.string().trim().min(1).max(2000)}).strict(),
 z.object({operation:z.literal('CLAIM_COMPLETE'),statement:z.string().trim().min(1).max(2000)}).strict(),
 z.object({operation:z.literal('CONFIRM'),statement:z.string().trim().min(1).max(2000)}).strict(),
 z.object({operation:z.literal('CLOSE')}).strict(),
 z.object({operation:z.literal('CANCEL')}).strict(),
]);
export type CaseCommand=z.infer<typeof caseCommand>;
export interface CaseLifecycle {
 state:z.infer<typeof caseState>;
 ownerId:string|null;
 createdBy:string;
 blockedReason:string|null;
 completion:{method:'UNVERIFIED'|'OWNER_REPORTED'|'ADMIN_CONFIRMED';actorId:string;statement:string}|null;
}
export class GroupCaseError extends Error {
 constructor(readonly code:string,readonly status=403,options?:ErrorOptions){super(code,options);}
}

/** Authority is established by the caller against current persisted sources. */
export function advanceCase(current:CaseLifecycle,command:CaseCommand,authority:{actorId:string;administrator:boolean;ownerReportedAllowed:boolean}):CaseLifecycle {
 const next:CaseLifecycle={state:current.state,ownerId:current.ownerId,createdBy:current.createdBy,blockedReason:current.blockedReason,completion:structuredClone(current.completion)},admin=authority.administrator,owner=authority.actorId===current.ownerId;
 const require=(condition:boolean,code='GROUP_CASE_TRANSITION_DENIED')=>{if(!condition)throw new GroupCaseError(code,409);};
 require(!['CLOSED','CANCELLED'].includes(current.state));
 switch(command.operation){
  case 'OPEN':require(admin&&current.state==='PROPOSED');next.state='OPEN';break;
  case 'ASSIGN':require(admin&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED','WAITING_CONFIRMATION'].includes(current.state));next.ownerId=command.ownerId;next.state='ASSIGNED';next.blockedReason=null;next.completion=null;break;
  case 'START':require(owner&&['ASSIGNED','BLOCKED'].includes(current.state));next.state='IN_PROGRESS';next.blockedReason=null;break;
  case 'BLOCK':require(owner&&['ASSIGNED','IN_PROGRESS'].includes(current.state));next.state='BLOCKED';next.blockedReason=command.reason;break;
  case 'CLAIM_COMPLETE':require(owner&&['ASSIGNED','IN_PROGRESS','BLOCKED'].includes(current.state));next.state=authority.ownerReportedAllowed?'RESOLVED':'WAITING_CONFIRMATION';next.blockedReason=null;next.completion={method:authority.ownerReportedAllowed?'OWNER_REPORTED':'UNVERIFIED',actorId:authority.actorId,statement:command.statement};break;
  case 'CONFIRM':require(admin&&!owner&&current.state==='WAITING_CONFIRMATION');next.state='RESOLVED';next.completion={method:'ADMIN_CONFIRMED',actorId:authority.actorId,statement:command.statement};break;
  case 'CLOSE':require(admin&&current.state==='RESOLVED');next.state='CLOSED';break;
  case 'CANCEL':require(admin||authority.actorId===current.createdBy);next.state='CANCELLED';break;
 }
 return next;
}

export const mentionCoverage=Object.freeze({mode:'MENTION_ONLY' as const,completeChat:false as const,notice:'仅包含已登记的 @ 提交和明确共享给本群的卡片事项，不覆盖全部群聊；未接入历史或被动监听。'});
