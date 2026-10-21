import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
afterAll(async()=>{await db.close();await root.end();});
it.each(['AHEAD','BEHIND'] as const)('default recovery follows the authoritative PostgreSQL lease when worker wall clock is %s',async mode=>{
 const ctx={tenantId:randomUUID(),actorId:randomUUID()};await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic retry clocks','ACTIVE')",[ctx.tenantId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic retry clocks','ACTIVE')",[ctx.tenantId,ctx.actorId]);const task=await new TaskStore(db).create(ctx,'只验证数据库租约时钟',randomUUID()),store=new RuntimeStore(db,vault),lease=(await store.acquire(ctx,task.runId,'synthetic-clock-owner'))!;expect(lease).not.toBeNull();if(mode==='BEHIND')await root.query("UPDATE runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[task.runId]);expect((await root.query('SELECT lease_until>clock_timestamp() valid FROM runs WHERE id=$1',[task.runId])).rows[0].valid).toBe(mode==='AHEAD');const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now+(mode==='AHEAD'?120000:-120000));
 try{expect(await new RetryDispatcher(db).dispatch(ctx)).toBe(mode==='AHEAD'?0:1);expect((await root.query('SELECT status,retry_generation FROM runs WHERE id=$1',[task.runId])).rows[0]).toMatchObject(mode==='AHEAD'?{status:'RUNNING',retry_generation:'0'}:{status:'QUEUED',retry_generation:'1'});expect((await root.query('SELECT id FROM tool_actions WHERE run_id=$1',[task.runId])).rowCount).toBe(0);}finally{clock.mockRestore();await store.release(ctx,lease);}
});
