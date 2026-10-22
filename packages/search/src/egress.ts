import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {SearchError} from './errors.js';

const maxUrlBytes=2048;
const localSuffixes=new Set(['localhost','local','internal','lan','home','corp','intranet','localdomain','onion','test','invalid']);

function v4(value:string):number|null{
 const parts=value.split('.');if(parts.length!==4)return null;let result=0;
 for(const part of parts){if(!/^\d{1,3}$/.test(part))return null;const octet=Number(part);if(octet>255)return null;result=result*256+octet;}
 return result;
}
const blocked4=[[0x00000000,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],
 [0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],
 [0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]] as const;
function in4(network:number,base:number,prefix:number){const mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;return ((network&mask)>>>0)===((base&mask)>>>0);}
function v6(value:string):bigint|null{
 const zone=value.indexOf('%');if(zone>=0)value=value.slice(0,zone);
 if(isIP(value)!==6)return null;
 if(value.includes('.')){
  const index=value.lastIndexOf(':');const embedded=v4(value.slice(index+1));if(embedded===null)return null;
  value=value.slice(0,index+1)+Math.floor(embedded/65536).toString(16)+':'+(embedded&0xffff).toString(16);
 }
 const halves=value.split('::');if(halves.length>2)return null;
 const split=(part:string)=>part===''?[]:part.split(':');
 const left=split(halves[0]??''),right=halves.length===2?split(halves[1]??''):null;
 const parts=right===null?left:[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right];
 if(parts.length!==8)return null;let result=0n;
 for(const part of parts){if(!/^[0-9a-fA-F]{1,4}$/.test(part))return null;result=(result<<16n)|BigInt(parseInt(part,16));}
 return result;
}
/** True only for globally routable unicast addresses. Conservative on purpose. */
export function publicAddress(address:string):boolean{
 const family=isIP(address);
 if(family===4){const parsed=v4(address);if(parsed===null)return false;return !blocked4.some(([base,prefix])=>in4(parsed,base,prefix));}
 if(family===6){
  const parsed=v6(address);if(parsed===null)return false;
  // 2000::/3 is the global-unicast block; this excludes mapped, NAT64, ULA, link-local and multicast.
  if((parsed>>125n)!==0b001n)return false;
  const top32=Number(parsed>>96n),top48=Number(parsed>>80n),top16=Number(parsed>>112n);
  if(top32===0x20010000||top32===0x20010db8||(top48===0x200100020000)||top16===0x2002||top16===0x3ffe||top16===0x3fff)return false;
  return true;
 }
 return false;
}
function hostnameAllowed(host:string):boolean{
 if(!host||host.length>253||host.startsWith('[')||isIP(host))return false;
 const normalized=host.endsWith('.')?host.slice(0,-1):host;
 if(!normalized.includes('.'))return false;
 if(localSuffixes.has(normalized))return false;
 for(const suffix of localSuffixes)if(normalized.endsWith('.'+suffix))return false;
 return normalized.split('.').every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}
/** Enforces HTTPS, default port, no credentials/fragment and a DNS name rather than a literal address. */
export function normalizePublicUrl(raw:string):URL{
 let url:URL;try{url=new URL(raw);}catch{throw new SearchError('SEARCH_URL_DENIED',400);}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href.length>maxUrlBytes)throw new SearchError('SEARCH_URL_DENIED',400);
 const host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(!hostnameAllowed(host))throw new SearchError('SEARCH_URL_DENIED',400);
 return url;
}
const tracking=/^(?:utm_.+|gclid|fbclid|msclkid|yclid|mc_cid|mc_eid)$/i;
/** Citation URLs keep their identity but lose fragments and known analytics parameters. */
export function canonicalResultUrl(raw:string):string{
 const url=normalizePublicUrl(raw);url.hash='';
 for(const key of [...url.searchParams.keys()])if(tracking.test(key))url.searchParams.delete(key);
 return url.href;
}

