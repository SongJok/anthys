import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {DbContext} from '../../packages/storage/src/database.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
import {CompanyDataClient} from '../../packages/company/src/data-client.js';
import {COMPANY_DATA_TOOL_NAME,companyDataContractHash,companyDataToolSchemaHash,dataChannelSchema,dataQuerySchema,dataResource,dataTemplateRefSchema,dataTemplateRef,type DataScope} from '../../packages/company/src/data-contracts.js';
import {aggregatePaymentAttempts,dataTemplateHash,dataTemplateSchema,loadDataTemplates,type GoldenPaymentEvent} from '../../packages/company/src/data-templates.js';
const templateDirectory=fileURLToPath(new URL('../../config/data-templates',import.meta.url));
export const goldenEvents:GoldenPaymentEvent[]=[
 {eventId:'e01',attemptId:'a1',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:00:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e02',attemptId:'a1',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:00:01.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e03',attemptId:'a2',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:01:00.000Z',channel:'app',status:'failed',valid:true},
 {eventId:'e04',attemptId:'a3',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T15:59:59.000Z',channel:'web',status:'success',valid:true},
 {eventId:'e05',attemptId:'a4',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T16:00:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e06',attemptId:'a5',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T15:59:59.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e07',attemptId:'a6',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:00:00.000Z',channel:'web',status:'unknown',valid:true},
 {eventId:'e08',attemptId:'a7',tenantId:'A',departmentId:'d_other',eventTime:'2026-10-13T04:01:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e09',attemptId:'a8',tenantId:'B',departmentId:'d_pay',eventTime:'2026-10-13T04:02:00.000Z',channel:'app',status:'failed',valid:true},
 {eventId:'e10',attemptId:'a9',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:03:00.000Z',channel:'app',status:'success',valid:false},
 {eventId:'e11',attemptId:'a10',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:04:00.000Z',channel:'app',status:'success',valid:true},
];
const tool={name:COMPANY_DATA_TOOL_NAME,inputSchema:{type:'object' as const,properties:{message:{type:'string'}},required:['message'],additionalProperties:false}};
const requestSchema=z.object({contractHash:z.literal(companyDataContractHash),operation:z.enum(['CHECK','QUERY']),nonce:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),scopeId:z.uuid(),scopeVersion:z.number().int().positive(),sourceRevision:z.string(),args:z.record(z.string(),z.unknown())}).strict();
const wireArgumentsSchema=z.object({template:dataTemplateRefSchema,definition:dataTemplateSchema.optional(),parameters:z.object({start:z.iso.datetime({offset:true}),end:z.iso.datetime({offset:true}),channel:dataChannelSchema.optional()}).strict()}).strict();
export const syntheticDataQuery={templateKey:'payments.success_rate_daily',templateVersion:'1.0.0',start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z'};
export async function companyDataFixture(root:pg.Pool,ctx:DbContext,runId:string){
 const templates=await loadDataTemplates(templateDirectory),template=templates.byRef.get(syntheticDataQuery.templateKey+'@'+syntheticDataQuery.templateVersion);if(!template)throw Error('SYNTHETIC_DATA_TEMPLATE_MISSING');
 const connectorId='synthetic-data-'+randomUUID(),connectionBinding=hash(connectorId),scopeId=randomUUID(),sourceId=randomUUID(),expiresAt=new Date(Date.now()+3600000).toISOString(),rowScope={tenant_id:'A',department_id:'d_pay'};
 const initial={authorized:true,version:1,revision:'synthetic-data-policy-1',rowScope,window:{from:'2026-10-12T00:00:00.000Z',until:'2026-10-14T00:00:00.000Z'},rows:goldenEvents};
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_COMPANY_DATA_AUTHORITY',$4,$5,$2::uuid::text,now())",[ctx.tenantId,sourceId,ctx.actorId,runId,JSON.stringify(initial)]);
 const scope:DataScope={id:scopeId,version:1,sourceRevision:initial.revision,templateKey:template.key,templateVersion:template.version,templateHash:dataTemplateHash(template),rowScope,classification:'CONFIDENTIAL',expiresAt,schemaHash:companyDataToolSchemaHash};
 await root.query("INSERT INTO company_data_scopes(tenant_id,id,owner_id,connector_id,connection_binding,template_key,template_version,template_hash,source_revision,tool_schema_hash,contract_hash,readonly_proof_ref,actor_resource_review_ref,row_scope_review_ref,row_scope,window_from,window_until,max_window_ms,classification,model_egress_allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SYNTHETIC_DATA_READONLY_REVIEW','SYNTHETIC_DATA_ACTOR_RESOURCE_REVIEW','SYNTHETIC_DATA_ROW_SCOPE_REVIEW',$12,'2026-10-12T00:00:00Z','2026-10-14T00:00:00Z',86400000,'CONFIDENTIAL',true,$13)",[ctx.tenantId,scopeId,ctx.actorId,connectorId,connectionBinding,template.key,template.version,scope.templateHash,scope.sourceRevision,scope.schemaHash,companyDataContractHash,rowScope,expiresAt]);
 const client=new Client({name:'anthys_synthetic_data',version:'0.1.0'},{capabilities:{}}),server=new Server({name:'synthetic-data-proxy',version:'1.0.0'},{capabilities:{tools:{}}}),[a,b]=InMemoryTransport.createLinkedPair();let initialized=false,lists=0,checks=0,queries=0,queryAttempts=0,attempts=0;
 const modes={paginate:false,noTools:false,drift:false,loop:false,deny:false,queryDeny:false,delayMs:0,queryDelayMs:0,empty:false,truncated:false,sampled:false,observedAt:null as string|null,mutate:null as null|((value:Record<string,unknown>)=>unknown)};
 const requests:{operation:string;nonce:string}[]=[];
 server.oninitialized=()=>{initialized=true;};
 const listHandler=async(req:z.infer<typeof ListToolsRequestSchema>)=>{lists++;if(modes.noTools)return {tools:[]};if(modes.loop)return {tools:[],nextCursor:'same'};if(modes.paginate&&!req.params?.cursor)return {tools:[],nextCursor:'data-page'};return {tools:[modes.drift?{...tool,inputSchema:{type:'object',properties:{dangerous:{type:'string'}}}}:tool]};};
 const callHandler=async(req:z.infer<typeof CallToolRequestSchema>)=>{
  attempts++;if(!initialized||req.params.name!==COMPANY_DATA_TOOL_NAME||!req.params.arguments||Object.keys(req.params.arguments).join(',')!=='message')throw Error('SYNTHETIC_DATA_CALL_INVALID');
  const input=requestSchema.parse(JSON.parse(req.params.arguments['message'] as string)),live=(await root.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0].payload_ref as typeof initial;
  requests.push({operation:input.operation,nonce:input.nonce});
  if(input.operation==='QUERY')queryAttempts++;
  if(modes.deny||modes.queryDeny&&input.operation==='QUERY'||!live.authorized||input.tenantId!==ctx.tenantId||input.actorId!==ctx.actorId||input.scopeId!==scopeId||input.scopeVersion!==live.version||input.sourceRevision!==live.revision)return {isError:true,content:[{type:'text',text:'SYNTHETIC_DATA_PROVIDER_DENIED_PRIVATE_SENTINEL'}]};
  const wire=wireArgumentsSchema.parse(input.args),reference=wire.template;
  if(reference.key!==template.key||reference.version!==template.version||reference.hash!==dataTemplateHash(template))return {isError:true,content:[{type:'text',text:'SYNTHETIC_DATA_TEMPLATE_CHANGED'}]};
  if(wire.definition){const definition=dataTemplateSchema.parse(wire.definition);if(canonical(definition)!==canonical(template)||dataTemplateHash(definition)!==reference.hash)return {isError:true,content:[{type:'text',text:'SYNTHETIC_DATA_DEFINITION_CHANGED'}]};}
  const query=dataQuerySchema.parse({templateKey:reference.key,templateVersion:reference.version,...wire.parameters});
  if(query.start<new Date(live.window.from).toISOString()||query.end>new Date(live.window.until).toISOString())return {isError:true,content:[{type:'text',text:'SYNTHETIC_DATA_WINDOW_DENIED'}]};
  if(modes.delayMs)await new Promise(resolve=>setTimeout(resolve,modes.delayMs));
  if(input.operation==='QUERY'&&modes.queryDelayMs)await new Promise(resolve=>setTimeout(resolve,modes.queryDelayMs));
  const common={contractHash:companyDataContractHash,nonce:input.nonce,tenantId:ctx.tenantId,actorId:ctx.actorId,scopeId,scopeVersion:live.version,sourceRevision:live.revision,template:dataTemplateRef(template),rowScope:live.rowScope};let reply:Record<string,unknown>;
  if(input.operation==='CHECK'){checks++;reply={...common,operation:'CHECK',allowed:true};}
  else{
   const observed=modes.observedAt?new Date(modes.observedAt):(await root.query('SELECT clock_timestamp() observed')).rows[0].observed as Date,aggregate=aggregatePaymentAttempts(modes.empty?[]:live.rows,{start:query.start,end:query.end,tenantId:String(live.rowScope.tenant_id),departmentId:String(live.rowScope.department_id),...(query.channel?{channel:query.channel}:{})});
   queries++;reply={...common,operation:'QUERY',result:{queryId:randomUUID(),window:{start:query.start,end:query.end,interval:'[start,end)'},watermark:observed.toISOString(),observedAt:observed.toISOString(),completeness:modes.sampled?'SAMPLED':modes.truncated?'TRUNCATED':'COMPLETE',metrics:{attempts:aggregate.attempts,successes:aggregate.successes,successRate:aggregate.successRate,byChannel:aggregate.byChannel}}};
  }
  return {content:[{type:'text',text:JSON.stringify(modes.mutate?modes.mutate(reply):reply)}]};
 };
 server.setRequestHandler(ListToolsRequestSchema,listHandler);server.setRequestHandler(CallToolRequestSchema,callHandler);
 await server.connect(b as Transport);await client.connect(a as Transport);
 const httpMethods:string[]=[];const httpFetcher=(expectedToken:string):typeof fetch=>{let ready=false;return async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.href!=='https://data.example/mcp'||new Headers(init?.headers).get('authorization')!=='Bearer '+expectedToken)throw Error('SYNTHETIC_DATA_HTTP_BINDING_INVALID');const body=JSON.parse(init!.body as string);httpMethods.push(body.method);if(body.method==='initialize')return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-data-proxy',version:'1.0.0'}}}),{headers:{'content-type':'application/json'}});if(body.method==='notifications/initialized'){ready=true;return new Response(null,{status:202});}if(!ready)throw Error('SYNTHETIC_DATA_HTTP_NOT_INITIALIZED');const result=body.method==='tools/list'?await listHandler(ListToolsRequestSchema.parse(body)):body.method==='tools/call'?await callHandler(CallToolRequestSchema.parse(body)):null;if(result===null)throw Error('SYNTHETIC_DATA_HTTP_METHOD_INVALID');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});};};
 return {client,server,httpFetcher,httpMethods,templates,template,resource:dataResource(syntheticDataQuery),adapter:new CompanyDataClient(client,connectorId,connectionBinding,COMPANY_DATA_TOOL_NAME,companyDataToolSchemaHash,templates,'INLINE_DEFINITION'),scope,modes,sourceId,requests,counts:()=>({initialized,lists,checks,queries,queryAttempts,attempts}),changeSource:async(change:Partial<typeof initial>)=>{const current=(await root.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0].payload_ref;await root.query('UPDATE outbox SET payload_ref=$2 WHERE id=$1',[sourceId,JSON.stringify({...current,...change})]);},close:async()=>{await client.close();await server.close();}};
}
