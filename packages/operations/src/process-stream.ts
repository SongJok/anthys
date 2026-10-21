import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {Transform,type Readable,type TransformCallback} from 'node:stream';
import {types} from 'node:util';

export type ProcessReadableOptions={file:string;args:readonly string[];cwd:string;env:Readonly<Record<string,string>>;signal:AbortSignal;timeoutMs:number;maxStdoutBytes:number;maxStderrBytes:number};
export type ProcessReadableResult={stream:Readable;completion:Promise<{stdoutBytes:number;stderrBytes:number}>;close:()=>Promise<void>};
export type ProcessStreamErrorCode='PROCESS_OPTIONS_INVALID'|'PROCESS_ABORTED_BEFORE_SPAWN'|'PROCESS_SPAWN_FAILED'|'PROCESS_EXIT_FAILED'|'PROCESS_STDOUT_FAILED'|'PROCESS_STDERR_FAILED'|'PROCESS_STDOUT_LIMIT'|'PROCESS_STDERR_LIMIT'|'PROCESS_TIMEOUT'|'PROCESS_ABORTED'|'PROCESS_CONSUMER_CLOSED'|'PROCESS_CLOSED';
export class ProcessStreamError extends Error{constructor(readonly code:ProcessStreamErrorCode){super(code);this.name='ProcessStreamError';}}
const invalid=():never=>{throw new ProcessStreamError('PROCESS_OPTIONS_INVALID');};
function object(raw:unknown):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||types.isProxy(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))return invalid();
 const result=Object.create(null) as Record<string,unknown>;
 for(const key of Reflect.ownKeys(raw)){if(typeof key!=='string')return invalid();const d=Object.getOwnPropertyDescriptor(raw,key);if(!d?.enumerable||!('value'in d))return invalid();result[key]=d.value;}return result;
}
function options(raw:ProcessReadableOptions):ProcessReadableOptions{
 const o=object(raw),keys=['file','args','cwd','env','signal','timeoutMs','maxStdoutBytes','maxStderrBytes'];
 if(Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))return invalid();
 for(const key of ['file','cwd'])if(typeof o[key]!=='string'||!(o[key] as string).length||(o[key] as string).length>4096||(o[key] as string).includes('\0')||!isAbsolute(o[key] as string))return invalid();
 if(types.isProxy(o['args'])||!Array.isArray(o['args'])||Object.getPrototypeOf(o['args'])!==Array.prototype||o['args'].length>128)return invalid();
 const descriptors=Object.getOwnPropertyDescriptors(o['args']),args:string[]=[];if(Reflect.ownKeys(descriptors).length!==o['args'].length+1)return invalid();
 let argBytes=0;for(let i=0;i<o['args'].length;i++){const d=descriptors[String(i)];if(!d?.enumerable||!('value'in d)||typeof d.value!=='string'||d.value.includes('\0')||(argBytes+=Buffer.byteLength(d.value))>128*1024)return invalid();args.push(d.value);}
 const envRaw=object(o['env']),env:Record<string,string>=Object.create(null) as Record<string,string>;if(Object.keys(envRaw).length>256)return invalid();let envBytes=0;
 for(const [key,value]of Object.entries(envRaw)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||value.includes('\0')||(envBytes+=Buffer.byteLength(key)+Buffer.byteLength(value))>256*1024)return invalid();env[key]=value;}
 for(const key of ['timeoutMs','maxStdoutBytes','maxStderrBytes'])if(typeof o[key]!=='number'||!Number.isSafeInteger(o[key])||(o[key] as number)<1)return invalid();
 if((o['timeoutMs'] as number)>3600000||types.isProxy(o['signal'])||!(o['signal'] instanceof AbortSignal))return invalid();
 return {file:o['file'] as string,cwd:o['cwd'] as string,args,env,signal:o['signal'],timeoutMs:o['timeoutMs'] as number,maxStdoutBytes:o['maxStdoutBytes'] as number,maxStderrBytes:o['maxStderrBytes'] as number};
}
/** Internal operations primitive, never an authorization or model command API.
 * Caller supplies reviewed executable/argv/target and awaits BOTH archive work
 * and completion. Stream EOF is gated on child close(0); EOF is not fsync proof.
 * Only the direct child is terminated/reaped; arbitrary descendants are not covered. */
