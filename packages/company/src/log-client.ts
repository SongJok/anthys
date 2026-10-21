import {randomUUID} from 'node:crypto';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {DbContext} from '../../storage/src/database.js';
import {chatSchemaHash,CompanySourceError} from './chat.js';
import {companyLogsContractHash,type LogScope} from './log-contracts.js';
export class CompanyLogsClient{
 private active=0;
 constructor(readonly client:Client,readonly connectorId:string,readonly connectionBinding:string,readonly timeoutMs=1500,readonly maxConcurrent=4){if(!/^[A-Za-z0-9._-]{1,128}$/.test(connectorId)||!/^[a-f0-9]{64}$/.test(connectionBinding)||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>2000||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw new CompanySourceError('COMPANY_LOG_LIMITS_INVALID');}
 async request(ctx:DbContext,scope:LogScope,operation:'CHECK'|'QUERY',args:Record<string,unknown>,signal:AbortSignal):Promise<{value:unknown;nonce:string}>{
  if(this.active>=this.maxConcurrent)throw new CompanySourceError('COMPANY_LOG_CONCURRENCY_LIMIT');this.active++;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]),options={signal:deadline,timeout:this.timeoutMs,maxTotalTimeout:this.timeoutMs,resetTimeoutOnProgress:false};
  try{
   deadline.throwIfAborted();if(!this.client.getServerCapabilities()?.tools)throw new CompanySourceError('COMPANY_LOG_TOOLS_UNAVAILABLE');
   let cursor:string|undefined,found:Parameters<typeof chatSchemaHash>[0]|undefined;const cursors=new Set<string>(),names=new Set<string>();
   for(let page=0;page<8;page++){const list=await this.client.listTools(cursor?{cursor}:{},options);for(const tool of list.tools){if(names.has(tool.name)||names.size>=64)throw new CompanySourceError('COMPANY_LOG_DISCOVERY_INVALID');names.add(tool.name);if(tool.name==='chat')found=tool;}cursor=list.nextCursor;if(!cursor)break;if(cursors.has(cursor)||page===7)throw new CompanySourceError('COMPANY_LOG_DISCOVERY_INCOMPLETE');cursors.add(cursor);}
   if(!found||chatSchemaHash(found)!==scope.schemaHash)throw new CompanySourceError('COMPANY_LOG_SCHEMA_CHANGED');
   const nonce=randomUUID(),message=JSON.stringify({contractHash:companyLogsContractHash,operation,nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,args});
   const reply=CallToolResultSchema.parse(await this.client.callTool({name:'chat',arguments:{message}},CallToolResultSchema,options));deadline.throwIfAborted();
   if(reply.isError)throw new CompanySourceError('COMPANY_LOG_UPSTREAM_DENIED');
   if(reply.content.length!==1||reply.content[0]?.type!=='text'||Buffer.byteLength(reply.content[0].text,'utf8')>96000)throw new CompanySourceError('COMPANY_LOG_RESPONSE_INVALID');
   let value:unknown;try{value=JSON.parse(reply.content[0].text);}catch{throw new CompanySourceError('COMPANY_LOG_RESPONSE_INVALID');}return {value,nonce};
  }finally{this.active--;}
 }
}
