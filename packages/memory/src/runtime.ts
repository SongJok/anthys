import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import type {Lease} from '../../runtime/src/store.js';
import {PrivatePreferences} from './service.js';
const classification=z.enum(['INTERNAL','CONFIDENTIAL','RESTRICTED']);
export const memoryModelPolicy=z.object({schemaVersion:z.literal(1),id:z.string().min(1).max(100),environment:z.enum(['PRODUCTION','SYNTHETIC_TEST']),approved:z.literal(true),approvalReference:z.string().min(8).max(512),validUntil:z.iso.datetime(),allowedClassifications:z.array(classification).min(1).max(3).refine(v=>new Set(v).size===v.length),maxItems:z.number().int().min(1).max(20),maxBytes:z.number().int().min(1000).max(12000)}).strict();
const item=z.object({memoryId:z.uuid(),revisionId:z.uuid(),revisionHash:z.string().regex(/^[a-f0-9]{64}$/),sensitivity:classification,title:z.string().min(1).max(160),content:z.string().min(1).max(4000),validFrom:z.iso.datetime(),validTo:z.iso.datetime()}).strict();
export const frozenMemory=z.object({state:z.enum(['BOUND','POLICY_DISABLED','GROUP_EXCLUDED']),policyHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),items:z.array(item).max(20),truncated:z.boolean(),scanned:z.number().int().nonnegative()}).strict().refine(v=>v.state==='BOUND'?v.policyHash!==null:v.policyHash===null&&v.items.length===0&&!v.truncated&&v.scanned===0).refine(v=>new Set(v.items.map(i=>i.memoryId)).size===v.items.length);
export type FrozenMemory=z.infer<typeof frozenMemory>;
export type MemoryModelPolicy=z.infer<typeof memoryModelPolicy>;
function loadPolicy(){const path=process.env['PRIVATE_MEMORY_MODEL_POLICY_FILE'];if(!path)return null;const data=readFileSync(path);if(data.length>65536)throw Error('MEMORY_MODEL_POLICY_TOO_LARGE');return memoryModelPolicy.parse(JSON.parse(data.toString('utf8')));}
export class RuntimePreferences {
 readonly policy:MemoryModelPolicy|null;
 constructor(readonly preferences:PrivatePreferences,policy:MemoryModelPolicy|null=loadPolicy()){
  this.policy=policy?Object.freeze(memoryModelPolicy.parse(policy)):null;
  if(this.policy){const isolated=process.env['OA_TEST_ISOLATED']==='true'&&process.env['APP_ENV']==='test';if((this.policy.environment==='SYNTHETIC_TEST')!==isolated)throw Error('MEMORY_MODEL_POLICY_ENVIRONMENT_MISMATCH');}
 }
 private usable(){return !!this.policy&&Date.parse(this.policy.validUntil)>Date.now();}
 async issue(c:pg.PoolClient,ctx:DbContext,lease:Lease):Promise<FrozenMemory>{
  if(lease.audience['kind']==='GROUP')return {state:'GROUP_EXCLUDED',policyHash:null,items:[],truncated:false,scanned:0};
  if(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId)throw Error('MEMORY_AUDIENCE_DENIED');
  if(!this.policy)return {state:'POLICY_DISABLED',policyHash:null,items:[],truncated:false,scanned:0};if(!this.usable())throw Error('MEMORY_MODEL_POLICY_EXPIRED');
  const result=await this.preferences.currentInTransaction(c,ctx,lease.goal,true),levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'],ceiling=levels.indexOf(lease.audience['classificationCeiling'] as string),selected:FrozenMemory['items']=[];let truncated=result.truncated,bytes=0;
  for(const record of result.items){if(!this.policy.allowedClassifications.includes(record.sensitivity)||levels.indexOf(record.sensitivity)>ceiling)continue;const value=item.parse({memoryId:record.id,revisionId:record.revisionId,revisionHash:record.revisionHash,sensitivity:record.sensitivity,title:record.title,content:record.content,validFrom:record.validFrom,validTo:record.validTo}),size=Buffer.byteLength(JSON.stringify(value));if(selected.length>=this.policy.maxItems||bytes+size>this.policy.maxBytes){truncated=true;continue;}selected.push(value);bytes+=size;}
  return frozenMemory.parse({state:'BOUND',policyHash:hash(canonical(this.policy)),items:selected,truncated,scanned:result.scanned});
 }
 async link(c:pg.PoolClient,ctx:DbContext,lease:Lease,snapshotId:string,proof:FrozenMemory){for(const value of proof.items)await c.query('INSERT INTO run_memory_sources(tenant_id,id,owner_id,run_id,task_id,snapshot_id,memory_id,revision_id,revision_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,randomUUID(),ctx.actorId,lease.runId,lease.taskId,snapshotId,value.memoryId,value.revisionId,value.revisionHash]);}
 async current(c:pg.PoolClient,ctx:DbContext,lease:Lease,snapshotId:string,raw:unknown){
  try{if(raw===undefined)return !(await c.query('SELECT id FROM run_memory_sources WHERE snapshot_id=$1 AND run_id=$2 AND owner_id=$3 LIMIT 1',[snapshotId,lease.runId,ctx.actorId])).rowCount;const proof=frozenMemory.parse(raw);if(proof.state==='GROUP_EXCLUDED')return lease.audience['kind']==='GROUP'&&!(await c.query('SELECT id FROM run_memory_sources WHERE snapshot_id=$1 AND owner_id=$2 LIMIT 1',[snapshotId,ctx.actorId])).rowCount;if(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId)return false;if(proof.state==='BOUND'&&(!this.usable()||proof.policyHash!==hash(canonical(this.policy))))return false;
   const refs=(await c.query('SELECT memory_id,revision_id,revision_hash FROM run_memory_sources WHERE snapshot_id=$1 AND run_id=$2 AND owner_id=$3 ORDER BY memory_id',[snapshotId,lease.runId,ctx.actorId])).rows,expected=proof.items.map(i=>({memory_id:i.memoryId,revision_id:i.revisionId,revision_hash:i.revisionHash})).sort((a,b)=>a.memory_id.localeCompare(b.memory_id));if(canonical(refs)!==canonical(expected))return false;
   for(const value of proof.items){const row=(await c.query("SELECT r.body_ref,r.body_hash,r.sensitivity,r.valid_from,r.valid_to FROM memory_items m JOIN memory_revisions r ON r.tenant_id=m.tenant_id AND r.id=m.current_revision_id AND r.memory_id=m.id AND r.owner_id=m.owner_id WHERE m.id=$1 AND m.owner_id=$2 AND m.state='ACTIVE' AND NOT EXISTS(SELECT 1 FROM memory_deletions d WHERE d.tenant_id=m.tenant_id AND d.memory_id=m.id) AND r.id=$3 AND r.allow_model=true AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()",[value.memoryId,ctx.actorId,value.revisionId])).rows[0];if(!row||row.body_hash!==value.revisionHash||hash(canonical(row.body_ref))!==value.revisionHash||row.sensitivity!==value.sensitivity||new Date(row.valid_from as string).toISOString()!==value.validFrom||new Date(row.valid_to as string).toISOString()!==value.validTo||!this.policy?.allowedClassifications.includes(value.sensitivity))return false;}
   return true;
  }catch{return false;}
 }
}
