import type {Database,DbContext} from '../../storage/src/database.js';
import {ModelBudget} from './model-budget.js';
import {trialState} from '../../storage/src/trial.js';
// Runtime-only maintenance over configured tenant namespaces. Discovery
// returns owner IDs, never private inputs, provider data or policy text.
export class BudgetRecovery {
 constructor(private db:Database,private budget=new ModelBudget()){}
 async owner(ctx:DbContext):Promise<number>{
  const lifecycle=await this.db.scope(ctx,c=>trialState(c,undefined,true));
  if(lifecycle.restricted&&!lifecycle.allowed)return 0;
  const trialRun=lifecycle.restricted&&lifecycle.mode!=='FORMAL'?lifecycle.runId:null;
  if(lifecycle.restricted&&lifecycle.mode!=='FORMAL'&&!trialRun)return 0;
  const runs=await this.db.scope(ctx,async c=>(await c.query("SELECT DISTINCT q.run_id FROM quota_ledger q WHERE ($1::boolean=false OR public.oa_lifecycle_run_allowed(q.run_id)) AND ($2::uuid IS NULL OR q.run_id=$2) AND q.accounting_version=1 AND q.dispatch_state IN ('PREPARED','DISPATCHING') AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.tenant_id=q.tenant_id AND r.id=q.run_id AND r.fence=q.run_fence AND r.status='RUNNING' AND r.lease_until>clock_timestamp()) ORDER BY q.run_id LIMIT 100",[lifecycle.mode==='FORMAL',trialRun])).rows);let count=0;
  for(const run of runs)count+=await this.db.scope(ctx,async c=>{const current=await trialState(c,run.run_id as string,true);if(current.restricted&&(!current.allowed||current.mode!=='FORMAL'&&current.runId!==run.run_id))return 0;return this.budget.recover(c,run.run_id as string);});return count;
 }
 async tenant(configuredScope:DbContext):Promise<number>{
  // Decide restricted authority before discovering other owners or old orphans.
  const lifecycle=await this.db.scope(configuredScope,c=>trialState(c,undefined,true));
  if(lifecycle.restricted&&!lifecycle.allowed)return 0;
  if(lifecycle.restricted&&lifecycle.mode!=='FORMAL')return this.owner(configuredScope);
  const owners=await this.db.scope(configuredScope,async c=>(await c.query('SELECT * FROM public.oa_budget_orphan_owners()')).rows);let count=0;
  for(const owner of owners)count+=await this.owner({tenantId:configuredScope.tenantId,actorId:owner.owner_id as string});return count;
 }
}
