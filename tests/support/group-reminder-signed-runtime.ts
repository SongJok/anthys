import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {groupReaderBindingHash} from '../../packages/dws/src/read-client.js';
import {rpcHash} from '../../packages/dws/src/signed-protocol.js';
import type {ScheduledGroupPolicy} from '../../packages/dws/src/scheduled-group-protocol.js';
import {groupReminderObserverSchema} from '../../packages/groups/src/reminder-audience.js';
import type {reminderExecution} from './group-reminder-execution.js';
import type {groupReminderDatabase} from './group-reminder-database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
/** Actual private config, socket, signatures, CLI and persisted owner state.
 * No network/model/platform sender is enabled by this synthetic fixture. */
export async function signedReminderRuntime(d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>,vault:Vault,q:{scheduleId:string;occurrenceId:string},extra:readonly {scheduleId:string;occurrenceId:string}[]=[]){
 const o=groupReminderObserverSchema.parse((await d.db.scope(s.w.f.ctx,c=>c.query("SELECT public.oa_group_reminder_observer($1,1,'PLAN') value",[q.occurrenceId]))).rows[0].value);
 const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519');
 const policy:ScheduledGroupPolicy={schemaVersion:1,purpose:'SCHEDULED_CONTRACT',capabilityBindingId:'dws.group.reminder-audience.v1',principal:{tenantId:s.w.f.ctx.tenantId,ownerId:o.serviceOwnerId,identityId:o.identityId,authEpoch:o.ownerAuthEpoch,authorizationVersion:o.authorizationVersion,audience:{kind:'PRIVATE_USER',id:o.serviceOwnerId},subject:o.subject},contractId:o.contractId,delegationId:o.delegationId,scheduleId:q.scheduleId,proactiveAuthorizationId:o.authorization.id,proactiveAuthorizationHash:o.authorization.documentHash,scopeId:o.scopeId,scopeVersion:o.scopeVersion,conversationId:o.groupId,profile:o.profile,binaryHash:o.binaryHash,membersSchemaHash:o.membersSchemaHash,infoSchemaHash:o.infoSchemaHash,validFrom:Date.now()-1000,expiresAt:Math.min(Date.parse(o.authorization.expiresAt),Date.parse(o.scopeExpiresAt),Date.parse(o.contractExpiresAt))-1000};
 const policies=[policy];for(const next of extra){const observed=groupReminderObserverSchema.parse((await d.db.scope(s.w.f.ctx,c=>c.query("SELECT public.oa_group_reminder_observer($1,1,'PLAN') value",[next.occurrenceId]))).rows[0].value);if(observed.serviceOwnerId!==o.serviceOwnerId||observed.groupId!==o.groupId||observed.contractHash!==o.contractHash||observed.authorization.documentHash!==o.authorization.documentHash||observed.schedule.id!==next.scheduleId)throw Error('SYNTHETIC_SIGNED_SCHEDULE_MISMATCH');policies.push({...policy,scheduleId:next.scheduleId});}
 const keys={tenantId:s.w.f.ctx.tenantId,corpId:o.subject.corpId,policyHash:rpcHash({review:'SYNTHETIC_PERSISTED_SCHEDULE_ONLY',nonce:randomUUID()}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:100};
 const service=new SignedDwsReadService(s.w.f.fixture.runner,{...keys,scheduledGroupPolicies:policies});
 try{
  await service.listen(socketPath);const callerFile=join(root,'caller.pem'),runnerFile=join(root,'runner.pem'),configurationFile=join(root,'reader.json');
  await writeFile(callerFile,caller.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(runnerFile,signer.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  await writeFile(configurationFile,JSON.stringify({schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_PERSISTED_SCHEDULE_REVIEW',socketPath,callerKeyId:keys.callerKeyId,callerPrivateKeyFile:callerFile,runnerKeyId:keys.runnerKeyId,runnerPublicKeyFile:runnerFile,bindingHash:service.bindingHash,policyHash:keys.policyHash,timeoutMs:3000,maxOutputBytes:131072,binaryHash:policy.binaryHash,schemaHash:s.w.f.fixture.runner.config.schemaHash,groupMembersSchemaHash:policy.membersSchemaHash,groupInfoSchemaHash:policy.infoSchemaHash,scheduledGroupPolicies:policies}),{mode:0o600});
  const identities=await configureDws(d.db,vault,{APP_ENV:'test',OA_TEST_ISOLATED:'true',DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:configurationFile});
  await d.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='dws.group.audience'",[s.w.f.ctx.tenantId,groupReaderBindingHash(identities.runner)]);
  return {identities,policy,policies,service,close:async()=>{await service.close();await rm(root,{recursive:true,force:true});}};
 }catch(error){await service.close();await rm(root,{recursive:true,force:true});throw error;}
}
