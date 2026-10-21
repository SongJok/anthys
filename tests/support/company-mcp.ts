import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {hash} from '../../packages/storage/src/crypto.js';
import type {DbContext} from '../../packages/storage/src/database.js';
import {companyContractHash,readSchema,searchSchema,codeResource,pathAllowed,type CodeScope} from '../../packages/company/src/contracts.js';
import {chatSchemaHash,CompanyChat} from '../../packages/company/src/chat.js';
const requestSchema=z.object({contractHash:z.literal(companyContractHash),operation:z.enum(['CHECK','SEARCH','READ']),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),scopeVersion:z.number().int().positive(),sourceRevision:z.string(),args:z.record(z.string(),z.unknown())}).strict();
export const syntheticChatTool={name:'chat',inputSchema:{type:'object' as const,properties:{message:{type:'string'}},required:['message'],additionalProperties:false}};
export const syntheticRepo='fixture/payments',syntheticCommit='a'.repeat(40),syntheticPath='src/payment.ts';
export async function companyFixture(root:pg.Pool,ctx:DbContext,runId:string,options:{text?:string;timeoutMs?:number}={}){
 const sourceId=randomUUID(),scopeId=randomUUID(),connectorId='synthetic-company-'+randomUUID(),source={repo:syntheticRepo,commit:syntheticCommit,revision:'synthetic-revision-1',scopeVersion:1,authorized:true,files:{[syntheticPath]:options.text??'export const success = true;\nexport const rate = 0.97;\n// source data only'} as Record<string,string>};
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_COMPANY_CODE',$4,$5,$2::uuid::text,now())",[ctx.tenantId,sourceId,ctx.actorId,runId,JSON.stringify(source)]);
 const scope:CodeScope={id:scopeId,version:1,sourceRevision:source.revision,schemaHash:chatSchemaHash(syntheticChatTool),allowedPaths:['src'],classification:'CONFIDENTIAL'};
 await root.query("INSERT INTO company_code_scopes(tenant_id,id,owner_id,connector_id,repo,commit_id,version,source_revision,tool_schema_hash,contract_hash,readonly_proof_ref,authorization_proof_ref,allowed_paths,classification,model_egress_allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'synthetic-upstream-readonly-contract','synthetic-actor-resource-proof',ARRAY['src'],'CONFIDENTIAL',true,now()+interval '1 hour')",[ctx.tenantId,scopeId,ctx.actorId,connectorId,syntheticRepo,syntheticCommit,source.revision,scope.schemaHash,companyContractHash]);
 const client=new Client({name:'anthys_synthetic_company_client',version:'0.1.0'},{capabilities:{}}),server=new Server({name:'synthetic-company-scoped-proxy',version:'1.0.0'},{capabilities:{tools:{}}}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 let lists=0,checks=0,reads=0,searches=0,attempts=0,initialized=false;const modes={paginate:false,schemaDrift:false,duplicateTools:false,listLoop:false,hang:false,businessHang:false,deny:false,checkHook:null as null|((input:{operation:string;args:Record<string,unknown>})=>Promise<void>),mutate:null as null|((reply:Record<string,unknown>)=>unknown)};
 server.oninitialized=()=>{initialized=true;};
 server.setRequestHandler(ListToolsRequestSchema,async request=>{lists++;if(modes.listLoop)return {tools:[],nextCursor:'same'};if(modes.paginate&&!request.params?.cursor)return {tools:[{name:'synthetic_metadata',inputSchema:{type:'object',properties:{}}}],nextCursor:'synthetic-read-page'};return {tools:modes.duplicateTools?[syntheticChatTool,syntheticChatTool]:[{...syntheticChatTool,inputSchema:modes.schemaDrift?{type:'object',properties:{dangerous:{type:'string'}}}:syntheticChatTool.inputSchema}]};});
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(!initialized||request.params.name!=='chat'||!request.params.arguments||Object.keys(request.params.arguments).join(',')!=='message')throw Error('SYNTHETIC_CHAT_ARGUMENTS_INVALID');
  if(modes.hang)await new Promise<void>(resolve=>setTimeout(resolve,250));
  attempts++;const input=requestSchema.parse(JSON.parse(request.params.arguments['message'] as string)),live=(await root.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0].payload_ref as typeof source;
  // Independent upstream authority, not an echo of the caller's scope claim.
  if(modes.deny||!live.authorized||input.tenantId!==ctx.tenantId||input.actorId!==ctx.actorId||input.scopeId!==scopeId||input.scopeVersion!==live.scopeVersion||input.sourceRevision!==live.revision||input.args['repo']!==live.repo||input.args['commit']!==live.commit)return {isError:true,content:[{type:'text',text:'SYNTHETIC_UPSTREAM_DENIED'}]};
  const common={contractHash:companyContractHash,nonce:input.nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId,scopeVersion:live.scopeVersion,sourceRevision:live.revision};let reply:Record<string,unknown>;
  if(input.operation==='CHECK'){checks++;await modes.checkHook?.(input);if(input.args['path']&&!pathAllowed(input.args['path'] as string,['src']))return {isError:true,content:[{type:'text',text:'SYNTHETIC_PATH_DENIED'}]};reply={...common,operation:'CHECK',allowed:true};}
  else if(input.operation==='SEARCH'){searches++;if(modes.businessHang)await new Promise<void>(resolve=>setTimeout(resolve,250));const args=searchSchema.parse(input.args),all=Object.entries(live.files).flatMap(([path,text])=>text.split('\n').flatMap((line,i)=>line.includes(args.keyword)?[{repo:live.repo,commit:live.commit,path,startLine:i+1,endLine:i+1,snippet:line,contentHash:hash(line)}]:[]));reply={...common,operation:'SEARCH',queryId:randomUUID(),matches:all.slice(0,args.limit),totalCount:all.length,truncated:all.length>args.limit};}
  else {reads++;if(modes.businessHang)await new Promise<void>(resolve=>setTimeout(resolve,250));const args=readSchema.parse(input.args),text=live.files[args.path as keyof typeof live.files];if(text===undefined||!pathAllowed(args.path,['src']))return {isError:true,content:[{type:'text',text:'SYNTHETIC_PATH_DENIED'}]};const lines=text.split('\n'),end=Math.min(args.endLine,lines.length),snippet=lines.slice(args.startLine-1,end).join('\n');reply={...common,operation:'READ',queryId:randomUUID(),fragment:{repo:live.repo,commit:live.commit,path:args.path,startLine:args.startLine,endLine:end,snippet,contentHash:hash(snippet)},totalLines:lines.length,truncated:false};}
  const value=modes.mutate?modes.mutate(reply):reply;return {content:[{type:'text',text:JSON.stringify(value)}]};
 });
 await server.connect(serverTransport as Transport);await client.connect(clientTransport as Transport);
 return {client,server,chat:new CompanyChat(client,connectorId,hash(connectorId),options.timeoutMs??1000),scope,sourceId,modes,resource:codeResource({repo:syntheticRepo,commit:syntheticCommit}),counts:()=>({lists,checks,reads,searches,attempts,initialized}),changeSource:async(change:Partial<typeof source>)=>{const live=(await root.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0].payload_ref;await root.query('UPDATE outbox SET payload_ref=$2 WHERE id=$1',[sourceId,JSON.stringify({...live,...change})]);},close:async()=>{await client.close();await server.close();}};
}
