import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {REVIEW_PROMPT} from '../../packages/runtime/src/narrative-review.js';
import type {PersonaRequest} from './persona-model.js';

// Explicit synthetic SSE drives native clarification/review persistence.
// Echoing the private canary is adversarial data-flow instrumentation, not a
// claim about GLM semantics or an approved business disclosure.
export function memoryDialogueModel() {
 const requests:PersonaRequest[]=[];
 let generations=0;
 const provider=new GlmProvider({apiKey:'synthetic-erasure-dialogue',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{
  const request=JSON.parse(init!.body as string) as PersonaRequest;
  requests.push(request);
  let content:string;
  if(request.messages[0]?.content===REVIEW_PROMPT) {
   const input=JSON.parse(request.messages[1]!.content!);
   const question=input.proposal.mode==='CLARIFICATION';
   content=JSON.stringify({schemaVersion:1,verdict:question?'CLARIFICATION':'GENERAL',relevant:true,fulfillsGoal:!question,requiresTools:question,isQuestion:question,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]});
  } else {
   const system=request.messages[0]!.content!,marker=system.indexOf('FROZEN_PERSONA_STYLE_DATA');
   if(marker<0)throw Error('DIALOGUE_PRIVATE_CONTEXT_REQUIRED');
   const frozen=JSON.parse(system.slice(system.indexOf('{',marker)));
   const canary=frozen.privatePreferences?.[0]?.content??frozen.fields.address;
   if(typeof canary!=='string')throw Error('DIALOGUE_PRIVATE_SOURCE_REQUIRED');
   const question=generations++===0;
   content=JSON.stringify({schemaVersion:1,mode:question?'CLARIFICATION':'CONVERSATION',text:question?canary+'：邀请用于什么场合？':canary+'：邀请你参加内部技术交流，共同讨论实现和验证。',claims:[],outcome:question?'CLARIFICATION':'COMPLETE'});
  }
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 return {provider,requests};
}
