import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {groupReaderBindingHash} from '../../packages/dws/src/read-client.js';
import {rpcHash} from '../../packages/dws/src/signed-protocol.js';
import type {NativeCaseRosterPolicy} from '../../packages/dws/src/native-case-roster-protocol.js';
import {nativeCaseObserverSchema,NativeCaseAudience} from '../../packages/groups/src/native-audience.js';
import type {groupCaseWorld} from './group-cases.js';
import type {groupReminderDatabase} from './group-reminder-database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
/** Signed service configuration is test-only; the policy authorizes neither a
 * requester nor a lease. Both must be observed from the actual nonce database. */
export async function signedNativeCaseRuntime(d:Awaited<ReturnType<typeof groupReminderDatabase>>,w:Awaited<ReturnType<typeof groupCaseWorld>>,vault:Vault){
 const accepted=(await w.f.ingress.acceptTrustedCallback(w.f.callback('汇总今日事项')))!,runId=(await d.root.query('SELECT id FROM runs WHERE task_id=$1',[accepted.taskId])).rows[0].id as string;
 const lease=(await w.f.store.acquire(w.f.ctx,runId,randomUUID()))!;
 const o=nativeCaseObserverSchema.parse((await d.db.scope(w.f.ctx,c=>c.query("SELECT public.oa_group_case_native_observer($1,$2,$3,$4,$5,'EXECUTION','case.read',NULL) value",[w.f.conversationId,lease.taskId,lease.runId,lease.workerId,lease.fence]))).rows[0].value);
 await w.f.store.release(w.f.ctx,lease);
 const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519');
 const policy:NativeCaseRosterPolicy={schemaVersion:1,purpose:'NATIVE_GROUP_CASE',capabilityBindingId:'dws.group.native-case-roster.v1',principal:{tenantId:w.f.ctx.tenantId,ownerId:o.serviceOwnerId,identityId:o.identityId,authEpoch:o.ownerAuthEpoch,authorizationVersion:o.authorizationVersion,audience:{kind:'PRIVATE_USER',id:o.serviceOwnerId},subject:o.subject},contractId:o.authority.contractId,contractVersion:o.authority.contractVersion,contractHash:o.contractHash,delegationId:o.delegationId,allowedActions:['case.read','case.create','case.update'],allowedPhases:['EXECUTION','RESULT_VERIFICATION'],scopeId:o.authority.scopeId,scopeVersion:o.scopeVersion,conversationId:w.f.conversationId,profile:o.profile,binaryHash:o.binaryHash,membersSchemaHash:o.membersSchemaHash,infoSchemaHash:o.infoSchemaHash,validFrom:Date.now()-1000,expiresAt:Math.min(Date.parse(o.scopeExpiresAt),Date.parse(o.contractExpiresAt))-1000};
 const keys={tenantId:w.f.ctx.tenantId,corpId:o.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_NATIVE_CASE_ONLY',nonce:randomUUID()}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:1000};
 const service=new SignedDwsReadService(w.f.fixture.runner,{...keys,nativeCaseRosterPolicies:[policy]});let audiences:NativeCaseAudience|undefined;
 try{
  await service.listen(socketPath);const callerFile=join(root,'caller.pem'),runnerFile=join(root,'runner.pem'),configurationFile=join(root,'reader.json');
  await writeFile(callerFile,caller.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(runnerFile,signer.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  await writeFile(configurationFile,JSON.stringify({schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_NATIVE_CASE_REVIEW',socketPath,callerKeyId:keys.callerKeyId,callerPrivateKeyFile:callerFile,runnerKeyId:keys.runnerKeyId,runnerPublicKeyFile:runnerFile,bindingHash:service.bindingHash,policyHash:keys.policyHash,timeoutMs:3000,maxOutputBytes:131072,binaryHash:policy.binaryHash,schemaHash:w.f.fixture.runner.config.schemaHash,groupMembersSchemaHash:policy.membersSchemaHash,groupInfoSchemaHash:policy.infoSchemaHash,nativeCaseRosterPolicies:[policy]}),{mode:0o600});
  const identities=await configureDws(d.db,vault,{APP_ENV:'test',OA_TEST_ISOLATED:'true',DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:configurationFile});
  await d.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='dws.group.audience'",[w.f.ctx.tenantId,groupReaderBindingHash(identities.runner)]);
  audiences=new NativeCaseAudience(d.db,vault,identities,'robot-1');w.f.store.configureNativeCaseAudience(audiences);w.f.store.configureGroupCases(w.cases);
  return {identities,audiences,policy,service,close:async()=>{await audiences?.close();await service.close();await rm(root,{recursive:true,force:true});}};
 }catch(error){await audiences?.close();await service.close();await rm(root,{recursive:true,force:true});throw error;}
}
