import {finalFromMessages} from './final-answer.js';
import './isolation.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {AgentRuntime} from '../../packages/runtime/src/loop.js';
import {GlmProvider} from '../../packages/provider-glm/src/client.js';
import {checkpointGateway,checkpointWriteName,writeArgs} from './checkpoint-capabilities.js';
const ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).parse(JSON.parse(process.argv[2]!)),runId=z.uuid().parse(process.argv[3]!),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault);let requests=0;
try{
 const model=new GlmProvider({apiKey:'synthetic',baseUrl:'https://open.bigmodel.cn/api/paas/v4',reasoningEffort:'high',fetch:async(_url,init)=>{requests++;const body=JSON.parse(init!.body as string),messages=body.messages as import('../../packages/provider-glm/src/sse.js').ProviderMessage[];
  await db.scope(ctx,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_CP_MODEL_OBSERVATION',$4,$5,$2::uuid::text,now())",[ctx.tenantId,randomUUID(),ctx.actorId,runId,JSON.stringify({hadRawReasoning:messages.some(m=>m.reasoning_content),hadOpaqueSentinel:JSON.stringify(messages).includes('OPAQUE_CHECKPOINT_SENTINEL'),hasStructuredCheckpoint:JSON.stringify(messages).includes('STRUCTURED_CHECKPOINT_DATA'),request:requests})]));
  const delta=requests===1?{tool_calls:[{index:0,id:'cached-write-after-rebuild',type:'function',function:{name:checkpointWriteName,arguments:JSON.stringify(writeArgs)}}]}:{content:finalFromMessages(messages)};return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:requests===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});await new AgentRuntime(store,model,checkpointGateway(store)).advance(ctx,runId);console.log(JSON.stringify({requests,processed:true}));
}finally{await db.close();}
