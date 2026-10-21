import '../support/isolation.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {Database} from '../../packages/storage/src/database.js';
import {secret} from '../../packages/config/src/index.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
afterAll(async()=>{await root.end();});
async function fixture(){
 const tenant=randomUUID(),foreignTenant=randomUUID(),owner={tenantId:tenant,actorId:randomUUID()},other={tenantId:tenant,actorId:randomUUID()},foreign={tenantId:foreignTenant,actorId:randomUUID()},grant=randomUUID();
 for(const t of [tenant,foreignTenant])await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic connection fixture','ACTIVE')",[t,'synthetic-'+t]);
 for(const actor of [owner,other,foreign])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic actor','ACTIVE')",[actor.tenantId,actor.actorId,'synthetic-'+actor.actorId]);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,'synthetic.connection','fixture:connection','PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour')",[tenant,grant,owner.actorId]);
 return {tenant,owner,other,foreign,grant};
}
it('the source requires its exact schema contract and a read-only migration ledger',async()=>{
 const db=new Database(secret('DATABASE_URL')!,1);try{expect(await db.ready()).toBe(true);}finally{await db.close();}
});
it('a borrowed connection terminated after audit INSERT cannot commit even when the callback returns normally',async()=>{
 const f=await fixture(),db=new Database(secret('DATABASE_URL')!,1),id=randomUUID();let entered!:()=>void,resume!:()=>void;
 const inserted=new Promise<void>(r=>{entered=r;}),continued=new Promise<void>(r=>{resume=r;}),log=vi.spyOn(console,'error').mockImplementation(()=>{});let pid:number|undefined,pending:Promise<void>|undefined;
 const audit=(client:pg.PoolClient)=>client.query("INSERT INTO audit_events(tenant_id,id,actor_id,action,resource,result,trace_id,hash) VALUES($1,$2,$3,'SYNTHETIC_CONNECTION_TEST','fixture:connection','SYNTHETIC',$4,$5)",[f.tenant,id,f.owner.actorId,randomUUID(),'a'.repeat(64)]);
 try{
  pending=db.scope(f.owner,async client=>{await audit(client);pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;entered();await continued;});void pending.catch(()=>{});
  await inserted;expect((await root.query('SELECT pg_terminate_backend($1) stopped',[pid])).rows[0].stopped).toBe(true);
  await vi.waitFor(()=>expect(db.transactionConnectionFailures).toBe(1));resume();
  await expect(pending).rejects.toBeInstanceOf(Error);
  expect(log.mock.calls).toContainEqual([JSON.stringify({kind:'DATABASE_TRANSACTION_CONNECTION_FAILED',count:1})]);expect(JSON.stringify(log.mock.calls)).not.toContain(f.owner.actorId);
  expect((await root.query('SELECT id FROM audit_events WHERE tenant_id=$1 AND id=$2',[f.tenant,id])).rowCount).toBe(0);
  const next=await db.scope(f.owner,async client=>{await audit(client);return (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;});expect(next).not.toBe(pid);
  expect((await root.query('SELECT id FROM audit_events WHERE tenant_id=$1 AND id=$2',[f.tenant,id])).rowCount).toBe(1);
  expect((await db.scope(f.other,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[f.grant]))).rowCount).toBe(0);
  expect((await db.scope(f.foreign,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[f.grant]))).rowCount).toBe(0);
 }finally{resume?.();await pending?.catch(()=>{});log.mockRestore();await db.close();}
});
it('a terminated idle connection is discarded, logs fixed metadata and cannot leak its prior actor',async()=>{
 const f=await fixture(),db=new Database(secret('DATABASE_URL')!,1),log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  const old=await db.scope(f.owner,async c=>{expect((await c.query('SELECT id FROM resource_grants WHERE id=$1',[f.grant])).rowCount).toBe(1);return (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;});
  expect((await root.query('SELECT pg_terminate_backend($1) stopped',[old])).rows[0].stopped).toBe(true);await vi.waitFor(()=>expect(db.idleConnectionFailures).toBe(1));
  expect(log.mock.calls).toContainEqual([JSON.stringify({kind:'DATABASE_IDLE_CONNECTION_FAILED',count:1})]);expect(JSON.stringify(log.mock.calls)).not.toContain(f.owner.actorId);
  const next=(await db.scope(f.other,c=>c.query("SELECT pg_backend_pid() pid,current_setting('app.actor_id') actor"))).rows[0];expect(next.pid).not.toBe(old);expect(next.actor).toBe(f.other.actorId);
  expect((await db.scope(f.other,c=>c.query('SELECT id FROM resource_grants WHERE id=$1',[f.grant]))).rowCount).toBe(0);expect(await db.ready()).toBe(true);
 }finally{log.mockRestore();await db.close();}
});
