import {generateKeyPairSync} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {nativeCaseRosterPolicySchema,nativeCaseRosterDelegationSchema,nativeCaseRosterTargetSchema,nativeCaseRosterRequestSchema,
  nativeCaseRosterSignedResultSchema,snapshotNativeCaseRosterPolicies,nativeCaseRosterTargetForPolicy,
  validateNativeCaseRosterDelegation,validateNativeCaseRosterResult,NATIVE_CASE_ROSTER_NOTICE,
  type NativeCaseRosterPolicy,type NativeCaseRosterDelegation} from '../../packages/dws/src/native-case-roster-protocol.js';
import {groupDelegationSchema,groupTargetSchema,requestSchema,rpcHash,signEnvelope,openEnvelope} from '../../packages/dws/src/signed-protocol.js';
import {caseRosterDelegationSchema,caseRosterRequestSchema,caseRosterPolicySchema} from '../../packages/dws/src/case-roster-protocol.js';
import {scheduledGroupDelegationSchema,scheduledGroupRequestSchema} from '../../packages/dws/src/scheduled-group-protocol.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-10-19T00:00:00Z'),sha=(letter:string)=>letter.repeat(64);
function policy():NativeCaseRosterPolicy{return {schemaVersion:1,purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',
  principal:{tenantId:id(1),ownerId:id(2),identityId:id(3),authEpoch:4,authorizationVersion:5,audience:{kind:'PRIVATE_USER',id:id(2)},subject:{corpId:'corp',userId:'service-owner'}},
  contractId:id(10),contractVersion:11,contractHash:sha('d'),delegationId:id(12),allowedActions:['case.read','case.create','case.update'],allowedPhases:['EXECUTION','RESULT_VERIFICATION'],
  scopeId:id(6),scopeVersion:7,conversationId:'group-8',profile:{schemaVersion:1,reviewRef:'synthetic-independent-review',conversationPointer:'/conversationId',typePointer:'/kind',typeValue:'GROUP',revisionPointer:'/revision',userCountPointer:'/humans',botCountPointer:'/bots',revisionMeaning:'EVERY_HUMAN_AND_BOT_ROSTER_CHANGE',countMeaning:'ALL_HUMANS_AND_BOTS_INCLUDING_EXTERNAL',independentFromProjectedRoster:true},
  binaryHash:sha('a'),membersSchemaHash:sha('b'),infoSchemaHash:sha('c'),validFrom:now-1000,expiresAt:now+10_000};}
function delegation(p=policy()):NativeCaseRosterDelegation{return {...structuredClone(p.principal),purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',
  requester:{actorId:id(20),authEpoch:21,taskId:id(22),runId:id(23),workerId:id(24),fence:25,deadline:now+20_000,phase:'EXECUTION'},
  contract:{contractId:p.contractId,version:p.contractVersion,revisionHash:p.contractHash,delegationId:p.delegationId},action:'case.read'};}
