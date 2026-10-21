import {advanceCase,caseCommand,caseDetails,caseStates,type CaseLifecycle,type CaseCommand} from '../../packages/groups/src/case-model.js';
const owner='10000000-0000-4000-8000-000000000001',admin='20000000-0000-4000-8000-000000000002',outsider='30000000-0000-4000-8000-000000000003';
const item=(state:CaseLifecycle['state']='IN_PROGRESS'):CaseLifecycle=>({state,ownerId:owner,createdBy:owner,blockedReason:'dependency',completion:null});
const commands:CaseCommand[]=[{operation:'OPEN'},{operation:'ASSIGN',ownerId:admin},{operation:'START'},{operation:'BLOCK',reason:'blocked'},{operation:'CLAIM_COMPLETE',statement:'好了'},{operation:'CONFIRM',statement:'reviewed'},{operation:'CLOSE'},{operation:'CANCEL'}];

it('unrelated members cannot take responsibility, complete, confirm or cancel any case state',()=>{
 for(const state of caseStates)for(const command of commands)expect(()=>advanceCase(item(state),command,{actorId:outsider,administrator:false,ownerReportedAllowed:true})).toThrow('GROUP_CASE_TRANSITION_DENIED');
});
it('terminal cases cannot be reopened even by an administrator who owns the case',()=>{
 for(const state of ['CLOSED','CANCELLED'] as const)for(const command of commands)expect(()=>advanceCase(item(state),command,{actorId:owner,administrator:true,ownerReportedAllowed:true})).toThrow();
});
it('a completion declaration never gains automatic verification and a dual-role owner cannot confirm their own declaration',()=>{
 const initial=item(),waiting=advanceCase(initial,{operation:'CLAIM_COMPLETE',statement:'好了'},{actorId:owner,administrator:true,ownerReportedAllowed:false});
 expect(initial).toEqual(item());expect(waiting).toMatchObject({state:'WAITING_CONFIRMATION',blockedReason:null,completion:{method:'UNVERIFIED'}});
 expect(()=>advanceCase(waiting,{operation:'CONFIRM',statement:'自己确认'},{actorId:owner,administrator:true,ownerReportedAllowed:false})).toThrow();
 expect(advanceCase(waiting,{operation:'CONFIRM',statement:'独立人工确认'},{actorId:admin,administrator:true,ownerReportedAllowed:false})).toMatchObject({state:'RESOLVED',completion:{method:'ADMIN_CONFIRMED',actorId:admin}});
 const reported=advanceCase(item('BLOCKED'),{operation:'CLAIM_COMPLETE',statement:'自报'},{actorId:owner,administrator:false,ownerReportedAllowed:true});expect(reported).toMatchObject({state:'RESOLVED',completion:{method:'OWNER_REPORTED'}});
});
it('reassignment removes the former owner completion and blocked reason; reopening from blocked remains owner-only',()=>{
 const pending={...item('WAITING_CONFIRMATION'),completion:{method:'UNVERIFIED' as const,actorId:owner,statement:'旧声明'}};
 expect(advanceCase(pending,{operation:'ASSIGN',ownerId:admin},{actorId:admin,administrator:true,ownerReportedAllowed:false})).toEqual({...item('ASSIGNED'),ownerId:admin,blockedReason:null});
 expect(advanceCase(item('BLOCKED'),{operation:'START'},{actorId:owner,administrator:false,ownerReportedAllowed:false})).toMatchObject({state:'IN_PROGRESS',blockedReason:null});
 expect(advanceCase(item('PROPOSED'),{operation:'CANCEL'},{actorId:owner,administrator:false,ownerReportedAllowed:false}).state).toBe('CANCELLED');
});
it('case inputs reject invented verification/authority fields, owner guessing and incomplete completion statements',()=>{
 expect(caseDetails.safeParse({title:'x',resourceRef:'resource',priority:'NORMAL',dueAt:null,ownerId:owner}).success).toBe(false);
 expect(caseCommand.safeParse({operation:'CLAIM_COMPLETE',statement:'好了',verification:{state:'VERIFIED'}}).success).toBe(false);
 expect(caseCommand.safeParse({operation:'CONFIRM',statement:' '}).success).toBe(false);
});
it('administrator status cannot skip acceptance, assignment, completion review or close prerequisites',()=>{
 for(const [state,command] of [
  ['IN_PROGRESS',{operation:'OPEN'}],['PROPOSED',{operation:'ASSIGN',ownerId:admin}],
  ['OPEN',{operation:'START'}],['PROPOSED',{operation:'BLOCK',reason:'x'}],
  ['OPEN',{operation:'CLAIM_COMPLETE',statement:'x'}],['IN_PROGRESS',{operation:'CONFIRM',statement:'x'}],
  ['WAITING_CONFIRMATION',{operation:'CLOSE'}],
 ] as [CaseLifecycle['state'],CaseCommand][]){
  expect(()=>advanceCase(item(state),command,{actorId:command.operation==='CONFIRM'?admin:owner,administrator:true,ownerReportedAllowed:true})).toThrow();
 }
 expect(advanceCase(item('OPEN'),{operation:'CANCEL'},{actorId:admin,administrator:true,ownerReportedAllowed:false}).state).toBe('CANCELLED');
});
