import {syntheticResultContract} from './capability-result-contract.js';
import {finalFromMessages} from './final-answer.js';
import './isolation.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {RetryDispatcher} from '../../packages/runtime/src/retry.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {RunQueue,runJobSchema} from '../../packages/tasks/src/queue.js';
const mode=process.argv[2]!,ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).parse(JSON.parse(process.argv[3]!)),queueName=process.argv[4]!;
const db=new Database(secret('RUNTIME_DATABASE_URL')!),queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,queueName);await queue.start();
try{if(mode==='dispatch'){console.log(JSON.stringify({dispatched:await new RetryDispatcher(db).dispatch(ctx)}));}
 else if(mode==='publish'){console.log(JSON.stringify({published:await queue.publish(db,ctx)}));}
 else{
  const jobs=await queue.boss.fetch(queueName,{batchSize:1});if(!jobs.length)throw Error('FIXTURE_QUEUE_JOB_MISSING');const job=jobs[0]!,data=runJobSchema.parse(job.data),store=new RuntimeStore(db,new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1')),gateway=new Gateway(store);
  const capability='synthetic.retry.read',name=toolName(capability,'1.0.0');gateway.register({...syntheticResultContract,id:capability,version:'1.0.0',description:'Synthetic isolated retry probe',risk:'READ',provider:'CORE',schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},bindingHash:'synthetic',state:'READY',resource:(_args,lease)=>lease.taskId,execute:async()=>{await db.scope(ctx,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_READ_COUNTER',$4,'{}',$5,now())",[ctx.tenantId,randomUUID(),ctx.actorId,data.runId,randomUUID()]));return {status:'OK',data:'synthetic read',evidenceIds:[],completeness:'COMPLETE'};}});
  const shutdown=new AbortController();for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>shutdown.abort(new Error('SERVICE_SHUTDOWN')));
  const model=new GlmProvider({apiKey:'synthetic-key',baseUrl:'https://open.bigmodel.cn/api/paas/v4',reasoningEffort:'high',fetch:async(_url,init)=>{
   if(mode==='hold'){console.log('MODEL_IN_FLIGHT');await new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));throw Error('UNREACHABLE_HOLD');}
   const state=(await db.scope(ctx,c=>c.query('SELECT retry_attempts FROM runs WHERE id=$1',[data.runId]))).rows[0],request=JSON.parse(init!.body as string) as {messages:import('../../packages/provider-glm/src/sse.js').ProviderMessage[]};
   if(mode!=='success'&&Number(state.retry_attempts)===0)return new Response('',{status:429,headers:{'retry-after':'2'}});
   if(mode!=='success'&&Number(state.retry_attempts)===1&&request.messages.at(-1)?.role==='tool')return new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',{headers:{'content-type':'text/event-stream'}});
   const tools=request.messages.filter(m=>m.role==='tool').length,wantsTool=tools===0||mode!=='success'&&tools<2;
   const delta=wantsTool?{tool_calls:[{index:0,id:'synthetic-call-'+randomUUID(),type:'function',function:{name,arguments:'{}'}}]}:{content:finalFromMessages(request.messages)};
   return new Response('data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason:wantsTool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  await new AgentRuntime(store,model,gateway).advance(ctx,data.runId,undefined,shutdown.signal,data.generation);await queue.boss.complete(queueName,job.id);console.log(JSON.stringify({processed:true,runId:data.runId,generation:data.generation}));
 }
}finally{await queue.stop();await db.close();}
