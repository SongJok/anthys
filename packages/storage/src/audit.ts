import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from './database.js';
import {hash} from './crypto.js';

const auditEvent=z.object({
 action:z.enum(['message.accepted','message.receipt','run.finalized','delivery.claimed','delivery.finished']),
 resource:z.uuid(),
 result:z.enum(['ENQUEUED','PENDING','SUCCEEDED','PARTIAL','WAITING_USER','SENDING','APPLIED_UNVERIFIED','FAILED','UNKNOWN','SUPPRESSED']),
 traceId:z.uuid()
}).strict();

// Call inside the business transaction, after its row locks. Only fixed
// metadata reaches this append-only table; never accept callback/provider text.
export async function appendAudit(c:pg.PoolClient,ctx:DbContext,event:z.infer<typeof auditEvent>,once=false):Promise<void>{
 const value=auditEvent.parse(event),id=randomUUID();
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.tenantId}:${ctx.actorId}:audit`]);
 if(once&&(await c.query('SELECT id FROM audit_events WHERE actor_id=$1 AND action=$2 AND resource=$3 AND result=$4 AND trace_id=$5 LIMIT 1',[ctx.actorId,value.action,value.resource,value.result,value.traceId])).rowCount)return;
 const prior=(await c.query('SELECT hash,created_at::text stamp FROM audit_events WHERE actor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.actorId])).rows[0];
 const previousHash=prior?.hash as string|undefined;
 const digest=hash(JSON.stringify({tenantId:ctx.tenantId,actorId:ctx.actorId,id,...value,previousHash:previousHash??null}));
 // Preserve a strict append order even within one transaction or a clock step.
 await c.query("INSERT INTO audit_events(tenant_id,id,actor_id,action,resource,result,trace_id,previous_hash,hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,greatest(clock_timestamp(),coalesce($10::timestamptz+interval '1 microsecond',clock_timestamp())))",[ctx.tenantId,id,ctx.actorId,value.action,value.resource,value.result,value.traceId,previousHash??null,digest,prior?.stamp??null]);
}
