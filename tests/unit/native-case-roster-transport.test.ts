import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect,vi} from 'vitest';
import {SignedGroupReadClient,type DwsNativeCaseRosterAuthority} from '../../packages/dws/src/read-client.js';
import {SignedGroupAudienceReader} from '../../packages/dws/src/signed-group-reader.js';
import {SignedDwsReadClient} from '../../packages/dws/src/signed-client.js';
import {readBindingHash,SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {nativeCaseRosterTargetForPolicy,type NativeCaseRosterPolicy,type NativeCaseRosterDelegation} from '../../packages/dws/src/native-case-roster-protocol.js';
import {groupMembersReply,groupInfoReply,syntheticGroupInfoProfile} from '../support/group-members.js';
import {projectGroupAudience,projectGroupMembers} from '../../packages/dws/src/group-contract.js';
import {rpcHash,type DwsGroupScope} from '../../packages/dws/src/signed-protocol.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import type {Database} from '../../packages/storage/src/database.js';
import type {DwsRunner} from '../../packages/dws/src/runner.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function policy():NativeCaseRosterPolicy{return {schemaVersion:1,purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',principal:{tenantId:id(1),ownerId:id(2),identityId:id(3),authEpoch:1,authorizationVersion:2,audience:{kind:'PRIVATE_USER',id:id(2)},subject:{corpId:'synthetic-corp',userId:'synthetic-owner'}},contractId:id(4),contractVersion:1,contractHash:'d'.repeat(64),delegationId:id(5),allowedActions:['case.read','case.create','case.update'],allowedPhases:['EXECUTION','RESULT_VERIFICATION'],scopeId:id(6),scopeVersion:1,conversationId:'cidSynthetic==',profile:structuredClone(syntheticGroupInfoProfile),binaryHash:'a'.repeat(64),membersSchemaHash:'b'.repeat(64),infoSchemaHash:'c'.repeat(64),validFrom:Date.now()-1000,expiresAt:Date.now()+60_000};}
function setup(){
 const p=policy(),d:NativeCaseRosterDelegation={...p.principal,purpose:p.purpose,capabilityBindingId:p.capabilityBindingId,requester:{actorId:id(7),authEpoch:3,taskId:id(8),runId:id(9),workerId:id(10),fence:4,deadline:Date.now()+10_000,phase:'EXECUTION'},contract:{contractId:p.contractId,version:p.contractVersion,revisionHash:p.contractHash,delegationId:p.delegationId},action:'case.read'},authority:DwsNativeCaseRosterAuthority={conversationId:p.conversationId,delegation:d,scopeId:p.scopeId,scopeVersion:p.scopeVersion,scopeExpiresAtMs:p.expiresAt+1000,contractExpiresAtMs:p.expiresAt+1000,profileHash:rpcHash(p.profile)};
 const config={mode:'SYNTHETIC_TEST' as const,binaryFile:'/private/tmp/unused/synthetic',root:'/private/tmp/unused/workspaces',binaryHash:p.binaryHash,schemaHash:'e'.repeat(64),timeoutMs:3000,maxOutputBytes:128000,groupMembersSchemaHash:p.membersSchemaHash,groupInfoSchemaHash:p.infoSchemaHash,signedBindingHash:'f'.repeat(64),signedPolicyHash:'0'.repeat(64)};
 const keys=generateKeyPairSync('ed25519'),low=new SignedDwsReadClient({socketPath:'/private/tmp/unused/runner.sock',callerKeyId:'caller',callerPrivateKey:keys.privateKey,runnerKeyId:'runner',runnerPublicKey:keys.publicKey,bindingHash:config.signedBindingHash,policyHash:config.signedPolicyHash,timeoutMs:3000});
 const observation=projectGroupAudience(groupInfoReply(),projectGroupMembers(groupMembersReply(),p.conversationId),groupInfoReply(),p.profile),state={schemaVersion:1 as const,files:{}};
 const call=vi.spyOn(low,'readNativeCaseRoster').mockResolvedValue({value:observation,state,grantsAuthority:false});
 const reader=new SignedGroupReadClient(config,new SignedGroupAudienceReader(low),[],[],[],[p]),args={conversationId:p.conversationId,authorizationVersion:p.principal.authorizationVersion,requestNonce:id(11)},signal=new AbortController().signal;
 return {p,d,authority,config,low,call,reader,args,signal,state,read:(a=authority)=>reader.readNativeCaseRoster!(p.principal.subject,state,args,p.profile,signal,a)};
}

