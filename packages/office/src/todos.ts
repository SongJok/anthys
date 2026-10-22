import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const instant=z.string().max(35).pipe(z.iso.datetime({offset:true})).transform(value=>new Date(value).toISOString());
const userId=z.uuid();
const title=z.string().trim().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'TODO_TITLE_INVALID');
const fields={title,dueAt:instant,assignee:userId.nullable()};
/** Bounded personal/assigned todo request. No notes or free-form payloads are
 * accepted, so the read-back comparison stays exact. */
export const todoRequestSchema=z.strictObject(fields);
export type TodoRequest=z.infer<typeof todoRequestSchema>;
export const todoUpdateRequestSchema=z.strictObject({todoId:userId,...fields});
export type TodoUpdateRequest=z.infer<typeof todoUpdateRequestSchema>;
export const todoCloseRequestSchema=z.strictObject({todoId:userId});
export type TodoCloseRequest=z.infer<typeof todoCloseRequestSchema>;
export interface TodoConnector{
 create(input:{title:string;dueAt:string;assignee:string|null;requestHash:string},signal:AbortSignal):Promise<{todoId:string}>;
 update(input:{todoId:string;title:string;dueAt:string;assignee:string|null;requestHash:string},signal:AbortSignal):Promise<{todoId:string}>;
 close(input:{todoId:string;requestHash:string},signal:AbortSignal):Promise<{todoId:string}>;
 read(input:{todoId:string},signal:AbortSignal):Promise<{todoId:string;title:string;dueAt:string;assignee:string|null;completed:boolean}>;
}
export type TodoResult=
 |{status:'PROPOSED';proposalId:string;title:string;dueAt:string;assignee:string|null;requestHash:string;expiresAt:string}
 |{status:'PROPOSED_UPDATE';proposalId:string;todoId:string;title:string;dueAt:string;assignee:string|null;requestHash:string;expiresAt:string}
 |{status:'PROPOSED_CLOSE';proposalId:string;todoId:string;requestHash:string;expiresAt:string}
 |{status:'READ';todoId:string;title:string;dueAt:string;assignee:string|null;completed:boolean}
 |{status:'VERIFIED';todoId:string;dueAt:string;assignee:string|null}
 |{status:'UPDATED';todoId:string;title:string;dueAt:string;assignee:string|null}
 |{status:'CLOSED';todoId:string}
 |{status:'BLOCKED_EXTERNAL';code:'TODO_CONNECTOR_UNAVAILABLE'}
 |{status:'READ_FAILED';code:'TODO_READBACK_UNAVAILABLE'}
 |{status:'INVALID_PROPOSAL';code:'TODO_REQUEST_INVALID'|'TODO_DUE_AT_NOT_FUTURE'|'TODO_PROPOSAL_UNKNOWN'|'TODO_PROPOSAL_EXPIRED'}
 |{status:'VERIFICATION_FAILED';code:'TODO_READBACK_MISMATCH'|'TODO_READBACK_UNAVAILABLE';todoId:string;effect:'UNKNOWN'}
 |{status:'UNKNOWN';code:'TODO_CREATE_OUTCOME_UNKNOWN'|'TODO_UPDATE_OUTCOME_UNKNOWN'|'TODO_CLOSE_OUTCOME_UNKNOWN';effect:'UNKNOWN'};
const digest=(domain:string,value:unknown)=>createHash('sha256').update(`anthys.office.todo.${domain}.v1\0`+JSON.stringify(value)).digest('hex');
type ProposalInput=
 |{action:'CREATE';request:TodoRequest;requestHash:string}
 |{action:'UPDATE';request:TodoUpdateRequest;requestHash:string}
 |{action:'CLOSE';todoId:string;requestHash:string};
type Proposal=ProposalInput&{expiresAt:number;claimed:boolean};
const readShape=z.strictObject({todoId:userId,title:z.string().min(1).max(256),dueAt:instant,assignee:userId.nullable(),completed:z.boolean()});
/** Two-step, connector-injected todo creation, update and close. Proposals make
 * no external call and are consumed once; success is reported only after an
 * exact read-back. A failed write or read-back is UNKNOWN, never a fabricated
 * external todo. */
