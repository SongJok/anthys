import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {RequestOptions} from 'node:https';
import type {IncomingMessage,ClientRequest} from 'node:http';
import {publicAddress,normalizePublicUrl,canonicalResultUrl,PublicFetcher} from '../../packages/search/src/egress.js';
import {reviewPublicSearchQuery} from '../../packages/search/src/query-policy.js';
import {SearchBroker,type SearchProvider} from '../../packages/search/src/broker.js';
function response(status=200,headers:Record<string,string>={},chunks:Buffer[]=[Buffer.from('safe text')]):IncomingMessage{
 const stream=Readable.from(chunks);return Object.assign(stream,{statusCode:status,headers}) as unknown as IncomingMessage;
}
type Seen={url:string;options:RequestOptions};
function client(responses:IncomingMessage[],seen:Seen[]=[]){
 return (url:URL,options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
  seen.push({url:url.toString(),options});
  const request=new EventEmitter() as EventEmitter&{setTimeout:()=>unknown;end:()=>void;destroy:(error?:Error)=>void};
  request.setTimeout=()=>request;
  request.destroy=(error?:Error)=>{if(error)request.emit('error',error);};
  request.end=()=>{const next=responses.shift();if(next)callback(next);else request.emit('error',Error('synthetic network failure'));};
  return request as unknown as ClientRequest;
 };
}
function hanging(){
 const request=new EventEmitter() as EventEmitter&{setTimeout:()=>unknown;end:()=>void;destroy:(error?:Error)=>void};
 request.setTimeout=()=>request;request.destroy=(error?:Error)=>{if(error)request.emit('error',error);};request.end=()=>undefined;
 return request as unknown as ClientRequest;
}
const resolve=async()=>[{address:'8.8.8.8',family:4}];
it('T103 blocks every non-public address family, encoded IPv4 literals and local DNS names',async()=>{
 for(const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.0.0.1','192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','::ffff:127.0.0.1','64:ff9b::808:808','100::1','fc00::1','fe80::1','ff02::1','2001::1','2001:2::1','2001:db8::1','2002:808:808::1','3ffe::1','3fff::1','not-ip'])expect(publicAddress(ip)).toBe(false);
 for(const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888','2606:4700:4700::1111','2a00:1450:4001:81b::200e'])expect(publicAddress(ip)).toBe(true);
 for(const url of ['http://search.example/a','ftp://search.example/a','https://127.0.0.1/a','https://[::1]/a','https://2130706433/a','https://0x7f000001/a','https://search.example:8443/a','https://user:secret@search.example/a','https://search.example/a#fragment','https://intranet/a','https://db.internal/a','https://foo.localhost/a','https://x.test/a'])expect(()=>normalizePublicUrl(url)).toThrow('SEARCH_URL_DENIED');
 expect(normalizePublicUrl('https://search.example/a?q=1').href).toBe('https://search.example/a?q=1');
 expect(canonicalResultUrl('https://search.example/a?utm_source=x&q=1&gclid=y')).toBe('https://search.example/a?q=1');
});
it('T103 rejects empty, mixed and rebinding DNS before any TLS request and validates redirect hops',async()=>{
 const seen:Seen[]=[];const fetcher=(resolver:()=>Promise<{address:string;family:number}[]>,responses:IncomingMessage[]=[])=>new PublicFetcher({resolve:resolver,request:client(responses,seen)});
 await expect(fetcher(async()=>[]).fetch('https://search.example/a')).rejects.toThrow('SEARCH_DNS_DENIED');
 await expect(fetcher(async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]).fetch('https://search.example/a')).rejects.toThrow('SEARCH_DNS_DENIED');
 await expect(fetcher(async()=>[{address:'8.8.8.8',family:6}]).fetch('https://search.example/a')).rejects.toThrow('SEARCH_DNS_DENIED');
 expect(seen).toHaveLength(0);
 let lookups=0;const rebinding=()=>new Promise<{address:string;family:number}[]>(accept=>accept(++lookups===1?[{address:'8.8.8.8',family:4}]:[{address:'127.0.0.1',family:4}]));
 await expect(fetcher(rebinding,[response(302,{location:'https://next.example/b'})]).fetch('https://search.example/a')).rejects.toThrow('SEARCH_DNS_DENIED');
 expect(seen).toHaveLength(1);
 for(const location of ['https://169.254.169.254/latest/meta-data','http://next.example/b',undefined])await expect(fetcher(resolve,[response(302,location?{location}:{})]).fetch('https://search.example/a')).rejects.toThrow('SEARCH_FETCH_REDIRECT_INVALID');
 await expect(fetcher(resolve,Array.from({length:4},()=>response(302,{location:'/again'}))).fetch('https://search.example/a')).rejects.toThrow('SEARCH_FETCH_REDIRECT_LIMIT');
});
it('T103 pins checked addresses, forbids credentials/compression and bounds size, type and time',async()=>{
 const seen:Seen[]=[];let requests=0;
 const fetcher=new PublicFetcher({resolve,request:client([response(302,{location:'/next'}),response(200,{'content-type':'text/html; charset=utf-8','content-length':'9'})],seen)});
 const page=await fetcher.fetch('https://search.example/a',new AbortController().signal,);
 expect(page).toMatchObject({url:'https://search.example/next',contentType:'text/html',text:'safe text'});
 requests++;expect(seen[1]!.options['agent']).toBe(false);expect(seen[1]!.options['servername']).toBe('search.example');
 expect(seen[1]!.options['headers']).toEqual({accept:'text/html,text/plain,application/json','accept-encoding':'identity'});
 const callback=vi.fn();(seen[0]!.options['lookup'] as (host:string,options:unknown,cb:typeof callback)=>void)('search.example',{},callback);
 expect(callback).toHaveBeenCalledWith(null,'8.8.8.8',4);expect(requests).toBe(1);
 const limited=(res:IncomingMessage,maxBytes=20)=>new PublicFetcher({resolve,maxBytes,request:client([res])});
 for(const [res,code] of [[response(200,{'content-type':'text/html','content-length':'100'}),'SEARCH_FETCH_SIZE_LIMIT'],[response(200,{'content-type':'text/html'},[Buffer.alloc(21)]),'SEARCH_FETCH_SIZE_LIMIT'],[response(200,{'content-type':'text/html','content-encoding':'gzip'}),'SEARCH_FETCH_ENCODING_DENIED'],[response(200,{'content-type':'image/png'}),'SEARCH_FETCH_TYPE_DENIED'],[response(200,{'content-type':'text/html','content-length':'10'}),'SEARCH_FETCH_NETWORK_FAILED'],[response(403,{'content-type':'text/html'}),'SEARCH_FETCH_REJECTED'],[response(204),'SEARCH_FETCH_REJECTED']] as const)await expect(limited(res).fetch('https://search.example/a')).rejects.toThrow(code);
 await expect(new PublicFetcher({resolve,request:client([])}).fetch('https://search.example/a')).rejects.toThrow('SEARCH_FETCH_NETWORK_FAILED');
 await expect(new PublicFetcher({resolve,request:hanging,timeoutMs:20}).fetch('https://search.example/a')).rejects.toThrow('SEARCH_FETCH_TIMEOUT');
 const aborted=new AbortController();aborted.abort();
 await expect(new PublicFetcher({resolve}).fetch('https://search.example/a',aborted.signal)).rejects.toThrow('SEARCH_CANCELLED');
});
it('T105 denies secrets, internal identifiers and non-PUBLIC classification before the provider is called',async()=>{
 for(const query of ['alice@example.com','password=prod-secret','MCP_DATA_TOKEN=synthetic','sk-abcdefghijkl','-----BEGIN PRIVATE KEY-----','postgres://db/app','https://127.0.0.1/admin','https://internal.corp/x','customer 123456','客户 123456','169.254.169.254','user 12345','订单 12345678901','id 123e4567-e89b-12d3-a456-426614174000','0123456789abcdef0123456789abcdef'])expect(()=>reviewPublicSearchQuery(query,'PUBLIC')).toThrow('SEARCH_QUERY_DENIED');
 for(const query of ['', ' ', 'a'.repeat(257), 'bad\u0000query'])expect(()=>reviewPublicSearchQuery(query,'PUBLIC')).toThrow('SEARCH_QUERY_DENIED');
 expect(()=>reviewPublicSearchQuery(42,'PUBLIC')).toThrow('SEARCH_QUERY_DENIED');
 expect(()=>reviewPublicSearchQuery('PostgreSQL 17 release notes','INTERNAL')).toThrow('SEARCH_CLASSIFICATION_DENIED');
 const reviewed=reviewPublicSearchQuery('  PostgreSQL   17 release notes  ','PUBLIC');
 expect(reviewed).toMatchObject({text:'PostgreSQL 17 release notes',classification:'PUBLIC'});expect(reviewed.hash).toMatch(/^[a-f0-9]{64}$/);expect(reviewed.hash).not.toContain('PostgreSQL');
 expect(reviewPublicSearchQuery('see https://example.com/docs','PUBLIC').text).toBe('see https://example.com/docs');
 let calls=0;const provider:SearchProvider={id:'synthetic-search',search:async()=>{calls++;return[];}};
 await expect(new SearchBroker({provider}).search('password=prod-secret',{classification:'PUBLIC'})).rejects.toThrow('SEARCH_QUERY_DENIED');
 expect(calls).toBe(0);
});
