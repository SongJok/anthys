import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import type {Vault,Sealed} from '../../storage/src/crypto.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {reminderPayload,renderReminder} from './model.js';
import {scheduleIdentity} from './service.js';
export async function reminderResultAllowed(c:pg.PoolClient,ctx:DbContext,vault:Vault,runId:string,result:string){try{
 const identity=await scheduleIdentity(c,ctx),row=(await c.query("SELECT o.*,s.payload_ref,s.payload_hash,s.auth_epoch,s.policy_version,s.id schedule_key,t.audience FROM schedule_occurrences o JOIN schedules s ON s.tenant_id=o.tenant_id AND s.id=o.schedule_id AND s.owner_id=o.owner_id JOIN tasks t ON t.tenant_id=o.tenant_id AND t.id=o.task_id AND t.requester_id=o.owner_id JOIN runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id AND r.owner_id=o.owner_id WHERE o.run_id=$1 AND o.state='STAGED' AND o.revision=s.revision AND s.state IN ('ACTIVE','COMPLETED') AND o.scheduled_at<=clock_timestamp() AND o.expires_at>clock_timestamp() AND t.expires_at=o.expires_at AND t.control_kind='REMINDER' AND t.status='COMPLETED' AND t.cancel_requested_at IS NULL AND t.auth_epoch=s.auth_epoch AND r.status='SUCCEEDED' AND r.result=$2 AND r.result_classification='INTERNAL' AND EXISTS(SELECT 1 FROM outbox b WHERE b.kind='SCHEDULE' AND b.aggregate_id=o.id AND b.published_at IS NOT NULL)",[runId,result])).rows[0];
 if(!row||Number(row.auth_epoch)!==identity.authEpoch||row.policy_version!==identity.policyVersion||row.content_hash!==hash(result)||canonical(row.audience)!==canonical({kind:'PRIVATE_USER',targetId:ctx.actorId,classificationCeiling:'INTERNAL'}))return false;
 const payloadText=vault.open(row.payload_ref as Sealed,`${ctx.tenantId}:${ctx.actorId}:schedule:${row.schedule_key}`);if(hash(payloadText)!==row.payload_hash)return false;const payload=reminderPayload.parse(JSON.parse(payloadText));
 return result===renderReminder(row.schedule_key as string,payload.text,(row.scheduled_at as Date).toISOString(),payload.rule.tz);
 }catch{return false;}}
export async function reminderDeliveryAllowed(c:pg.PoolClient,ctx:DbContext,vault:Vault,delivery:Record<string,unknown>){try{
 const text=vault.open(JSON.parse(delivery.content_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:delivery:${delivery.id}`),row=(await c.query("SELECT task_id,delivery_id FROM schedule_occurrences WHERE run_id=$1 AND state='STAGED'",[delivery.source_run_id])).rows[0];
 return !!row&&row.delivery_id===delivery.id&&row.task_id===delivery.task_id&&delivery.classification==='INTERNAL'&&canonical(delivery.target)===canonical({kind:'PRIVATE_USER',targetId:ctx.actorId,classificationCeiling:'INTERNAL'})&&await reminderResultAllowed(c,ctx,vault,delivery.source_run_id as string,text);
 }catch{return false;}}
