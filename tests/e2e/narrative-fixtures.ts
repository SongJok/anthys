import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type {Database} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {REVIEW_PROMPT} from '../../packages/runtime/src/narrative-review.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
export async function browserNarratives(db:Database,vault:Vault,tenantId:string,actorId:string){
 const ctx={tenantId,actorId},store=new RuntimeStore(db,vault),gateway=new Gateway(store),fixtures:Record<string,{taskId:string;runId:string;goal:string;question:string;answer:string}>={};
 const provider=new GlmProvider({apiKey:'synthetic-browser-narrative',baseUrl:'https://synthetic.invalid',reasoningEffort:'high',fetch:async(_url,init)=>{const request=JSON.parse(init!.body as string) as {messages:ProviderMessage[]},review=request.messages[0]?.content===REVIEW_PROMPT,answered=request.messages.some(m=>m.role==='user'&&m.content==='第一个');let content:string;if(review){const input=JSON.parse(request.messages[1]!.content!),question=input.proposal.mode==='CLARIFICATION';content=JSON.stringify({schemaVersion:1,verdict:question?'CLARIFICATION':'GENERAL',relevant:true,fulfillsGoal:!question,requiresTools:question,isQuestion:question,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]});}else content=JSON.stringify({schemaVersion:1,mode:answered?'CONVERSATION':'CLARIFICATION',text:answered?'欢迎参加技术分享，一起交流实现与验证经验。':'选择用途：1. 技术分享；2. 项目复盘？',claims:[],outcome:answered?'COMPLETE':'CLARIFICATION'});return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
 for(const project of ['desktop','mobile']){const goal='准备邀请草稿 '+project,task=await new TaskStore(db).create(ctx,goal,randomUUID());await new AgentRuntime(store,provider,gateway).advance(ctx,task.runId);fixtures[project]={...task,goal,question:'选择用途：1. 技术分享；2. 项目复盘？',answer:'欢迎参加技术分享，一起交流实现与验证经验。'};}
 await writeFile('.data/test-environment/browser-narrative-fixtures.json',JSON.stringify(fixtures),{mode:0o600});
 let pending:Promise<void>|null=null;const timer=setInterval(()=>{if(pending)return;pending=(async()=>{for(const f of Object.values(fixtures)){const state=(await db.scope(ctx,c=>c.query('SELECT status,retry_generation FROM runs WHERE id=$1',[f.runId]))).rows[0];if(state.status==='QUEUED')await new AgentRuntime(store,provider,gateway).advance(ctx,f.runId,undefined,undefined,Number(state.retry_generation));}})().finally(()=>{pending=null;});},100);timer.unref();
 return {close:async()=>{clearInterval(timer);await pending;}};
}
