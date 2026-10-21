import {syntheticResultContract} from './capability-result-contract.js';
import './isolation.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import type {DbContext} from '../../packages/storage/src/database.js';
import type {RuntimeStore,Lease} from '../../packages/runtime/src/store.js';
import type {FinalClaim} from '../../packages/runtime/src/final-plan.js';
import {toolResultSchema} from '../../packages/contracts/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {secret} from '../../packages/config/src/index.js';
// Explicit synthetic fixtures now emit the actual finalization protocol. This
// helper never changes production model output or manufactures a source result.
export function finalFromMessages(messages:ProviderMessage[]):string{
 const calls=new Map(messages.flatMap(m=>m.tool_calls??[]).map(c=>[c.id,c])),latest=new Map<string,ProviderMessage>();
 for(const message of messages)if(message.role==='tool'){const call=calls.get(message.tool_call_id!);if(call)latest.set(call.function.name+':'+call.function.arguments,message);}
 const claims:FinalClaim[]=[...latest.values()].map(m=>({kind:'STATUS',ref:{kind:'TOOL_CALL',id:m.tool_call_id!},expected:toolResultSchema.parse(JSON.parse(m.content!)).status}));
 for(const message of messages){const marker='STRUCTURED_CHECKPOINT_DATA: ',index=message.content?.indexOf(marker)??-1;if(index<0)continue;const checkpoint=JSON.parse(message.content!.slice(index+marker.length));for(const observation of checkpoint.observations??[])claims.push({kind:'STATUS',ref:{kind:'ACTION',id:observation.actionId},expected:observation.result.status});for(const omitted of checkpoint.omitted??[])if(!checkpoint.observations?.some((o:{actionId:string})=>o.actionId===omitted.actionId))claims.push({kind:'LIMITATION',ref:{kind:'ACTION',id:omitted.actionId},expectedReason:omitted.reason});}
 return JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims,outcome:'COMPLETE'});
}
export async function finalizeRecorded(gateway:Gateway,ctx:DbContext,lease:Lease):Promise<void>{
 const store=gateway.store,rows=(await store.guarded(ctx,lease,c=>c.query("SELECT * FROM tool_actions WHERE run_id=$1 AND state='VERIFIED' ORDER BY created_at,id",[lease.runId]))).rows;
 for(const row of rows){const callId='synthetic-recorded-'+randomUUID(),args=store.openActionInput(ctx,row.logical_action_key as string,row.input_ref),result=(row.result as {ciphertext?:unknown}).ciphertext?store.openToolResult(ctx,row.logical_action_key as string,row.result):toolResultSchema.parse(row.result);await store.append(ctx,lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name:toolName(row.capability_id as string,row.tool_version as string),arguments:JSON.stringify(args)}}]});await store.append(ctx,lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});}
 await gateway.finalize(ctx,lease,finalFromMessages(await store.history(ctx,lease)));
}
export async function finalizeSyntheticText(store:RuntimeStore,ctx:DbContext,lease:Lease,text:string):Promise<Gateway>{
 const group=lease.audience['kind']==='GROUP',gateway=syntheticTextGateway(store,text,group?'MCP':'CORE'),id='synthetic.fixture.text',name=toolName(id,'1.0.0'),callId='synthetic-fixture-'+randomUUID();if(group){const fixtureAdmin=new Database(secret('MIGRATION_DATABASE_URL')!);try{await fixtureAdmin.scope(ctx,async c=>{await c.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{\"synthetic\":true}','synthetic-fixture-text-v1','READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO NOTHING",[ctx.tenantId,randomUUID(),id]);for(const [kind,target,version] of [['PRIVATE_USER',ctx.actorId,null],['GROUP',lease.audience['targetId'],lease.audience['membershipVersion']]])await c.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,membership_version,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RESTRICTED',now()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,id,lease.taskId,kind,target,version]);});}finally{await fixtureAdmin.close();}}const result=await gateway.execute(ctx,lease,name,{},new AbortController().signal);await store.append(ctx,lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:'{}'}}]});await store.append(ctx,lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});await gateway.finalize(ctx,lease,JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/text',expected:text,coverage:'COMPLETE'}],outcome:'COMPLETE'}));return gateway;
}
export function syntheticTextGateway(store:RuntimeStore,text:string,provider:'CORE'|'MCP'='CORE'):Gateway{const gateway=new Gateway(store);gateway.register({...syntheticResultContract,id:'synthetic.fixture.text',version:'1.0.0',description:'Synthetic test-only text source',risk:'READ',provider,schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},state:'READY',bindingHash:'synthetic-fixture-text-v1',resource:(_a,l)=>l.taskId,classifyResult:()=> 'INTERNAL',allowResource:async(_a,_context,_c,cached)=>!cached||(cached as {data?:{text?:string}}).data?.text===text,execute:async()=>({status:'OK',data:{text},evidenceIds:[],completeness:'COMPLETE'})});return gateway;}
