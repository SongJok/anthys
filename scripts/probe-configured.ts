import {mkdir,writeFile} from 'node:fs/promises';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {GlmProvider} from '../packages/provider-glm/src/client.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {createHash} from 'node:crypto';
loadEnvFile();
// This script is run only after explicit destination-specific approval.
if(process.env['CONFIGURED_PROBE_APPROVED']!=='true') throw Error('EXPLICIT_PROBE_APPROVAL_REQUIRED');
await mkdir('reports/probes',{recursive:true});
const results:{component:string;status:string;detail:string;evidenceRef?:string;errorKind?:string;httpStatus?:number}[]=[];
const apiKey=secret('GLM_API_KEY'),baseUrl=secret('GLM_BASE_URL');
if(apiKey&&baseUrl){
 try{
  if(new URL(baseUrl).origin!=='https://open.bigmodel.cn') throw Error('UNAPPROVED_DESTINATION');
  const model=new GlmProvider({apiKey,baseUrl,reasoningEffort:'high',timeoutMs:30000});
  const r=await model.complete([{role:'user',content:'Reply with exactly open_aider_connectivity_ok. This connection test contains no enterprise data.'}],[],AbortSignal.timeout(35000));
  const report={checkedAt:new Date().toISOString(),environment:'LIVE',status:r.message.content?.trim()==='open_aider_connectivity_ok'?'PASS':'FAIL',scope:'TEXT_SSE_CONNECTIVITY_ONLY',model:'glm-5.3-flash',requestId:r.requestId,usage:r.usage,reasoningReturned:typeof r.message.reasoning_content==='string',reasoningRecorded:false,remaining:['multi-tool loop','cancellation','image','structured output','full model evaluation']};
  const path='reports/probes/glm-connectivity.json';await writeFile(path,JSON.stringify(report,null,2)+'\n');results.push({component:'GLM',status:report.status,detail:report.scope,evidenceRef:path});
 }catch{results.push({component:'GLM',status:'FAIL',detail:'CONNECTION_OR_PROTOCOL_PROBE_FAILED'});}
}else results.push({component:'GLM',status:'BLOCKED_EXTERNAL',detail:'CONFIGURATION_MISSING'});
const clientId=secret('DINGTALK_CLIENT_ID'),clientSecret=secret('DINGTALK_CLIENT_SECRET');
if(clientId&&clientSecret){
 try{
  const r=await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appKey:clientId,appSecret:clientSecret}),signal:AbortSignal.timeout(15000),redirect:'error'});
  const raw=await r.json() as Record<string,unknown>;
  const valid=r.ok&&typeof raw['accessToken']==='string'&&typeof raw['expireIn']==='number';
  results.push({component:'DINGTALK_APP_AUTH',status:valid?'PASS':'FAIL',detail:valid?'TOKEN_EXCHANGE_ONLY_NO_MESSAGES_SENT':'TOKEN_EXCHANGE_REJECTED'});
 }catch{results.push({component:'DINGTALK_APP_AUTH',status:'FAIL',detail:'TOKEN_EXCHANGE_FAILED'});}
}else results.push({component:'DINGTALK_APP_AUTH',status:'BLOCKED_EXTERNAL',detail:'CONFIGURATION_MISSING'});
for(const [label,key] of [['configured-mcp-1','AIDER_AI_DD_MCP'],['configured-mcp-2','AIDER_AI_DD_CHAT_MCP']] as const){
 const endpoint=process.env[key],token=process.env['AIDER_AI_DD_MCP_TOKEN'];
 if(!endpoint){results.push({component:label,status:'BLOCKED_EXTERNAL',detail:'ENDPOINT_MISSING'});continue;}
 let client:Client|undefined;
 try{
  const url=new URL(endpoint);if(url.origin!=='https://dd-agent.tuwan.com') throw Error('UNAPPROVED_DESTINATION');
  const boundFetch:typeof fetch=(input,init={})=>{const target=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(target.origin!==url.origin)throw Error('MCP_ORIGIN_CHANGED');return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(15000)])});};
  const requestInit={headers:token?{authorization:`Bearer ${token}`}:{}};
  client=new Client({name:'open_aider_contract_probe',version:'0.1.0'},{capabilities:{}});
  const transport=url.pathname.endsWith('/sse')?new SSEClientTransport(url,{requestInit,fetch:boundFetch}):new StreamableHTTPClientTransport(url,{requestInit,fetch:boundFetch});
  // SDK 1.32.1 declares sessionId as string|undefined on the implementation but optional string on its own Transport interface. Runtime methods are the same; keep strict project settings.
  await client.connect(transport as Transport);let cursor:string|undefined,complete=false;const tools:unknown[]=[],cursors=new Set<string>();
  for(let page=0;page<10;page++){
   const r=await client.listTools(cursor?{cursor}:{});tools.push(...r.tools.map(t=>({name:t.name,inputSchema:t.inputSchema,...(t.annotations?{annotations:t.annotations}:{})})));cursor=r.nextCursor;
   if(!cursor){complete=true;break;}if(cursors.has(cursor))throw Error('PAGINATION_LOOP');cursors.add(cursor);
  }
  const raw=JSON.stringify(tools);if(token&&raw.includes(token))throw Error('PROVIDER_ECHOED_SECRET');
  const path=`reports/probes/${label}-tools.json`;
  await writeFile(path,JSON.stringify({checkedAt:new Date().toISOString(),environment:'LIVE',status:complete?'PASS':'PARTIAL',scope:'INITIALIZE_AND_TOOLS_DISCOVERY_ONLY',serverVersion:client.getServerVersion(),schemaHash:createHash('sha256').update(raw).digest('hex'),complete,tools,businessCalls:0,companyCodeLogMapping:'UNVERIFIED',reviewRequired:true},null,2)+'\n');
  results.push({component:label,status:complete?'PASS':'PARTIAL',detail:`DISCOVERY_ONLY: ${tools.length} tools; no business calls`,evidenceRef:path});
 }catch(error){const e=error as {name?:unknown;code?:unknown};results.push({component:label,status:'FAIL',detail:'INITIALIZE_OR_TOOLS_DISCOVERY_FAILED',...(typeof e.name==='string'&&/^[A-Za-z]+Error$/.test(e.name)?{errorKind:e.name}:{}),...(typeof e.code==='number'?{httpStatus:e.code}:{})});}finally{await client?.close().catch(()=>{});}
}
await writeFile('reports/probes/configured-summary.json',JSON.stringify({checkedAt:new Date().toISOString(),environment:'LIVE',results},null,2)+'\n');console.log(JSON.stringify(results,null,2));if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
