import {randomUUID,X509Certificate} from 'node:crypto';
import {getCACertificates} from 'node:tls';
import {describe,it,expect,vi} from 'vitest';
import {startSyntheticAgentHttps,type SyntheticAgentHttps,type SyntheticAgentHttpsOptions} from '../support/company-agent-https.js';
import {connectCompanyAgent,type AgentConnectionPin} from '../../packages/company/src/agent-connection.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {hash} from '../../packages/storage/src/crypto.js';

const reviewedSchema={type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false};
// setDefaultCACertificates parses/deduplicates PEM; compare exact trust anchors by certificate DER, not text spelling.
const caDigest=()=>hash([...new Set(getCACertificates('default').map(pem=>new X509Certificate(pem).fingerprint256))].sort().join('\n'));
function pin(fixture:SyntheticAgentHttps):AgentConnectionPin{return {connectorId:'synthetic-native-https',endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(fixture.endpoint),credentialHash:hash(fixture.token),server:{name:'synthetic-native-https-agent',version:'1.0.0'},toolName:'chat',inputSchemaHash:agentChatInputSchemaHash(reviewedSchema)};}
function context(signal=new AbortController().signal){return {signal,absoluteDeadlineMs:Date.now()+10_000};}
const environment=(fixture:SyntheticAgentHttps)=>({AIDER_AI_DD_CHAT_MCP:fixture.endpoint,AIDER_AI_DD_MCP_TOKEN:fixture.token});
async function withFixture(options:SyntheticAgentHttpsOptions,run:(fixture:SyntheticAgentHttps)=>Promise<void>){
  const before=caDigest(),fixture=await startSyntheticAgentHttps(options);
  try{await run(fixture);}finally{await fixture.close();expect(caDigest()===before).toBe(true);}
}

describe('actual loopback HTTPS MCP through default native fetch (synthetic only)',()=>{
  it('negotiates actual TLS/SDK discovery and receives one unverified answer after more than two seconds',async()=>{
    await withFixture({delayMs:3100,text:'SYNTHETIC native TLS reply; no enterprise fact certified'},async fixture=>{
      const ctx=context(),localRequestId=randomUUID();let prepared=0;
      // Omit fetcher: production code must use global fetch through the existing network guard.
      const connection=await connectCompanyAgent(pin(fixture),ctx,environment(fixture));
      try{
        const started=performance.now(),result=await connection.chat.request({...ctx,localRequestId,message:'SYNTHETIC code/log/data question over loopback TLS',maxWaitMs:10_000,beforeDispatch:async summary=>{expect(summary.localRequestId===localRequestId).toBe(true);prepared++;}});
        expect(result).toMatchObject({status:'RESPONSE_RECEIVED',localRequestId,text:'SYNTHETIC native TLS reply; no enterprise fact certified',source:{protocol:'MCP',toolName:'chat',verification:'UNVERIFIED'}});
        expect(performance.now()-started>=3000).toBe(true);expect(prepared).toBe(1);expect(fixture.callCount()).toBe(1);
        expect(fixture.methods).toEqual(['initialize','notifications/initialized','tools/list','tools/call']);
        expect(connection.usage().bytes>0).toBe(true);expect(connection.usage().chunks>0).toBe(true);
      }finally{await connection.close();}
    });
  },20_000);
  it('rejects a different actual SDK server version over TLS before discovery or business dispatch',async()=>{
    await withFixture({serverVersion:'2.0.0'},async fixture=>{
      await expect(connectCompanyAgent(pin(fixture),context(),environment(fixture))).rejects.toThrow('AGENT_SERVER_CHANGED');
      expect(fixture.methods).toEqual(['initialize','notifications/initialized']);expect(fixture.callCount()).toBe(0);
    });
  },20_000);
  it('rejects actual tools/list schema drift over TLS with NOT_SENT and no host dispatch or tools/call',async()=>{
    const changed={...reviewedSchema,properties:{message:{type:'string'},conversationId:{type:'integer'}}};
    await withFixture({inputSchema:changed},async fixture=>{
      const ctx=context(),connection=await connectCompanyAgent(pin(fixture),ctx,environment(fixture));let prepared=0;
      try{
        const result=await connection.chat.request({...ctx,localRequestId:randomUUID(),message:'SYNTHETIC schema rejection',maxWaitMs:10_000,beforeDispatch:async()=>{prepared++;}});
        expect(result).toMatchObject({status:'NOT_SENT',reason:'SCHEMA_CHANGED'});expect(prepared).toBe(0);expect(fixture.callCount()).toBe(0);
        expect(fixture.methods).toEqual(['initialize','notifications/initialized','tools/list']);
      }finally{await connection.close();}
    });
  },20_000);
  it('aborts a real in-flight TLS call as local UNKNOWN without reasking or claiming remote cancellation',async()=>{
    await withFixture({delayMs:10_000},async fixture=>{
      const controller=new AbortController(),ctx=context(controller.signal),connection=await connectCompanyAgent(pin(fixture),ctx,environment(fixture));let prepared=0;
      try{
        const pending=connection.chat.request({...ctx,localRequestId:randomUUID(),message:'SYNTHETIC local cancellation only',maxWaitMs:10_000,beforeDispatch:async()=>{prepared++;}});
        await vi.waitFor(()=>expect(fixture.callCount()).toBe(1),{timeout:2000,interval:10});controller.abort();
        await expect(pending).resolves.toMatchObject({status:'UNKNOWN',reason:'CANCELLED',remoteCancellation:'UNCONFIRMED',localCancellationRequested:true});
        expect(prepared).toBe(1);expect(fixture.callCount()).toBe(1);expect(fixture.methods.filter(method=>method==='tools/call')).toHaveLength(1);
      }finally{await connection.close();}
    });
  },20_000);
});
