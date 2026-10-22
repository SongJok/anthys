import {randomUUID} from 'node:crypto';
import {TodoCoordinator,type TodoConnector} from '../../packages/office/src/todos.js';

const now=Date.parse('2026-10-21T00:00:00.000Z'),assignee=randomUUID();
const request={title:'Synthetic todo',dueAt:'2026-10-21T10:00:00.000Z',assignee};
class SyntheticTodos implements TodoConnector{
 created:Parameters<TodoConnector['create']>[0][]=[];updated:Parameters<TodoConnector['update']>[0][]=[];closed:Parameters<TodoConnector['close']>[0][]=[];
 failCreate=false;failUpdate=false;failClose=false;failRead=false;
 mutateRead:((todo:{todoId:string;title:string;dueAt:string;assignee:string|null;completed:boolean})=>typeof todo)|undefined;
 private readonly todos=new Map<string,{todoId:string;title:string;dueAt:string;assignee:string|null;completed:boolean}>();
 async create(input:Parameters<TodoConnector['create']>[0]){this.created.push(input);if(this.failCreate)throw Error('SYNTHETIC_CREATE_FAILED');const todoId=randomUUID();this.todos.set(todoId,{todoId,title:input.title,dueAt:input.dueAt,assignee:input.assignee,completed:false});return {todoId};}
 async update(input:Parameters<TodoConnector['update']>[0]){this.updated.push(input);if(this.failUpdate)throw Error('SYNTHETIC_UPDATE_FAILED');const todo=this.todos.get(input.todoId)!;this.todos.set(input.todoId,{...todo,title:input.title,dueAt:input.dueAt,assignee:input.assignee});return {todoId:input.todoId};}
 async close(input:Parameters<TodoConnector['close']>[0]){this.closed.push(input);if(this.failClose)throw Error('SYNTHETIC_CLOSE_FAILED');const todo=this.todos.get(input.todoId)!;this.todos.set(input.todoId,{...todo,completed:true});return {todoId:input.todoId};}
 async read({todoId}:{todoId:string}){if(this.failRead)throw Error('SYNTHETIC_READ_FAILED');const todo=this.todos.get(todoId)!;return this.mutateRead?this.mutateRead({...todo}):todo;}
}

it('proposes without an external call and verifies the exact created todo once',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now});
 const proposal=await coordinator.propose(request,new AbortController().signal);
 expect(proposal).toMatchObject({status:'PROPOSED',title:request.title,dueAt:request.dueAt,assignee,expiresAt:new Date(now+300_000).toISOString()});
 expect((proposal as {requestHash:string}).requestHash).toMatch(/^[a-f0-9]{64}$/);
 expect(connector.created).toHaveLength(0);
 const result=await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal);
 expect(result).toMatchObject({status:'VERIFIED',dueAt:request.dueAt,assignee});
 expect(connector.created).toHaveLength(1);expect(connector.created[0]).toMatchObject({title:request.title,dueAt:request.dueAt,assignee,requestHash:(proposal as {requestHash:string}).requestHash});
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_UNKNOWN'});
 expect(connector.created).toHaveLength(1);
});

it('rejects unknown and expired proposals without a create call',async()=>{
 const connector=new SyntheticTodos();let clock=now;const coordinator=new TodoCoordinator({connector,now:()=>clock,proposalTtlMs:1000});
 expect(await coordinator.confirm(randomUUID(),new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_UNKNOWN'});
 const proposal=await coordinator.propose(request,new AbortController().signal);clock=now+1000;
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_EXPIRED'});
 expect(connector.created).toHaveLength(0);
});

it('never reports success for an unknown create outcome or an unavailable or mismatched read-back',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now});
 async function confirm(){const proposal=await coordinator.propose(request,new AbortController().signal);return coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal);}
 connector.failCreate=true;expect(await confirm()).toMatchObject({status:'UNKNOWN',code:'TODO_CREATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 connector.failCreate=false;connector.failRead=true;expect(await confirm()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_UNAVAILABLE',effect:'UNKNOWN'});
 connector.failRead=false;connector.mutateRead=todo=>({...todo,assignee:null});expect(await confirm()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',effect:'UNKNOWN'});
 connector.mutateRead=todo=>({...todo,completed:true});expect(await confirm()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',effect:'UNKNOWN'});
 connector.mutateRead=undefined;expect(await confirm()).toMatchObject({status:'VERIFIED'});
});

