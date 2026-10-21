import {z} from 'zod';

const limitsSchema=z.object({
 absoluteDeadlineMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 maxResponseBytes:z.number().int().min(1).max(1048576).default(1048576),
 maxTotalBytes:z.number().int().min(1).max(4194304).default(4194304),
 maxChunks:z.number().int().min(1).max(8192).default(8192),
 idleTimeoutMs:z.number().int().min(1).max(1200000).default(1200000)
}).strict();
export class AgentTransportError extends Error {
 constructor(readonly code:string){super(code);}
}
/** One connection per durable request. Bounds apply before SDK JSON/SSE parsing,
 * including discovery, errors and progress. No redirects, optional GET channel,
 * auth discovery, remote polling or DELETE cancellation are inferred. */
export function boundedAgentFetch(endpoint:string,parent:AbortSignal,options:z.input<typeof limitsSchema>,fetcher:typeof fetch=fetch){
 const limits=limitsSchema.parse(options),target=new URL(endpoint);
 if(target.protocol!=='https:'||target.username||target.password||target.hash||target.search||target.href!==endpoint)throw new AgentTransportError('AGENT_ENDPOINT_INVALID');
 const remaining=limits.absoluteDeadlineMs-Date.now();
 if(remaining<=0||remaining>1200000)throw new AgentTransportError('AGENT_DEADLINE_INVALID');
 const connection=new AbortController();let bytes=0,chunks=0,closed=false;
 const readers=new Set<()=>void>();
 const fail=(code:string)=>{const error=new AgentTransportError(code);if(!connection.signal.aborted)connection.abort(error);return error;};
 const abortParent=()=>{fail('AGENT_WAIT_CANCELLED');};
 parent.addEventListener('abort',abortParent,{once:true});if(parent.aborted)abortParent();
 const timer=setTimeout(()=>{fail('AGENT_ABSOLUTE_DEADLINE');},remaining);timer.unref();
 async function interrupt<T>(promise:Promise<T>,signal:AbortSignal,timeout:number):Promise<T>{
  let abort=()=>{},idle:ReturnType<typeof setTimeout>|undefined;
  const interrupted=new Promise<never>((_resolve,reject)=>{
   abort=()=>reject(connection.signal.reason instanceof AgentTransportError?connection.signal.reason:new AgentTransportError('AGENT_WAIT_CANCELLED'));
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   idle=setTimeout(()=>reject(fail('AGENT_IDLE_DEADLINE')),Math.max(1,Math.min(timeout,limits.absoluteDeadlineMs-Date.now())));idle.unref();
  });
  try{return await Promise.race([promise,interrupted]);}finally{if(idle)clearTimeout(idle);signal.removeEventListener('abort',abort);}
 }
 const bounded:typeof fetch=async(input,init={})=>{
  if(closed)throw new AgentTransportError('AGENT_CONNECTION_CLOSED');
  connection.signal.throwIfAborted();
  if(Date.now()>=limits.absoluteDeadlineMs)throw fail('AGENT_ABSOLUTE_DEADLINE');
  const request=input instanceof Request?input:undefined,url=new URL(request?.url??String(input));
  if(url.href!==target.href)throw fail('AGENT_DESTINATION_CHANGED');
  const method=(init.method??request?.method??'GET').toUpperCase();
  if(method==='GET')return new Response(null,{status:405});
  if(method!=='POST')throw fail('AGENT_METHOD_UNAPPROVED');
  const body=init.body??request?.body;
  if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>80000)throw fail('AGENT_REQUEST_LIMIT');
  const signal=AbortSignal.any([connection.signal,...(init.signal?[init.signal]:[]),...(request?[request.signal]:[])]);
  const pending=Promise.resolve().then(()=>{signal.throwIfAborted();if(Date.now()>=limits.absoluteDeadlineMs)throw fail('AGENT_ABSOLUTE_DEADLINE');return fetcher(input,{...init,method:'POST',body,redirect:'error',signal});});
  // Also dispose a late response from a non-cooperative fetch implementation.
  void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
  const response=await interrupt(pending,signal,limits.idleTimeoutMs);
  const rejectResponse=(code:string)=>{void response.body?.cancel().catch(()=>{});throw fail(code);};
  if(Date.now()>=limits.absoluteDeadlineMs)rejectResponse('AGENT_ABSOLUTE_DEADLINE');
  if(signal.aborted)rejectResponse('AGENT_WAIT_CANCELLED');
  if(response.redirected||response.url&&response.url!==target.href||response.status>=300&&response.status<400)rejectResponse('AGENT_REDIRECT_REJECTED');
  const headerBytes=Array.from(response.headers).reduce((sum,[key,value])=>sum+Buffer.byteLength(key+value,'utf8'),0);
  if(headerBytes>65536)rejectResponse('AGENT_HEADER_LIMIT');
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>Math.min(limits.maxResponseBytes,limits.maxTotalBytes-bytes)))rejectResponse('AGENT_RESPONSE_LIMIT');
  if(!response.body)return response;
  const reader=response.body.getReader();let responseBytes=0,finished=false;
  const detach=()=>{readers.delete(dispose);signal.removeEventListener('abort',dispose);};
  const dispose=()=>{if(finished)return;finished=true;detach();void reader.cancel().catch(()=>{}).finally(()=>reader.releaseLock());};
  readers.add(dispose);signal.addEventListener('abort',dispose,{once:true});if(signal.aborted)dispose();
  const stream=new ReadableStream<Uint8Array>({async pull(controller){
   try{
    signal.throwIfAborted();if(Date.now()>=limits.absoluteDeadlineMs)throw fail('AGENT_ABSOLUTE_DEADLINE');
    const next=await interrupt(reader.read(),signal,limits.idleTimeoutMs);
    signal.throwIfAborted();if(Date.now()>=limits.absoluteDeadlineMs)throw fail('AGENT_ABSOLUTE_DEADLINE');
    if(next.done){finished=true;detach();reader.releaseLock();controller.close();return;}
    responseBytes+=next.value.byteLength;bytes+=next.value.byteLength;chunks++;
    if(responseBytes>limits.maxResponseBytes||bytes>limits.maxTotalBytes||chunks>limits.maxChunks)throw fail('AGENT_RESPONSE_LIMIT');
    controller.enqueue(next.value);
   }catch(error){dispose();controller.error(connection.signal.reason instanceof AgentTransportError?connection.signal.reason:signal.aborted?new AgentTransportError('AGENT_WAIT_CANCELLED'):error instanceof AgentTransportError?error:new AgentTransportError('AGENT_STREAM_INTERRUPTED'));}
  },cancel(){dispose();}});
  return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
 return {fetch:bounded,signal:connection.signal,close(){if(closed)return;closed=true;clearTimeout(timer);parent.removeEventListener('abort',abortParent);fail('AGENT_CONNECTION_CLOSED');for(const dispose of readers)dispose();},usage:()=>({bytes,chunks})};
}
