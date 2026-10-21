import {reviewedCapability} from '../../gateway/src/reviewed-capabilities.js';
import {taskResultContract,taskBindingHash} from './task-result-contract.js';
import {randomUUID} from 'node:crypto';
import {watchTrial,trialState,TrialStopped} from '../../storage/src/trial.js';
import {z} from 'zod';
import {glmRequestBody,type ModelProvider} from '../../provider-glm/src/client.js';
import {ProviderError} from '../../provider-glm/src/client.js';
import type {DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {Gateway,canonical} from '../../gateway/src/index.js';
import {estimateModelPayload,type ModelReservation} from './model-budget.js';
import {BudgetError} from './budget.js';
import {RuntimeStore,LeaseLost} from './store.js';
import type {CompleteTurn,StreamProgress} from '../../provider-glm/src/sse.js';
import {SYSTEM_PROMPT,CONTEXT_BYTES,ContextLimit,ContextRebuildRequired,ContextIntegrity} from './checkpoint.js';
export function registerTaskCapability(gateway:Gateway):void {
 gateway.register({...taskResultContract,...reviewedCapability('tasks.get','core:tasks.current'),id:'tasks.get',version:'1.0.0',description:'Read the current task state and goal. Does not execute or change anything.',risk:'READ',provider:'CORE',schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},bindingHash:taskBindingHash,state:'READY',resource:(_args,lease)=>lease.taskId,execute:async(_args,{principal,lease})=>{
  const q=await gateway.store.db.scope(principal,c=>c.query('SELECT id,goal,status FROM tasks WHERE id=$1',[lease.taskId]));return {status:q.rowCount?'OK':'EMPTY',data:q.rows[0]??null,evidenceIds:[],completeness:'COMPLETE'};
 }});
}
export class AgentRuntime {
 constructor(private store:RuntimeStore,private model:ModelProvider,private gateway:Gateway) {}
 async advance(ctx:DbContext,runId:string,workerId=randomUUID(),parentSignal?:AbortSignal,expectedGeneration?:number):Promise<void> {
  const lease=await this.store.acquire(ctx,runId,workerId,expectedGeneration);if(!lease) return;
  const watcher=await watchTrial(this.store.db,ctx,runId);
  const controller=new AbortController(),activeDeadline=AbortSignal.timeout(lease.remainingActiveMs),signal=AbortSignal.any([controller.signal,activeDeadline,watcher.signal,...(parentSignal?[parentSignal]:[])]);
  const timer=setInterval(()=>{void this.store.renew(ctx,lease).catch(()=>controller.abort(new LeaseLost()));},10000);timer.unref();
  let request:ModelReservation|null=null,providerInvoked=false;
  try {
   await this.store.recoverModels(ctx,lease);
   if(!await this.gateway.prepareAudience(ctx,lease,signal)){await this.store.pause(ctx,lease,'WAITING_AUTH','GROUP_AUDIENCE_UNVERIFIED');return;}
   if(await this.store.processNativeGroupCase(ctx,lease,signal))return;
   if(!await this.gateway.preparePersonas(ctx,lease,signal)){await this.store.pause(ctx,lease,'WAITING_USER','PERSONA_CONTEXT_UNAVAILABLE');return;}
   if(await this.gateway.resumeApproved(ctx,lease,signal))return;
   const initial=await this.gateway.loadContext(ctx,lease);if(initial.blocked)return;let history=initial.messages;
   if(!history.length) {const personaMessage=await this.store.guarded(ctx,lease,c=>this.store.personaMessage(c,ctx,lease,signal));await this.store.append(ctx,lease,{role:'system',content:SYSTEM_PROMPT+(personaMessage?'\n'+personaMessage.content:'')});const inputs=await this.store.inputManifest(ctx,lease);await this.store.append(ctx,lease,{role:'user',content:lease.goal+(inputs.length?'\nAttachment references (not contents or credentials): '+JSON.stringify(inputs):'')});history=await this.store.history(ctx,lease);}
   while(!signal.aborted) {
    if(!await this.gateway.contextAllowed(ctx,lease,history)){const rebuilt=await this.gateway.rebuildContext(ctx,lease,'AUTHORIZATION_CHANGED',history);if(rebuilt.blocked)return;history=rebuilt.messages;continue;}
    const lastAssistant=[...history].reverse().find(m=>m.role==='assistant');
    const pending=lastAssistant?.tool_calls?.filter(tc=>!history.some(m=>m.role==='tool'&&m.tool_call_id===tc.id))??[];
    if(pending.length) {
     for(const call of pending) {
      signal.throwIfAborted();
      const inputHash=hash(canonical({name:call.function.name,args:JSON.parse(call.function.arguments) as unknown}));
      const count=await this.store.guarded(ctx,lease,async c=>{
       const q=await c.query('SELECT count(*)::int n FROM run_steps WHERE run_id=$1 AND input_hash=$2',[runId,inputHash]);
       await c.query("INSERT INTO run_steps(tenant_id,id,owner_id,run_id,seq,kind,state,input_hash,safe_payload) VALUES($1,$2,$3,$4,(SELECT coalesce(max(seq),0)+1 FROM run_steps WHERE run_id=$4),'tool.started','PREPARED',$5,$6)",[ctx.tenantId,randomUUID(),ctx.actorId,runId,inputHash,JSON.stringify({tool:call.function.name})]);return Number(q.rows[0].n);
      });
      if(count>=2) {await this.store.pause(ctx,lease,'PARTIAL','NO_PROGRESS_GUARD');return;}
      const result=await this.gateway.execute(ctx,lease,call.function.name,JSON.parse(call.function.arguments) as unknown,signal);
      if(result.status==='DEFERRED')return;
      await this.store.append(ctx,lease,{role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
      if(result.status==='UNKNOWN') {await this.store.pause(ctx,lease,'WAITING_USER','RECONCILIATION_REQUIRED');return;}
      if(result.status==='NEEDS_AUTH') {await this.store.pause(ctx,lease,'WAITING_AUTH',result.remediation?.kind??'USER_CONSENT_REQUIRED');return;}
      if(result.status==='NEEDS_APPROVAL') {await this.store.pause(ctx,lease,'WAITING_APPROVAL','APPROVAL_REQUIRED');return;}
      if(result.status==='RETRYABLE_ERROR') {await this.store.scheduleRetry(ctx,lease,'READ_TOOL_RETRYABLE');return;}
     }
     const current=await this.gateway.loadContext(ctx,lease);if(current.blocked)return;history=current.messages;continue;
    }
    // A complete assistant response without tools was committed before a crash.
    if(history.at(-1)?.role==='assistant'&&!history.at(-1)?.tool_calls?.length) {
     const proposal=history.at(-1)!.content??'',input=await this.store.narrativeInput(ctx,lease,proposal);
     if(input&&!await this.store.hasNarrativeReview(ctx,lease,proposal,input)){
      const limits=Object.freeze(this.store.modelLimits());if(!this.model.describeRequest&&process.env['OA_TEST_ISOLATED']!=='true')throw new BudgetError('MODEL_REQUEST_DESCRIPTION_REQUIRED');
      const messages=structuredClone(input.messages);for(const message of messages)Object.freeze(message);Object.freeze(messages);const payload=this.model.describeRequest?.(messages,[],limits)??glmRequestBody(messages,[],'high',limits);request=await this.store.prepareModel(ctx,lease,payload);providerInvoked=false;
      await this.store.startModel(ctx,lease,request,payload,c=>this.gateway.modelDispatchReason(ctx,lease,history,c,signal));signal.throwIfAborted();
      if(estimateModelPayload(this.model.describeRequest?.(messages,[],limits)??glmRequestBody(messages,[],'high',limits)).hash!==request.payloadHash)throw new ProviderError('PAYLOAD_CHANGED_BEFORE_SEND',false,null,'NOT_SENT');
      await this.store.guarded(ctx,lease,async()=>{});signal.throwIfAborted();providerInvoked=true;const reviewed=await this.model.complete(messages,[],signal,undefined,limits),reviewRequest=request;await this.store.finishModel(ctx,request.id,'COMPLETE',reviewed.usage);request=null;signal.throwIfAborted();
      if(reviewed.message.tool_calls?.length||reviewed.finishReason!=='stop')throw new ProviderError('NARRATIVE_REVIEW_PROTOCOL_INVALID',false);
      if(!await this.gateway.modelAllowed(ctx,lease)){await this.store.pause(ctx,lease,'WAITING_USER','KILL_SWITCH');return;}
      await this.store.recordNarrativeReview(ctx,lease,proposal,input,reviewRequest,reviewed.message.content??'');
     }
     const finalized=await this.gateway.finalize(ctx,lease,proposal,true);if(finalized.kind!=='REPAIR')return;const current=await this.gateway.loadContext(ctx,lease);if(current.blocked)return;history=current.messages;continue;}
    if(Buffer.byteLength(JSON.stringify(history),'utf8')>CONTEXT_BYTES) {const rebuilt=await this.gateway.rebuildContext(ctx,lease,'CONTEXT_LIMIT',history);if(rebuilt.blocked)return;history=rebuilt.messages;continue;}
    const tools=await this.gateway.tools(ctx,lease);if(!await this.gateway.contextAllowed(ctx,lease,history)){const rebuilt=await this.gateway.rebuildContext(ctx,lease,'AUTHORIZATION_CHANGED',history);if(rebuilt.blocked)return;history=rebuilt.messages;continue;}
    if(!await this.gateway.modelAllowed(ctx,lease)){await this.store.pause(ctx,lease,'WAITING_USER','KILL_SWITCH');return;}
    const limits=Object.freeze(this.store.modelLimits());if(!this.model.describeRequest&&process.env['OA_TEST_ISOLATED']!=='true')throw new BudgetError('MODEL_REQUEST_DESCRIPTION_REQUIRED');
    const requestMessages=structuredClone(history),requestTools=structuredClone(tools);const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(requestMessages);freeze(requestTools);
    const payload=this.model.describeRequest?.(requestMessages,requestTools,limits)??glmRequestBody(requestMessages,requestTools,'high',limits);request=await this.store.prepareModel(ctx,lease,payload);providerInvoked=false;
    const streamAttempt=await this.store.beginStream(ctx,lease,request.id);let progress:StreamProgress={sequence:0,contentFragments:0,toolFragments:0},lastProgressAt=0,turn:CompleteTurn;
    try{await this.store.startModel(ctx,lease,request,payload,c=>this.gateway.modelDispatchReason(ctx,lease,requestMessages,c,signal));}
    catch(error){if(error instanceof BudgetError&&['MODEL_CONTEXT_CHANGED_BEFORE_DISPATCH','MODEL_KILL_SWITCH'].includes(error.code)){await this.store.finishModel(ctx,request.id,'NOT_SENT',null,error.code);request=null;await this.store.streamProgress(ctx,lease,streamAttempt,progress,'INTERRUPTED');if(error.code==='MODEL_KILL_SWITCH'){await this.store.pause(ctx,lease,'WAITING_USER','KILL_SWITCH');return;}const rebuilt=await this.gateway.rebuildContext(ctx,lease,'AUTHORIZATION_CHANGED',history);if(rebuilt.blocked)return;history=rebuilt.messages;continue;}throw error;}
    try{signal.throwIfAborted();if(estimateModelPayload(this.model.describeRequest?.(requestMessages,requestTools,limits)??glmRequestBody(requestMessages,requestTools,'high',limits)).hash!==request.payloadHash)throw new ProviderError('PAYLOAD_CHANGED_BEFORE_SEND',false,null,'NOT_SENT');await this.store.guarded(ctx,lease,async()=>{});signal.throwIfAborted();providerInvoked=true;turn=await this.model.complete(requestMessages,requestTools,signal,async current=>{progress=current;if(Date.now()-lastProgressAt>=750){await this.store.streamProgress(ctx,lease,streamAttempt,progress,'RECEIVING');lastProgressAt=Date.now();}},limits);await this.store.finishModel(ctx,request.id,'COMPLETE',turn.usage);request=null;await this.store.streamProgress(ctx,lease,streamAttempt,progress,'COMPLETE');}
    catch(error){try{await this.store.streamProgress(ctx,lease,streamAttempt,progress,'INTERRUPTED');}catch(lost){if(!(lost instanceof LeaseLost)&&!(lost instanceof BudgetError))throw lost;}throw error;}
    signal.throwIfAborted();await this.store.append(ctx,lease,turn.message);
    const current=await this.gateway.loadContext(ctx,lease);if(current.blocked)return;history=current.messages;
   }
   throw signal.reason;
  } catch(e) {
   if(request){await this.store.finishModel(ctx,request.id,!providerInvoked||e instanceof ProviderError&&e.requestState==='NOT_SENT'?'NOT_SENT':'UNKNOWN',null,e instanceof Error?e.name:'MODEL_REQUEST_FAILED');request=null;}
   try {
    const lifecycle=await this.store.db.scope(ctx,c=>trialState(c,lease.runId,true));if(lifecycle.restricted&&lifecycle.mode!=='FORMAL')await this.store.db.scope(ctx,c=>trialState(c,lease.runId,false,e instanceof TrialStopped?e.reason:'TRIAL_RUN_STOPPED'));
    else if(activeDeadline.aborted)await this.store.stopBudget(ctx,lease,'ACTIVE_TIME_BUDGET_EXHAUSTED');
    else if(e instanceof BudgetError){if(e.retryable)await this.store.scheduleRetry(ctx,lease,e.code,e.retryAfterMs);else await this.store.stopBudget(ctx,lease,e.code);}
    else if(e instanceof TrialStopped&&e.reason.startsWith('GROUP_CONTRACT_'))await this.store.pause(ctx,lease,'PARTIAL',e.reason);
    else if(e instanceof LeaseLost || signal.aborted) {if(parentSignal?.aborted&&parentSignal.reason instanceof Error&&parentSignal.reason.message==='SERVICE_SHUTDOWN')await this.store.scheduleRetry(ctx,lease,'SERVICE_SHUTDOWN',100);else await this.store.pause(ctx,lease,'PARTIAL','CANCELLED_OR_ACTIVE_TIME_LIMIT');}
    else {const code=e instanceof ProviderError?e.code:e instanceof ContextRebuildRequired?e.reason:e instanceof ContextLimit||e instanceof ContextIntegrity?e.message:e instanceof Error&&e.message==='MODEL_BUDGET_EXHAUSTED'?e.message:'PROTOCOL_OR_PROVIDER_FAILURE';if(code==='MODEL_BUDGET_EXHAUSTED'||e instanceof ContextLimit||e instanceof ContextIntegrity)await this.store.pause(ctx,lease,'PARTIAL',code);else if(e instanceof ProviderError&&!e.retryable)await this.store.pause(ctx,lease,/^AUTH_|^BLOCKED_EXTERNAL/.test(code)?'WAITING_AUTH':'FAILED',code);else await this.store.scheduleRetry(ctx,lease,code,e instanceof ProviderError?e.retryAfterMs:null);}
   }catch(error){if(error instanceof BudgetError)await this.store.stopBudget(ctx,lease,error.code);else if(!(error instanceof LeaseLost))throw error; /* A concurrent stop or newer owner has authority over every provider outcome. */}
  } finally {clearInterval(timer);controller.abort();await watcher.stop();await this.store.release(ctx,lease);}
 }
}
