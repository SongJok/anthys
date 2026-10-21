import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import {CompanyAgentChat} from './agent-chat.js';
import {boundedAgentFetch,AgentTransportError} from './agent-transport.js';

export const DEFAULT_AGENT_ENDPOINT_KEY='AIDER_AI_DD_CHAT_MCP' as const;
export const agentConnectionPinSchema=z.object({
 connectorId:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
 endpointKey:z.enum(['AIDER_AI_DD_MCP','AIDER_AI_DD_CHAT_MCP']).default(DEFAULT_AGENT_ENDPOINT_KEY),
 endpointHash:z.string().regex(/^[a-f0-9]{64}$/),credentialHash:z.string().regex(/^[a-f0-9]{64}$/),
 server:z.object({name:z.string().min(1).max(256),version:z.string().min(1).max(128)}).strict(),
 toolName:z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),inputSchemaHash:z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type AgentConnectionPin=z.infer<typeof agentConnectionPinSchema>;
/** A default selects only a configuration key, never another server or a grant. */
export function companyAgentEndpoint(pin:Pick<AgentConnectionPin,'endpointKey'>,env:NodeJS.ProcessEnv){const endpoint=env[pin.endpointKey];if(!endpoint)throw new AgentTransportError('AGENT_CONNECTION_MISSING_'+pin.endpointKey);return endpoint;}
/** No environment load or connection at import time. The host supplies its
 * independently reviewed pin and explicit request deadline after admission. */
export async function connectCompanyAgent(pin:AgentConnectionPin,context:{signal:AbortSignal;absoluteDeadlineMs:number},env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
 const reviewed=agentConnectionPinSchema.parse(pin),endpoint=companyAgentEndpoint(reviewed,env),token=env['AIDER_AI_DD_MCP_TOKEN'];
 if(!endpoint||hash(endpoint)!==reviewed.endpointHash||!token||token.length<16||token.length>8192||/[\u0000-\u0020\u007f]/.test(token)||hash(token)!==reviewed.credentialHash)throw new AgentTransportError('AGENT_CONNECTION_CONFIGURATION_CHANGED');
 const connecting=new AbortController(),connectionDeadline=Math.min(context.absoluteDeadlineMs,Date.now()+2000);
 const bound=boundedAgentFetch(endpoint,AbortSignal.any([context.signal,connecting.signal]),{absoluteDeadlineMs:context.absoluteDeadlineMs},fetcher);
 const connectionTimer=setTimeout(()=>connecting.abort(),2000);connectionTimer.unref();
 // The text-only contract has no reviewed output schema. SDK listTools caches
 // and compiles advertised output schemas before returning to our adapter;
 // refuse them through the public validator hook, before any untrusted AJV
 // compilation/regular-expression execution can block deadline timers.
 const client=new Client({name:'open_aider_company_agent',version:'0.1.0'},{capabilities:{},jsonSchemaValidator:{getValidator(){throw new AgentTransportError('AGENT_OUTPUT_SCHEMA_UNREVIEWED');}}});
 // A fresh SDK transport belongs to one local request. No old MCP session,
 // conversation, retry or GET/SSE reconnection is used to recover a lost call.
 const transport=new StreamableHTTPClientTransport(new URL(endpoint),{fetch:bound.fetch,requestInit:{headers:{authorization:'Bearer '+token}},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1,maxReconnectionDelay:1,reconnectionDelayGrowFactor:1}});
 const close=async()=>{bound.close();await client.close().catch(()=>{});};
 try{
  const timeout=Math.max(1,Math.min(2000,context.absoluteDeadlineMs-Date.now()));
  await client.connect(transport as Transport,{timeout,maxTotalTimeout:timeout,resetTimeoutOnProgress:false,signal:bound.signal});
  const actual=client.getServerVersion();if(actual?.name!==reviewed.server.name||actual.version!==reviewed.server.version||!client.getServerCapabilities()?.tools)throw new AgentTransportError('AGENT_SERVER_CHANGED');
  context.signal.throwIfAborted();if(connecting.signal.aborted||Date.now()>=connectionDeadline)throw new AgentTransportError('AGENT_CONNECTION_TIMEOUT');if(Date.now()>=context.absoluteDeadlineMs)throw new AgentTransportError('AGENT_ABSOLUTE_DEADLINE');
  return {chat:new CompanyAgentChat(client,{toolName:reviewed.toolName,inputSchemaHash:reviewed.inputSchemaHash}),close,usage:bound.usage};
 }catch(error){await close();throw new AgentTransportError(connecting.signal.aborted&&!context.signal.aborted?'AGENT_CONNECTION_TIMEOUT':error instanceof AgentTransportError?error.code:'AGENT_CONNECTION_UNAVAILABLE');}
 finally{clearTimeout(connectionTimer);}
}
