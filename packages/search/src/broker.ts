import {SearchError} from './errors.js';
import {reviewPublicSearchQuery} from './query-policy.js';
import {buildSearchEvidence,type SearchEvidence} from './report.js';

export interface SearchProvider {readonly id:string;search(query:string,options:{signal:AbortSignal;limit:number}):Promise<readonly unknown[]>;}
export type SearchBrokerOptions={provider:SearchProvider;clock?:()=>number;timeoutMs?:number;limit?:number};
/** Public-web search broker. The provider endpoint and credentials are trusted service configuration, never request input. */
export class SearchBroker {
 private readonly provider:SearchProvider;private readonly clock:()=>number;private readonly timeoutMs:number;private readonly limit:number;
 constructor(options:SearchBrokerOptions){
  const {provider,timeoutMs=8000,limit=8}=options;
  if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.id)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new SearchError('SEARCH_PROVIDER_INVALID_REPLY',502);
  this.provider=provider;this.clock=options.clock??Date.now;this.timeoutMs=timeoutMs;this.limit=limit;
 }
 /** Requires an explicit PUBLIC outbound classification; internal queries are denied before the provider is called. */
 async search(raw:unknown,options:{classification:string;signal?:AbortSignal}):Promise<SearchEvidence>{
  const query=reviewPublicSearchQuery(raw,options.classification);
  if(options.signal?.aborted)throw new SearchError('SEARCH_CANCELLED',499);
  const controller=new AbortController();
  let cancel:(error:Error)=>void=()=>undefined;
  const cancelled=new Promise<never>((_accept,reject)=>{cancel=reject;});
  const abort=()=>{controller.abort(options.signal?.reason);cancel(new SearchError('SEARCH_CANCELLED',499));};
  options.signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_accept,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new SearchError('SEARCH_TIMEOUT',504));},this.timeoutMs);});
  try{
   const results=await Promise.race([this.provider.search(query.text,{signal:controller.signal,limit:this.limit}),timeout,cancelled]);
   if(!Array.isArray(results))throw new SearchError('SEARCH_PROVIDER_INVALID_REPLY',502);
   return buildSearchEvidence({providerId:this.provider.id,queryHash:query.hash,observedAt:new Date(this.clock()).toISOString(),outcome:results.length?'OK':'EMPTY',results,limit:this.limit});
  }catch(error){
   if(options.signal?.aborted)throw new SearchError('SEARCH_CANCELLED',499);
   if(timedOut)return buildSearchEvidence({providerId:this.provider.id,queryHash:query.hash,observedAt:new Date(this.clock()).toISOString(),outcome:'TIMEOUT',results:[],limit:this.limit});
   if(error instanceof SearchError&&error.code==='SEARCH_PROVIDER_INVALID_REPLY')throw error;
   return buildSearchEvidence({providerId:this.provider.id,queryHash:query.hash,observedAt:new Date(this.clock()).toISOString(),outcome:'UNAVAILABLE',results:[],limit:this.limit});
  }finally{
   if(timer!==undefined)clearTimeout(timer);
   options.signal?.removeEventListener('abort',abort);
  }
 }
}
