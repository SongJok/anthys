import {lstat,readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';
import {canonical,type Gateway} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {CompanySourceError} from './chat.js';
import {CompanyDataClient} from './data-client.js';
import {COMPANY_DATA_TOOL_NAME,companyDataContractHash,companyDataToolSchemaHash} from './data-contracts.js';
import {registerCompanyDataCapabilities,companyDataBindingHash} from './data.js';
import {loadDataTemplates} from './data-templates.js';
export const companyDataConfigurationSchema=z.object({
 schemaVersion:z.literal(1),connectorId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),transport:z.literal('STREAMABLE_HTTP'),
 server:z.object({name:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict(),endpoint:z.url(),allowedOrigin:z.url(),contractHash:z.literal(companyDataContractHash),
 tool:z.object({name:z.literal(COMPANY_DATA_TOOL_NAME),inputSchemaHash:z.literal(companyDataToolSchemaHash)}).strict(),
 templateMode:z.enum(['INLINE_DEFINITION','KEY_ONLY']),templatesDirectory:z.string().min(1).max(2048),templateRegistryHash:z.string().regex(/^[a-f0-9]{64}$/),
 reviewed:z.literal(true),readOnlyReviewRef:z.string().min(1).max(2048),actorResourceReviewRef:z.string().min(1).max(2048),rowScopeReviewRef:z.string().min(1).max(2048),templateRegistryReviewRef:z.string().min(1).max(2048),
 auth:z.object({mode:z.literal('API_KEY'),tokenFile:z.string().min(1)}).strict(),timeoutMs:z.number().int().min(50).max(2000),maxConcurrent:z.number().int().min(1).max(8)
}).strict().refine(c=>{const url=new URL(c.endpoint);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.origin===c.allowedOrigin&&!url.hostname.endsWith('.invalid')&&!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);},'UNREVIEWED_DATA_ENDPOINT');
async function boundedDataResponse(response:Response):Promise<Response>{
 if(!response.body)return response;const max=128000,length=response.headers.get('content-length');if(length&&Number(length)>max){await response.body.cancel();throw new CompanySourceError('COMPANY_DATA_RESPONSE_TOO_LARGE');}
 const reader=response.body.getReader();let count=0;const body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();return;}count+=next.value.byteLength;if(count>max){await reader.cancel();controller.error(new CompanySourceError('COMPANY_DATA_RESPONSE_TOO_LARGE'));return;}controller.enqueue(next.value);}catch{controller.error(new CompanySourceError('COMPANY_DATA_RESPONSE_UNREADABLE'));}},cancel:reason=>reader.cancel(reason)});return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
export async function configureCompanyData(gateway:Gateway,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch,approved?:readonly {id:string;version:string;bindingHash:string}[]):Promise<{enabled:boolean;client?:CompanyDataClient;close:()=>Promise<void>}>{
 const disabled=()=>({enabled:false,close:async()=>{}});if(approved!==undefined&&!approved.some(c=>c.id==='company.data.query'&&c.version==='1.0.0'))return disabled();
 const path=env['COMPANY_DATA_MCP_CONFIG_FILE'];if(!path)return disabled();
 let config:z.infer<typeof companyDataConfigurationSchema>,token:string;
 try{
  const profile=await lstat(path);if(!profile.isFile()||profile.isSymbolicLink()||(profile.mode&0o777)!==0o600||profile.size>65536)throw Error('INVALID_PRIVATE_DATA_CONFIGURATION');
  config=companyDataConfigurationSchema.parse(JSON.parse(await readFile(path,'utf8')));const file=await lstat(config.auth.tokenFile);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||file.size>8192)throw Error('INVALID_DATA_TOKEN_FILE');
  token=(await readFile(config.auth.tokenFile,'utf8')).trim();if(token.length<16||token.length>8192||/[\r\n]/.test(token))throw Error('INVALID_DATA_TOKEN');
 }catch{throw new CompanySourceError('COMPANY_DATA_CONFIGURATION_INVALID');}
 const templates=await loadDataTemplates(config.templatesDirectory);if(templates.registryHash!==config.templateRegistryHash)throw new CompanySourceError('COMPANY_DATA_CONFIGURATION_INVALID');
 const connectionBinding=hash(canonical({config,credentialHash:hash(token)}));
 if(approved!==undefined&&!approved.some(c=>c.id==='company.data.query'&&c.version==='1.0.0'&&c.bindingHash===companyDataBindingHash(config.connectorId,connectionBinding,config.tool.name,config.tool.inputSchemaHash,templates.registryHash)))return disabled();
 const boundFetch:typeof fetch=async(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==config.allowedOrigin||url.username||url.password)throw new CompanySourceError('COMPANY_DATA_DESTINATION_CHANGED');if((init.method??'GET')==='GET')return new Response(null,{status:405});
  return boundedDataResponse(await fetcher(input,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(config.timeoutMs)])}));};
 const client=new Client({name:'anthys_company_data',version:'0.1.0'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(config.endpoint),{requestInit:{headers:{authorization:'Bearer '+token}},fetch:boundFetch});
 try{await client.connect(transport as Transport,{timeout:config.timeoutMs,maxTotalTimeout:config.timeoutMs,signal:AbortSignal.timeout(config.timeoutMs)});if(client.getServerVersion()?.name!==config.server.name||client.getServerVersion()?.version!==config.server.version||!client.getServerCapabilities()?.tools)throw Error('DATA_SERVER_CHANGED');
  const adapter=new CompanyDataClient(client,config.connectorId,connectionBinding,config.tool.name,config.tool.inputSchemaHash,templates,config.templateMode,config.timeoutMs,config.maxConcurrent);registerCompanyDataCapabilities(gateway,adapter);return {enabled:true,client:adapter,close:()=>client.close()};}
 catch{await client.close().catch(()=>{});throw new CompanySourceError('COMPANY_DATA_CONNECTION_UNAVAILABLE');}
}
export const companyDataContractFileSchema=z.object({contract:z.object({id:z.literal('anthys.company.data.query'),version:z.literal(1),operations:z.tuple([z.literal('CHECK'),z.literal('QUERY')]),authorization:z.literal('UPSTREAM_RESOURCE_ENFORCED'),sideEffects:z.literal('NONE'),templates:z.literal('CERTIFIED_REGISTRY'),aggregates:z.literal('SERVER_COMPUTED')}).strict(),contractHash:z.string().regex(/^[a-f0-9]{64}$/),sdk:z.string().min(1),selectedUpstreamTool:z.literal(COMPANY_DATA_TOOL_NAME),server:z.object({name:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict(),inputSchemaHash:z.string().regex(/^[a-f0-9]{64}$/),templateRegistryHash:z.string().regex(/^[a-f0-9]{64}$/),templateFiles:z.array(z.object({key:z.string(),version:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1)}).strict();
