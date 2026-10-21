import {z} from 'zod';
export interface ToolCall {id:string;type:'function';function:{name:string;arguments:string}}
export interface ProviderMessage {role:'system'|'user'|'assistant'|'tool';content:string|null;reasoning_content?:string;tool_calls?:ToolCall[];tool_call_id?:string}
export interface CompleteTurn {message:ProviderMessage;usage:Record<string,unknown>|null;finishReason:'stop'|'tool_calls';requestId:string|null}
// Deliberately contains counts only: no text, reasoning, tool identity or arguments.
export interface StreamProgress {sequence:number;contentFragments:number;toolFragments:number}
export type ProgressObserver=(progress:StreamProgress)=>Promise<void>;
const deltaSchema=z.object({content:z.string().nullable().optional(),reasoning_content:z.string().optional(),role:z.string().optional(),tool_calls:z.array(z.object({index:z.number().int().nonnegative(),id:z.string().optional(),type:z.literal('function').optional(),function:z.object({name:z.string().optional(),arguments:z.string().optional()}).optional()})).optional()});
const eventSchema=z.object({id:z.string().optional(),choices:z.array(z.object({index:z.number().int(),delta:deltaSchema.optional(),finish_reason:z.string().nullable().optional()})),usage:z.record(z.string(),z.unknown()).nullable().optional(),error:z.unknown().optional()});
export class ProtocolError extends Error {constructor(code:string){super(code);this.name='ProtocolError';}}
export async function collectSse(chunks:AsyncIterable<Uint8Array>,signal?:AbortSignal,maxBytes=2*1024*1024,observer?:ProgressObserver):Promise<CompleteTurn> {
 const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',eventLines:string[]=[],content='',reasoning='',done=false,finish:CompleteTurn['finishReason']|null=null,bytes=0,usage:CompleteTurn['usage']=null,requestId:string|null=null;
 const calls=new Map<number,ToolCall>();
 const progress:StreamProgress={sequence:0,contentFragments:0,toolFragments:0};
 async function dispatch() {
  if(!eventLines.length) return;const text=eventLines.join('\n');eventLines=[];
  if(done) throw new ProtocolError('DATA_AFTER_DONE');
  if(text==='[DONE]') {done=true;return;}
  let raw:unknown;try{raw=JSON.parse(text);}catch{throw new ProtocolError('INVALID_EVENT_JSON');}
  const e=eventSchema.parse(raw);if(e.error) throw new ProtocolError('PROVIDER_STREAM_ERROR');
  if(e.id) requestId=e.id;if(e.usage) usage=e.usage;
  for(const choice of e.choices) {
   if(choice.index!==0||e.choices.length>1) throw new ProtocolError('MULTIPLE_CHOICES_UNSUPPORTED');
   const d=choice.delta;
   if(finish && d && (d.content||d.reasoning_content||d.tool_calls?.length)) throw new ProtocolError('DELTA_AFTER_FINISH');
   if(d?.content) content+=d.content;if(d?.reasoning_content) reasoning+=d.reasoning_content;
   for(const tc of d?.tool_calls??[]) {
    if(tc.index>=24) throw new ProtocolError('TOO_MANY_TOOLS');
    const call=calls.get(tc.index)??{id:'',type:'function',function:{name:'',arguments:''}};
    if(tc.id) call.id+=tc.id;if(tc.function?.name) call.function.name+=tc.function.name;if(tc.function?.arguments) call.function.arguments+=tc.function.arguments;
    calls.set(tc.index,call);
   }
   if(choice.finish_reason) {if(!['stop','tool_calls'].includes(choice.finish_reason)) throw new ProtocolError('INCOMPLETE_FINISH:'+choice.finish_reason);if(finish) throw new ProtocolError('DUPLICATE_FINISH');finish=choice.finish_reason as CompleteTurn['finishReason'];}
   if(d?.content||d?.tool_calls?.length){progress.sequence++;if(d.content)progress.contentFragments++;if(d.tool_calls?.length)progress.toolFragments++;await observer?.({...progress});}
  }
 }
 async function line(text:string) {if(text==='') await dispatch();else if(text.startsWith('data:')) eventLines.push(text.slice(5).replace(/^ /,''));}
 async function consumeLines(final=false) {
  let index:number;
  while((index=buffer.search(/[\r\n]/))>=0) {
   const ch=buffer[index];if(ch==='\r'&&index===buffer.length-1&&!final)break;
   const text=buffer.slice(0,index),width=ch==='\r'&&buffer[index+1]==='\n'?2:1;buffer=buffer.slice(index+width);await line(text);
  }
 }
 for await(const chunk of chunks) {
  signal?.throwIfAborted();bytes+=chunk.byteLength;if(bytes>maxBytes) throw new ProtocolError('STREAM_SIZE_LIMIT');
  buffer+=decoder.decode(chunk,{stream:true});await consumeLines();
 }
 buffer+=decoder.decode();await consumeLines(true);if(buffer)await line(buffer);await dispatch();signal?.throwIfAborted();
 if(!done||!finish) throw new ProtocolError('INCOMPLETE_STREAM');
 const toolCalls=[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([_,v])=>v);
 if((finish==='tool_calls')!==(toolCalls.length>0)) throw new ProtocolError('TOOL_FINISH_MISMATCH');
 const seen=new Set<string>();
 for(const [index,call] of toolCalls.entries()) {
  if(!calls.has(index)||!call.id||seen.has(call.id)||!/^cap_[a-f0-9]{12}$/.test(call.function.name)) throw new ProtocolError('INVALID_TOOL_ID_OR_NAME');
  seen.add(call.id);try{JSON.parse(call.function.arguments);}catch{throw new ProtocolError('INCOMPLETE_TOOL_ARGUMENTS');}
 }
 const message:ProviderMessage={role:'assistant',content:content||null};if(reasoning) message.reasoning_content=reasoning;if(toolCalls.length) message.tool_calls=toolCalls;
 return {message,usage,finishReason:finish,requestId};
}
