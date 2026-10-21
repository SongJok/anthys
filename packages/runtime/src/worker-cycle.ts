import type {Database,DbContext} from '../../storage/src/database.js';
import type {RunQueue} from '../../tasks/src/queue.js';
import type {RuntimeStore} from './store.js';
import type {BudgetRecovery} from './budget-recovery.js';
import type {RetryDispatcher} from './retry.js';
export async function publishWorkerCycle(db:Database,scopes:DbContext[],services:{store:Pick<RuntimeStore,'recoverGroupReplies'|'recoverSourceReplies'>;budgetRecovery:Pick<BudgetRecovery,'tenant'>;retryDispatcher:Pick<RetryDispatcher,'dispatch'>;queue:Pick<RunQueue,'publish'>}){
 const trial=db.trialProfileHash!==null;
 const tenants=[...new Map(scopes.map(scope=>[scope.tenantId,scope])).values()];
 for(const scope of tenants)await services.budgetRecovery.tenant(scope);
 for(const scope of scopes){
  // TRIAL never enters historical continuation/retry discovery. The dedicated
  // RUN publisher and budget recovery independently recheck DB authority.
  if(!trial){await services.store.recoverGroupReplies(scope);await services.store.recoverSourceReplies(scope);await services.retryDispatcher.dispatch(scope);}
  await services.queue.publish(db,scope);
 }
}
