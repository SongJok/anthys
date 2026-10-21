import {syntheticResultContract} from './capability-result-contract.js';
import './isolation.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
const [mode,subject,runId]=process.argv.slice(2),ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).parse(JSON.parse(subject!)),run=z.uuid().parse(runId),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault),gateway=new Gateway(store),name=toolName('synthetic.final.source','1.0.0');let requests=0;
gateway.register({...syntheticResultContract,id:'synthetic.final.source',version:'1.0.0',description:'Synthetic restart finalization source',risk:'READ',provider:'MCP',bindingHash:'synthetic-final-source-v1',state:'READY',protectResult:true,schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},resource:(_a,l)=>l.taskId,allowResource:async(_a,{lease},c,cached)=>{const row=(await c.query("SELECT payload_ref FROM outbox WHERE aggregate_id=$1 AND kind='SYNTHETIC_FINAL_SOURCE'",[lease.runId])).rows[0];if(!row)return false;const data=(cached as {data?:{sourceHash?:string}}|null)?.data;return data?data.sourceHash===hash(JSON.stringify(row.payload_ref)):true;},execute:async(_a,{principal,lease})=>db.scope(principal,async c=>{const data=(await c.query("SELECT payload_ref FROM outbox WHERE aggregate_id=$1 AND kind='SYNTHETIC_FINAL_SOURCE'",[lease.runId])).rows[0].payload_ref;await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_FINAL_PROCESS_READ',$4,'{}',$2::uuid::text,now())",[ctx.tenantId,randomUUID(),ctx.actorId,run]);return {status:'OK',data:{...data,sourceHash:hash(JSON.stringify(data))},evidenceIds:[],completeness:'COMPLETE'};})});
try{
 const model=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn',reasoningEffort:'high',fetch:async(_url,init)=>{requests++;const messages=(JSON.parse(init!.body as string) as {messages:ProviderMessage[]}).messages,source=messages.filter(m=>m.role==='tool').at(-1),feedback=messages.some(m=>m.role==='system'&&m.content?.startsWith('FINAL_VALIDATION_REJECTED:'));
  if(mode==='hold'&&feedback){console.log('FINAL_REPAIR_FEEDBACK_DURABLE');await new Promise<void>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));}
  const delta=!source?{tool_calls:[{index:0,id:'synthetic-final-process-'+randomUUID(),type:'function',function:{name,arguments:'{}'}}]}:mode==='hold'?{content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'FALSE_NARRATIVE_DRAFT_SENTINEL',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:source.tool_call_id},pointer:'/value',expected:6,coverage:'COMPLETE'}],outcome:'COMPLETE'}),reasoning_content:'OPAQUE_REJECTED_DRAFT_SENTINEL'}:{content:JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:source.tool_call_id},pointer:'/value',expected:6,coverage:'COMPLETE'}],outcome:'COMPLETE'})};return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:source?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});await new AgentRuntime(store,model,gateway).advance(ctx,run);console.log(JSON.stringify({requests,processed:true}));
}finally{await db.close();}
