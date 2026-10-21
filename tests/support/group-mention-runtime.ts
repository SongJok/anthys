import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {groupReaderBindingHash} from '../../packages/dws/src/read-client.js';
import {rpcHash} from '../../packages/dws/src/signed-protocol.js';
import type {GroupMentionRosterPolicy,GroupMentionRosterDelegation} from '../../packages/dws/src/group-mention-roster-protocol.js';
import type {groupCaseWorld} from './group-cases.js';
import type {groupReminderDatabase} from './group-reminder-database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
/** One policy is installed before the next task exists. It contains no task,
 * run, worker or fabricated session; production host SQL must supply those. */
export async function signedGroupMentionRuntime(d:Awaited<ReturnType<typeof groupReminderDatabase>>,w:Awaited<ReturnType<typeof groupCaseWorld>>,vault:Vault){
 const row=(await d.root.query('SELECT d.id,d.authorization_version,d.auth_epoch,d.delegation_expires_at,s.info_profile,s.binary_hash,s.members_schema_hash,s.info_schema_hash,s.expires_at scope_expires_at,c.id contract_id,c.version contract_version,c.document_hash,c.expires_at contract_expires_at,c.delegation_id FROM dws_identities d JOIN dws_group_scopes s ON s.tenant_id=d.tenant_id AND s.owner_id=d.owner_id JOIN group_contracts c ON c.tenant_id=s.tenant_id AND c.group_id=s.conversation_external_id WHERE d.tenant_id=$1 AND d.owner_id=$2 AND s.id=$3',[w.f.ctx.tenantId,w.f.ctx.actorId,w.f.scopeId])).rows[0];
 const policy:GroupMentionRosterPolicy={schemaVersion:1,purpose:'GROUP_MENTION',capabilityBindingId:'dws.group.mention-audience.v1',action:'question.answer',sourceMode:'MENTION_ONLY',principal:{tenantId:w.f.ctx.tenantId,ownerId:w.f.ctx.actorId,identityId:row.id,authEpoch:Number(row.auth_epoch),authorizationVersion:Number(row.authorization_version),audience:{kind:'PRIVATE_USER',id:w.f.ctx.actorId},subject:{corpId:w.f.corpId,userId:w.f.ownerExternal}},contractId:row.contract_id,contractVersion:Number(row.contract_version),contractHash:row.document_hash,delegationId:row.delegation_id,scopeId:w.f.scopeId,scopeVersion:1,conversationId:w.f.conversationId,profile:row.info_profile,binaryHash:row.binary_hash,membersSchemaHash:row.members_schema_hash,infoSchemaHash:row.info_schema_hash,validFrom:Date.now()-1000,expiresAt:Math.min(row.scope_expires_at.getTime(),row.contract_expires_at.getTime(),row.delegation_expires_at.getTime())-1000,allowedPhases:['EXECUTION','WAITING_EXTERNAL','RESULT_VERIFICATION']};
 const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-dws-rpc-')));await chmod(root,0o700);const socketPath=join(root,'runner.sock'),caller=generateKeyPairSync('ed25519'),signer=generateKeyPairSync('ed25519');
 const keys={tenantId:w.f.ctx.tenantId,corpId:w.f.corpId,policyHash:rpcHash({review:'SYNTHETIC_GROUP_MENTION_ONLY',nonce:randomUUID()}),callerKeyId:'synthetic-caller',callerPublicKey:caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:signer.privateKey,maxRequestMs:3000,maxConcurrent:2,maxReplayEntries:1000};
 const service=new SignedDwsReadService(w.f.fixture.runner,{...keys,groupMentionPolicies:[policy]});
 try{
  await service.listen(socketPath);const callerFile=join(root,'caller.pem'),runnerFile=join(root,'runner.pem'),configurationFile=join(root,'reader.json');
  await writeFile(callerFile,caller.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(runnerFile,signer.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  await writeFile(configurationFile,JSON.stringify({schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_GROUP_MENTION_REVIEW',socketPath,callerKeyId:keys.callerKeyId,callerPrivateKeyFile:callerFile,runnerKeyId:keys.runnerKeyId,runnerPublicKeyFile:runnerFile,bindingHash:service.bindingHash,policyHash:keys.policyHash,timeoutMs:3000,maxOutputBytes:131072,binaryHash:policy.binaryHash,schemaHash:w.f.fixture.runner.config.schemaHash,groupMembersSchemaHash:policy.membersSchemaHash,groupInfoSchemaHash:policy.infoSchemaHash,groupMentionPolicies:[policy]}),{mode:0o600});
  const identities=await configureDws(d.db,vault,{APP_ENV:'test',OA_TEST_ISOLATED:'true',DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:configurationFile}),observations:GroupMentionRosterDelegation[]=[];
  const read=identities.runner!.readGroupMentionAudience!.bind(identities.runner!);identities.runner!.readGroupMentionAudience=async(...args)=>{observations.push(structuredClone(args[5].delegation));return read(...args);};
  await d.root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='dws.group.audience'",[w.f.ctx.tenantId,groupReaderBindingHash(identities.runner)]);
  return {identities,policy,service,observations,configurationFile,close:async()=>{await service.close();await rm(root,{recursive:true,force:true});}};
 }catch(error){await service.close();await rm(root,{recursive:true,force:true});throw error;}
}
