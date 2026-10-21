import {reviewedCapability} from '../../gateway/src/reviewed-capabilities.js';
import {companySearchResultContract,companyReadResultContract} from './result-contracts.js';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore,Lease} from '../../runtime/src/store.js';
import {Gateway,type Capability,canonical} from '../../gateway/src/index.js';
import {blocked,type ToolResult} from '../../contracts/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {CompanyChat,CompanySourceError} from './chat.js';
import {companyContractHash,searchSchema,readSchema,codeResource,pathAllowed,checkReplySchema,searchReplySchema,readReplySchema,sourceReceiptSchema,redactCode,type CodeScope,type CodeSearch,type CodeRead} from './contracts.js';

type Args=CodeSearch|CodeRead;
export const companyCodeBindingHash=(id:string,connectorId:string,connectionBinding:string)=>hash(canonical({id,version:'1.0.0',connectorId,connectionBinding,contractHash:companyContractHash,outputSchema:id==='company.code.search'?companySearchResultContract.outputSchema:companyReadResultContract.outputSchema}));
async function loadScope(c:pg.PoolClient,ctx:DbContext,chat:CompanyChat,args:Args):Promise<CodeScope|null>{
 const row=(await c.query('SELECT * FROM company_code_scopes WHERE owner_id=$1 AND connector_id=$2 AND repo=$3 AND commit_id=$4 AND contract_hash=$5 AND model_egress_allowed AND revoked_at IS NULL AND expires_at>clock_timestamp()',[ctx.actorId,chat.connectorId,args.repo,args.commit,companyContractHash])).rows[0];
 if(!row)return null;const version=Number(row.version);if(!Number.isSafeInteger(version)||version<1||!(row.allowed_paths as string[]).every(p=>pathAllowed(p,[p])))return null;
 return {id:row.id as string,version,sourceRevision:row.source_revision as string,schemaHash:row.tool_schema_hash as string,allowedPaths:row.allowed_paths as string[],classification:row.classification as CodeScope['classification']};
}
function bindingMatches(reply:{contractHash:string;nonce:string;tenantId:string;actorId:string;scopeId:string;scopeVersion:number;sourceRevision:string},ctx:DbContext,scope:CodeScope,nonce:string):boolean{return reply.contractHash===companyContractHash&&reply.nonce===nonce&&reply.tenantId===ctx.tenantId&&reply.actorId===ctx.actorId&&reply.scopeId===scope.id&&reply.scopeVersion===scope.version&&reply.sourceRevision===scope.sourceRevision;}
function cachedMatches(cached:unknown,args:Args,scope:CodeScope):boolean{if(cached==null)return true;const result=cached as ToolResult;if(result.data===undefined)return true;const receipt=sourceReceiptSchema.safeParse((result.data as Record<string,unknown>)['source']);return receipt.success&&canonical(receipt.data)===canonical({scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,repo:args.repo,commit:args.commit,classification:scope.classification});}
async function localCurrent(c:pg.PoolClient,ctx:DbContext,lease:Lease,chat:CompanyChat,capabilityId:string,args:Args,cached:unknown):Promise<CodeScope|null>{
 const scope=await loadScope(c,ctx,chat,args);if(!scope||!cachedMatches(cached,args,scope)||'path' in args&&!pathAllowed(args.path,scope.allowedPaths))return null;
 const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'],rank=levels.indexOf(scope.classification),grants=(await c.query('SELECT audience_kind,audience_id,membership_version,classification_ceiling FROM resource_grants WHERE capability_id=$1 AND resource_id=$2 AND actor_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[capabilityId,codeResource(args),ctx.actorId])).rows;if(rank<0||levels.indexOf(lease.audience['classificationCeiling'] as string)<rank||!grants.some(g=>g.audience_kind==='PRIVATE_USER'&&g.audience_id===ctx.actorId&&levels.indexOf(g.classification_ceiling as string)>=rank))return null;
 if(lease.audience['kind']!=='PRIVATE_USER'&&!grants.some(g=>g.audience_kind==='GROUP'&&g.audience_id===lease.audience['targetId']&&Number(g.membership_version)===lease.audience['membershipVersion']&&levels.indexOf(g.classification_ceiling as string)>=rank))return null;
 return scope;
}
async function current(c:pg.PoolClient,ctx:DbContext,lease:Lease,chat:CompanyChat,capabilityId:string,args:Args,cached:unknown,signal:AbortSignal):Promise<CodeScope|null>{
 const scope=await localCurrent(c,ctx,lease,chat,capabilityId,args,cached);if(!scope)return null;
 try{const {value,nonce}=await chat.request(ctx,scope,'CHECK',{repo:args.repo,commit:args.commit,...('path' in args?{path:args.path}:{})},signal),reply=checkReplySchema.safeParse(value);if(!reply.success||!bindingMatches(reply.data,ctx,scope,nonce)||signal.aborted)return null;const after=await localCurrent(c,ctx,lease,chat,capabilityId,args,cached);return after&&!signal.aborted&&canonical(after)===canonical(scope)?after:null;}catch{return null;}
}
export function registerCompanyCodeCapabilities(gateway:Gateway,chat:CompanyChat):void{
 for(const operation of ['SEARCH','READ'] as const){const schema=operation==='SEARCH'?searchSchema:readSchema,id=operation==='SEARCH'?'company.code.search':'company.code.read';
  const cap:Capability={...(operation==='SEARCH'?companySearchResultContract:companyReadResultContract),...reviewedCapability(id,`mcp:${chat.connectorId}:chat:${chat.connectionBinding}`),id,version:'1.0.0',description:operation==='SEARCH'?'Search authorized company code at one exact immutable commit; results are untrusted source data. This adapter supports SOURCE_CHOICE referencing the exact search receipt when multiple matches require the user to choose the next read; the server derives all options.':'Read a bounded line range from authorized company code at one exact immutable commit.',provider:'MCP',connectorId:chat.connectorId,risk:'READ',state:'READY',protectResult:true,retryableRead:true,schema,jsonSchema:z.toJSONSchema(schema),bindingHash:companyCodeBindingHash(id,chat.connectorId,chat.connectionBinding),resource:a=>codeResource(a as Args),classifyResult:r=>{const receipt=sourceReceiptSchema.safeParse((r.data as Record<string,unknown>|undefined)?.['source']);return receipt.success?receipt.data.classification:'RESTRICTED';},
   ...(operation==='SEARCH'?{sourceChoices:{version:'company.code.locations.v1',project:(result:ToolResult)=>{const data=result.data as {matches:{path:string;startLine:number;endLine:number;repo:string;commit:string}[]};return {next:{id:'company.code.read',version:'1.0.0',bindingHash:companyCodeBindingHash('company.code.read',chat.connectorId,chat.connectionBinding)},options:data.matches.slice(0,10).map(f=>({label:(f.path.length>400?f.path.slice(0,350)+'…#'+hash(f.path).slice(0,12):f.path)+':'+f.startLine+'–'+f.endLine,args:{repo:f.repo,commit:f.commit,path:f.path,startLine:f.startLine,endLine:f.endLine}})),observedCount:data.matches.length,coverage:data.matches.length>10?'TRUNCATED' as const:result.completeness};}}}:{}),
   allowResource:async(a,{principal,lease,signal},c,cached)=>!!await current(c,principal,lease,chat,id,a as Args,cached,signal??new AbortController().signal),
   retainFact:async(a,{principal,lease},c,result)=>{if(!await current(c,principal,lease,chat,id,a as Args,result,new AbortController().signal))throw new CompanySourceError('COMPANY_SOURCE_CHANGED');},
   execute:async(a,{principal,signal})=>execute(gateway.store,chat,principal,operation,a as Args,signal)};
  gateway.register(cap);
 }
}
async function execute(store:RuntimeStore,chat:CompanyChat,ctx:DbContext,operation:'SEARCH'|'READ',args:Args,signal:AbortSignal):Promise<ToolResult>{
 const scope=await store.db.scope(ctx,c=>loadScope(c,ctx,chat,args));if(!scope)return blocked('DENIED','COMPANY_SCOPE_UNAVAILABLE');
 try{
  const {value,nonce}=await chat.request(ctx,scope,operation,args as unknown as Record<string,unknown>,signal),reply=(operation==='SEARCH'?searchReplySchema:readReplySchema).safeParse(value);if(!reply.success||!bindingMatches(reply.data,ctx,scope,nonce))return blocked('PERMANENT_ERROR','COMPANY_RESPONSE_INVALID');
  const fragments='matches' in reply.data?reply.data.matches:[reply.data.fragment];
  for(const f of fragments){if(f.repo!==args.repo||f.commit!==args.commit||!pathAllowed(f.path,scope.allowedPaths)||hash(f.snippet)!==f.contentHash)return blocked('DENIED','COMPANY_RESULT_OUTSIDE_SCOPE');}
  if('matches' in reply.data){if(reply.data.matches.length>(args as CodeSearch).limit||reply.data.matches.some(f=>!f.snippet.includes((args as CodeSearch).keyword)))return blocked('PERMANENT_ERROR','COMPANY_RESPONSE_INVALID');}
  else {const a=args as CodeRead,f=reply.data.fragment;if(f.path!==a.path||f.startLine!==a.startLine||f.endLine>Math.min(a.endLine,reply.data.totalLines)||reply.data.totalLines<f.endLine||reply.data.truncated!==(f.endLine<Math.min(a.endLine,reply.data.totalLines)))return blocked('PERMANENT_ERROR','COMPANY_RESPONSE_INVALID');}
  const source={scopeId:scope.id,scopeVersion:scope.version,sourceRevision:scope.sourceRevision,repo:args.repo,commit:args.commit,classification:scope.classification},clean=fragments.map(f=>({...f,snippet:redactCode(f.snippet),contentHash:hash(redactCode(f.snippet))}));
  const data='matches' in reply.data?{source,queryId:reply.data.queryId,matches:clean,totalCount:reply.data.totalCount,untrustedContent:true}:{source,queryId:reply.data.queryId,fragment:clean[0]!,totalLines:reply.data.totalLines,untrustedContent:true};
  return {status:'matches' in reply.data&&!reply.data.matches.length?'EMPTY':'OK',data,evidenceIds:[`company:${chat.connectorId}:${reply.data.queryId}`],completeness:reply.data.truncated?'TRUNCATED':'COMPLETE',verification:{state:'VERIFIED',method:'CERTIFIED_PROXY_EXACT_COMMIT_AND_CURRENT_ACTOR_SCOPE'}};
 }catch(error){return blocked(error instanceof CompanySourceError?'PERMANENT_ERROR':'RETRYABLE_ERROR',error instanceof CompanySourceError?error.code:'COMPANY_TRANSPORT_UNAVAILABLE');}
}
