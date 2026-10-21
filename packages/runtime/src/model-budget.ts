import {groupGovernance} from '../../groups/src/governance.js';
import {randomUUID} from 'node:crypto';
import {Decimal} from 'decimal.js';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {BudgetError} from './budget.js';
import {assertPolicyEnvironment,loadModelBudgetPolicy,modelBudgetPolicySchema,type ModelBudgetPolicy} from './budget-policy.js';
import type {Lease} from './store.js';

type ScopeKind='TENANT'|'GROUP'|'DEPARTMENT'|'USER'|'TASK';
type Scope={kind:ScopeKind;id:string;period:string;limit:ModelBudgetPolicy['limits']['tenant']};
export type ModelReservation={id:string;inputTokens:number;outputTokens:number;payloadHash:string;policyHash:string};
type RequestRow=Record<string,unknown>&{id:string;run_id:string;dispatch_state:string;token_state:string;cost_state:string;reservation:string;reserved_tokens:string;input_bound:string;output_bound:string;policy_hash:string;payload_hash:string;policy_snapshot:{policy:ModelBudgetPolicy;departments:string[]};period:string;usage_hash:string|null;pricing_valid:boolean};
const usageSchema=z.object({prompt_tokens:z.number().int().nonnegative().safe(),completion_tokens:z.number().int().nonnegative().safe(),total_tokens:z.number().int().nonnegative().safe().optional(),prompt_tokens_details:z.object({cached_tokens:z.number().int().nonnegative().safe().optional()}).passthrough().optional()}).passthrough();
const Money=Decimal.clone({precision:48,rounding:Decimal.ROUND_CEIL});
const moneyText=(value:Decimal)=>value.toDecimalPlaces(12,Decimal.ROUND_CEIL).toFixed(12);
const scopeOrder:Record<ScopeKind,number>={TENANT:0,GROUP:1,DEPARTMENT:2,USER:3,TASK:4};
export function quotaMoney(input:number,output:number,rates:{inputPerMillion:string;outputPerMillion:string;cache?:{inputPerMillion:string;storagePerMillionTokenHour:'0'}|undefined},cachedInput=0):string{
 if(!Number.isSafeInteger(cachedInput)||cachedInput<0||cachedInput>input)throw new BudgetError('MODEL_CACHED_USAGE_INVALID');
 if(cachedInput>0&&!rates.cache)throw new BudgetError('MODEL_CACHE_TARIFF_UNCONFIRMED');
 // Reserve with ordinary ceilings before dispatch. Only an explicitly reviewed
 // zero-storage cache tariff can reduce the final input charge; round once.
 return moneyText(new Money(input-cachedInput).mul(rates.inputPerMillion).add(new Money(cachedInput).mul(rates.cache?.inputPerMillion??rates.inputPerMillion)).add(new Money(output).mul(rates.outputPerMillion)).div(1000000));
}
export function estimateModelPayload(payload:Record<string,unknown>):{tokens:number;hash:string}{
 let serialized:string;try{serialized=JSON.stringify(payload);}catch{throw new BudgetError('MODEL_REQUEST_UNSERIALIZABLE');}
 if(typeof serialized!=='string')throw new BudgetError('MODEL_REQUEST_UNSERIALIZABLE');
 if(payload['model']!=='glm-5.3-flash'||!Array.isArray(payload['messages'])||!payload['messages'].every(m=>m&&typeof m==='object'&&('content' in m)&&(m.content===null||typeof m.content==='string')))throw new BudgetError('MODEL_REQUEST_SHAPE_UNSUPPORTED');
 const tools=payload['tools'];if(tools!==undefined&&!Array.isArray(tools))throw new BudgetError('MODEL_REQUEST_SHAPE_UNSUPPORTED');
 // Includes the actual serialized native body: opaque reasoning, tool schemas,
 // function arguments and all provider settings. Framing and 25% margin are extra.
 return {tokens:Math.ceil((Buffer.byteLength(serialized,'utf8')+1024+payload['messages'].length*128+(Array.isArray(tools)?tools.length*256:0))*1.25),hash:hash(serialized)};
}
export class ModelBudget {
 readonly policy:ModelBudgetPolicy|null;
 private error:string|null;
 constructor(policy?:ModelBudgetPolicy){
  if(policy){this.policy=modelBudgetPolicySchema.parse(policy);assertPolicyEnvironment(this.policy);this.error=null;}
  else{const loaded=loadModelBudgetPolicy();this.policy=loaded.policy;this.error=loaded.error;}
 }
 limits(){if(!this.policy)throw new BudgetError(this.error??'MODEL_BUDGET_POLICY_UNCONFIGURED');return {maxOutputTokens:this.policy.maxOutputTokens};}
 private async ensurePolicy(c:pg.PoolClient,ctx:DbContext):Promise<{policy:ModelBudgetPolicy;hash:string}>{
  const p=this.policy;if(!p)throw new BudgetError(this.error??'MODEL_BUDGET_POLICY_UNCONFIGURED');assertPolicyEnvironment(p);const digest=hash(JSON.stringify(p));
  // id=tenant_id has a second unique index. Concurrent first requests can
  // conflict on either index; both mean the same policy must be rechecked.
  await c.query('INSERT INTO budget_policies(tenant_id,id,policy_hash,document,currency,valid_until) VALUES($1,$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ctx.tenantId,digest,JSON.stringify(p),p.currency,p.validUntil]);
  const row=(await c.query('SELECT * FROM public.oa_budget_policy_state()')).rows[0];
  if(row.policy_hash!==digest||row.currency!==p.currency)throw new BudgetError('MODEL_BUDGET_POLICY_VERSION_MISMATCH');if(!row.valid)throw new BudgetError('MODEL_BUDGET_POLICY_EXPIRED');if(row.blocked_reason)throw new BudgetError('MODEL_BUDGET_POLICY_BLOCKED');return {policy:p,hash:digest};
 }
 private async departments(c:pg.PoolClient,ctx:DbContext):Promise<string[]>{const rows=(await c.query('SELECT DISTINCT department_id FROM memberships WHERE user_id=$1 AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp()) ORDER BY department_id',[ctx.actorId])).rows;return rows.length?rows.map(r=>r.department_id as string):['UNASSIGNED'];}
 private async day(c:pg.PoolClient,zone:string){return (await c.query("WITH sampled AS (SELECT clock_timestamp() sampled_at) SELECT to_char(sampled_at AT TIME ZONE $1,'YYYY-MM-DD') period,date_trunc('day',sampled_at AT TIME ZONE $1) AT TIME ZONE $1 starts,(date_trunc('day',sampled_at AT TIME ZONE $1)+interval '1 day') AT TIME ZONE $1 ends FROM sampled",[zone])).rows[0] as {period:string;starts:Date;ends:Date};}
 private async allocations(c:pg.PoolClient,id:string){return (await c.query("SELECT a.*,b.scope_kind,b.scope_id FROM budget_allocations a JOIN budget_buckets b ON b.tenant_id=a.tenant_id AND b.id=a.bucket_id WHERE a.request_id=$1 ORDER BY CASE b.scope_kind WHEN 'TENANT' THEN 0 WHEN 'GROUP' THEN 1 WHEN 'DEPARTMENT' THEN 2 WHEN 'USER' THEN 3 ELSE 4 END,b.scope_id,b.id FOR UPDATE OF b",[id])).rows;}
 private async release(c:pg.PoolClient,row:RequestRow,code:string){
  if(row.token_state==='RELEASED'&&row.cost_state==='RELEASED')return;
  if(row.token_state==='SETTLED'||row.cost_state==='SETTLED')throw new BudgetError('SETTLED_MODEL_COST_CANNOT_BE_RELEASED');
  for(const a of await this.allocations(c,row.id)){const changed=await c.query('UPDATE budget_buckets SET reserved_tokens=reserved_tokens-$2,reserved_money=reserved_money-$3,version=version+1,updated_at=now() WHERE id=$1 AND reserved_tokens>=$2 AND reserved_money>=$3 RETURNING id',[a.bucket_id,a.reserved_tokens,a.reserved_money]);if(!changed.rowCount)throw new BudgetError('MODEL_QUOTA_ACCOUNTING_INTEGRITY');}
  if(['DISPATCHING','UNKNOWN'].includes(row.dispatch_state)&&!(await c.query('UPDATE runs SET model_turns=model_turns-1 WHERE id=$1 AND model_turns>0 RETURNING id',[row.run_id])).rowCount)throw new BudgetError('MODEL_TURN_ACCOUNTING_INTEGRITY');
  await c.query("UPDATE quota_ledger SET dispatch_state='RELEASED',token_state='RELEASED',cost_state='RELEASED',used_tokens=0,used=0,failure_code=$2,billing_basis='CONFIRMED_NOT_SENT',updated_at=now(),version=version+1 WHERE id=$1",[row.id,code]);
 }
 async recover(c:pg.PoolClient,runId:string):Promise<number>{
  await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[runId]);
  const rows=(await c.query("SELECT q.* FROM quota_ledger q WHERE q.run_id=$1 AND q.accounting_version=1 AND q.dispatch_state IN ('PREPARED','DISPATCHING') AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.fence=q.run_fence AND r.status='RUNNING' AND r.lease_until>clock_timestamp()) ORDER BY q.attempt_no FOR UPDATE OF q",[runId])).rows as RequestRow[];
  for(const row of rows)if(row.dispatch_state==='PREPARED')await this.release(c,row,'RECOVERED_BEFORE_DISPATCH');else await c.query("UPDATE quota_ledger SET dispatch_state='UNKNOWN',token_state='UNKNOWN',cost_state='UNKNOWN',failure_code='RECOVERED_AFTER_DISPATCH',updated_at=now(),version=version+1 WHERE id=$1",[row.id]);return rows.length;
 }
 async prepare(c:pg.PoolClient,ctx:DbContext,lease:Lease,payload:Record<string,unknown>):Promise<ModelReservation>{
  const configured=await this.ensurePolicy(c,ctx),p=configured.policy,estimate=estimateModelPayload(payload);
  if(payload['max_tokens']!==p.maxOutputTokens)throw new BudgetError('MODEL_OUTPUT_BUDGET_MISMATCH');if(estimate.tokens>p.maxInputTokens)throw new BudgetError('MODEL_INPUT_BUDGET_EXHAUSTED');
  const day=await this.day(c,p.dayZone);if((await c.query('SELECT public.oa_budget_has_legacy($1,$2) found',[day.starts,day.ends])).rows[0].found)throw new BudgetError('LEGACY_MODEL_COST_RECONCILIATION_REQUIRED');
  await this.recover(c,lease.runId);
  if((await c.query("SELECT id FROM quota_ledger WHERE run_id=$1 AND accounting_version=1 AND dispatch_state IN ('PREPARED','DISPATCHING')",[lease.runId])).rowCount)throw new BudgetError('MODEL_RUN_REQUEST_IN_PROGRESS',true,1000);
  const state=(await c.query('SELECT model_turns,model_attempts FROM runs WHERE id=$1',[lease.runId])).rows[0];if(Number(state.model_turns)>=lease.maxTurns||Number(state.model_attempts)>=Math.max(1,lease.maxTurns*4))throw new BudgetError('MODEL_BUDGET_EXHAUSTED');
  const departments=await this.departments(c,ctx),tokens=estimate.tokens+p.maxOutputTokens,money=quotaMoney(estimate.tokens,p.maxOutputTokens,p.ceiling);
  const scopes:Scope[]=[{kind:'TENANT',id:ctx.tenantId,period:day.period,limit:p.limits.tenant},...departments.map(id=>({kind:'DEPARTMENT' as const,id,period:day.period,limit:p.limits.department})),{kind:'USER',id:ctx.actorId,period:day.period,limit:p.limits.user},{kind:'TASK',id:lease.taskId,period:'LIFETIME',limit:p.limits.task}];if(lease.audience['kind']==='GROUP'){
   const governance=await groupGovernance(c,String(lease.audience['targetId']));if(!governance.allowed)throw new BudgetError('GROUP_CONTRACT_STOPPED');
   if(governance.mode==='CONTRACT'){
    if(governance.currency!==p.currency)throw new BudgetError('GROUP_CONTRACT_BUDGET_CURRENCY_MISMATCH');
    // Stable group identity and LIFETIME survive revisions, pauses and new delegates.
    scopes.push({kind:'GROUP',id:String(lease.audience['targetId']),period:'LIFETIME',limit:{...p.limits.tenant,money:new Money(governance.maxAmountMinor).div(100).toFixed(2)}});
   }
  }
  scopes.sort((a,b)=>scopeOrder[a.kind]-scopeOrder[b.kind]||a.id.localeCompare(b.id));
  const attempt=Number((await c.query('UPDATE runs SET model_attempts=model_attempts+1 WHERE id=$1 RETURNING model_attempts',[lease.runId])).rows[0].model_attempts),id=randomUUID();
  await c.query("INSERT INTO quota_ledger(tenant_id,id,owner_id,run_id,subject,period,reservation,cost_state,accounting_version,attempt_no,run_fence,dispatch_state,token_state,reserved_tokens,input_bound,output_bound,policy_hash,policy_snapshot,payload_hash,currency) VALUES($1,$2,$3,$4,$3::uuid::text,$5,$6,'RESERVED',1,$7,$8,'PREPARED','RESERVED',$9,$10,$11,$12,$13,$14,$15)",[ctx.tenantId,id,ctx.actorId,lease.runId,day.period,money,attempt,lease.fence,tokens,estimate.tokens,p.maxOutputTokens,configured.hash,JSON.stringify({policy:p,departments}),estimate.hash,p.currency]);
  for(const scope of scopes){
   await c.query('INSERT INTO budget_buckets(tenant_id,id,scope_kind,scope_id,period,currency,limit_tokens,limit_money,policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,scope_kind,scope_id,period,currency) DO NOTHING',[ctx.tenantId,randomUUID(),scope.kind,scope.id,scope.period,p.currency,scope.limit.tokens,scope.limit.money,configured.hash]);
   const bucket=(await c.query('SELECT * FROM budget_buckets WHERE scope_kind=$1 AND scope_id=$2 AND period=$3 AND currency=$4 FOR UPDATE',[scope.kind,scope.id,scope.period,p.currency])).rows[0];
   if(new Money(bucket.reserved_tokens as string).add(bucket.used_tokens as string).add(tokens).gt(scope.limit.tokens))throw new BudgetError('MODEL_TOKEN_BUDGET_EXHAUSTED_'+scope.kind);
   if(new Money(bucket.reserved_money as string).add(bucket.used_money as string).add(money).gt(scope.limit.money))throw new BudgetError('MODEL_MONEY_BUDGET_EXHAUSTED_'+scope.kind);
   if(Number((await c.query('SELECT public.oa_budget_live_count($1) count',[bucket.id])).rows[0].count)>=scope.limit.concurrent)throw new BudgetError('MODEL_CONCURRENCY_LIMIT',true,1000);
   await c.query('UPDATE budget_buckets SET reserved_tokens=reserved_tokens+$2,reserved_money=reserved_money+$3,limit_tokens=$4,limit_money=$5,policy_hash=$6,version=version+1,updated_at=now() WHERE id=$1',[bucket.id,tokens,money,scope.limit.tokens,scope.limit.money,configured.hash]);
   await c.query('INSERT INTO budget_allocations(tenant_id,id,owner_id,request_id,bucket_id,reserved_tokens,reserved_money) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,randomUUID(),ctx.actorId,id,bucket.id,tokens,money]);
  }
  return {id,inputTokens:estimate.tokens,outputTokens:p.maxOutputTokens,payloadHash:estimate.hash,policyHash:configured.hash};
 }
 async start(c:pg.PoolClient,ctx:DbContext,lease:Lease,reservation:ModelReservation,payload:Record<string,unknown>):Promise<void>{
  const configured=await this.ensurePolicy(c,ctx),row=(await c.query("SELECT * FROM quota_ledger WHERE id=$1 AND run_id=$2 AND run_fence=$3 AND dispatch_state='PREPARED' AND accounting_version=1 FOR UPDATE",[reservation.id,lease.runId,lease.fence])).rows[0] as RequestRow|undefined;
  if(!row)throw new BudgetError('MODEL_RESERVATION_STALE');if(row.policy_hash!==configured.hash)throw new BudgetError('MODEL_BUDGET_POLICY_VERSION_MISMATCH');if(row.payload_hash!==estimateModelPayload(payload).hash)throw new BudgetError('MODEL_PAYLOAD_CHANGED_BEFORE_DISPATCH');
  if((await this.day(c,configured.policy.dayZone)).period!==row.period)throw new BudgetError('MODEL_BUDGET_PERIOD_CHANGED',true,100);
  if(JSON.stringify(await this.departments(c,ctx))!==JSON.stringify(row.policy_snapshot.departments))throw new BudgetError('MODEL_DEPARTMENT_SCOPE_CHANGED');
  if(!(await c.query('UPDATE runs SET model_turns=model_turns+1 WHERE id=$1 AND model_turns<$2 RETURNING id',[lease.runId,lease.maxTurns])).rowCount)throw new BudgetError('MODEL_BUDGET_EXHAUSTED');
  await c.query("UPDATE quota_ledger SET dispatch_state='DISPATCHING',updated_at=now(),version=version+1 WHERE id=$1",[row.id]);
 }
 async finish(c:pg.PoolClient,id:string,kind:'COMPLETE'|'UNKNOWN'|'NOT_SENT',rawUsage:Record<string,unknown>|null=null,code=''):Promise<{violation:boolean}>{
  const scope=(await c.query('SELECT run_id FROM quota_ledger WHERE id=$1 AND accounting_version=1',[id])).rows[0];if(!scope)throw new BudgetError('MODEL_RESERVATION_NOT_FOUND');await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[scope.run_id]);
  const row=(await c.query("SELECT q.*,CASE WHEN q.policy_snapshot->'policy'->'pricing'<>'null'::jsonb THEN q.created_at>=(q.policy_snapshot->'policy'->'pricing'->>'validFrom')::timestamptz AND q.created_at<(q.policy_snapshot->'policy'->'pricing'->>'validUntil')::timestamptz ELSE false END pricing_valid FROM quota_ledger q WHERE q.id=$1 AND q.accounting_version=1 FOR UPDATE",[id])).rows[0] as RequestRow|undefined;
  if(!row)throw new BudgetError('MODEL_RESERVATION_NOT_FOUND');if(row.dispatch_state==='RELEASED')return {violation:false};
  if(kind==='COMPLETE'&&row.dispatch_state==='PREPARED'){await c.query('SELECT public.oa_budget_block()');await c.query("UPDATE quota_ledger SET dispatch_state='UNKNOWN',token_state='UNKNOWN',cost_state='UNKNOWN',failure_code='UNTRACKED_MODEL_DISPATCH' WHERE id=$1",[id]);return {violation:true};}
  if(kind==='NOT_SENT'||row.dispatch_state==='PREPARED'){await this.release(c,row,code||'CONFIRMED_BEFORE_DISPATCH');return {violation:false};}
  if(kind==='UNKNOWN'){
   if(row.dispatch_state==='DISPATCHING')await c.query("UPDATE quota_ledger SET dispatch_state='UNKNOWN',token_state='UNKNOWN',cost_state='UNKNOWN',failure_code=$2,updated_at=now(),version=version+1 WHERE id=$1",[id,code||'MODEL_REQUEST_INTERRUPTED']);return {violation:false};
  }
  const p=modelBudgetPolicySchema.parse(row.policy_snapshot.policy),pricing=p.pricing,parsed=usageSchema.safeParse(rawUsage);
  if(!parsed.success||parsed.data.total_tokens!==undefined&&parsed.data.total_tokens!==parsed.data.prompt_tokens+parsed.data.completion_tokens||parsed.success&&(parsed.data.prompt_tokens_details?.cached_tokens??0)>parsed.data.prompt_tokens||pricing?.cache&&parsed.data.prompt_tokens_details?.cached_tokens===undefined){
   if(row.token_state!=='SETTLED')await c.query("UPDATE quota_ledger SET dispatch_state='COMPLETE',token_state='UNKNOWN',cost_state='UNKNOWN',failure_code='MODEL_USAGE_UNAVAILABLE',updated_at=now(),version=version+1 WHERE id=$1",[id]);return {violation:false};
  }
  const u=parsed.data,usage={prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens,total_tokens:u.prompt_tokens+u.completion_tokens,cached_tokens:u.prompt_tokens_details?.cached_tokens??0},usageHash=hash(JSON.stringify(usage));
  if(row.usage_hash&&row.usage_hash!==usageHash||u.prompt_tokens>Number(row.input_bound)||u.completion_tokens>Number(row.output_bound)){
   await c.query('SELECT public.oa_budget_block()');await c.query("UPDATE quota_ledger SET dispatch_state='UNKNOWN',token_state=CASE WHEN token_state='SETTLED' THEN token_state ELSE 'UNKNOWN' END,cost_state=CASE WHEN cost_state='SETTLED' THEN cost_state ELSE 'UNKNOWN' END,failure_code='PROVIDER_USAGE_OUTSIDE_RESERVATION',provider_usage=CASE WHEN usage_hash IS NOT NULL THEN provider_usage ELSE $2::jsonb END,updated_at=now(),version=version+1 WHERE id=$1",[id,JSON.stringify(usage)]);return {violation:true};
  }
  if(row.token_state==='SETTLED')return {violation:false};
  const cost=pricing&&row.pricing_valid&&(usage.cached_tokens===0||pricing.cache)?quotaMoney(u.prompt_tokens,u.completion_tokens,pricing,usage.cached_tokens):null;
  if(cost!==null&&new Money(cost).gt(row.reservation)){await c.query('SELECT public.oa_budget_block()');await c.query("UPDATE quota_ledger SET dispatch_state='UNKNOWN',token_state=CASE WHEN token_state='SETTLED' THEN token_state ELSE 'UNKNOWN' END,cost_state=CASE WHEN cost_state='SETTLED' THEN cost_state ELSE 'UNKNOWN' END,failure_code='PROVIDER_USAGE_OUTSIDE_RESERVATION',updated_at=now(),version=version+1 WHERE id=$1",[id]);return {violation:true};}
  for(const a of await this.allocations(c,id)){
   const update=await c.query('UPDATE budget_buckets SET reserved_tokens=reserved_tokens-$2,used_tokens=used_tokens+$3,reserved_money=reserved_money-$4,used_money=used_money+$5,version=version+1,updated_at=now() WHERE id=$1 AND reserved_tokens>=$2 AND reserved_money>=$4 RETURNING id',[a.bucket_id,a.reserved_tokens,usage.total_tokens,cost===null?'0':a.reserved_money,cost??'0']);if(!update.rowCount)throw new BudgetError('MODEL_QUOTA_ACCOUNTING_INTEGRITY');
  }
  await c.query("UPDATE quota_ledger SET dispatch_state='COMPLETE',token_state='SETTLED',cost_state=$2,used_tokens=$3,used=$4,provider_usage=$5,usage_hash=$6,billing_basis=$7,updated_at=now(),version=version+1 WHERE id=$1",[id,cost===null?'UNKNOWN':'SETTLED',usage.total_tokens,cost,JSON.stringify(usage),usageHash,cost===null?'USAGE_KNOWN_TARIFF_UNCONFIRMED':'ADMIN_APPROVED_RATE_AND_PROVIDER_USAGE']);return {violation:false};
 }
}