function request(p=policy(),d=delegation(p)){return nativeCaseRosterRequestSchema.parse({type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:id(30),requestId:id(31),bindingHash:sha('e'),policyHash:sha('f'),issuedAt:now,expiresAt:now+5000,operation:'READ_NATIVE_GROUP_CASE_ROSTER',delegation:d,group:nativeCaseRosterTargetForPolicy(p),state:{schemaVersion:1,files:{}}});}
function result(p=policy(),d=delegation(p)){
  const group=nativeCaseRosterTargetForPolicy(p),users=[{openDingtalkId:'open-requester',role:'member'},{openDingtalkId:'open-service',role:'owner'}],bots=[{openBotId:'bot-1',openDingtalkId:'bot-open',robotCode:'robot-1'}],record={conversationId:p.conversationId,revision:'synthetic-r1',userCount:2,botCount:1};
  return {operation:'READ_NATIVE_GROUP_CASE_ROSTER',grantsAuthority:false,delegationHash:rpcHash(d),group,observation:{contractVersion:'im.group-members.v1',conversationId:p.conversationId,users,bots,membershipHash:rpcHash({contractVersion:'im.group-members.v1',conversationId:p.conversationId,users,bots}),internalMembersVerified:false,platformCountsVerified:true,independentSource:{reviewRef:p.profile.reviewRef,revision:record.revision,userCount:2,botCount:1,recordHash:rpcHash(record),profileHash:group.profileHash}}};
}
const fixed:[string,(d:NativeCaseRosterDelegation)=>NativeCaseRosterDelegation][]=[
  ['tenant',d=>({...d,tenantId:id(90)})],['credential owner and its audience',d=>({...d,ownerId:id(90),audience:{...d.audience,id:id(90)}})],
  ['credential identity',d=>({...d,identityId:id(90)})],['credential owner epoch',d=>({...d,authEpoch:90})],['credential authorization version',d=>({...d,authorizationVersion:90})],
  ['credential corp',d=>({...d,subject:{...d.subject,corpId:'other'}})],['credential user',d=>({...d,subject:{...d.subject,userId:'requester'}})],
  ['contract ID',d=>({...d,contract:{...d.contract,contractId:id(90)}})],['contract version',d=>({...d,contract:{...d.contract,version:90}})],
  ['contract revision hash',d=>({...d,contract:{...d.contract,revisionHash:sha('0')}})],['contract delegation ID',d=>({...d,contract:{...d.contract,delegationId:id(90)}})],
];
const dynamic:[string,(d:NativeCaseRosterDelegation)=>NativeCaseRosterDelegation][]=[
  ['actual requester actor',d=>({...d,requester:{...d.requester,actorId:id(90)}})],['actual requester epoch',d=>({...d,requester:{...d.requester,authEpoch:90}})],
  ['task',d=>({...d,requester:{...d.requester,taskId:id(90)}})],['run',d=>({...d,requester:{...d.requester,runId:id(90)}})],
  ['worker',d=>({...d,requester:{...d.requester,workerId:id(90)}})],['fence',d=>({...d,requester:{...d.requester,fence:90}})],
  ['fixed authority deadline',d=>({...d,requester:{...d.requester,deadline:now+19_000}})],['phase',d=>({...d,requester:{...d.requester,phase:'RESULT_VERIFICATION'}})],
];

