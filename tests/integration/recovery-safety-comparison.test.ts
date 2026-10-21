import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {PrivatePreferences} from '../../packages/memory/src/service.js';
import {Personas} from '../../packages/personas/src/service.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {capturePostgresInventory,comparePostgresInventories} from '../../packages/operations/src/postgres-inventory.js';
import {compareRecoverySafety} from '../../packages/operations/src/recovery-safety-comparison.js';

const signal=()=>new AbortController().signal;
/** Actual whole-database rollback, deliberately WITHOUT copying newer tombstones
 * into the restored target. This checks the diagnostic boundary, not a replay
 * implementation or authorization to resume the restored runtime. */
it('T124 detects safety facts lost after a whole old-backup restore even when backup integrity is MATCH',async()=>{
 const own=await groupReminderDatabase(),key=randomBytes(32),vault=new Vault(new Map([['synthetic',key]]),'synthetic');
 let directory:string|undefined;
 try{
  await own.install();
  const ctx={tenantId:randomUUID(),actorId:randomUUID()},grantId=randomUUID(),actionId=randomUUID();
  await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_RECOVERY_DIFF','ACTIVE')",[ctx.tenantId]);
  await own.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC_RECOVERY_DIFF','ACTIVE')",[ctx.tenantId,ctx.actorId]);
  const sessions=new Sessions(own.appDb,randomBytes(32).toString('hex')),session=await sessions.create(ctx),principal=(await sessions.authenticate(session.cookie))!;
  const source={sessionId:principal.sessionId,authEpoch:principal.authEpoch},memory=new PrivatePreferences(own.db,vault),personas=new Personas(own.db,vault);
  const canary='SYNTHETIC_DELETED_AFTER_BACKUP_'+randomUUID(),saved=await memory.save(ctx,{kind:'PREFERENCE',title:'合成恢复核对',content:canary,sensitivity:'CONFIDENTIAL',allowModel:false},randomUUID(),source);
  await personas.patch(ctx,{kind:'USER',id:ctx.actorId},{address:canary},'"0"',randomUUID(),source);
  const task=await new TaskStore(own.db).create(ctx,'SYNTHETIC_RECONCILIATION_ONLY',randomUUID());
  // Fixture setup is not an actual external call or production grant operation.
  // The post-backup transitions below model the durable facts that recovery
  // must not lose; memory/persona erasure uses their real production services.
  await own.root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'synthetic.recovery.read','synthetic-resource','PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 day')",[ctx.tenantId,grantId,ctx.actorId]);
  await own.root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,tool_version) VALUES($1,$2,$3,$4,$5,$6,'PREPARED','SYNTHETIC_RECOVERY','1.0.0')",[ctx.tenantId,actionId,ctx.actorId,task.runId,randomUUID(),hash('SYNTHETIC_RECOVERY')]);
  await own.root.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline,state) VALUES($1,$2,$3,$4,$1::uuid::text,$2::uuid::text,'SYNTHETIC_ROBOT','SYNTHETIC_CONVERSATION',clock_timestamp()+interval '1 day','ARMED')",[ctx.tenantId,ctx.actorId,hash('SYNTHETIC_RECOVERY_TRIAL'),hash('SYNTHETIC_RECOVERY_BUDGET')]);
  const system=(await own.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value as string;
  const inventory=(connectionString:string,expectedDatabase:string)=>capturePostgresInventory({connectionString,expectedDatabase,expectedSystemIdentifier:system,expectedSchemaFingerprint:requiredSchema.contractHash,limits:{maxTables:512,maxRows:100000,maxBytes:32*1024*1024,timeoutMs:60000},signal:signal()});
  const before=await inventory(own.connectionString,own.name),dump=await own.dumpOwn();
  expect((await memory.forget(ctx,saved.memoryId,randomUUID(),source)).outcome).toBe('DELETED');
  await personas.erasePrivate(ctx,randomUUID(),source);
  await own.root.query('UPDATE resource_grants SET revoked_at=clock_timestamp(),version=version+1 WHERE id=$1',[grantId]);
  await own.root.query("UPDATE tool_actions SET state='UNKNOWN' WHERE id=$1",[actionId]);
  await own.root.query("UPDATE one_shot_trials SET state='CLOSED',closed_at=clock_timestamp(),close_reason='SYNTHETIC_AFTER_BACKUP_CLOSE' WHERE tenant_id=$1",[ctx.tenantId]);
  const current=await inventory(own.connectionString,own.name);
  expect((await own.root.query('SELECT count(*)::int n FROM memory_deletions WHERE memory_id=$1',[saved.memoryId])).rows[0].n).toBe(1);
  expect((await own.root.query('SELECT count(*)::int n FROM persona_privacy_erasures WHERE owner_id=$1',[ctx.actorId])).rows[0].n).toBe(1);
  // Destroy only this fixture's confirmed nonce after capturing the newer facts.
  // The private inventory contains hashes/counts, not executable erasure rows.
  expect((await own.destroyOwnSource()).state).toBe('DESTROYED');
  const target=await own.restoreOwn(dump);dump.fill(0);
  const restored=await inventory(target.connectionString,target.name);
  expect(comparePostgresInventories(before,restored)).toMatchObject({status:'MATCH',externalDispatchResumeAuthorized:false});
  expect((await target.root.query('SELECT state FROM memory_items WHERE id=$1',[saved.memoryId])).rows[0].state).toBe('ACTIVE');
  expect((await target.root.query('SELECT count(*)::int n FROM memory_deletions')).rows[0].n).toBe(0);
  expect((await target.root.query('SELECT count(*)::int n FROM persona_privacy_erasures')).rows[0].n).toBe(0);
  expect((await target.root.query('SELECT revoked_at FROM resource_grants WHERE id=$1',[grantId])).rows[0].revoked_at).toBeNull();
  expect((await target.root.query('SELECT state FROM tool_actions WHERE id=$1',[actionId])).rows[0].state).toBe('PREPARED');
  expect((await target.root.query('SELECT state FROM one_shot_trials WHERE tenant_id=$1',[ctx.tenantId])).rows[0].state).toBe('ARMED');
  const result=compareRecoverySafety(current,restored);
  expect(result).toMatchObject({status:'DIFFERENCE_REQUIRES_RECONCILIATION',externalDispatchResumeAuthorized:false,currentAuthorityFreshnessVerified:false,safetyFactsReplayed:false,revocationAndExternalStateReconciliationRequired:true});
  expect(result.tables.changed.map(row=>row.name)).toEqual(expect.arrayContaining(['memory_deletions','memory_scope_epochs','persona_privacy_state','persona_privacy_erasures','resource_grants','one_shot_trials','tool_actions']));
  const same=compareRecoverySafety(restored,restored);
  expect(same).toMatchObject({status:'NO_DIFFERENCE_OBSERVED',externalDispatchResumeAuthorized:false,currentAuthorityFreshnessVerified:false,safetyFactsReplayed:false});
  directory=await realpath(await mkdtemp(join(await realpath('/tmp'),'oa-recovery-diff-')));
  const currentFile=join(directory,'current.json'),restoredFile=join(directory,'restored.json');
  await writeFile(currentFile,JSON.stringify(current),{mode:0o600});await writeFile(restoredFile,JSON.stringify(restored),{mode:0o600});
  const cwd=resolve(import.meta.dirname,'../..');
  const command=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
   const child=spawn(process.execPath,['--import',join(cwd,'scripts/test-network-guard.mjs'),'--import',join(cwd,'node_modules/tsx/dist/loader.mjs'),join(cwd,'scripts/restore-verification.ts'),'compare-safety','--current',currentFile,'--restored',restoredFile],{cwd,env:{PATH:process.env['PATH']??'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
   child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});
  });
  expect(command.code).toBe(1);expect(command.stderr).toBe('');expect(JSON.parse(command.stdout)).toEqual(result);
  for(const privateText of [canary,ctx.tenantId,ctx.actorId,grantId,actionId,own.connectionString,directory])expect(command.stdout).not.toContain(privateText);
  // The comparison is read-only: no "repair" of CLOSED/UNKNOWN/grants or erasure
  // occurred; no runtime/model/connector/sender is started against this target.
  expect((await inventory(target.connectionString,target.name)).contentFingerprint).toBe(restored.contentFingerprint);
 }finally{await own.close();if(directory)await rm(directory,{recursive:true,force:true});key.fill(0);}
},120000);