it('defaults to blocked external, rejects invalid or past due requests and honors abort',async()=>{
 expect(await new TodoCoordinator({connector:null,now:()=>now}).propose(request,new AbortController().signal)).toMatchObject({status:'BLOCKED_EXTERNAL',code:'TODO_CONNECTOR_UNAVAILABLE'});
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now});
 for(const invalid of [{...request,title:'  '},{...request,title:'bad\u0000title'},{...request,dueAt:'not-a-date'},{...request,assignee:'not-a-uuid'},{...request,extra:true}]){
  expect(await coordinator.propose(invalid,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 }
 expect(await coordinator.propose({...request,dueAt:new Date(now).toISOString()},new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_DUE_AT_NOT_FUTURE'});
 const abort=new AbortController();abort.abort();
 expect(await coordinator.propose(request,abort.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 const proposal=await coordinator.propose(request,new AbortController().signal),abortedConfirm=new AbortController();abortedConfirm.abort();
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,abortedConfirm.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 expect(connector.created).toHaveLength(0);
});

async function created(coordinator:TodoCoordinator){
 const proposal=await coordinator.propose(request,new AbortController().signal),result=await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal);
 return (result as {todoId:string}).todoId;
}

it('reads one bounded todo and rejects invalid ids or abort',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now}),todoId=await created(coordinator);
 expect(await coordinator.read(todoId,new AbortController().signal)).toMatchObject({status:'READ',todoId,title:request.title,dueAt:request.dueAt,assignee,completed:false});
 expect(await coordinator.read('not-a-uuid',new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 const aborted=new AbortController();aborted.abort();
 expect(await coordinator.read(todoId,aborted.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 connector.failRead=true;expect(await coordinator.read(todoId,new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'TODO_READBACK_UNAVAILABLE'});
});

it('updates through one consumed proposal and verifies the exact read-back',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now}),todoId=await created(coordinator);
 const next={todoId,title:'Updated todo',dueAt:'2026-10-22T10:00:00.000Z',assignee:null};
 async function confirmUpdate(){const proposal=await coordinator.proposeUpdate(next,new AbortController().signal);return coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal);}
 const proposal=await coordinator.proposeUpdate(next,new AbortController().signal);
 expect(proposal).toMatchObject({status:'PROPOSED_UPDATE',todoId,title:next.title,dueAt:next.dueAt,assignee:null});
 expect(connector.updated).toHaveLength(0);
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'UPDATED',todoId,title:next.title,dueAt:next.dueAt,assignee:null});
 expect(connector.updated).toHaveLength(1);expect(connector.updated[0]).toMatchObject({todoId,title:next.title,dueAt:next.dueAt,assignee:null,requestHash:(proposal as {requestHash:string}).requestHash});
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_UNKNOWN'});
 expect(await coordinator.read(todoId,new AbortController().signal)).toMatchObject({title:next.title,assignee:null,completed:false});
 connector.failUpdate=true;expect(await confirmUpdate()).toMatchObject({status:'UNKNOWN',code:'TODO_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 connector.failUpdate=false;connector.mutateRead=todo=>({...todo,title:'unexpected'});expect(await confirmUpdate()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',effect:'UNKNOWN'});
 connector.mutateRead=undefined;connector.failRead=true;expect(await confirmUpdate()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_UNAVAILABLE',effect:'UNKNOWN'});
 expect(connector.updated).toHaveLength(4);
});

it('closes through one consumed proposal and verifies completion',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now}),todoId=await created(coordinator);
 async function confirmClose(){const proposal=await coordinator.proposeClose({todoId},new AbortController().signal);return coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal);}
 const proposal=await coordinator.proposeClose({todoId},new AbortController().signal);
 expect(proposal).toMatchObject({status:'PROPOSED_CLOSE',todoId});
 expect(connector.closed).toHaveLength(0);
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'CLOSED',todoId});
 expect(connector.closed).toHaveLength(1);expect(connector.closed[0]).toMatchObject({todoId,requestHash:(proposal as {requestHash:string}).requestHash});
 expect(await coordinator.confirm((proposal as {proposalId:string}).proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_PROPOSAL_UNKNOWN'});
 expect(await coordinator.read(todoId,new AbortController().signal)).toMatchObject({completed:true});
 connector.failClose=true;expect(await confirmClose()).toMatchObject({status:'UNKNOWN',code:'TODO_CLOSE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 connector.failClose=false;connector.mutateRead=todo=>({...todo,completed:false});expect(await confirmClose()).toMatchObject({status:'VERIFICATION_FAILED',code:'TODO_READBACK_MISMATCH',effect:'UNKNOWN'});
 expect(connector.closed).toHaveLength(3);
});

it('rejects invalid update or close proposals before any external mutation',async()=>{
 const connector=new SyntheticTodos(),coordinator=new TodoCoordinator({connector,now:()=>now}),todoId=await created(coordinator);
 for(const invalid of [{todoId:'not-a-uuid',...request},{todoId,...request,title:'  '},{todoId,...request,extra:true}]){
  expect(await coordinator.proposeUpdate(invalid,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 }
 expect(await coordinator.proposeClose({todoId:'not-a-uuid'},new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 const aborted=new AbortController();aborted.abort();
 expect(await coordinator.proposeClose({todoId},aborted.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'TODO_REQUEST_INVALID'});
 expect(connector.updated).toHaveLength(0);expect(connector.closed).toHaveLength(0);
});
