import {generateKeyPairSync} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {scheduledGroupPolicySchema,scheduledGroupDelegationSchema,scheduledGroupRequestSchema,
 scheduledGroupSignedResultSchema,snapshotScheduledGroupPolicies,scheduledGroupTargetForPolicy,
 validateScheduledGroupDelegation,validateScheduledGroupResult,type ScheduledGroupPolicy,type ScheduledGroupDelegation} from '../../packages/dws/src/scheduled-group-protocol.js';
import {groupTargetSchema,groupDelegationSchema,requestSchema,rpcHash,signEnvelope,openEnvelope} from '../../packages/dws/src/signed-protocol.js';
import {caseRosterDelegationSchema} from '../../packages/dws/src/case-roster-protocol.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-10-19T00:00:00Z'),sha=(c:string)=>c.repeat(64);
function policy():ScheduledGroupPolicy{return {schemaVersion:1,purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',
 principal:{tenantId:id(1),ownerId:id(2),identityId:id(3),authEpoch:4,authorizationVersion:5,audience:{kind:'PRIVATE_USER',id:id(2)},subject:{corpId:'corp',userId:'service-A'}},
 contractId:id(10),delegationId:id(11),scheduleId:id(12),proactiveAuthorizationId:id(13),proactiveAuthorizationHash:sha('d'),
 scopeId:id(6),scopeVersion:7,conversationId:'group-8',profile:{schemaVersion:1,reviewRef:'synthetic-profile-review',conversationPointer:'/conversationId',typePointer:'/kind',typeValue:'GROUP',revisionPointer:'/revision',userCountPointer:'/humans',botCountPointer:'/bots',revisionMeaning:'EVERY_HUMAN_AND_BOT_ROSTER_CHANGE',countMeaning:'ALL_HUMANS_AND_BOTS_INCLUDING_EXTERNAL',independentFromProjectedRoster:true},
 binaryHash:sha('a'),membersSchemaHash:sha('b'),infoSchemaHash:sha('c'),validFrom:now-1000,expiresAt:now+5000};}
function delegation(p=policy()):ScheduledGroupDelegation{return {...structuredClone(p.principal),purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',
 contract:{contractId:p.contractId,delegationId:p.delegationId,version:1,revisionHash:sha('e')},authorization:{id:p.proactiveAuthorizationId,version:2,documentHash:p.proactiveAuthorizationHash},
 scheduled:{scheduleId:p.scheduleId,revision:1,generation:2,occurrenceId:id(20),fence:3,scheduledAt:'2026-10-19T00:00:00Z',notificationId:id(21),originHash:sha('f'),phase:'PLAN'}};}
