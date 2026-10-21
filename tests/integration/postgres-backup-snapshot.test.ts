import '../support/isolation.js';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {historicalMigrationDatabase} from '../support/historical-migration-database.js';
import {openPostgresBackupSnapshot,type PostgresBackupSnapshotOptions} from '../../packages/operations/src/postgres-backup-snapshot.js';
import {projectBackupSchemaPrefix} from '../../packages/operations/src/project-backup-profile.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
let own:Awaited<ReturnType<typeof historicalMigrationDatabase>>,system:string;
const leases:Awaited<ReturnType<typeof openPostgresBackupSnapshot>>[]=[];
beforeAll(async()=>{own=await historicalMigrationDatabase(73);system=(await own.root.query('SELECT system_identifier::text value FROM pg_control_system()')).rows[0].value;},60000);
afterEach(async()=>{await Promise.all(leases.splice(0).map(lease=>lease.close()));});
afterAll(async()=>{await own?.close();},60000);
function options(patch:Partial<PostgresBackupSnapshotOptions>={}):PostgresBackupSnapshotOptions{
 const url=new URL(own.connectionString);
 return {connection:{host:'127.0.0.1',port:64711,database:own.name,user:'oa_migrator',password:decodeURIComponent(url.password),ssl:false,sslnegotiation:'postgres',client_encoding:'UTF8',replication:'false',binary:false,options:'-c row_security=off'},expectedDatabase:own.name,expectedSystemIdentifierSha256:hash(system),expectedMigrationCount:73,expectedSchemaFingerprint:projectBackupSchemaPrefix(73),expiresAt:new Date(Date.now()+30000).toISOString(),maxDurationMs:10000,signal:new AbortController().signal,...patch};
}
async function acquire(patch:Partial<PostgresBackupSnapshotOptions>={}){const value=await openPostgresBackupSnapshot(options(patch));leases.push(value);return value;}
it('exports a real readonly snapshot importable by another actual connection, without claiming current-state or maintenance proof',async()=>{
 const lease=await acquire(),reader=new pg.Client(options().connection),tenant=randomUUID();
 try{
  expect(lease).toMatchObject({externalDispatchResumeAuthorized:false,maintenanceIndependentlyVerified:false,sourceSchemaFingerprint:projectBackupSchemaPrefix(73)});expect(lease.snapshotId).toMatch(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]+$/);
  await own.root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC_SNAPSHOT','ACTIVE')",[tenant]);
  await reader.connect();await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+lease.snapshotId+"'");
  expect((await reader.query('SELECT count(*) n FROM tenants WHERE tenant_id=$1',[tenant])).rows[0].n).toBe('0');expect((await own.root.query('SELECT count(*) n FROM tenants WHERE tenant_id=$1',[tenant])).rows[0].n).toBe('1');
  // A held snapshot stays coherent; independent current inventories and an
  // external write fence are still required by the complete coordinator.
  await lease.checkHeldSnapshot();expect((await reader.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
 }finally{await reader.query('ROLLBACK').catch(()=>{});await reader.end();await lease.close();await own.root.query('DELETE FROM tenants WHERE tenant_id=$1',[tenant]);}
 await expect(lease.checkHeldSnapshot()).rejects.toThrow('BACKUP_SNAPSHOT_CLOSED');
});
it('rejects wrong system identity or ledger and releases its own connection and advisory lock',async()=>{
 await expect(acquire({expectedSystemIdentifierSha256:'b'.repeat(64)})).rejects.toThrow('BACKUP_SNAPSHOT_IDENTITY_REJECTED');
 await expect(acquire({expectedMigrationCount:94,expectedSchemaFingerprint:projectBackupSchemaPrefix(94)})).rejects.toThrow('BACKUP_SNAPSHOT_LEDGER_CHANGED');
 const client=await own.root.connect();try{expect((await client.query("SELECT pg_try_advisory_lock(hashtext('anthys_migrations')) obtained")).rows[0].obtained).toBe(true);await client.query("SELECT pg_advisory_unlock(hashtext('anthys_migrations'))");}finally{client.release();}
 expect((await own.root.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='anthys_backup_snapshot'",[own.name])).rows[0].n).toBe('0');
});
it('refuses even an idle application connection and does not terminate it',async()=>{
 const url=new URL(process.env['DATABASE_URL']!);url.pathname='/'+own.name;const app=new pg.Client({connectionString:url.href});try{await app.connect();await expect(acquire()).rejects.toThrow('BACKUP_SNAPSHOT_DISPATCHERS_OR_IN_FLIGHT');expect((await app.query('SELECT 1 value')).rows[0].value).toBe(1);}finally{await app.end();}
});
it('pre-cancel or an expired window never opens a control connection',async()=>{
 const a=new AbortController();a.abort();await expect(acquire({signal:a.signal})).rejects.toThrow('BACKUP_SNAPSHOT_CANCELLED');await expect(acquire({expiresAt:'2000-01-01T00:00:00.000Z'})).rejects.toThrow('BACKUP_SNAPSHOT_WINDOW_CLOSED');
 expect((await own.root.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='anthys_backup_snapshot'",[own.name])).rows[0].n).toBe('0');
});
it('cancels an already exported snapshot, closes it and keeps the source ledger untouched',async()=>{
 const a=new AbortController(),lease=await acquire({signal:a.signal});a.abort();await expect(lease.checkHeldSnapshot()).rejects.toThrow('BACKUP_SNAPSHOT_CANCELLED_OR_TIMEOUT');await lease.close();expect((await own.root.query('SELECT count(*) n FROM schema_migrations')).rows[0].n).toBe('73');
});
it('acquires the migration lock before freezing the ledger snapshot, rejecting a migration committed during its actual lock wait',async()=>{
 const blocker=await own.root.connect();let pending:ReturnType<typeof acquire>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext('anthys_migrations'))");pending=acquire();void pending.catch(()=>{});
  const end=performance.now()+3000;for(;;){if((await own.root.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND a.application_name='anthys_backup_snapshot' AND l.locktype='advisory' AND NOT l.granted) waiting",[own.name])).rows[0].waiting)break;if(performance.now()>=end)throw Error('SYNTHETIC_SNAPSHOT_LOCK_WAIT_NOT_OBSERVED');await new Promise(r=>setTimeout(r,10));}
  const migration=requiredSchema.migrations[73]!,sql=await readFile('db/migrations/'+migration.name,'utf8');expect(hash(sql)).toBe(migration.hash);await blocker.query(sql);await blocker.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)',[migration.name,migration.hash]);await blocker.query('COMMIT');
  await expect(pending).rejects.toThrow('BACKUP_SNAPSHOT_LEDGER_CHANGED');expect((await own.root.query('SELECT count(*) n FROM schema_migrations')).rows[0].n).toBe('74');
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await pending?.catch(()=>{});}
},30000);
