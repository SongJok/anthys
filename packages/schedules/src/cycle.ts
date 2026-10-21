import type {DbContext} from '../../storage/src/database.js';
/** A failed owner cannot starve another owner's queue. Abort remains a stop. */
export async function runReminderCycle(scopes:readonly DbContext[],scheduler:{tick(ctx:DbContext,signal:AbortSignal):Promise<void>},signal:AbortSignal,onFailure:(index:number)=>void){
 let completed=0,failed=0;
 for(const [index,ctx] of scopes.entries()){signal.throwIfAborted();try{await scheduler.tick(ctx,signal);completed++;}catch{signal.throwIfAborted();failed++;onFailure(index);}}
 return {completed,failed};
}
