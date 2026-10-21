import {collectSse,type CompleteTurn,type ProviderMessage,type ProgressObserver} from './sse.js';
export interface ModelTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export class ProviderError extends Error {
 constructor(readonly code:string,readonly retryable:boolean,readonly retryAfterMs:number|null=null,readonly requestState:'UNKNOWN'|'NOT_SENT'='UNKNOWN'){super(code);this.name='ProviderError';}
}
export type ModelRequestLimits={maxOutputTokens:number};
export function glmRequestBody(messages:ProviderMessage[],tools:ModelTool[],reasoningEffort:'low'|'high'|'max'='high',limits:ModelRequestLimits={maxOutputTokens:8192}):Record<string,unknown>{
 if(!Number.isInteger(limits.maxOutputTokens)||limits.maxOutputTokens<1||limits.maxOutputTokens>8192)throw new ProviderError('INVALID_OUTPUT_BUDGET',false,null,'NOT_SENT');
 return {model:'glm-5.3-flash',messages,thinking:{type:'enabled',clear_thinking:false},reasoning_effort:reasoningEffort,stream:true,tool_stream:true,temperature:1,top_p:0.95,max_tokens:limits.maxOutputTokens,...(tools.length?{tools}:{})};
}
export interface ModelProvider {describeRequest?(messages:ProviderMessage[],tools:ModelTool[],limits:ModelRequestLimits):Record<string,unknown>;complete(messages:ProviderMessage[],tools:ModelTool[],signal:AbortSignal,observer?:ProgressObserver,limits?:ModelRequestLimits):Promise<CompleteTurn>}
export class GlmProvider implements ModelProvider {
 constructor(private opts:{apiKey:string;baseUrl:string;reasoningEffort:'low'|'high'|'max';fetch?:typeof fetch;timeoutMs?:number}) {
  if(!opts.apiKey) throw new ProviderError('BLOCKED_EXTERNAL:GLM_API_KEY',false,null,'NOT_SENT');
  const url=new URL(opts.baseUrl);if(url.protocol!=='https:' && url.hostname!=='127.0.0.1') throw Error('GLM_HTTPS_REQUIRED');
 }
 describeRequest(messages:ProviderMessage[],tools:ModelTool[],limits:ModelRequestLimits={maxOutputTokens:8192}){return glmRequestBody(messages,tools,this.opts.reasoningEffort,limits);}
 async complete(messages:ProviderMessage[],tools:ModelTool[],signal:AbortSignal,observer?:ProgressObserver,limits:ModelRequestLimits={maxOutputTokens:8192}):Promise<CompleteTurn> {
  if(signal.aborted)throw new ProviderError('REQUEST_ABORTED_BEFORE_SEND',false,null,'NOT_SENT');
  const cancel=AbortSignal.any([signal,AbortSignal.timeout(this.opts.timeoutMs??240000)]);
  const response=await (this.opts.fetch??fetch)(`${this.opts.baseUrl.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${this.opts.apiKey}`,'content-type':'application/json'},body:JSON.stringify(this.describeRequest(messages,tools,limits)),signal:cancel,redirect:'error'});
  if(!response.ok) {
   const r=response.headers.get('retry-after');const delay=r?(/^\d+(\.\d+)?$/.test(r)?Number(r)*1000:Math.max(0,Date.parse(r)-Date.now())):null;
   await response.body?.cancel();throw new ProviderError(response.status===401?'AUTH_INVALID':response.status===429?'RATE_LIMITED':response.status===400?'INVALID_REQUEST_OR_CONTEXT':'PROVIDER_HTTP_ERROR',response.status===429||response.status>=500,Number.isFinite(delay)?delay:null);
  }
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')) {await response.body?.cancel();throw new ProviderError('INVALID_STREAM_RESPONSE',false);}
  return collectSse(response.body,cancel,2*1024*1024,observer);
 }
}
