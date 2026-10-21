import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {REVIEW_PROMPT} from '../../packages/runtime/src/narrative-review.js';
import type {PersonaRequest} from './persona-model.js';
export function memoryModel(){
 const requests:PersonaRequest[]=[],control:{beforeGeneration:((request:PersonaRequest)=>Promise<void>)|null}={beforeGeneration:null};
 // Explicit synthetic SSE proves actual source/data flow, not model semantics.
 const provider=new GlmProvider({apiKey:'synthetic-memory-provider',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const request=JSON.parse(init!.body as string) as PersonaRequest;requests.push(request);let content:string;
  if(request.messages[0]?.content===REVIEW_PROMPT)content=JSON.stringify({schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]});
  else{if(control.beforeGeneration)await control.beforeGeneration(request);const text=request.messages[0]?.content??'',start=text.indexOf('FROZEN_PERSONA_STYLE_DATA'),data=start<0?null:JSON.parse(text.slice(text.indexOf('{',start))) as {privatePreferences?:{content:string}[]};content=JSON.stringify({schemaVersion:1,mode:'CONVERSATION',text:data?.privatePreferences?.map(x=>x.content).join('；')||'当前请求没有可使用的个人长期偏好。',claims:[],outcome:'COMPLETE'});}
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});return {provider,requests,control};
}
