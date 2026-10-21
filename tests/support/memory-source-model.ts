import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {toolName} from '../../packages/gateway/src/index.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import {syntheticRepo,syntheticCommit} from './company-mcp.js';
export function memorySourceModel(){
 const requests:{messages:ProviderMessage[]}[]=[],readName=toolName('company.code.read','1.0.0'),searchName=toolName('company.code.search','1.0.0');
 // Native local SSE drives real Gateway/search/selection/checkpoint persistence.
 // It is an explicit data-flow fixture, not model semantics or enterprise LIVE.
 const provider=new GlmProvider({apiKey:'synthetic-erasure-graph',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const body=JSON.parse(init!.body as string) as typeof requests[number];requests.push(body);const selected=body.messages.findLast(m=>m.role==='user'&&(m.content?.startsWith('AUTHENTICATED_SOURCE_SELECTION')||m.content?.startsWith('SAVED_AUTHENTICATED_SOURCE_SELECTIONS'))),read=body.messages.findLast(m=>m.role==='tool'&&m.tool_call_id==='erasure-selected-read'),searched=body.messages.findLast(m=>m.role==='tool'&&m.tool_call_id==='erasure-source-search');let delta:Record<string,unknown>,finish='stop';
  if(read){delta={role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:'erasure-selected-read'},pointer:'/fragment',expected:JSON.parse(read.content!).data.fragment,coverage:'COMPLETE'}],outcome:'COMPLETE'})};}
  else if(selected){const value=selected.content!.startsWith('SAVED_')?JSON.parse(selected.content!.slice(selected.content!.indexOf('[')))[0]:JSON.parse(selected.content!.slice(selected.content!.indexOf('{')));delta={role:'assistant',tool_calls:[{index:0,id:'erasure-selected-read',type:'function',function:{name:readName,arguments:JSON.stringify(value.args)}}]};finish='tool_calls';}
  else if(searched){delta={role:'assistant',content:JSON.stringify({schemaVersion:1,mode:'SOURCE_CHOICE',text:'',claims:[],outcome:'CLARIFICATION',sourceChoice:{ref:{kind:'TOOL_CALL',id:'erasure-source-search'}}})};}
  else{const system=body.messages[0]!.content!,marker=system.indexOf('FROZEN_PERSONA_STYLE_DATA');if(marker<0)throw Error('ERASURE_GRAPH_PRIVATE_CONTEXT_REQUIRED');const frozen=JSON.parse(system.slice(system.indexOf('{',marker))),keyword=frozen.privatePreferences?.[0]?.content??frozen.fields.address;if(typeof keyword!=='string')throw Error('ERASURE_GRAPH_PRIVATE_SOURCE_REQUIRED');delta={role:'assistant',tool_calls:[{index:0,id:'erasure-source-search',type:'function',function:{name:searchName,arguments:JSON.stringify({repo:syntheticRepo,commit:syntheticCommit,keyword,limit:10})}}]};finish='tool_calls';}
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});return {provider,requests};
}
