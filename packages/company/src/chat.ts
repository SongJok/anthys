import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {DbContext} from '../../storage/src/database.js';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {companyContractHash,type CodeScope} from './contracts.js';

export class CompanySourceError extends Error{constructor(readonly code:string){super(code);this.name='CompanySourceError';}}
export function chatSchemaHash(tool:{inputSchema:unknown;outputSchema?:unknown;annotations?:unknown}):string{return hash(canonical({inputSchema:tool.inputSchema,outputSchema:tool.outputSchema??null,annotations:tool.annotations??null}));}
export type ReadOperation='CHECK'|'SEARCH'|'READ';
export class CompanyChat {
 private active=0;
 constructor(readonly client:Client,readonly connectorId:string,readonly connectionBinding:string,readonly timeoutMs=1500,readonly maxConcurrent=4){if(!/^[a-f0-9]{64}$/.test(connectionBinding)||!/^[A-Za-z0-9._-]{1,128}$/.test(connectorId)||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>2000||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8)throw new CompanySourceError('INVALID_CONNECTOR_LIMITS');}
 async request(ctx:DbContext,scope:CodeScope,operation:ReadOperation,args:Record<string,unknown>,signal:AbortSignal):Promise<{value:unknown;nonce:string}>{
  if(this.active>=this.maxConcurrent)throw new CompanySourceError('COMPANY_CONCURRENCY_LIMIT');this.active++;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]),options={signal:deadline,timeout:this.timeoutMs,maxTotalTimeout:this.timeoutMs,resetTimeoutOnProgress:false};
  try{
   deadline.throwIfAborted();if(!this.client.getServerCapabilities()?.tools)throw new CompanySourceError('COMPANY_TOOLS_UNAVAILABLE');
   let cursor:string|undefined,found:Parameters<typeof chatSchemaHash>[0]|undefined;const cursors=new Set<string>(),names=new Set<string>();
   for(let page=0;page<8;page++){const listed=await this.client.listTools(cursor?{cursor}:{},options);for(const tool of listed.tools){if(names.has(tool.name)||names.size>=64)throw new CompanySourceError('COMPANY_DISCOVERY_INVALID');names.add(tool.name);if(tool.name==='chat')found=tool;}cursor=listed.nextCursor;if(!cursor)break;if(cursors.has(cursor)||page===7)throw new CompanySourceError('COMPANY_DISCOVERY_INCOMPLETE');cursors.add(cursor);}
   if(!found||chatSchemaHash(found)!==scope.schemaHash)throw new CompanySourceError('COMPANY_SCHEMA_CHANGED');
   const nonce=randomUUID(),message=JSON.stringify({contractHash:companyContractHash,operation,nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,args});
   // No free-form model prompt, shared conversationId, images, sampling or
   // elicitation. A separately certified proxy must enforce this envelope.
   const reply=CallToolResultSchema.parse(await this.client.callTool({name:'chat',arguments:{message}},CallToolResultSchema,options));
   if(reply.isError)throw new CompanySourceError('COMPANY_UPSTREAM_DENIED');
   if(reply.content.length!==1||reply.content[0]?.type!=='text'||Buffer.byteLength(reply.content[0].text,'utf8')>96000)throw new CompanySourceError('COMPANY_RESPONSE_INVALID');
   let value:unknown;try{value=JSON.parse(reply.content[0].text);}catch{throw new CompanySourceError('COMPANY_RESPONSE_INVALID');}
   return {value,nonce};
  }finally{this.active--;}
 }
}
