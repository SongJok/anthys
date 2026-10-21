import {randomUUID} from 'node:crypto';
import type {Page} from '@playwright/test';
import {escalationUiRequestLifetimeMs} from '../../apps/web/src/group-escalations-flow.js';

type Method='GET'|'POST';
type Entry={sequence:number;method:Method;path:string;url:string;status:number|null;deadline:number;state:'PENDING'|'READY'|'ERROR';body?:unknown;error?:string;timer?:ReturnType<typeof setTimeout>;reader?:ReadableStreamDefaultReader<Uint8Array>};
type BrowserWitness={epoch:string;sequence:number;fatal:string|null;disposed:boolean;entries:Entry[];stop:()=>void};
export type EscalationFetchReceipt={sequence:number;url:string;status:number;body:unknown};
export type EscalationFetchWitness={sequence:()=>Promise<number>;read:(query:{afterSequence:number;method:Method;path:string;timeoutMs?:number})=>Promise<EscalationFetchReceipt>;dispose:()=>Promise<void>};

/** Test-only observation. Does not authorize requests or authenticate replies.
 * Install before goto; dispose in finally. The original fetch promise/response
 * is returned unchanged. No request headers, bodies, cookies or CDP body cache. */
export async function installEscalationFetchWitness(page:Page,options:{origin:string;group:string;timeoutMs:number;maxBodyBytes:number}):Promise<EscalationFetchWitness>{
 const {origin,group,timeoutMs,maxBodyBytes}=options;
 let parsed:URL;try{parsed=new URL(origin);}catch{throw Error('ESCALATION_WITNESS_OPTIONS_REJECTED');}
 if(parsed.origin!==origin||!['http:','https:'].includes(parsed.protocol)||typeof group!=='string'||!group.trim()||group.length>256||/[\u0000-\u001f\u007f]/.test(group)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>escalationUiRequestLifetimeMs||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>1024*1024)throw Error('ESCALATION_WITNESS_OPTIONS_REJECTED');
 const prefix='/api/v1/groups/'+encodeURIComponent(group)+'/case-escalations/',uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
 const accepts=(method:Method,path:string)=>path.startsWith(prefix)&&new RegExp('^'+uuid+(method==='POST'?'/(confirm|cancel)':'')+'$').test(path.slice(prefix.length));
 const key='__oaEscalationWitness_'+randomUUID().replaceAll('-','');let epoch:string|undefined,disposed=false;
 const script=await page.addInitScript(({key,origin,prefix,uuid,timeoutMs,maxBodyBytes})=>{
  if(window!==window.top)return;
  const native=window.fetch,entries:Entry[]=[],state:BrowserWitness={epoch:crypto.randomUUID(),sequence:0,fatal:null,disposed:false,entries,stop:()=>{}};
  const clock=performance.now.bind(performance);
  const cancel=(reader:ReadableStreamDefaultReader<Uint8Array>|undefined)=>{
   if(!reader)return;
   // Tee cancellation can wait for the application's branch. Own the promise
   // without awaiting it or aborting the original request/response branch.
   try{void reader.cancel().then(()=>{},()=>{state.fatal='ESCALATION_WITNESS_CANCEL_FAILED';});}catch{state.fatal='ESCALATION_WITNESS_CANCEL_FAILED';}
  };
  const fail=(entry:Entry,code:string)=>{if(entry.state!=='PENDING')return;entry.state='ERROR';entry.error=code;if(entry.timer)clearTimeout(entry.timer);cancel(entry.reader);};
  const observe=async(entry:Entry,response:Response)=>{
   if(entry.state!=='PENDING'||state.disposed)return;
   if(clock()>=entry.deadline){fail(entry,'ESCALATION_WITNESS_TIMEOUT');return;}
   if(response.redirected||response.url!==entry.url){fail(entry,'ESCALATION_WITNESS_REDIRECTED');return;}
   entry.status=response.status;let clone:Response;
   try{clone=response.clone();}catch{fail(entry,'ESCALATION_WITNESS_CLONE_FAILED');return;}
   if(!clone.body){fail(entry,'ESCALATION_WITNESS_BODY_MISSING');return;}
   const reader=clone.body.getReader();entry.reader=reader;const chunks:Uint8Array[]=[];let bytes=0;
   try{
    for(;;){
     if(entry.state!=='PENDING'||state.disposed)return;
     if(clock()>=entry.deadline){fail(entry,'ESCALATION_WITNESS_TIMEOUT');return;}
     const part=await reader.read();
     if(entry.state!=='PENDING'||state.disposed)return;
     if(clock()>=entry.deadline){fail(entry,'ESCALATION_WITNESS_TIMEOUT');return;}
     if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBodyBytes){fail(entry,'ESCALATION_WITNESS_BODY_LIMIT');return;}chunks.push(part.value);
    }
    const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(joined),body:unknown=JSON.parse(text);
    if(clock()>=entry.deadline){fail(entry,'ESCALATION_WITNESS_TIMEOUT');return;}
    entry.body=body;entry.state='READY';if(entry.timer)clearTimeout(entry.timer);
   }catch{fail(entry,'ESCALATION_WITNESS_BODY_INVALID');}
   finally{try{reader.releaseLock();}catch{fail(entry,'ESCALATION_WITNESS_READER_FAILED');}}
  };
  const matches=(method:string,url:URL)=>url.origin===origin&&url.search===''&&url.hash===''&&url.pathname.startsWith(prefix)&&((method==='GET'&&new RegExp('^'+uuid+'$').test(url.pathname.slice(prefix.length)))||(method==='POST'&&new RegExp('^'+uuid+'/(confirm|cancel)$').test(url.pathname.slice(prefix.length))));
  const wrapper:typeof fetch=function(this:unknown,...args){
   let entry:Entry|undefined;
   if(!state.disposed){
    try{
     const [input,init]=args,url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
     if(matches(method,url)){
      if(entries.length>=32)state.fatal='ESCALATION_WITNESS_RECORD_LIMIT';
      else{entry={sequence:++state.sequence,method:method as Method,path:url.pathname,url:url.href,status:null,deadline:clock()+timeoutMs,state:'PENDING'};entries.push(entry);const current=entry;entry.timer=setTimeout(()=>fail(current,'ESCALATION_WITNESS_TIMEOUT'),timeoutMs);}
     }
    }catch{state.fatal='ESCALATION_WITNESS_REQUEST_UNOBSERVABLE';}
   }
   // Non-async wrapper: return exactly the original promise, not a chained one.
   let original:ReturnType<typeof fetch>;
   try{original=Reflect.apply(native,this,args) as ReturnType<typeof fetch>;}catch(error){if(entry)fail(entry,'ESCALATION_WITNESS_FETCH_REJECTED');throw error;}
   if(entry){const current=entry;void original.then(response=>observe(current,response),()=>{fail(current,'ESCALATION_WITNESS_FETCH_REJECTED');}).catch(()=>{fail(current,'ESCALATION_WITNESS_INTERNAL_FAILURE');});}
   return original;
  };
  state.stop=()=>{if(state.disposed)return;state.disposed=true;for(const entry of entries)fail(entry,'ESCALATION_WITNESS_DISPOSED');entries.length=0;if(window.fetch===wrapper)window.fetch=native;};
  Object.defineProperty(window,key,{value:state,configurable:true});window.fetch=wrapper;
 },{key,origin,prefix,uuid,timeoutMs,maxBodyBytes});
 const ensure=()=>{if(disposed)throw Error('ESCALATION_WITNESS_DISPOSED');};
 return {
  async sequence(){ensure();try{const value=await page.evaluate(key=>{const s=Reflect.get(window,key) as BrowserWitness|undefined;if(!s||s.disposed||s.fatal)throw Error(s?.fatal??'ESCALATION_WITNESS_NOT_INSTALLED');return {epoch:s.epoch,sequence:s.sequence};},key);epoch=value.epoch;return value.sequence;}catch{throw Error('ESCALATION_WITNESS_CONTEXT_UNAVAILABLE');}},
  async read(query){
   ensure();const {afterSequence,method,path}=query,waitMs=query.timeoutMs??timeoutMs;
   if(!epoch||!Number.isSafeInteger(afterSequence)||afterSequence<0||!['GET','POST'].includes(method)||!accepts(method,path)||!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>timeoutMs)throw Error('ESCALATION_WITNESS_QUERY_REJECTED');
   const expectedEpoch=epoch;let handle:Awaited<ReturnType<Page['waitForFunction']>>|undefined;
   try{
    handle=await page.waitForFunction(({key,expectedEpoch,afterSequence,method,path})=>{
     const s=Reflect.get(window,key) as BrowserWitness|undefined;
     if(!s||s.epoch!==expectedEpoch||s.disposed)return {error:'ESCALATION_WITNESS_CONTEXT_CHANGED'};
     if(s.fatal)return {error:s.fatal};
     const entries=s.entries.filter(e=>e.sequence>afterSequence&&e.method===method&&e.path===path);
     if(entries.length>1)return {error:'ESCALATION_WITNESS_AMBIGUOUS'};
     const entry=entries[0];if(!entry)return false;
     if(entry.state==='ERROR')return {error:entry.error??'ESCALATION_WITNESS_FAILED'};
     if(performance.now()>=entry.deadline)return {error:'ESCALATION_WITNESS_TIMEOUT'};
     return entry.state==='READY'?{receipt:{sequence:entry.sequence,url:entry.url,status:entry.status,body:entry.body}}:false;
    },{key,expectedEpoch,afterSequence,method,path},{timeout:waitMs,polling:10});
    const result=await handle.jsonValue() as {error?:string;receipt?:EscalationFetchReceipt};if(result.error)throw Error(result.error);if(!result.receipt)throw Error('ESCALATION_WITNESS_FAILED');return result.receipt;
   }catch(error){if(error instanceof Error&&/^ESCALATION_WITNESS_[A-Z_]+$/.test(error.message))throw error;throw Error('ESCALATION_WITNESS_WAIT_OR_CONTEXT_FAILED');}
   finally{try{await handle?.dispose();}catch{throw Error('ESCALATION_WITNESS_HANDLE_CLEANUP_FAILED');}}
  },
  async dispose(){if(disposed)return;disposed=true;const cleanup=await Promise.allSettled([script.dispose(),page.isClosed()?Promise.resolve():page.evaluate(key=>{const s=Reflect.get(window,key) as BrowserWitness|undefined;s?.stop();Reflect.deleteProperty(window,key);},key)]);if(cleanup.some(result=>result.status==='rejected'))throw Error('ESCALATION_WITNESS_CLEANUP_UNCONFIRMED');},
 };
}
