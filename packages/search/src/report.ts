import {z} from 'zod';
import {canonicalResultUrl} from './egress.js';
import {SearchError} from './errors.js';

export type SearchOutcome='OK'|'EMPTY'|'TIMEOUT'|'UNAVAILABLE';
export type SourceFreshness='FRESH'|'AGING'|'STALE'|'UNKNOWN';
export type SearchSource=Readonly<{rank:number;url:string;title:string;snippet:string;publishedAt:string|null;retrievedAt:string;freshness:SourceFreshness;trust:'UNTRUSTED_EXTERNAL_CONTENT'}>;
export type SearchEvidence=Readonly<{schemaVersion:1;providerId:string;queryHash:string;observedAt:string;outcome:SearchOutcome;sources:readonly SearchSource[];droppedUnsafeUrls:number;truncated:boolean;noResults:boolean;mixedFreshness:boolean;oldestPublishedAt:string|null;newestPublishedAt:string|null}>;
const resultSchema=z.object({url:z.string().min(1).max(2048),title:z.string().min(1).max(300),snippet:z.string().max(2000).optional(),publishedAt:z.string().max(35).nullable().optional()}).strict();
const providerIdPattern=/^[a-z0-9][a-z0-9._-]{0,63}$/;
function instant(value:string,code:'SEARCH_PROVIDER_INVALID_REPLY'):string{
 const stamp=Date.parse(value);if(!Number.isFinite(stamp))throw new SearchError(code,502);return new Date(stamp).toISOString();
}
/** External text stays inert data: controls and bidi overrides are removed, whitespace collapsed, length bounded. */
export function untrustedText(value:string,max:number):string{
 return value.normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
function freshness(published:string|null,observed:number):SourceFreshness{
 if(published===null)return 'UNKNOWN';const days=Math.floor((observed-Date.parse(published))/86400000);
 if(days<0)return 'UNKNOWN';if(days<=30)return 'FRESH';if(days<=180)return 'AGING';return 'STALE';
}
/** Builds an explicit evidence report. It never fetches result URLs and never treats provider text as instructions. */
export function buildSearchEvidence(input:{providerId:string;queryHash:string;observedAt:string;outcome:SearchOutcome;results:readonly unknown[];limit?:number}):SearchEvidence{
 const limit=input.limit??10;if(!providerIdPattern.test(input.providerId)||!/^[a-f0-9]{64}$/.test(input.queryHash)||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new SearchError('SEARCH_PROVIDER_INVALID_REPLY',502);
 const observed=instant(input.observedAt,'SEARCH_PROVIDER_INVALID_REPLY');
 if(input.outcome!=='OK'){
  if(input.results.length)throw new SearchError('SEARCH_PROVIDER_INVALID_REPLY',502);
  return Object.freeze({schemaVersion:1,providerId:input.providerId,queryHash:input.queryHash,observedAt:observed,outcome:input.outcome,sources:Object.freeze([]),droppedUnsafeUrls:0,truncated:false,noResults:input.outcome==='EMPTY',mixedFreshness:false,oldestPublishedAt:null,newestPublishedAt:null});
 }
 let dropped=0;const seen=new Set<string>(),parsedSources:{url:string;title:string;snippet:string;publishedAt:string|null}[]=[];
 for(const raw of input.results){
  const parsed=resultSchema.safeParse(raw);if(!parsed.success)throw new SearchError('SEARCH_PROVIDER_INVALID_REPLY',502);
  let url:string;try{url=canonicalResultUrl(parsed.data.url);}catch{dropped++;continue;}
  const title=untrustedText(parsed.data.title,300),snippet=untrustedText(parsed.data.snippet??'',2000);
  if(!title){dropped++;continue;}
  if(seen.has(url))continue;seen.add(url);
  const published=parsed.data.publishedAt?instant(parsed.data.publishedAt,'SEARCH_PROVIDER_INVALID_REPLY'):null;
  parsedSources.push({url,title,snippet,publishedAt:published});
 }
 const kept=parsedSources.slice(0,limit),now=Date.parse(observed),published=kept.flatMap(source=>source.publishedAt?[source.publishedAt]:[]);
 const sources=Object.freeze(kept.map((source,index)=>Object.freeze({rank:index+1,...source,retrievedAt:observed,freshness:freshness(source.publishedAt,now),trust:'UNTRUSTED_EXTERNAL_CONTENT' as const})));
 const kinds=new Set(sources.map(source=>source.freshness).filter(kind=>kind!=='UNKNOWN'));
 const dates=published.map(value=>Date.parse(value)).sort((a,b)=>a-b);
 return Object.freeze({schemaVersion:1,providerId:input.providerId,queryHash:input.queryHash,observedAt:observed,outcome:sources.length?'OK':'EMPTY',sources,droppedUnsafeUrls:dropped,truncated:parsedSources.length>limit,noResults:sources.length===0,mixedFreshness:kinds.size>1,
  oldestPublishedAt:dates.length?new Date(dates[0]!).toISOString():null,newestPublishedAt:dates.length?new Date(dates[dates.length-1]!).toISOString():null});
}