function request(p=policy(),d=delegation(p)){return scheduledGroupRequestSchema.parse({type:'READ_REQUEST',protocol:'OA_DWS_READ_V1',instanceId:id(30),requestId:id(31),bindingHash:sha('a'),policyHash:sha('b'),issuedAt:now,expiresAt:now+1000,operation:'READ_GROUP_REMINDER_AUDIENCE',delegation:d,group:scheduledGroupTargetForPolicy(p),state:{schemaVersion:1,files:{}}});}
function result(p=policy(),d=delegation(p)){
 const group=scheduledGroupTargetForPolicy(p),users=[{openDingtalkId:'open-A',role:'owner'}],bots:never[]=[],record={conversationId:p.conversationId,revision:'r1',userCount:1,botCount:0};
 return {operation:'READ_GROUP_REMINDER_AUDIENCE',grantsAuthority:false,delegationHash:rpcHash(d),group,observation:{contractVersion:'im.group-members.v1',conversationId:p.conversationId,users,bots,membershipHash:rpcHash({contractVersion:'im.group-members.v1',conversationId:p.conversationId,users,bots}),internalMembersVerified:false,platformCountsVerified:true,independentSource:{reviewRef:p.profile.reviewRef,revision:'r1',userCount:1,botCount:0,recordHash:rpcHash(record),profileHash:group.profileHash}}};
}
const dynamic:[string,(d:ScheduledGroupDelegation)=>ScheduledGroupDelegation][]=[
 ['schedule revision',d=>({...d,scheduled:{...d.scheduled,revision:9}})],
 ['generation',d=>({...d,scheduled:{...d.scheduled,generation:9}})],
 ['occurrenceId',d=>({...d,scheduled:{...d.scheduled,occurrenceId:id(90)}})],
 ['fence',d=>({...d,scheduled:{...d.scheduled,fence:9}})],
 ['scheduledAt',d=>({...d,scheduled:{...d.scheduled,scheduledAt:'2026-10-19T00:00:01Z'}})],
 ['notificationId',d=>({...d,scheduled:{...d.scheduled,notificationId:id(91)}})],
 ['originHash',d=>({...d,scheduled:{...d.scheduled,originHash:sha('0')}})],
 ['phase',d=>({...d,scheduled:{...d.scheduled,phase:'SEND'}})],
 ['contract version',d=>({...d,contract:{...d.contract,version:9}})],
 ['contract revisionHash',d=>({...d,contract:{...d.contract,revisionHash:sha('0')}})],
 ['authorization version',d=>({...d,authorization:{...d.authorization,version:9}})],
];
const fixed:[string,(d:ScheduledGroupDelegation)=>ScheduledGroupDelegation][]=[
 ['tenantId',d=>({...d,tenantId:id(90)})],['ownerId+audience',d=>({...d,ownerId:id(90),audience:{...d.audience,id:id(90)}})],
 ['identityId',d=>({...d,identityId:id(90)})],['authEpoch',d=>({...d,authEpoch:9})],['authorizationVersion',d=>({...d,authorizationVersion:9})],
 ['subject corp',d=>({...d,subject:{...d.subject,corpId:'other'}})],['subject user',d=>({...d,subject:{...d.subject,userId:'other'}})],
 ['contractId',d=>({...d,contract:{...d.contract,contractId:id(90)}})],['delegationId',d=>({...d,contract:{...d.contract,delegationId:id(90)}})],
 ['scheduleId',d=>({...d,scheduled:{...d.scheduled,scheduleId:id(90)}})],['authorizationId',d=>({...d,authorization:{...d.authorization,id:id(90)}})],
 ['authorization documentHash',d=>({...d,authorization:{...d.authorization,documentHash:sha('0')}})],
];

