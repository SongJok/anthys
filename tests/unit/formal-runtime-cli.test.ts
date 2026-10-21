import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {readFileSync} from 'node:fs';
import {hash} from '../../packages/storage/src/crypto.js';
import {budgetTransitionFingerprint} from '../../packages/config/src/budget-transition.js';
import {modelBudgetPolicySchema} from '../../packages/runtime/src/budget-policy.js';
import {groupDelegationFingerprint} from '../../packages/config/src/group-contract-delegation.js';
it('group delegation plan binds independently reviewed source versions without reading credentials or accepting unreviewed writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-group-review-cli-')),path=join(dir,'profile.json');try{
  const f=groupDelegationFingerprint({schemaVersion:1,approved:true,id:randomUUID(),tenantId:randomUUID(),groupId:'cidSynthetic==',administratorId:randomUUID(),serviceOwnerId:randomUUID(),serviceIdentityId:randomUUID(),scopeId:randomUUID(),roleBindingId:randomUUID(),administratorAuthEpoch:1,serviceOwnerAuthEpoch:1,roleVersion:1,serviceAuthorizationVersion:1,scopeVersion:1,validUntil:'2027-01-01T00:00:00.000Z',currency:'CNY',maxAmountMinor:1000,reviewReference:'SYNTHETIC_INDEPENDENT_GROUP_REVIEW',sourceReviewHash:'a'.repeat(64),administratorDirectoryHash:'b'.repeat(64)});await writeFile(path,f.serialized,{mode:0o600});
  const run=(args:string[])=>execFileSync(process.execPath,['--import','tsx','scripts/group-contract-delegation.ts',...args],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(run(['plan','--profile',path]))).toMatchObject({mode:'PLAN_ONLY',profileHash:f.hash,databaseAccess:false,servicesStarted:false,platformPermissionsVerified:false});
  for(const mode of ['approve','revoke']){let failure:unknown;try{run([mode,'--profile',path]);}catch(e){failure=e;}expect((failure as {stderr:string}).stderr).toContain('GROUP_DELEGATION_EXACT_REVIEW_REQUIRED');}
  await writeFile(path,'{"SYNTHETIC_PRIVATE_OPERATOR_SENTINEL": malformed',{mode:0o600});let error:unknown;try{run(['plan','--profile',path]);}catch(e){error=e;}expect((error as {stderr:string}).stderr).toContain('GROUP_DELEGATION_PROFILE_INVALID');expect((error as {stderr:string}).stderr).not.toContain('SYNTHETIC_PRIVATE_OPERATOR_SENTINEL');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('budget window transition plans bind exact three documents and refuse unreviewed activation before credential loading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-budget-transition-cli-'));try{
  const policy=modelBudgetPolicySchema.parse({...JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')),approvalReference:'SYNTHETIC_NEXT_BUDGET_REVIEW'}),policyHash=hash(JSON.stringify(policy));
  const formal=formalProfileFingerprint({schemaVersion:1,authorizationId:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),sourceTrialProfileHash:'a'.repeat(64),corpId:'SYNTHETIC',externalUserId:'owner',robotCode:'synthetic',conversationId:'synthetic-dm',validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',budgetPolicyHash:policyHash,approvalReference:'SYNTHETIC_FRESH_FORMAL_REVIEW',modelAllowed:false,modelApprovalReference:null,entrypoints:['INGRESS'],inputPolicy:{attachments:false,controls:false},capabilities:[]});
  const request={schemaVersion:1,transitionId:randomUUID(),tenantId:formal.profile.tenantId,actorId:formal.profile.actorId,sourceTrialProfileHash:formal.profile.sourceTrialProfileHash,expectedPolicyHash:'b'.repeat(64),expectedPolicyVersion:'1',policyHash,formalProfileHash:formal.hash,reviewReference:policy.approvalReference},frozen=budgetTransitionFingerprint(request,policy,formal.profile);
  for(const [name,body] of [['request',frozen.serialized],['policy',JSON.stringify(policy)],['profile',formal.serialized]])await writeFile(join(dir,name!+'.json'),body!,{mode:0o600});
  const flags=['--request',join(dir,'request.json'),'--policy',join(dir,'policy.json'),'--profile',join(dir,'profile.json')],run=(args:string[])=>execFileSync(process.execPath,['--import','tsx','scripts/budget-transition.ts',...args],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(run(['plan',...flags]))).toMatchObject({mode:'PLAN_ONLY',requestHash:frozen.hash,policyHash,formalProfileHash:formal.hash,databaseAccess:false,activation:false});
  for(const tail of [[],['--expected-request-hash','c'.repeat(64),'--review-ref',request.reviewReference],['--expected-request-hash',frozen.hash,'--review-ref','SYNTHETIC_WRONG_REVIEW']]){let failure:unknown;try{run(['authorize',...flags,...tail]);}catch(e){failure=e;}expect((failure as {stderr:string}).stderr).toContain('BUDGET_TRANSITION_EXACT_REVIEW_REQUIRED');}
  for(const patch of [{schemaVersion:2},{expectedPolicyVersion:'01'},{policyHash:'d'.repeat(64)},{actorId:randomUUID()},{formalProfileHash:'e'.repeat(64)},{extra:true}])expect(()=>budgetTransitionFingerprint({...request,...patch},policy,formal.profile)).toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('operator command defaults to an offline review plan and refuses unreviewed write modes before credential loading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-formal-cli-')),path=join(dir,'profile.json');try{
  const frozen=formalProfileFingerprint({schemaVersion:1,authorizationId:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),sourceTrialProfileHash:'a'.repeat(64),corpId:'SYNTHETIC',externalUserId:'owner',robotCode:'synthetic',conversationId:'synthetic-dm',validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',budgetPolicyHash:'b'.repeat(64),approvalReference:'SYNTHETIC_PLAN_ONLY',modelAllowed:false,modelApprovalReference:null,entrypoints:['INGRESS'],inputPolicy:{attachments:false,controls:false},capabilities:[]});await writeFile(path,frozen.serialized,{mode:0o600});
  const run=(args:string[])=>execFileSync(process.execPath,['--import','tsx','scripts/formal-runtime.ts',...args],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']});
  expect(JSON.parse(run(['plan','--profile',path]))).toMatchObject({mode:'PLAN_ONLY',profileHash:frozen.hash,databaseAccess:false,activation:false,modelAllowed:false});
  for(const mode of ['authorize','revoke']){let error:unknown;try{run([mode,'--profile',path]);}catch(e){error=e;}expect(error).toBeTruthy();expect((error as {stderr:string}).stderr).toContain('FORMAL_REVIEWED_PROFILE_REQUIRED');}
 }finally{await rm(dir,{recursive:true,force:true});}
});