describe('native group case roster pure leaf (no SQL or membership authority)',()=>{
  it('preserves a member requester distinct from the reviewed service credential owner',()=>{
    const p=policy(),d=delegation(p),original=structuredClone({p,d}),accepted=validateNativeCaseRosterDelegation(d,p,{now}),r=validateNativeCaseRosterResult(result(p,d),{delegation:d,policy:p,now});
    expect(accepted.requester.actorId).toBe(id(20));expect(accepted.ownerId).toBe(id(2));expect(accepted.requester.actorId).not.toBe(accepted.ownerId);
    expect(r.grantsAuthority).toBe(false);expect(r.value.internalMembersVerified).toBe(false);expect(r.notice).toBe(NATIVE_CASE_ROSTER_NOTICE);expect(r.notice).toContain('不证明');expect(r.notice).toContain('SUCCEEDED');expect({p,d}).toEqual(original);
    expect(Object.isFrozen(accepted.requester)).toBe(true);expect(Object.isFrozen(r.value.users)).toBe(true);
  });
  it.each(fixed)('rejects fixed reviewed binding mismatch: %s',(_name,change)=>{expect(()=>validateNativeCaseRosterDelegation(change(delegation()),policy(),{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');});
  it.each(dynamic)('binds %s as a signed assertion and refuses copying an earlier response',(_name,change)=>{
    const p=policy(),d=delegation(p),next=change(d),keys=generateKeyPairSync('ed25519'),original=request(p,d),changed=request(p,next),signed=signEnvelope(original,'synthetic-native-key',keys.privateKey);
    expect(validateNativeCaseRosterDelegation(next,p,{now})).toEqual(next); // SQL is responsible for proving these claims.
    expect(rpcHash(next)).not.toBe(rpcHash(d));expect(rpcHash(changed)).not.toBe(rpcHash(original));
    expect(openEnvelope(signed,'synthetic-native-key',keys.publicKey,nativeCaseRosterRequestSchema)).toEqual(original);
    expect(()=>openEnvelope({...signed,payload:changed},'synthetic-native-key',keys.publicKey,nativeCaseRosterRequestSchema)).toThrow('DWS_RPC_SIGNATURE_INVALID');
    expect(()=>validateNativeCaseRosterResult(result(p,d),{delegation:next,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
    expect(validateNativeCaseRosterResult(result(p,next),{delegation:next,policy:p,now}).grantsAuthority).toBe(false);
  });
  it('requires explicit unique action and phase allowlists and never widens missing policy',()=>{
    const p=policy(),d=delegation(p);
    for(const allowedActions of [undefined,[],['case.read','case.read'],['question.answer']])expect(nativeCaseRosterPolicySchema.safeParse({...p,allowedActions}).success).toBe(false);
    for(const allowedPhases of [undefined,[],['EXECUTION','EXECUTION'],['RUNNING'],['EXECUTION','RESULT_VERIFICATION','EXECUTION']])expect(nativeCaseRosterPolicySchema.safeParse({...p,allowedPhases}).success).toBe(false);
    expect(()=>validateNativeCaseRosterDelegation({...d,action:'case.create'},{...p,allowedActions:['case.read']},{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    expect(()=>validateNativeCaseRosterDelegation(d,{...p,allowedPhases:['RESULT_VERIFICATION']},{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    expect(()=>validateNativeCaseRosterDelegation({...d,requester:{...d.requester,phase:'RESULT_VERIFICATION'}},{...p,allowedPhases:['EXECUTION']},{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
  });
  it('allows create/update only during installed EXECUTION, while RESULT_VERIFICATION is always read-only',()=>{
    const p=policy(),d=delegation(p);
    for(const action of ['case.create','case.update'] as const){
      expect(validateNativeCaseRosterDelegation({...d,action},p,{now}).action).toBe(action);
      const claimed={...d,action,requester:{...d.requester,phase:'RESULT_VERIFICATION'}};
      expect(nativeCaseRosterDelegationSchema.safeParse(claimed).success).toBe(false);
      expect(()=>validateNativeCaseRosterDelegation(claimed,p,{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    }
    expect(validateNativeCaseRosterDelegation({...d,requester:{...d.requester,phase:'RESULT_VERIFICATION'}},{...p,allowedPhases:['RESULT_VERIFICATION']},{now}).action).toBe('case.read');
    expect(()=>validateNativeCaseRosterResult(result(p,d),{delegation:{...d,action:'case.create',requester:{...d.requester,phase:'RESULT_VERIFICATION'}},policy:p,now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
  });
  it('checks policy validity and fixed requester deadline endpoints without inventing a renewed lease',()=>{
    const p=policy(),d=delegation(p);
    expect(validateNativeCaseRosterDelegation(d,p,{now:p.validFrom})).toEqual(d);
    expect(validateNativeCaseRosterDelegation(d,p,{now:p.expiresAt-1})).toEqual(d);
    for(const clock of [p.validFrom-1,p.expiresAt,NaN,Infinity,-1,now+0.1,Number.MAX_SAFE_INTEGER+1])expect(()=>validateNativeCaseRosterDelegation(d,p,{now:clock})).toThrow('DWS_RPC_EXPIRED');
    const shorter={...d,requester:{...d.requester,deadline:now+500}};
    expect(validateNativeCaseRosterDelegation(shorter,p,{now:now+499})).toEqual(shorter);
    expect(()=>validateNativeCaseRosterResult(result(p,shorter),{delegation:shorter,policy:p,now:now+500})).toThrow('DWS_RPC_EXPIRED');
    expect(nativeCaseRosterPolicySchema.safeParse({...p,expiresAt:p.validFrom}).success).toBe(false);
    for(const field of ['leaseUntil','leaseExpiresAt','remainingActiveMs'])expect(nativeCaseRosterDelegationSchema.safeParse({...d,requester:{...d.requester,[field]:now+30_000}}).success).toBe(false);
  });
  it('bounds the new request leaf by positive 10s RPC lifetime and the fixed requester deadline',()=>{
    const original=request(),d=delegation();
    expect(nativeCaseRosterRequestSchema.safeParse({...original,expiresAt:now+10_000}).success).toBe(true);
    for(const change of [{expiresAt:now},{expiresAt:now-1},{expiresAt:now+10_001},{expiresAt:Infinity},{issuedAt:now+0.1}])expect(nativeCaseRosterRequestSchema.safeParse({...original,...change}).success).toBe(false);
    const shorter={...original,delegation:{...d,requester:{...d.requester,deadline:now+1000}}};
    expect(nativeCaseRosterRequestSchema.safeParse({...shorter,expiresAt:now+1000}).success).toBe(true);
    expect(nativeCaseRosterRequestSchema.safeParse({...shorter,expiresAt:now+1001}).success).toBe(false);
  });
  it('rejects invalid requester references/integers, mismatched owner audience and all unknown native fields',()=>{
    const p=policy(),d=delegation(p);
    for(const field of ['actorId','taskId','runId','workerId'])expect(nativeCaseRosterDelegationSchema.safeParse({...d,requester:{...d.requester,[field]:'not-a-uuid'}}).success).toBe(false);
    for(const field of ['authEpoch','fence','deadline'])for(const value of [-1,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1])expect(nativeCaseRosterDelegationSchema.safeParse({...d,requester:{...d.requester,[field]:value}}).success).toBe(false);
    for(const field of ['authEpoch','fence'])expect(nativeCaseRosterDelegationSchema.safeParse({...d,requester:{...d.requester,[field]:0}}).success).toBe(false);
    for(const field of ['sessionId','scheduleId','requestId','lease','approved'])expect(nativeCaseRosterDelegationSchema.safeParse({...d,requester:{...d.requester,[field]:id(90)}}).success).toBe(false);
    for(const field of ['sessionId','taskId','runId','argv','endpoint','scheduled','authorization'])expect(nativeCaseRosterDelegationSchema.safeParse({...d,[field]:'untrusted'}).success).toBe(false);
    expect(nativeCaseRosterPolicySchema.safeParse({...p,principal:{...p.principal,audience:{kind:'PRIVATE_USER',id:id(20)}}}).success).toBe(false);
    expect(nativeCaseRosterDelegationSchema.safeParse({...d,audience:{kind:'PRIVATE_USER',id:id(20)}}).success).toBe(false);
    for(const raw of [{...p,approved:true},{...p,principal:{...p.principal,role:'ADMIN'}},{...p,profile:{...p.profile,verified:true}}])expect(nativeCaseRosterPolicySchema.safeParse(raw).success).toBe(false);
    expect(nativeCaseRosterDelegationSchema.safeParse({...d,contract:{...d.contract,approved:true}}).success).toBe(false);
    for(const raw of [undefined,null,{}])expect(()=>validateNativeCaseRosterDelegation(d,raw,{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
  });
  it('freezes independent 32-policy snapshots and rejects absent/duplicate scope definitions without installing them',()=>{
    const raw=policy(),snapshot=snapshotNativeCaseRosterPolicies([raw]);raw.profile.reviewRef='mutated';raw.allowedPhases.pop();
    expect(snapshot[0]?.profile.reviewRef).toBe('synthetic-independent-review');expect(snapshot[0]?.allowedPhases).toEqual(['EXECUTION','RESULT_VERIFICATION']);
    for(const value of [snapshot,snapshot[0],snapshot[0]?.principal,snapshot[0]?.principal.subject,snapshot[0]?.allowedPhases,snapshot[0]?.allowedActions,snapshot[0]?.profile])expect(Object.isFrozen(value)).toBe(true);
    expect(()=>{snapshot[0]!.principal.subject.userId='other';}).toThrow();expect(snapshotNativeCaseRosterPolicies(undefined)).toEqual([]);expect(snapshotNativeCaseRosterPolicies([])).toEqual([]);
    for(const raw of [null,[{}],[policy(),policy()],Array.from({length:33},(_,n)=>({...policy(),scopeId:id(100+n)}))])expect(()=>snapshotNativeCaseRosterPolicies(raw)).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');
    expect(snapshotNativeCaseRosterPolicies(Array.from({length:32},(_,n)=>({...policy(),scopeId:id(100+n)})))).toHaveLength(32);
    const reference='abcdef00-0000-4000-8000-000000000001';
    expect(nativeCaseRosterPolicySchema.safeParse({...policy(),scopeId:reference.toUpperCase()}).success).toBe(true);
    expect(()=>snapshotNativeCaseRosterPolicies([{...policy(),scopeId:reference},{...policy(),scopeId:reference.toUpperCase()}])).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');
  });
  it('pins the entire reviewed policy in its distinct target hash',()=>{
    const p=policy(),target=nativeCaseRosterTargetForPolicy(p);expect(nativeCaseRosterTargetSchema.parse(target)).toEqual(groupTargetSchema.parse(target));expect(target.scopeHash).toBe(rpcHash(p));
    const changes=[{...p,contractId:id(90)},{...p,contractVersion:90},{...p,contractHash:sha('0')},{...p,delegationId:id(90)},
      {...p,scopeId:id(90)},{...p,scopeVersion:90},{...p,conversationId:'other-group'},{...p,profile:{...p.profile,reviewRef:'other-review'}},
      {...p,binaryHash:sha('0')},{...p,membersSchemaHash:sha('0')},{...p,infoSchemaHash:sha('0')},{...p,validFrom:p.validFrom-1},{...p,expiresAt:p.expiresAt+1},
      {...p,allowedActions:['case.read']},{...p,allowedPhases:['EXECUTION']},...fixed.slice(0,7).map(([,change])=>{const d=change(delegation(p));return {...p,principal:{tenantId:d.tenantId,ownerId:d.ownerId,identityId:d.identityId,authEpoch:d.authEpoch,authorizationVersion:d.authorizationVersion,audience:d.audience,subject:d.subject}};})];
    for(const changed of changes)expect(nativeCaseRosterTargetForPolicy(changed).scopeHash).not.toBe(target.scopeHash);
    const {contractVersion:_version,contractHash:_hash,allowedPhases:_phases,...oldBase}=p;
    const oldPolicy=caseRosterPolicySchema.parse({...oldBase,purpose:'H5_SESSION',capabilityBindingId:'dws.group.case-roster.v1'});
    expect(target.scopeHash).not.toBe(rpcHash(oldPolicy));
  });
  it('keeps all old H5/native-ask/scheduled leaves strict and rejects them in the new leaf',()=>{
    const p=policy(),d=delegation(p),original=request(p,d),principal=p.principal;
    const nativeAsk={...principal,taskId:id(22),runId:id(23),capabilityBindingId:'dws.group.audience.v1'};
    const h5={...principal,purpose:'H5_SESSION',capabilityBindingId:'dws.group.case-roster.v1',requester:{actorId:id(20),sessionId:id(40),authEpoch:21},contract:d.contract,action:'case.read'};
    const scheduled={...principal,purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',contract:d.contract,authorization:{id:id(41),version:1,documentHash:sha('a')},scheduled:{scheduleId:id(42),revision:1,generation:1,occurrenceId:id(43),fence:1,scheduledAt:'2026-10-19T00:00:00Z',notificationId:id(44),originHash:sha('b'),phase:'PLAN'}};
    const oldLeaves=[{schema:requestSchema,value:{...original,operation:'READ_GROUP_AUDIENCE',delegation:nativeAsk}},{schema:caseRosterRequestSchema,value:{...original,operation:'READ_GROUP_CASE_ROSTER',delegation:h5}},{schema:scheduledGroupRequestSchema,value:{...original,operation:'READ_GROUP_REMINDER_AUDIENCE',delegation:scheduled}}];
    expect(groupDelegationSchema.safeParse(nativeAsk).success).toBe(true);expect(caseRosterDelegationSchema.safeParse(h5).success).toBe(true);expect(scheduledGroupDelegationSchema.safeParse(scheduled).success).toBe(true);
    for(const leaf of oldLeaves){expect(leaf.schema.safeParse(leaf.value).success).toBe(true);expect(leaf.schema.safeParse(original).success).toBe(false);expect(nativeCaseRosterRequestSchema.safeParse(leaf.value).success).toBe(false);expect(nativeCaseRosterDelegationSchema.safeParse(leaf.value.delegation).success).toBe(false);}
    for(const oldSchema of [groupDelegationSchema,caseRosterDelegationSchema,scheduledGroupDelegationSchema])expect(oldSchema.safeParse(d).success).toBe(false);
    for(const change of [{purpose:'H5_SESSION'},{purpose:'SCHEDULED_CONTRACT'},{capabilityBindingId:'dws.group.audience.v1'},{capabilityBindingId:'dws.group.case-roster.v1'},{capabilityBindingId:'dws.group.reminder-audience.v1'}])expect(nativeCaseRosterDelegationSchema.safeParse({...d,...change}).success).toBe(false);
    // Ed25519 key/domain is unchanged. Isolation is by signed strict leaf fields, not a fictitious new cryptographic protocol.
  });
  it('rejects every target dimension, unbound result operation, authority and unknown result keys',()=>{
    const p=policy(),d=delegation(p),r=result(p,d);
    for(const group of [{...r.group,conversationId:'other'},{...r.group,scopeId:id(90)},{...r.group,scopeVersion:90},...(['scopeHash','profileHash','binaryHash','membersSchemaHash','infoSchemaHash'] as const).map(field=>({...r.group,[field]:sha('0')})),{...r.group,path:'untrusted'}])expect(()=>validateNativeCaseRosterResult({...r,group},{delegation:d,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
    for(const change of [{operation:'READ_GROUP_CASE_ROSTER'},{operation:'READ_GROUP_AUDIENCE'},{operation:'READ_GROUP_REMINDER_AUDIENCE'},{grantsAuthority:true},{delegationHash:sha('0')},{published:true}])expect(()=>validateNativeCaseRosterResult({...r,...change},{delegation:d,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
  });
  it('reuses actual complete independent observation checks and never elevates platform counts to internal authority',()=>{
    const p=policy(),d=delegation(p),r=result(p,d),o=r.observation;
    for(const observation of [null,{...o,internalMembersVerified:true},{...o,platformCountsVerified:false},{...o,users:[...o.users,...o.users]},{...o,users:[...o.users].reverse()},{...o,membershipHash:sha('0')},{...o,partial:true},{...o,independentSource:{...o.independentSource,userCount:1}},{...o,independentSource:{...o.independentSource,botCount:0}},{...o,independentSource:{...o.independentSource,recordHash:sha('0')}},{...o,independentSource:{...o.independentSource,profileHash:sha('0')}}])expect(nativeCaseRosterSignedResultSchema.safeParse({...r,observation}).success).toBe(false);
    expect(()=>validateNativeCaseRosterResult({...r,observation:{...o,independentSource:{...o.independentSource,reviewRef:'other-review'}}},{delegation:d,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
  });
  it('binds an allowed execution action change and explicitly does not prove live or historical authority',()=>{
    const p=policy(),d=delegation(p),changed:NativeCaseRosterDelegation={...d,action:'case.update'};
    expect(()=>validateNativeCaseRosterResult(result(p,d),{delegation:changed,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
    const invented={...d,requester:{...d.requester,actorId:id(91),taskId:id(92),runId:id(93),workerId:id(94),fence:999}};
    expect(validateNativeCaseRosterDelegation(invented,p,{now})).toEqual(invented); // Intentionally no DB membership/lease lookup.
    expect(validateNativeCaseRosterDelegation({...invented,requester:{...invented.requester,phase:'RESULT_VERIFICATION'}},p,{now}).requester.phase).toBe('RESULT_VERIFICATION'); // Does not prove persisted SUCCEEDED.
    const keys=generateKeyPairSync('ed25519'),signed=signEnvelope(request(p,invented),'synthetic-key',keys.privateKey);
    expect(openEnvelope(signed,'synthetic-key',keys.publicKey,nativeCaseRosterRequestSchema).delegation.requester.actorId).toBe(id(91));
  });
});
