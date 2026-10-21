import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {appendAudit} from '../../packages/storage/src/audit.js';
import {hash} from '../../packages/storage/src/crypto.js';

const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!);
const ctx={tenantId:randomUUID(),actorId:randomUUID()},other=randomUUID(),resource=randomUUID(),traceId=randomUUID();
const event={action:'message.accepted' as const,resource,result:'ENQUEUED' as const,traceId};
beforeAll(async()=>{
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC AUDIT','ACTIVE')",[ctx.tenantId]);
 for(const id of [ctx.actorId,other])await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC','ACTIVE')",[ctx.tenantId,id]);
});
afterAll(async()=>{await db.close();await admin.end();});

it('concurrent audit appends and multiple appends per transaction form one ordered, verifiable actor chain',async()=>{
 await Promise.all(Array.from({length:20},()=>db.scope(ctx,c=>appendAudit(c,ctx,event))));
 await db.scope(ctx,async c=>{await appendAudit(c,ctx,event);await appendAudit(c,ctx,event);});
 const rows=(await db.scope(ctx,c=>c.query('SELECT *,created_at::text stamp FROM audit_events ORDER BY created_at,id'))).rows;
 expect(rows).toHaveLength(22);let previousHash:string|null=null,previousStamp='';
 for(const row of rows){
  expect(row.previous_hash).toBe(previousHash);
  expect(row.hash).toBe(hash(JSON.stringify({tenantId:ctx.tenantId,actorId:ctx.actorId,id:row.id,...event,previousHash})));
  expect(row.stamp>previousStamp).toBe(true);previousStamp=row.stamp as string;previousHash=row.hash as string;
 }
});

it('an aborted business transaction leaves no audit success; unstructured data is rejected before insertion',async()=>{
 const absent=randomUUID();
 await expect(db.scope(ctx,async c=>{await appendAudit(c,ctx,{...event,resource:absent});throw Error('SYNTHETIC_ROLLBACK');})).rejects.toThrow('SYNTHETIC_ROLLBACK');
 expect((await db.scope(ctx,c=>c.query('SELECT id FROM audit_events WHERE resource=$1',[absent]))).rowCount).toBe(0);
 const unsafe={...event,resource:absent,body:'SYNTHETIC_PRIVATE_TEXT',webhook:'SYNTHETIC_WEBHOOK_SECRET'};
 await expect(db.scope(ctx,c=>appendAudit(c,ctx,unsafe))).rejects.toThrow();
 expect((await db.scope(ctx,c=>c.query('SELECT id FROM audit_events WHERE resource=$1',[absent]))).rowCount).toBe(0);
});

it('concurrent observations of the same terminal delivery append its audit result once',async()=>{
 const terminal={action:'delivery.finished' as const,resource:randomUUID(),result:'UNKNOWN' as const,traceId:randomUUID()};
 await Promise.all(Array.from({length:20},()=>db.scope(ctx,c=>appendAudit(c,ctx,terminal,true))));
 expect((await db.scope(ctx,c=>c.query('SELECT id FROM audit_events WHERE resource=$1',[terminal.resource]))).rowCount).toBe(1);
});

it('actor and tenant isolation apply to audit reads and inserts, with immutable existing rows',async()=>{
 await db.scope(ctx,c=>appendAudit(c,ctx,event));
 expect((await db.scope({...ctx,actorId:other},c=>c.query('SELECT id FROM audit_events'))).rowCount).toBe(0);
 expect((await db.scope({tenantId:randomUUID(),actorId:ctx.actorId},c=>c.query('SELECT id FROM audit_events'))).rowCount).toBe(0);
 await expect(db.scope(ctx,c=>appendAudit(c,{...ctx,actorId:other},event))).rejects.toMatchObject({code:'42501'});
 await expect(db.scope(ctx,c=>c.query("UPDATE audit_events SET result='FORGED'"))).rejects.toMatchObject({code:'42501'});
 await expect(db.scope(ctx,c=>c.query('DELETE FROM audit_events'))).rejects.toMatchObject({code:'42501'});
});
