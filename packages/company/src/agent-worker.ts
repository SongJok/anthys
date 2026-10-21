import {randomUUID} from 'node:crypto';
import type {DbContext} from '../../storage/src/database.js';
import type {CompanyAgentChat,AgentChatResult} from './agent-chat.js';
import type {CompanyAgentRequests,AgentRequestRow} from './agent-requests.js';
import {watchTrial} from '../../storage/src/trial.js';
import type {AgentRequestClaim} from './agent-requests.js';

export type AgentConnectionOpener=(row:AgentRequestRow,signal:AbortSignal)=>Promise<{chat:Pick<CompanyAgentChat,'request'>;close:()=>Promise<void>}>;
/** A background unit claims durable state first; it never resubmits a previously
 * dispatched row. Host scheduling is separate from the model-run worker. */
export class CompanyAgentWorker {
 constructor(private readonly requests:CompanyAgentRequests,private readonly open:AgentConnectionOpener,private readonly observe?:(ctx:DbContext,claim:AgentRequestClaim,row:AgentRequestRow,signal:AbortSignal)=>Promise<void>){}
 async once(ctx:DbContext,parent:AbortSignal,workerId:string=randomUUID()){
  const claim=await this.requests.claim(ctx,workerId,parent);if(!claim)return false;
  const controller=new AbortController();let signal=AbortSignal.any([parent,controller.signal]),watcher:Awaited<ReturnType<typeof watchTrial>>|undefined;let renewing:Promise<void>|undefined,connection:Awaited<ReturnType<AgentConnectionOpener>>|undefined;
  // A roster observation holds the same formal lifecycle rows as renewal.
  // Serialize only this worker's two operations; the independent authority
  // watcher and all original request/lease/deadline checks remain active.
  let observing:Promise<void>|undefined;
  const observe=(row:AgentRequestRow,abort:AbortSignal)=>{
   observing=(async()=>{await renewing;abort.throwIfAborted();await this.observe!(ctx,claim,row,abort);})();
   return observing.finally(()=>{observing=undefined;});
  };
  const timer=setInterval(()=>{if(!observing&&!renewing&&!signal.aborted)renewing=this.requests.renew(ctx,claim,signal).then(allowed=>{if(!allowed)controller.abort();},()=>controller.abort()).finally(()=>{renewing=undefined;});},1000);timer.unref();
  let result:AgentChatResult={status:'NOT_SENT',localRequestId:claim.id,reason:'INVALID_CONFIGURATION'};
  try{
   const loaded=await this.requests.load(ctx,claim,signal);signal.throwIfAborted();
   watcher=await watchTrial(this.requests.store.db,ctx,loaded.row.run_id);signal=AbortSignal.any([signal,watcher.signal]);signal.throwIfAborted();
   connection=await this.open(loaded.row,signal);signal.throwIfAborted();
   result=await connection.chat.request({localRequestId:claim.id,message:loaded.message,signal,absoluteDeadlineMs:loaded.row.deadline.getTime(),maxWaitMs:Number(loaded.row['wait_budget_ms']),...(this.observe?{prepareDispatch:(s:AbortSignal)=>observe(loaded.row,s)}:{}),beforeDispatch:(summary,dispatchSignal)=>this.requests.beforeDispatch(ctx,claim,summary,dispatchSignal)});
   if(result.status==='RESPONSE_RECEIVED'&&this.observe)await observe(loaded.row,signal);
  }catch{result={status:'NOT_SENT',localRequestId:claim.id,reason:'HOST_REJECTED'}; /* Persisted dispatch, never this label, decides UNKNOWN. */ }
  finally{
   clearInterval(timer);await renewing;
   // The chat deadline can win its Promise.race before an aborted observation
   // finishes rollback/cleanup. Drain it before completing this same claim.
   await observing?.catch(()=>{});
   try{await this.requests.complete(ctx,claim,result,signal);if(!signal.aborted)await this.requests.resume(ctx,claim.id,signal);}
   finally{controller.abort();await watcher?.stop();await connection?.close().catch(()=>{});}
  }
  return true;
 }
}