describe('scheduled group observation pure contract',()=>{
 it('accepts the exact installed definition and returns observation without authority',()=>{
  const p=policy(),d=delegation(p),original=structuredClone({p,d});expect(validateScheduledGroupDelegation(d,p,{now})).toEqual(d);
  const r=validateScheduledGroupResult(result(p,d),{delegation:d,policy:p,now});expect(r.grantsAuthority).toBe(false);expect(r.value.internalMembersVerified).toBe(false);expect({p,d}).toEqual(original);
 });
 it.each(fixed)('rejects fixed binding mismatch: %s',(_name,change)=>{const p=policy();expect(()=>validateScheduledGroupDelegation(change(delegation(p)),p,{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');});
 it('requires matching owner audience and rejects cross-purpose/native/H5 fields',()=>{
  const p=policy(),d=delegation(p);
  expect(scheduledGroupPolicySchema.safeParse({...p,principal:{...p.principal,audience:{kind:'PRIVATE_USER',id:id(90)}}}).success).toBe(false);
  for(const change of [{audience:{kind:'PRIVATE_USER',id:id(90)}},{taskId:id(90)},{runId:id(90)},{sessionId:id(90)},{requester:{actorId:id(90),sessionId:id(91),authEpoch:1}},{purpose:'H5_SESSION'},{purpose:'NATIVE_RUN'},{capabilityBindingId:'dws.group.audience.v1'},{capabilityBindingId:'dws.group.case-roster.v1'}])expect(scheduledGroupDelegationSchema.safeParse({...d,...change}).success).toBe(false);
  expect(groupDelegationSchema.safeParse(d).success).toBe(false);expect(caseRosterDelegationSchema.safeParse(d).success).toBe(false);expect(requestSchema.safeParse(request(p,d)).success).toBe(false);
 });
 it('rejects unknown fields at every policy and delegation level',()=>{
  const p=policy(),d=delegation(p);
  for(const extra of [{...p,approved:true},{...p,argv:['read']},{...p,endpoint:'https://invalid.example'},{...p,principal:{...p.principal,role:'admin'}},{...p,principal:{...p.principal,subject:{...p.principal.subject,profile:'other'}}},{...p,principal:{...p.principal,audience:{...p.principal.audience,target:'other'}}},{...p,profile:{...p.profile,approved:true}}])expect(scheduledGroupPolicySchema.safeParse(extra).success).toBe(false);
  for(const extra of [{...d,approved:true},{...d,subject:{...d.subject,role:'admin'}},{...d,audience:{...d.audience,target:'other'}},{...d,scheduled:{...d.scheduled,sessionId:id(90)}},{...d,contract:{...d.contract,approved:true}},{...d,authorization:{...d.authorization,approved:true}}])expect(scheduledGroupDelegationSchema.safeParse(extra).success).toBe(false);
 });
 it.each(['validFrom','expiresAt'] as const)('enforces exact %s endpoint',endpoint=>{
  const p=policy(),d=delegation(p);if(endpoint==='validFrom'){expect(validateScheduledGroupDelegation(d,p,{now:p.validFrom})).toEqual(d);expect(()=>validateScheduledGroupDelegation(d,p,{now:p.validFrom-1})).toThrow('DWS_RPC_EXPIRED');}else{expect(validateScheduledGroupDelegation(d,p,{now:p.expiresAt-1})).toEqual(d);expect(()=>validateScheduledGroupDelegation(d,p,{now:p.expiresAt})).toThrow('DWS_RPC_EXPIRED');expect(()=>validateScheduledGroupResult(result(p,d),{delegation:d,policy:p,now:p.expiresAt})).toThrow('DWS_RPC_EXPIRED');}
 });
 it.each([NaN,Infinity,-1,now+0.5])('rejects invalid explicit clock %s',clock=>{expect(()=>validateScheduledGroupDelegation(delegation(),policy(),{now:clock})).toThrow('DWS_RPC_EXPIRED');});
 it('rejects invalid validity windows and invalid dynamic reference values',()=>{
  const p=policy(),d=delegation(p);for(const expiresAt of [p.validFrom,p.validFrom-1,Infinity])expect(scheduledGroupPolicySchema.safeParse({...p,expiresAt}).success).toBe(false);
  for(const scheduled of [{...d.scheduled,revision:0},{...d.scheduled,generation:0},{...d.scheduled,fence:0},{...d.scheduled,fence:Number.MAX_SAFE_INTEGER+1},{...d.scheduled,phase:'H5_SESSION'},{...d.scheduled,scheduledAt:'2026-02-30T00:00:00Z'},{...d.scheduled,notificationId:'not-uuid'},{...d.scheduled,originHash:'reviewed'}])expect(scheduledGroupDelegationSchema.safeParse({...d,scheduled}).success).toBe(false);
 });
 it.each(dynamic)('binds %s into Ed25519 request and rejects reusing the old result',(_name,change)=>{
  const p=policy(),d=delegation(p),changed=change(d),key=generateKeyPairSync('ed25519'),original=request(p,d),next=request(p,changed),signed=signEnvelope(original,'synthetic-key',key.privateKey);
  expect(validateScheduledGroupDelegation(changed,p,{now})).toEqual(changed); // Caller assertion, not DB proof.
  expect(rpcHash(changed)).not.toBe(rpcHash(d));expect(rpcHash(next)).not.toBe(rpcHash(original));
  expect(openEnvelope(signed,'synthetic-key',key.publicKey,scheduledGroupRequestSchema)).toEqual(original);
  expect(()=>openEnvelope({...signed,payload:next},'synthetic-key',key.publicKey,scheduledGroupRequestSchema)).toThrow('DWS_RPC_SIGNATURE_INVALID');
  expect(()=>validateScheduledGroupResult(result(p,d),{delegation:changed,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
  expect(validateScheduledGroupResult(result(p,changed),{delegation:changed,policy:p,now}).grantsAuthority).toBe(false);
 });
 it('creates an independent deeply frozen snapshot and rejects absent/duplicate/unbounded definitions',()=>{
  const raw=policy(),snapshot=snapshotScheduledGroupPolicies([raw]);raw.profile.reviewRef='changed';expect(snapshot[0]?.profile.reviewRef).toBe('synthetic-profile-review');
  for(const value of [snapshot,snapshot[0],snapshot[0]?.principal,snapshot[0]?.principal.audience,snapshot[0]?.profile])expect(Object.isFrozen(value)).toBe(true);
  expect(()=>{snapshot[0]!.principal.subject.userId='other';}).toThrow();expect(snapshotScheduledGroupPolicies(undefined)).toEqual([]);expect(snapshotScheduledGroupPolicies([])).toEqual([]);
  for(const value of [null,[{}],[policy(),policy()],Array.from({length:33},(_,n)=>({...policy(),scheduleId:id(100+n)}))])expect(()=>snapshotScheduledGroupPolicies(value)).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');
  expect(snapshotScheduledGroupPolicies([policy(),{...policy(),scheduleId:id(90)}])).toHaveLength(2);
  for(const value of [undefined,null,{}])expect(()=>validateScheduledGroupDelegation(delegation(),value,{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
 });
 it('uses compatible target schema and hashes every fixed policy dimension',()=>{
  const p=policy(),target=scheduledGroupTargetForPolicy(p);expect(groupTargetSchema.parse(target)).toEqual(target);expect(target.scopeHash).toBe(rpcHash(p));
  const changes=[{...p,schemaVersion:1,scopeVersion:8},{...p,scopeId:id(90)},{...p,conversationId:'other'},
   {...p,contractId:id(90)},{...p,delegationId:id(90)},{...p,scheduleId:id(90)},{...p,proactiveAuthorizationId:id(90)},{...p,proactiveAuthorizationHash:sha('0')},
   {...p,binaryHash:sha('0')},{...p,membersSchemaHash:sha('0')},{...p,infoSchemaHash:sha('0')},{...p,validFrom:p.validFrom-1},{...p,expiresAt:p.expiresAt+1},{...p,profile:{...p.profile,reviewRef:'different'}},
   ...fixed.slice(0,7).map(([,change])=>{const d=change(delegation(p));return {...p,principal:{tenantId:d.tenantId,ownerId:d.ownerId,identityId:d.identityId,authEpoch:d.authEpoch,authorizationVersion:d.authorizationVersion,audience:d.audience,subject:d.subject}};})];
  for(const changed of changes)expect(scheduledGroupTargetForPolicy(changed).scopeHash).not.toBe(target.scopeHash);
 });
 it('rejects each target field mismatch and unexpected result/operation/authority fields',()=>{
  const p=policy(),d=delegation(p),r=result(p,d);
  for(const field of ['scopeHash','profileHash','binaryHash','membersSchemaHash','infoSchemaHash'] as const)expect(()=>validateScheduledGroupResult({...r,group:{...r.group,[field]:sha('0')}},{delegation:d,policy:p,now})).toThrow();
  for(const change of [{scopeId:id(90)},{scopeVersion:99},{conversationId:'other'},{endpoint:'bad'}])expect(()=>validateScheduledGroupResult({...r,group:{...r.group,...change}},{delegation:d,policy:p,now})).toThrow();
  for(const change of [{operation:'READ_GROUP_AUDIENCE'},{operation:'READ_GROUP_CASE_ROSTER'},{grantsAuthority:true},{delegationHash:sha('0')},{approved:true}])expect(()=>validateScheduledGroupResult({...r,...change},{delegation:d,policy:p,now})).toThrow();
 });
 it('rejects malformed/incomplete/duplicated observation and wrong independent review',()=>{
  const p=policy(),d=delegation(p),r=result(p,d),o=r.observation;
  for(const observation of [null,{...o,internalMembersVerified:true},{...o,platformCountsVerified:false},{...o,membershipHash:sha('0')},{...o,users:[...o.users,...o.users]},{...o,partial:true},{...o,independentSource:{...o.independentSource,userCount:2}},{...o,independentSource:{...o.independentSource,recordHash:sha('0')}}])expect(scheduledGroupSignedResultSchema.safeParse({...r,observation}).success).toBe(false);
  expect(()=>validateScheduledGroupResult({...r,observation:{...o,independentSource:{...o.independentSource,reviewRef:'unreviewed'}}},{delegation:d,policy:p,now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
 });
 it('strict request schema rejects endpoint/argv/fake session fields, while crypto alone proves no DB origin',()=>{
  const original=request(),keys=generateKeyPairSync('ed25519');for(const change of [{operation:'READ_GROUP_AUDIENCE'},{sessionId:id(90)},{argv:['read']},{endpoint:'https://invalid.example'}])expect(scheduledGroupRequestSchema.safeParse({...original,...change}).success).toBe(false);
  const invented={...delegation(),scheduled:{...delegation().scheduled,occurrenceId:id(99),originHash:sha('0'),fence:999}};
  const signed=signEnvelope(request(policy(),invented),'synthetic-key',keys.privateKey);expect(openEnvelope(signed,'synthetic-key',keys.publicKey,scheduledGroupRequestSchema).delegation).toEqual(invented);
  // Deliberately accepts authenticated caller assertions. Actual DB FK/current
  // generation/fence/revocation and nonce replay cache are outside this module.
 });
});
