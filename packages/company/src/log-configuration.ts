import {readFile,lstat} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';
import {canonical,type Gateway} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {CompanySourceError} from './chat.js';
import {companyLogsContractHash} from './log-contracts.js';
import {CompanyLogsClient} from './log-client.js';
import {companyLogsBindingHash,registerCompanyLogCapabilities} from './logs.js';
// Keep log configuration independent: loading a disabled log connector must
// not evaluate or depend on the separately optional code connector module.
export const companyLogConfigurationSchema=z.object({schemaVersion:z.literal(1),connectorId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),transport:z.literal('STREAMABLE_HTTP'),server:z.object({name:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict(),endpoint:z.url(),allowedOrigin:z.url(),contractHash:z.literal(companyLogsContractHash),reviewed:z.literal(true),readOnlyReviewRef:z.string().min(1).max(2048),actorResourceReviewRef:z.string().min(1).max(2048),auth:z.object({mode:z.literal('API_KEY'),tokenFile:z.string().min(1)}).strict(),timeoutMs:z.number().int().min(50).max(2000),maxConcurrent:z.number().int().min(1).max(8),redactionPolicyReviewRef:z.string().min(8).max(2048)}).strict().refine(c=>{const url=new URL(c.endpoint);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.origin===c.allowedOrigin&&!url.hostname.endsWith('.invalid')&&!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);},'UNREVIEWED_LOG_ENDPOINT');
async function boundedLogResponse(response:Response):Promise<Response>{
 if(!response.body)return response;const max=128000,length=response.headers.get('content-length');if(length&&Number(length)>max){await response.body.cancel();throw new CompanySourceError('COMPANY_LOG_RESPONSE_TOO_LARGE');}
 const reader=response.body.getReader();let count=0;const body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();return;}count+=next.value.byteLength;if(count>max){await reader.cancel();controller.error(new CompanySourceError('COMPANY_LOG_RESPONSE_TOO_LARGE'));return;}controller.enqueue(next.value);}catch{controller.error(new CompanySourceError('COMPANY_LOG_RESPONSE_UNREADABLE'));}},cancel:reason=>reader.cancel(reason)});return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
export async function configureCompanyLogs(gateway:Gateway,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch,approved?:readonly {id:string;version:string;bindingHash:string}[]):Promise<{enabled:boolean;close:()=>Promise<void>}>{
 const disabled=()=>({enabled:false,close:async()=>{}});if(approved!==undefined&&!approved.some(c=>c.id==='company.logs.query'&&c.version==='1.0.0'))return disabled();
 const path=env['COMPANY_LOGS_MCP_CONFIG_FILE'];if(!path)return disabled();
 let config:z.infer<typeof companyLogConfigurationSchema>,token:string;
 try{
  const profile=await lstat(path);if(!profile.isFile()||profile.isSymbolicLink()||(profile.mode&0o777)!==0o600||profile.size>65536)throw Error('INVALID_PRIVATE_LOG_CONFIGURATION');
  config=companyLogConfigurationSchema.parse(JSON.parse(await readFile(path,'utf8')));const file=await lstat(config.auth.tokenFile);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||file.size>8192)throw Error('INVALID_LOG_TOKEN_FILE');
  token=(await readFile(config.auth.tokenFile,'utf8')).trim();if(token.length<16||token.length>8192||/[\r\n]/.test(token))throw Error('INVALID_LOG_TOKEN');
 }catch{throw new CompanySourceError('COMPANY_LOG_CONFIGURATION_INVALID');}
 // This binding is separate from the unchanged code connector. A shared key
 // authenticates this connection, never the actor's authority to read logs.
 const connectionBinding=hash(canonical({config,credentialHash:hash(token)}));
 if(approved!==undefined&&!approved.some(c=>c.id==='company.logs.query'&&c.version==='1.0.0'&&c.bindingHash===companyLogsBindingHash(config.connectorId,connectionBinding)))return disabled();
 const boundFetch:typeof fetch=async(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==config.allowedOrigin||url.username||url.password)throw new CompanySourceError('COMPANY_LOG_DESTINATION_CHANGED');if((init.method??'GET')==='GET')return new Response(null,{status:405});
  return boundedLogResponse(await fetcher(input,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(config.timeoutMs)])}));};
 const client=new Client({name:'anthys_company_logs',version:'0.1.0'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(config.endpoint),{requestInit:{headers:{authorization:'Bearer '+token}},fetch:boundFetch});
 try{await client.connect(transport as Transport,{timeout:config.timeoutMs,maxTotalTimeout:config.timeoutMs,signal:AbortSignal.timeout(config.timeoutMs)});if(client.getServerVersion()?.name!==config.server.name||client.getServerVersion()?.version!==config.server.version||!client.getServerCapabilities()?.tools)throw Error('LOG_SERVER_CHANGED');registerCompanyLogCapabilities(gateway,new CompanyLogsClient(client,config.connectorId,connectionBinding,config.timeoutMs,config.maxConcurrent));return {enabled:true,close:()=>client.close()};}
 catch{await client.close().catch(()=>{});throw new CompanySourceError('COMPANY_LOG_CONNECTION_UNAVAILABLE');}
}
