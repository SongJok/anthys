import {randomUUID} from 'node:crypto';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {DbContext} from '../../storage/src/database.js';
import {chatSchemaHash,CompanySourceError} from './chat.js';
import {companyDataContractHash,type DataScope} from './data-contracts.js';
import {requireDataTemplate,type DataTemplate,type DataTemplateRegistry} from './data-templates.js';
import {upstreamErrorFrom} from './upstream-error.js';
// A timed-out upstream request may still be running. The local side keeps the
// request handle it issued so the execution stays reconcilable, and never
// compensates the timeout with another query.
export type DataNonce=ReturnType<typeof randomUUID>;
export class CompanyDataTimeoutError extends CompanySourceError{
 constructor(readonly nonce:DataNonce,readonly reason:'TIMEOUT'|'CANCELLED'){super(reason==='TIMEOUT'?'COMPANY_DATA_UPSTREAM_TIMEOUT':'COMPANY_DATA_CALLER_CANCELLED');this.name='CompanyDataTimeoutError';}
}
export class CompanyDataClient{
 private active=0;
 constructor(readonly client:Client,readonly connectorId:string,readonly connectionBinding:string,readonly toolName:string,readonly inputSchemaHash:string,readonly templates:DataTemplateRegistry,readonly templateMode:'INLINE_DEFINITION'|'KEY_ONLY',readonly timeoutMs=1500,readonly maxConcurrent=4){
  if(!/^[A-Za-z0-9._-]{1,128}$/.test(connectorId)||!/^[a-f0-9]{64}$/.test(connectionBinding)||!/^[A-Za-z0-9_.-]{1,128}$/.test(toolName)||!/^[a-f0-9]{64}$/.test(inputSchemaHash)||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>2000||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw new CompanySourceError('COMPANY_DATA_LIMITS_INVALID');
 }
 template(key:string,version:string):DataTemplate{return requireDataTemplate(this.templates,key,version);}
 async request(ctx:DbContext,scope:DataScope,operation:'CHECK'|'QUERY',args:Record<string,unknown>,signal:AbortSignal,nonce:DataNonce=randomUUID()):Promise<{value:unknown;nonce:DataNonce}>{
  if(this.active>=this.maxConcurrent)throw new CompanySourceError('COMPANY_DATA_CONCURRENCY_LIMIT');this.active++;
  const timeoutSignal=AbortSignal.timeout(this.timeoutMs),deadline=AbortSignal.any([signal,timeoutSignal]),options={signal:deadline,timeout:this.timeoutMs+50,maxTotalTimeout:this.timeoutMs+50,resetTimeoutOnProgress:false};
  try{
   if(signal.aborted)throw new CompanyDataTimeoutError(nonce,'CANCELLED');if(!this.client.getServerCapabilities()?.tools)throw new CompanySourceError('COMPANY_DATA_TOOLS_UNAVAILABLE');
   let cursor:string|undefined,found:(Parameters<typeof chatSchemaHash>[0]&{name:string})|undefined;const cursors=new Set<string>(),names=new Set<string>();
   for(let page=0;page<8;page++){const list=await this.client.listTools(cursor?{cursor}:{},options);for(const tool of list.tools){if(names.has(tool.name)||names.size>=64)throw new CompanySourceError('COMPANY_DATA_DISCOVERY_INVALID');names.add(tool.name);if(tool.name===this.toolName)found=tool;}cursor=list.nextCursor;if(!cursor)break;if(cursors.has(cursor)||page===7)throw new CompanySourceError('COMPANY_DATA_DISCOVERY_INCOMPLETE');cursors.add(cursor);}
   if(!found||found.name!==this.toolName||chatSchemaHash(found)!==this.inputSchemaHash||scope.schemaHash!==this.inputSchemaHash)throw new CompanySourceError('COMPANY_DATA_SCHEMA_CHANGED');
   const message=JSON.stringify({contractHash:companyDataContractHash,operation,nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,args});
   let raw:unknown;
   try{raw=await this.client.callTool({name:this.toolName,arguments:{message}},CallToolResultSchema,options);}
   catch(error){if(signal.aborted)throw new CompanyDataTimeoutError(nonce,'CANCELLED');if(timeoutSignal.aborted)throw new CompanyDataTimeoutError(nonce,'TIMEOUT');throw error;}
   const reply=CallToolResultSchema.parse(raw);if(signal.aborted)throw new CompanyDataTimeoutError(nonce,'CANCELLED');
   if(reply.isError)throw upstreamErrorFrom(reply,{contractHash:companyDataContractHash,nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId:scope.id});
   if(reply.content.length!==1||reply.content[0]?.type!=='text'||Buffer.byteLength(reply.content[0].text,'utf8')>96000)throw new CompanySourceError('COMPANY_DATA_RESPONSE_INVALID');
   let value:unknown;try{value=JSON.parse(reply.content[0].text);}catch{throw new CompanySourceError('COMPANY_DATA_RESPONSE_INVALID');}return {value,nonce};
  }finally{this.active--;}
 }
}
