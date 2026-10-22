import '../support/isolation.js';
import pg from 'pg';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {freezeRecoverySafetySource,recoverySafetyProjectionHash,recoverySafetyProjectionScope,type RecoverySafetySourceInput} from '../../packages/operations/src/recovery-safety-source.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {PrivatePreferences} from '../../packages/memory/src/service.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function input(own:Awaited<ReturnType<typeof groupReminderDatabase>>):Promise<RecoverySafetySourceInput>{
 const row=(await own.root.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) oid,(SELECT system_identifier::text FROM pg_control_system()) system')).rows[0];
 return {connectionString:own.connectionString,expectedDatabase:own.name,expectedDatabaseOid:row.oid,expectedSystemIdentifier:row.system,expectedSchemaFingerprint:requiredSchema.contractHash,timeoutMs:15000,maxRows:10000,maxBytes:3*1024*1024,signal:new AbortController().signal};
}
async function control(p:RecoverySafetySourceInput){const url=new URL(p.connectionString);url.pathname='/postgres';const c=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:3000});c.on('error',()=>{});await c.connect();return c;}

it('cold fence captures the whole fixed safety projection from the exact source and blocks every subsequent connection',async()=>{
 const own=await groupReminderDatabase();own.root.on('error',()=>{});const key=randomBytes(32);let admin:pg.Client|undefined;
 try{
  await own.install();const tenantId=randomUUID(),actorId=randomUUID(),canary='SYNTHETIC_PRIVATE_BODY_NOT_IN_SAFETY_CAPSULE_'+randomUUID();
  await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_FENCE','ACTIVE')",[tenantId]);
  await own.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,$3,'ACTIVE')",[tenantId,actorId,canary]);
  const sessions=new Sessions(own.appDb,randomBytes(32).toString('hex')),session=await sessions.create({tenantId,actorId}),principal=(await sessions.authenticate(session.cookie))!,memory=new PrivatePreferences(own.db,new Vault(new Map([['synthetic',key]]),'synthetic'));
  const source={sessionId:principal.sessionId,authEpoch:principal.authEpoch},saved=await memory.save({tenantId,actorId},{kind:'PREFERENCE',title:'合成冻结',content:canary,sensitivity:'CONFIDENTIAL',allowModel:false},randomUUID(),source);await memory.forget({tenantId,actorId},saved.memoryId,randomUUID(),source);
  await own.root.query("INSERT INTO dws_identities(tenant_id,id,owner_id,corp_id,external_user_id,auth_epoch,state,credentials_ref,binary_hash,delegation_expires_at) VALUES($1,$2,$3,$1::uuid::text,$3::uuid::text,1,'AUTH_REQUIRED',$4,$5,clock_timestamp()+interval '1 hour')",[tenantId,randomUUID(),actorId,JSON.stringify({synthetic:canary}),'a'.repeat(64)]);
  const p=await input(own);admin=await control(p);
  for(const change of [{expectedDatabaseOid:String(Number(p.expectedDatabaseOid)+1)},{expectedSystemIdentifier:'1'},{expectedSchemaFingerprint:'b'.repeat(64)}]){
   await expect(freezeRecoverySafetySource({...p,...change})).rejects.toMatchObject({sourceFenceMayBeActive:false});expect((await admin.query('SELECT datallowconn allowed FROM pg_database WHERE oid=$1::oid',[p.expectedDatabaseOid])).rows[0].allowed).toBe(true);
  }
  const captured=await freezeRecoverySafetySource(p);expect(captured).toMatchObject({externalDispatchResumeAuthorized:false,independentRetentionVerified:false,sourceReopenAuthorized:false,fence:{kind:'PG_NO_CONNECTIONS_SINGLE_BACKEND_V1',allowConnections:false,otherBackends:0,preparedTransactions:0}});
  expect(captured.facts.projectionHash).toBe(recoverySafetyProjectionHash);expect(captured.facts.tables.map(t=>t.table)).toEqual(recoverySafetyProjectionScope.tables.map(t=>t.table));expect(captured.factsHash).toBe(hash(JSON.stringify(captured.facts)));
  for(const table of captured.facts.tables)expect(table.sha256).toBe(hash(JSON.stringify(table.rows)));
  const erased=captured.facts.tables.find(t=>t.table==='memory_deletions')!;expect(erased.rows).toHaveLength(1);expect(JSON.parse(erased.rows[0]!).memory_id).toBe(saved.memoryId);expect(JSON.stringify(captured)).not.toContain(canary);expect(JSON.stringify(captured.facts)).not.toContain('credentials_ref');
  const fence=(await admin.query('SELECT datallowconn allowed,(SELECT count(*)::int FROM pg_stat_activity WHERE datid=d.oid) backends FROM pg_database d WHERE oid=$1::oid',[p.expectedDatabaseOid])).rows[0];expect(fence).toEqual({allowed:false,backends:0});
  const rejected=new pg.Client({connectionString:p.connectionString,connectionTimeoutMillis:2000});rejected.on('error',()=>{});try{await expect(rejected.connect()).rejects.toMatchObject({code:'55000'});}finally{await rejected.end();}
  // The source remains fenced, even after successful capture. Only this
  // fixture's issued nonce is destroyed; no generic reopen or FORCE is used.
  expect((await own.destroyOwnSource()).state).toBe('DESTROYED');
 }finally{await admin?.end();await own.close();key.fill(0);}
},60000);

it('a bounded projection failure leaves the confirmed source fenced and issues no successful authority result',async()=>{
 const own=await groupReminderDatabase();own.root.on('error',()=>{});let admin:pg.Client|undefined;
 try{await own.install();const p=await input(own);admin=await control(p);await expect(freezeRecoverySafetySource({...p,maxBytes:1024})).rejects.toMatchObject({code:'RECOVERY_SOURCE_CAPTURE_LIMIT',sourceFenceMayBeActive:true});expect((await admin.query('SELECT datallowconn allowed FROM pg_database WHERE oid=$1::oid',[p.expectedDatabaseOid])).rows[0].allowed).toBe(false);expect((await own.destroyOwnSource()).state).toBe('DESTROYED');}finally{await admin?.end();await own.close();}
},60000);

it('rejects an already cancelled source operation and unsafe routing before any database fence',async()=>{
 const p:RecoverySafetySourceInput={connectionString:'postgresql://oa_migrator:synthetic@127.0.0.1:64711/anthys_test_never_connect',expectedDatabase:'anthys_test_never_connect',expectedDatabaseOid:'1',expectedSystemIdentifier:'1',expectedSchemaFingerprint:'a'.repeat(64),timeoutMs:1000,maxRows:100,maxBytes:4096,signal:AbortSignal.abort()};
 await expect(freezeRecoverySafetySource(p)).rejects.toMatchObject({code:'RECOVERY_SOURCE_CANCELLED',sourceFenceMayBeActive:false});
 for(const connectionString of [p.connectionString.replace('64711','64712'),p.connectionString+'?options=unsafe',p.connectionString.replace('127.0.0.1','example.invalid')])await expect(freezeRecoverySafetySource({...p,connectionString,signal:new AbortController().signal})).rejects.toMatchObject({code:'RECOVERY_SOURCE_INPUT_INVALID',sourceFenceMayBeActive:false});
});
