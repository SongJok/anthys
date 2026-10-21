import {readFile,stat} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import type {Gateway} from '../../gateway/src/index.js';
import {companyContractHash} from './contracts.js';
import {CompanyChat,CompanySourceError} from './chat.js';
import {registerCompanyCodeCapabilities,companyCodeBindingHash} from './code.js';
export const companyConfigurationSchema=z.object({schemaVersion:z.literal(1),connectorId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),transport:z.literal('STREAMABLE_HTTP'),server:z.object({name:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict(),endpoint:z.url(),allowedOrigin:z.url(),contractHash:z.literal(companyContractHash),reviewed:z.literal(true),readOnlyReviewRef:z.string().min(1).max(2048),actorResourceReviewRef:z.string().min(1).max(2048),auth:z.object({mode:z.literal('API_KEY'),tokenFile:z.string().min(1)}).strict(),timeoutMs:z.number().int().min(50).max(2000),maxConcurrent:z.number().int().min(1).max(8)}).strict().refine(c=>{const url=new URL(c.endpoint);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.origin===c.allowedOrigin&&!url.hostname.endsWith('.invalid')&&!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);},'UNREVIEWED_ENDPOINT');
async function boundedResponse(response:Response):Promise<Response>{
 if(!response.body)return response;const max=128000,length=response.headers.get('content-length');if(length&&Number(length)>max){await response.body.cancel();throw new CompanySourceError('COMPANY_RESPONSE_TOO_LARGE');}
 const reader=response.body.getReader();let count=0;const body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();return;}count+=next.value.byteLength;if(count>max){await reader.cancel();controller.error(new CompanySourceError('COMPANY_RESPONSE_TOO_LARGE'));return;}controller.enqueue(next.value);}catch{controller.error(new CompanySourceError('COMPANY_RESPONSE_UNREADABLE'));}},cancel:reason=>reader.cancel(reason)});return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
export async function configureCompanyCode(gateway:Gateway,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch,approved?:readonly {id:string;version:string;bindingHash:string}[]):Promise<{enabled:boolean;close:()=>Promise<void>}>{
 if(approved!==undefined&&!approved.some(a=>['company.code.search','company.code.read'].includes(a.id)&&a.version==='1.0.0'))return {enabled:false,close:async()=>{}};
 const path=env['COMPANY_MCP_CONFIG_FILE'];if(!path)return {enabled:false,close:async()=>{}};
 // Only an explicitly mounted, independently reviewed contract opts in. Never
 // promote existing generic AIDER_AI_* chat credentials to READ authority.
 const config=companyConfigurationSchema.parse(JSON.parse(await readFile(path,'utf8'))),file=await stat(config.auth.tokenFile);if(!file.isFile()||(file.mode&0o077)!==0)throw new CompanySourceError('COMPANY_TOKEN_FILE_PERMISSIONS');
 const token=(await readFile(config.auth.tokenFile,'utf8')).trim();if(token.length<16||token.length>8192||/[\r\n]/.test(token))throw new CompanySourceError('COMPANY_TOKEN_INVALID');
 const connectionBinding=hash(canonical({config,credentialHash:hash(token)}));
 if(approved!==undefined&&!['company.code.search','company.code.read'].some(id=>approved.some(a=>a.id===id&&a.version==='1.0.0'&&a.bindingHash===companyCodeBindingHash(id,config.connectorId,connectionBinding))))return {enabled:false,close:async()=>{}};
 const boundFetch:typeof fetch=async(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==config.allowedOrigin)throw new CompanySourceError('COMPANY_DESTINATION_CHANGED');
  // No server-initiated sampling/elicitation/long-lived notification channel.
  // Rediscovery precedes each call, so disabling optional GET is deliberate.
  if((init.method??'GET')==='GET')return new Response(null,{status:405});
  return boundedResponse(await fetcher(input,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(config.timeoutMs)])}));};
 const client=new Client({name:'open_aider_company_code',version:'0.1.0'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(config.endpoint),{requestInit:{headers:{authorization:'Bearer '+token}},fetch:boundFetch});
 try{await client.connect(transport as Transport,{timeout:config.timeoutMs,maxTotalTimeout:config.timeoutMs,signal:AbortSignal.timeout(config.timeoutMs)});if(client.getServerVersion()?.name!==config.server.name||client.getServerVersion()?.version!==config.server.version||!client.getServerCapabilities()?.tools)throw new CompanySourceError('COMPANY_SERVER_CHANGED');registerCompanyCodeCapabilities(gateway,new CompanyChat(client,config.connectorId,connectionBinding,config.timeoutMs,config.maxConcurrent));return {enabled:true,close:()=>client.close()};}
 catch{await client.close().catch(()=>{});throw new CompanySourceError('COMPANY_CONNECTION_UNAVAILABLE');}
}