export class TodoCoordinator{
 private readonly proposals=new Map<string,Proposal>();
 constructor(private readonly options:{connector:TodoConnector|null;now?:()=>number;proposalTtlMs?:number}){}
 private now(){return (this.options.now??Date.now)();}
 private store(value:ProposalInput,expiresAt:number){const proposalId=randomUUID();this.proposals.set(proposalId,{...value,expiresAt,claimed:false});if(this.proposals.size>1024)this.proposals.delete(this.proposals.keys().next().value!);return {proposalId,expiresAt};}
 async propose(raw:unknown,signal:AbortSignal):Promise<TodoResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'};
  const parsed=todoRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'};
  const request=parsed.data,now=this.now();
  if(Date.parse(request.dueAt)<=now)return {status:'INVALID_PROPOSAL',code:'TODO_DUE_AT_NOT_FUTURE'};
  const requestHash=digest('create',[request.title,request.dueAt,request.assignee]),{proposalId,expiresAt}=this.store({action:'CREATE',request,requestHash},now+(this.options.proposalTtlMs??300_000));
  return {status:'PROPOSED',proposalId,title:request.title,dueAt:request.dueAt,assignee:request.assignee,requestHash,expiresAt:new Date(expiresAt).toISOString()};
 }
 async proposeUpdate(raw:unknown,signal:AbortSignal):Promise<TodoResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'};
  const parsed=todoUpdateRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'};
  const request=parsed.data;
  const requestHash=digest('update',[request.todoId,request.title,request.dueAt,request.assignee]),{proposalId,expiresAt}=this.store({action:'UPDATE',request,requestHash},this.now()+(this.options.proposalTtlMs??300_000));
  return {status:'PROPOSED_UPDATE',proposalId,todoId:request.todoId,title:request.title,dueAt:request.dueAt,assignee:request.assignee,requestHash,expiresAt:new Date(expiresAt).toISOString()};
 }
 async proposeClose(raw:unknown,signal:AbortSignal):Promise<TodoResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'};
  const parsed=todoCloseRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'};
  const todoId=parsed.data.todoId,requestHash=digest('close',[todoId]),{proposalId,expiresAt}=this.store({action:'CLOSE',todoId,requestHash},this.now()+(this.options.proposalTtlMs??300_000));
  return {status:'PROPOSED_CLOSE',proposalId,todoId,requestHash,expiresAt:new Date(expiresAt).toISOString()};
 }
 async read(rawTodoId:unknown,signal:AbortSignal):Promise<TodoResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'};
  const todoId=userId.safeParse(rawTodoId);if(!todoId.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'};
  try{const observed=readShape.parse(await this.options.connector.read({todoId:todoId.data},signal));return {status:'READ',...observed};}catch{return {status:'READ_FAILED',code:'TODO_READBACK_UNAVAILABLE'};}
 }
 async confirm(proposalId:string,signal:AbortSignal):Promise<TodoResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'};
  const proposal=this.proposals.get(proposalId);if(!proposal||proposal.claimed)return {status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_UNKNOWN'};
  if(proposal.expiresAt<=this.now())return {status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_EXPIRED'};
  if(!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'};
  proposal.claimed=true;
  let todoId:string;
  if(proposal.action==='CREATE'){
   try{({todoId}=await this.options.connector.create({...proposal.request,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'TODO_CREATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
  }else if(proposal.action==='UPDATE'){
   try{({todoId}=await this.options.connector.update({...proposal.request,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'TODO_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
   if(todoId!==proposal.request.todoId)return {status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',todoId,effect:'UNKNOWN'};
  }else{
   try{({todoId}=await this.options.connector.close({todoId:proposal.todoId,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'TODO_CLOSE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
   if(todoId!==proposal.todoId)return {status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',todoId,effect:'UNKNOWN'};
  }
  let observed:{todoId:string;title:string;dueAt:string;assignee:string|null;completed:boolean};
  try{observed=readShape.parse(await this.options.connector.read({todoId},signal));}catch{return {status:'VERIFICATION_FAILED',code:'TODO_READBACK_UNAVAILABLE',todoId,effect:'UNKNOWN'};}
  if(proposal.action==='CLOSE')return observed.todoId===proposal.todoId&&observed.completed?{status:'CLOSED',todoId:proposal.todoId}:{status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',todoId:proposal.todoId,effect:'UNKNOWN'};
  const expected=proposal.request;
  if(observed.todoId!==todoId||observed.title!==expected.title||observed.dueAt!==expected.dueAt||observed.assignee!==expected.assignee||observed.completed!==false)return {status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',todoId,effect:'UNKNOWN'};
  return proposal.action==='CREATE'?{status:'VERIFIED',todoId,dueAt:expected.dueAt,assignee:expected.assignee}:{status:'UPDATED',todoId,title:expected.title,dueAt:expected.dueAt,assignee:expected.assignee};
 }
}