describe('native roster transport boundary (no SQL authority)',()=>{
 it('keeps the high-level operation absent unless its own explicit policy is installed',()=>{
  const f=setup(),scope:DwsGroupScope={scopeId:f.p.scopeId,scopeVersion:1,conversationId:f.p.conversationId,profile:f.p.profile,binaryHash:f.p.binaryHash,membersSchemaHash:f.p.membersSchemaHash,infoSchemaHash:f.p.infoSchemaHash,validFrom:f.p.validFrom,expiresAt:f.p.expiresAt,delegation:{...f.p.principal,taskId:id(8),runId:id(9),capabilityBindingId:'dws.group.audience.v1'}};
  expect(new SignedGroupReadClient(f.config,new SignedGroupAudienceReader(f.low),[scope]).readNativeCaseRoster).toBeUndefined();
  expect(()=>new SignedGroupReadClient(f.config,new SignedGroupAudienceReader(f.low))).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');expect(typeof f.reader.readNativeCaseRoster).toBe('function');
 });
 it('accepts a short fixed task deadline within a longer reviewed policy without substituting the owner for requester',async()=>{
  const f=setup();f.authority.delegation.requester.deadline=Date.now()+5000;const result=await f.read();expect(result.value.internalMembersVerified).toBe(false);expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.call.mock.calls[0]![0].requester.actorId).toBe(id(7));expect(f.call.mock.calls[0]![0].ownerId).toBe(id(2));expect(f.call.mock.calls[0]![2]).toEqual(nativeCaseRosterTargetForPolicy(f.p));
 });
 it.each(['scopeId','scopeVersion','conversationId','profileHash','scopeExpiresAtMs','contractExpiresAtMs','unknown','unsafeExpiry'] as const)('rejects malformed or drifting independent authority %s before transport',async field=>{
  const f=setup(),a=structuredClone(f.authority);
  const raw={...a,...(field==='scopeId'?{scopeId:id(90)}:field==='scopeVersion'?{scopeVersion:9}:field==='conversationId'?{conversationId:'other'}:field==='profileHash'?{profileHash:'0'.repeat(64)}:field==='unknown'?{sessionId:id(90)}:field==='unsafeExpiry'?{scopeExpiresAtMs:NaN}:{[field]:f.p.expiresAt-1})};
  await expect(f.read(raw)).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});expect(f.call).not.toHaveBeenCalled();
 });
 it('rejects phase/action, credential, contract and binary/schema/profile drift before the low-level client',async()=>{
  for(const change of [(f:ReturnType<typeof setup>)=>{f.authority.delegation.requester.phase='RESULT_VERIFICATION';f.authority.delegation.action='case.update';},(f:ReturnType<typeof setup>)=>{f.authority.delegation.subject.userId='other';},(f:ReturnType<typeof setup>)=>{f.authority.delegation.contract.version++;},(f:ReturnType<typeof setup>)=>{f.authority.delegation.authorizationVersion++;}]){
   const f=setup();change(f);await expect(f.read()).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});expect(f.call).not.toHaveBeenCalled();
  }
  const f=setup();for(const change of [{binaryHash:'0'.repeat(64)},{groupMembersSchemaHash:'0'.repeat(64)},{groupInfoSchemaHash:'0'.repeat(64)}]){
   const reader=new SignedGroupReadClient({...f.config,...change},new SignedGroupAudienceReader(f.low),[],[],[],[f.p]);await expect(reader.readNativeCaseRoster!(f.p.principal.subject,f.state,f.args,f.p.profile,f.signal,f.authority)).rejects.toMatchObject({code:'DWS_RPC_SCOPE_MISMATCH'});
  }expect(f.call).not.toHaveBeenCalled();
 });
 it('refuses pre-cancel, expired claims, mismatched reply and expiry during the reply',async()=>{
  const f=setup(),abort=new AbortController();abort.abort();await expect(f.reader.readNativeCaseRoster!(f.p.principal.subject,f.state,f.args,f.p.profile,abort.signal,f.authority)).rejects.toBeDefined();expect(f.call).not.toHaveBeenCalled();
  f.authority.delegation.requester.deadline=Date.now();await expect(f.read()).rejects.toMatchObject({code:'DWS_RPC_EXPIRED'});expect(f.call).not.toHaveBeenCalled();
  const g=setup();g.call.mockResolvedValueOnce({value:{...projectGroupAudience(groupInfoReply(),projectGroupMembers(groupMembersReply(),g.p.conversationId),groupInfoReply(),g.p.profile),membershipHash:'0'.repeat(64)},state:g.state,grantsAuthority:false});await expect(g.read()).rejects.toMatchObject({code:'DWS_RPC_GROUP_RESULT_INVALID'});
  const h=setup();h.authority.delegation.requester.deadline=Date.now()+20;h.call.mockImplementationOnce(async()=>{await new Promise(resolve=>setTimeout(resolve,40));return {value:projectGroupAudience(groupInfoReply(),projectGroupMembers(groupMembersReply(),h.p.conversationId),groupInfoReply(),h.p.profile),state:h.state,grantsAuthority:false};});await expect(h.read()).rejects.toMatchObject({code:'DWS_RPC_EXPIRED'});
 });
 it('preserves old empty-policy binding bytes and independently binds each new reviewed policy',()=>{
  const f=setup(),runner={config:f.config};const original=readBindingHash(runner);
  expect(original).toBe('27c4d95d358f2ec6bcaf1c27ab5a5fc9c2be6e453e2450c2fa28e0dcece453a8');expect(readBindingHash(runner,[],[],[],[],[],[])).toBe(original);
  const next=readBindingHash(runner,[],[],[],[],[],[f.p]);expect(next).not.toBe(original);
  for(const changed of [{...f.p,contractVersion:2},{...f.p,contractHash:'0'.repeat(64)},{...f.p,allowedPhases:['EXECUTION']},{...f.p,scopeVersion:2},{...f.p,profile:{...f.p.profile,reviewRef:'another-review'}}])expect(readBindingHash(runner,[],[],[],[],[],[changed])).not.toBe(next);
 });
 it('refuses runner pin mismatch and snapshots new installed policy rather than borrowing later mutable objects',()=>{
  const f=setup(),keys=generateKeyPairSync('ed25519'),runner={config:f.config,verify:async()=>{throw Error('UNUSED');},readSelf:async()=>{throw Error('UNUSED');},readGroupAudience:async()=>{throw Error('UNUSED');}} satisfies Pick<DwsRunner,'config'|'verify'|'readSelf'|'readGroupAudience'>;
  const p={tenantId:f.p.principal.tenantId,corpId:f.p.principal.subject.corpId,policyHash:'f'.repeat(64),callerKeyId:'caller',callerPublicKey:keys.publicKey,runnerKeyId:'runner',runnerPrivateKey:keys.privateKey,maxRequestMs:3000,maxConcurrent:1,maxReplayEntries:10,nativeCaseRosterPolicies:[f.p]};
  expect(()=>new SignedDwsReadService({...runner,config:{...f.config,binaryHash:'0'.repeat(64)}},p)).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');const service=new SignedDwsReadService(runner,p),before=service.bindingHash;f.p.allowedActions.pop();expect(service.bindingHash).toBe(before);expect(readBindingHash(runner,[],[],[],[],[],[f.p])).not.toBe(before);
 });
 it('loads a private explicit native-only config locally, leaves default disconnected and rejects unknown native config fields',async()=>{
  const f=setup(),root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);const caller=generateKeyPairSync('ed25519'),runner=generateKeyPairSync('ed25519'),callerFile=join(root,'caller.pem'),runnerFile=join(root,'runner.pem'),file=join(root,'config.json');
  const db={} as Database,vault=new Vault(new Map([['synthetic',randomBytes(32)]]),'synthetic'),env={DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:file};
  const config={schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_NATIVE_ROSTER_ONLY',socketPath:join(root,'runner.sock'),callerKeyId:'caller',callerPrivateKeyFile:callerFile,runnerKeyId:'runner',runnerPublicKeyFile:runnerFile,bindingHash:f.config.signedBindingHash,policyHash:f.config.signedPolicyHash,timeoutMs:3000,maxOutputBytes:128000,binaryHash:f.config.binaryHash,schemaHash:f.config.schemaHash,groupMembersSchemaHash:f.config.groupMembersSchemaHash,groupInfoSchemaHash:f.config.groupInfoSchemaHash,nativeCaseRosterPolicies:[f.p]};
  try{await writeFile(callerFile,caller.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});await writeFile(runnerFile,runner.publicKey.export({format:'pem',type:'spki'}),{mode:0o600});await writeFile(file,JSON.stringify(config),{mode:0o600});
   expect((await configureDws(db,vault,{})).runner).toBeUndefined();const configured=await configureDws(db,vault,env);expect(configured.runner?.transport).toBe('SIGNED_GROUP');expect(typeof configured.runner?.readNativeCaseRoster).toBe('function');expect(configured.runner?.readSelf).toBeUndefined();
   for(const nativeCaseRosterPolicies of [[],[{...f.p,sessionId:id(90)}],[f.p,f.p]]){await writeFile(file,JSON.stringify({...config,nativeCaseRosterPolicies}));await expect(configureDws(db,vault,env)).rejects.toBeDefined();}
   const {nativeCaseRosterPolicies:_native,...absent}=config;await writeFile(file,JSON.stringify(absent));await expect(configureDws(db,vault,env)).rejects.toBeDefined();
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