interface Address{address:string;family:number}
type Requester=(url:URL,options:https.RequestOptions,callback:(res:IncomingMessage)=>void)=>ClientRequest;
const textTypes=new Set(['text/html','text/plain','application/xhtml+xml','application/json','application/ld+json']);
export type FetchedPage=Readonly<{url:string;contentType:string;bytes:Buffer;text:string}>;
/** Public-web fetch guard: resolves every hop, pins the checked address, refuses private IPs and unsafe redirects. */
export class PublicFetcher {
 private readonly maxBytes:number;private readonly timeoutMs:number;
 constructor(private readonly options:{maxBytes?:number;timeoutMs?:number;resolve?:(host:string)=>Promise<Address[]>;request?:Requester}={}){
  this.maxBytes=options.maxBytes??2*1024*1024;this.timeoutMs=options.timeoutMs??10000;
  if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1||!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<1)throw new SearchError('SEARCH_URL_DENIED',400);
 }
 async fetch(initial:string,signal?:AbortSignal):Promise<FetchedPage>{
  let url=normalizePublicUrl(initial);
  for(let hop=0;hop<4;hop++){
   if(signal?.aborted)throw new SearchError('SEARCH_CANCELLED',499);
   const addresses=await (this.options.resolve??(host=>lookup(host,{all:true,verbatim:true})))(url.hostname);
   if(!addresses.length||addresses.some(item=>!publicAddress(item.address)||isIP(item.address)!==item.family))throw new SearchError('SEARCH_DNS_DENIED',403);
   const chosen=addresses.find(item=>item.family===4)??addresses[0]!;
   signal?.throwIfAborted();
   const response=await new Promise<IncomingMessage>((accept,reject)=>{
    const timer:{handle:ReturnType<typeof setTimeout>|undefined}={handle:undefined};
    const request=(this.options.request??https.request)(url,{method:'GET',agent:false,servername:url.hostname,family:chosen.family,
     lookup:(_host,_options,callback)=>callback(null,chosen.address,chosen.family),
     headers:{accept:'text/html,text/plain,application/json','accept-encoding':'identity'},maxHeaderSize:16384,...(signal?{signal}:{})},value=>{
      if(timer.handle!==undefined)clearTimeout(timer.handle);accept(value);
    });
    timer.handle=setTimeout(()=>request.destroy(new SearchError('SEARCH_FETCH_TIMEOUT',504)),this.timeoutMs);
    request.once('error',error=>{if(timer.handle!==undefined)clearTimeout(timer.handle);reject(error instanceof SearchError?error:new SearchError('SEARCH_FETCH_NETWORK_FAILED',502));});
    request.end();
   });
   if([301,302,303,307,308].includes(response.statusCode??0)){
    const location=response.headers.location;response.destroy();
    if(!location)throw new SearchError('SEARCH_FETCH_REDIRECT_INVALID',502);
    try{url=normalizePublicUrl(new URL(location,url).href);}catch{throw new SearchError('SEARCH_FETCH_REDIRECT_INVALID',502);}
    continue;
   }
   if(response.statusCode!==200){response.destroy();throw new SearchError('SEARCH_FETCH_REJECTED',(response.statusCode??0)>=500||response.statusCode===429?502:403);}
   const encoding=response.headers['content-encoding'];
   if(encoding&&encoding!=='identity'){response.destroy();throw new SearchError('SEARCH_FETCH_ENCODING_DENIED',403);}
   const length=response.headers['content-length'];
   if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>this.maxBytes)){response.destroy();throw new SearchError('SEARCH_FETCH_SIZE_LIMIT',413);}
   const mime=(response.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();
   if(!textTypes.has(mime)){response.destroy();throw new SearchError('SEARCH_FETCH_TYPE_DENIED',403);}
   const chunks:Buffer[]=[];let size=0;
   try{
    for await(const chunk of response){signal?.throwIfAborted();const bytes=Buffer.from(chunk as Uint8Array);size+=bytes.length;if(size>this.maxBytes)throw new SearchError('SEARCH_FETCH_SIZE_LIMIT',413);chunks.push(bytes);}
   }catch(error){response.destroy();throw error instanceof SearchError?error:new SearchError('SEARCH_FETCH_NETWORK_FAILED',502);}
   if(length!==undefined&&size!==Number(length))throw new SearchError('SEARCH_FETCH_NETWORK_FAILED',502);
   const bytes=Buffer.concat(chunks);
   return Object.freeze({url:url.href,contentType:mime,bytes,text:bytes.toString('utf8')});
  }
  throw new SearchError('SEARCH_FETCH_REDIRECT_LIMIT',502);
 }
}
