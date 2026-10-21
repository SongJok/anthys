import '../support/isolation.js';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {configureDws} from '../../packages/dws/src/configuration.js';
import {GroupAudience,groupAudienceBindingHash} from '../../packages/groups/src/audience.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
import {signedGroupReadFixture} from '../support/signed-group-read-fixture.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
import type {DwsGroupDelegation} from '../../packages/dws/src/signed-protocol.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!,max:4}),db=new Database(secret('RUNTIME_DATABASE_URL')!,12),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});
afterAll(async()=>{await db.close();await root.end();});

type SetupFault='bad-signature'|'expired'|'no-service-scopes'|'wrong-group';
async function fresh(fault?:SetupFault){
 // Existing fixture provisions a DEFAULT synthetic tenant, exact-profile enrollment,
 // reviewed scope/directory/bot, and a real SDK ingress task/run. No model is called.
 const business=await groupRuntimeFixture(root,db,vault);cleanup.push(()=>business.close());
 const store=new RuntimeStore(db,vault),acquired=await store.acquire(business.ctx,business.runId,'signed-group-e2e');
 if(!acquired)throw Error('SIGNED_GROUP_LEASE_NOT_ACQUIRED');const lease=acquired;cleanup.push(()=>store.release(business.ctx,lease));
 const identity=(await root.query('SELECT id,authorization_version,credential_version FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[business.ctx.tenantId,business.ctx.actorId])).rows[0];
 const row=(await root.query('SELECT version,expires_at FROM dws_group_scopes WHERE tenant_id=$1 AND id=$2',[business.ctx.tenantId,business.scopeId])).rows[0];
 const delegation:DwsGroupDelegation={tenantId:business.ctx.tenantId,ownerId:business.ctx.actorId,identityId:identity.id,taskId:lease.taskId,runId:lease.runId,authEpoch:lease.authEpoch,authorizationVersion:Number(identity.authorization_version),capabilityBindingId:'dws.group.audience.v1',audience:{kind:'PRIVATE_USER',id:business.ctx.actorId},subject:{corpId:business.corpId,userId:business.ownerExternal}};
 const signed=await signedGroupReadFixture({cli:business.fixture,configureSource:false,delegation,scopeId:business.scopeId,scopeVersion:Number(row.version),expiresAt:fault==='expired'?Date.now()-1:Math.min(Date.now()+60000,new Date(row.expires_at).getTime()),enabled:fault!=='no-service-scopes'});cleanup.push(()=>signed.close());
 const callerFile=join(signed.root,'caller-private.pem'),runnerFile=join(signed.root,'runner-public.pem'),configFile=join(signed.root,'signed-client.json');
 const caller=fault==='bad-signature'?generateKeyPairSync('ed25519').privateKey:signed.caller.privateKey;
 await writeFile(callerFile,caller.export({type:'pkcs8',format:'pem'}),{mode:0o600});await writeFile(runnerFile,signed.signer.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 await writeFile(configFile,JSON.stringify({schemaVersion:1,mode:'SIGNED_GROUP_READ_V1',executionMode:'SYNTHETIC_TEST',reviewed:true,reviewReference:'SYNTHETIC_DEFAULT_GROUP_E2E_ONLY',socketPath:signed.socketPath,callerKeyId:signed.policy.callerKeyId,callerPrivateKeyFile:callerFile,runnerKeyId:signed.policy.runnerKeyId,runnerPublicKeyFile:runnerFile,bindingHash:signed.service.bindingHash,policyHash:signed.policy.policyHash,timeoutMs:3000,maxOutputBytes:128000,binaryHash:signed.scope.binaryHash,schemaHash:business.fixture.runner.config.schemaHash,groupMembersSchemaHash:signed.scope.membersSchemaHash,groupInfoSchemaHash:signed.scope.infoSchemaHash,groupScopes:[fault==='wrong-group'?{...signed.scope,conversationId:'cidWrong=='}:signed.scope]}),{mode:0o600});
 const configured=await configureDws(db,vault,{DWS_ENABLED:'true',DWS_RUNNER_CONFIG_FILE:configFile});
 expect(configured.runner?.transport).toBe('SIGNED_GROUP');expect(configured.runner?.readSelf).toBeUndefined();expect(configured.runner?.readDocument).toBeUndefined();
 const audience=new GroupAudience(db,vault,configured,business.binding.robotCode);cleanup.push(()=>audience.close());store.configureGroupAudience(audience);
 await root.query("UPDATE capability_bindings SET schema_hash=$2 WHERE tenant_id=$1 AND logical_id='dws.group.audience' AND semantic_version='1.0.0'",[business.ctx.tenantId,groupAudienceBindingHash(configured)]);
 for(const file of [callerFile,runnerFile,configFile,signed.socketPath])expect((await lstat(file)).mode&0o777).toBe(0o600);expect((await lstat(signed.root)).mode&0o777).toBe(0o700);
 const issue=(ctx:DbContext=business.ctx)=>audience.issue(ctx,lease,c=>store.guard(c,lease),AbortSignal.timeout(10000));
 const credentialVersion=async()=>Number((await root.query('SELECT credential_version FROM dws_identities WHERE tenant_id=$1 AND id=$2',[business.ctx.tenantId,identity.id])).rows[0].credential_version);
 const proofs=async()=>(await root.query('SELECT id,proof_hash FROM run_group_audiences WHERE tenant_id=$1 AND run_id=$2',[business.ctx.tenantId,lease.runId])).rows;
 async function noDownstream(){
  expect(business.requests).toHaveLength(0);expect(signed.legacyCalls).toEqual([]);
  expect((await root.query('SELECT id FROM deliveries WHERE tenant_id=$1 AND source_run_id=$2',[business.ctx.tenantId,lease.runId])).rowCount).toBe(0);
  expect((await root.query('SELECT id FROM tool_actions WHERE tenant_id=$1 AND run_id=$2',[business.ctx.tenantId,lease.runId])).rowCount).toBe(0);
  expect((await root.query('SELECT result FROM runs WHERE tenant_id=$1 AND id=$2',[business.ctx.tenantId,lease.runId])).rows[0].result).toBeNull();
 }
 async function denied(promise:Promise<unknown>,code?:string){let returned:unknown;let error:unknown;try{returned=await promise;}catch(e){error=e;}expect(error).toBeInstanceOf(Error);if(code)expect(error).toMatchObject({code});expect(returned).toBeUndefined();expect(await proofs()).toHaveLength(0);expect((await root.query('SELECT group_audience_id FROM runs WHERE tenant_id=$1 AND id=$2',[business.ctx.tenantId,lease.runId])).rows[0].group_audience_id).toBeNull();await noDownstream();}
 return {business,configured,store,lease,signed,audience,issue,identity,proofs,credentialVersion,noDownstream,denied};
}

it('real configureDws -> identity -> GroupAudience -> signed adapter/client/service -> runner/CLI -> fresh owner guard issues one bound proof',async()=>{
 const f=await fresh(),version=await f.credentialVersion(),proof=await f.issue();expect(proof.id).toMatch(/^[a-f0-9-]{36}$/);expect(await f.proofs()).toEqual([{id:proof.id,proof_hash:proof.hash}]);expect(f.signed.groupCalls).toHaveLength(1);
 const [subject,,args,profile]=f.signed.groupCalls[0]!;expect(subject).toEqual(f.signed.delegation.subject);expect(args.conversationId).toBe(f.business.conversationId);expect(profile).toEqual(f.signed.scope.profile);
 const events=(await f.business.fixture.events()).filter(x=>['GROUP_INFO','GROUP_READ'].includes(x.phase));expect(events.map(x=>x.phase)).toEqual(['GROUP_INFO','GROUP_READ','GROUP_INFO']);expect(events.every(x=>x.user===f.business.ownerExternal&&x.tokenMatches&&x.group===f.business.conversationId)).toBe(true);
 expect(await f.credentialVersion()).toBe(version+1);await f.noDownstream();
 const lease={...f.lease,groupAudience:proof};expect(await db.scope(f.business.ctx,c=>f.audience.currentLocal(c,f.business.ctx,lease))).toBe(true);
 // A valid leaf signature is not a membership/ACL grant. The fresh owner read
 // must notice an independently changed roster and refuse the old proof.
 await f.business.configure({info:groupInfoReply(2,1,'after-proof-member-change')});expect(await db.scope(f.business.ctx,c=>f.audience.current(c,f.business.ctx,lease))).toBe(false);expect(f.signed.groupCalls).toHaveLength(2);expect(await f.proofs()).toHaveLength(1);await f.noDownstream();
},30000);

it.each(['bad-signature','expired','no-service-scopes','wrong-group'] as const)('configured signed path %s rejects with zero runner/proof/downstream',async fault=>{
 const f=await fresh(fault),before=await f.credentialVersion();await f.denied(f.issue(),fault==='bad-signature'?'DWS_RPC_TRANSPORT_FAILED':'DWS_RPC_SCOPE_MISMATCH');expect(f.signed.groupCalls).toHaveLength(0);expect(await f.credentialVersion()).toBe(before);
});
it.each(['tenant','actor'] as const)('real current guard rejects wrong %s before signed read',async field=>{
 const f=await fresh(),ctx={...f.business.ctx,[field==='tenant'?'tenantId':'actorId']:randomUUID()};await f.denied(f.issue(ctx));expect(f.signed.groupCalls).toHaveLength(0);
});
it('current identity authorization change cannot reuse the configured delegation',async()=>{
 const f=await fresh();await root.query('UPDATE dws_identities SET authorization_version=authorization_version+1 WHERE tenant_id=$1 AND id=$2',[f.business.ctx.tenantId,f.identity.id]);await f.denied(f.issue(),'DWS_RPC_SCOPE_MISMATCH');expect(f.signed.groupCalls).toHaveLength(0);
});
it.each(['schema','partial','member-change','external-denial','external-roster'] as const)('actual CLI %s cannot return enterprise data, create proof or enqueue any sending',async mode=>{
 const f=await fresh(),reply=groupMembersReply(f.business.conversationId,[f.business.ownerOpen,mode==='external-roster'?'unbound-external-open-id':f.business.otherOpen]);if(mode==='partial')reply.data.buckets.users.partial=true;
 await f.business.fixture.mode(mode==='schema'?'schema':'normal',{groups:{[f.business.conversationId]:{allowedUsers:mode==='external-denial'?[]:[f.business.ownerExternal],reply,info:groupInfoReply(),infoAfter:mode==='member-change'?groupInfoReply(2,1,'r2'):groupInfoReply()}}});
 await f.denied(f.issue(),{schema:'DWS_SCHEMA_CHANGED',partial:'DWS_RPC_EXECUTION_FAILED','member-change':'DWS_RPC_EXECUTION_FAILED','external-denial':'DWS_BUSINESS_DENIED','external-roster':'GROUP_MEMBER_DIRECTORY_AMBIGUOUS'}[mode]);expect(f.signed.groupCalls).toHaveLength(1);
});
it.each(['scope','directory'] as const)('independent PG %s revoke at completed real read barrier is seen by fresh owner postguard',async kind=>{
 const f=await fresh(),before=await f.credentialVersion();let revoked=false;
 f.signed.afterRead(async()=>{if(revoked)return;await root.query(kind==='scope'?'UPDATE dws_group_scopes SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2':'UPDATE group_directory_bindings SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND scope_id=$2 AND user_id=$3',kind==='scope'?[f.business.ctx.tenantId,f.business.scopeId]:[f.business.ctx.tenantId,f.business.scopeId,f.business.otherId]);revoked=true;});
 await f.denied(f.issue(),kind==='scope'?'GROUP_SCOPE_UNVERIFIED':'GROUP_MEMBER_DIRECTORY_UNVERIFIED');expect(revoked).toBe(true);expect(f.signed.groupCalls).toHaveLength(1);
 // Scope rejection occurs inside identity read, before state persistence.
 // Directory rejection occurs later in GroupAudience, after legitimate rotation.
 expect(await f.credentialVersion()).toBe(before+(kind==='directory'?1:0));
});
it('protocol replay refusal differs from business duplicate-proof protection on the actual configured call chain',async()=>{
 const f=await fresh(),proof=await f.issue(),before=await f.credentialVersion();
 await expect(f.issue()).rejects.toMatchObject({code:'GROUP_AUDIENCE_ALREADY_BOUND'});expect(await f.proofs()).toEqual([{id:proof.id,proof_hash:proof.hash}]);expect(await f.credentialVersion()).toBe(before+1);expect(f.signed.groupCalls).toHaveLength(2);
 const expired=await f.signed.request();expired.expiresAt=Date.now()-1;expect((await f.signed.rawRead(f.signed.sign(expired))).result).toEqual({ok:false,code:'DWS_RPC_EXPIRED'});
 const request=await f.signed.request(),envelope=f.signed.sign(request),results=await Promise.all([f.signed.rawRead(envelope),f.signed.rawRead(envelope)]);expect(results.filter(x=>x.result.ok)).toHaveLength(1);expect(results.find(x=>!x.result.ok)!.result).toEqual({ok:false,code:'DWS_RPC_REPLAY'});expect(f.signed.groupCalls).toHaveLength(3);expect(await f.proofs()).toHaveLength(1);await f.noDownstream();
},30000);