export function createProcessReadable(raw:ProcessReadableOptions):ProcessReadableResult{
 const input=options(raw);if(input.signal.aborted)throw new ProcessStreamError('PROCESS_ABORTED_BEFORE_SPAWN');const deadline=performance.now()+input.timeoutMs;
 let child:ReturnType<typeof spawn>;
 try{child=spawn(input.file,[...input.args],{cwd:input.cwd,env:{...input.env},shell:false,detached:false,stdio:['ignore','pipe','pipe']});}catch{throw new ProcessStreamError('PROCESS_SPAWN_FAILED');}
 let stdoutBytes=0,stderrBytes=0,childClosed=false,sourceEnded=false,consumerEnded=false,completed=false,failure:ProcessStreamError|null=null,flush:TransformCallback|undefined;
 let killTimer:ReturnType<typeof setTimeout>|undefined;
 let resolveCompletion!:(value:{stdoutBytes:number;stderrBytes:number})=>void,rejectCompletion!:(error:ProcessStreamError)=>void,resolveClosed!:()=>void;
 const completion=new Promise<{stdoutBytes:number;stderrBytes:number}>((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;});
 // Keep the original rejecting promise public, while avoiding an unhandled
 // rejection before a caller has attached its archive/completion handlers.
 void completion.catch(()=>{});
 const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
 const stream=new Transform({highWaterMark:64*1024,transform(chunk:Buffer,_encoding,callback){
  if(!failure&&performance.now()>=deadline)fail('PROCESS_TIMEOUT');if(failure){callback(failure);return;}stdoutBytes+=chunk.length;
  if(!Number.isSafeInteger(stdoutBytes)||stdoutBytes>input.maxStdoutBytes){fail('PROCESS_STDOUT_LIMIT');callback(failure);return;}callback(null,chunk);
 },flush(callback){flush=callback;releaseEof();}});
 stream.on('error',()=>{});
 const timer=setTimeout(()=>fail('PROCESS_TIMEOUT'),input.timeoutMs);timer.unref();
 const stop=()=>fail('PROCESS_ABORTED');
 function tidy(){clearTimeout(timer);if(killTimer)clearTimeout(killTimer);input.signal.removeEventListener('abort',stop);}
 function settle(){
  if(completed||!childClosed)return;
  if(!failure&&performance.now()>=deadline){fail('PROCESS_TIMEOUT');return;}
  if(failure){completed=true;tidy();rejectCompletion(failure);}
  else if(sourceEnded&&consumerEnded){completed=true;tidy();resolveCompletion({stdoutBytes,stderrBytes});}
 }
 function releaseEof(){if(!flush||!childClosed)return;if(!failure&&performance.now()>=deadline){fail('PROCESS_TIMEOUT');return;}const callback=flush;flush=undefined;if(failure)callback(failure);else if(sourceEnded)callback();else fail('PROCESS_STDOUT_FAILED');}
 function terminate(){
  if(childClosed)return;
  child.stdout?.destroy();child.stderr?.destroy();try{child.kill('SIGTERM');}catch{/* escalation below */}
  if(!killTimer){killTimer=setTimeout(()=>{if(!childClosed)try{child.kill('SIGKILL');}catch{/* close still witnesses reaping */}},250);killTimer.unref();}
 }
 function fail(code:ProcessStreamErrorCode){
  if(completed||failure)return;failure=new ProcessStreamError(code);
  const callback=flush;flush=undefined;callback?.(failure);stream.destroy(failure);terminate();settle();
 }
 stream.once('end',()=>{consumerEnded=true;settle();});
 stream.once('close',()=>{if(!consumerEnded&&!failure)fail('PROCESS_CONSUMER_CLOSED');});
 child.once('error',()=>fail('PROCESS_SPAWN_FAILED'));
 child.stdout?.once('error',()=>fail('PROCESS_STDOUT_FAILED'));
 child.stdout?.once('end',()=>{sourceEnded=true;releaseEof();});
 child.stdout?.once('close',()=>{if(!sourceEnded&&!failure)fail('PROCESS_STDOUT_FAILED');});
 child.stderr?.on('data',(chunk:Buffer)=>{if(!failure&&performance.now()>=deadline)fail('PROCESS_TIMEOUT');if(failure)return;stderrBytes+=chunk.length;if(!Number.isSafeInteger(stderrBytes)||stderrBytes>input.maxStderrBytes)fail('PROCESS_STDERR_LIMIT');});
 child.stderr?.once('error',()=>fail('PROCESS_STDERR_FAILED'));
 child.once('close',(code,signal)=>{
  childClosed=true;if(killTimer)clearTimeout(killTimer);
  if(!failure&&(code!==0||signal!==null))fail('PROCESS_EXIT_FAILED');
  if(!failure&&!sourceEnded)fail('PROCESS_STDOUT_FAILED');releaseEof();settle();resolveClosed();
 });
 input.signal.addEventListener('abort',stop,{once:true});
 if(input.signal.aborted)stop();else child.stdout?.pipe(stream);
 return {stream,completion,close:()=>{if(!completed&&!failure)fail('PROCESS_CLOSED');return closed;}};
}
