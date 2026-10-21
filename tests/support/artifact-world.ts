import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {syntheticResultContract} from './capability-result-contract.js';
import type {groupReminderDatabase} from './group-reminder-database.js';
import type {Sessions} from '../../packages/identity/src/sessions.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {toolName,type Gateway,type Capability} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
const signal=()=>new AbortController().signal;
export async function artifactWorld(deps:{isolated:Awaited<ReturnType<typeof groupReminderDatabase>>;store:RuntimeStore;gateway:Gateway;sessions:Sessions},origin:string,options:{finalize?:boolean}={}){
 const {isolated,store,gateway,sessions}=deps;
 const root=isolated.root,ctx={tenantId:randomUUID(),actorId:randomUUID()},foreign={tenantId:ctx.tenantId,actorId:randomUUID()};
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'SYNTHETIC ARTIFACT','ACTIVE')",[ctx.tenantId]);
 for(const actor of [ctx,foreign])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'SYNTHETIC','ACTIVE')",[ctx.tenantId,actor.actorId]);
 const owner=await sessions.create(ctx),other=await sessions.create(foreign),principal=(await sessions.authenticate(owner.cookie))!;
 const task=await new TaskStore(isolated.db).create(ctx,'Read the exact synthetic value','synthetic-task-'+randomUUID()),runId=task.runId,lease=(await store.acquire(ctx,runId,'synthetic-artifact'))!;
 const sourceId=randomUUID(),capId='synthetic.artifact.'+randomUUID(),bindingHash=hash(capId),callId='call-'+randomUUID(),name=toolName(capId,'1.0.0'),value='900719925474099312345.000000000000000000001';let calls=0,sourceGate:()=>Promise<void>=async()=>{};
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_ARTIFACT_SOURCE',$4,$5,$2::uuid::text,now())",[ctx.tenantId,sourceId,ctx.actorId,runId,JSON.stringify({value})]);
 const cap:Capability={...syntheticResultContract,id:capId,version:'1.0.0',description:'Synthetic private artifact source',risk:'READ',provider:'MCP',bindingHash,state:'READY',protectResult:true,schema:z.object({}).strict(),jsonSchema:{type:'object',properties:{},additionalProperties:false},resource:()=>task.taskId,allowResource:async(_args,_context,c,cached)=>{const r=(await c.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0];const allowed=!!r&&(!cached||(cached as {data:{sourceHash:string}}).data.sourceHash===hash(JSON.stringify(r.payload_ref)));await sourceGate();return allowed;},execute:async()=>{calls++;const data=(await root.query('SELECT payload_ref FROM outbox WHERE id=$1',[sourceId])).rows[0].payload_ref;return {status:'OK',data:{...data,sourceHash:hash(JSON.stringify(data))},evidenceIds:[sourceId],completeness:'COMPLETE'};}};
 gateway.register(cap);await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0','{}',$4,'READ','READY')",[ctx.tenantId,randomUUID(),capId,bindingHash]);
 await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'RESTRICTED',clock_timestamp()+interval '1 hour')",[ctx.tenantId,randomUUID(),ctx.actorId,capId,task.taskId]);
 const result=await gateway.execute(ctx,lease,name,{},signal());assert.equal(result.status,'OK');
 await store.append(ctx,lease,{role:'system',content:'Synthetic artifact fixture'});await store.append(ctx,lease,{role:'user',content:lease.goal});await store.append(ctx,lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:'{}'}}]});await store.append(ctx,lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});
 if(options.finalize!==false)await gateway.finalize(ctx,lease,JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/value',expected:value,coverage:'COMPLETE'}],outcome:'COMPLETE'}));
 if(options.finalize!==false){const row=(await root.query('SELECT status,result FROM runs WHERE id=$1',[runId])).rows[0];assert.equal(row.status,'SUCCEEDED');assert.equal(await gateway.finalResultAllowed(ctx,runId,row.result),true);}
 const request=(path:string,options:{method?:string;body?:unknown;key?:string;ticket?:string;session?:typeof owner;csrf?:boolean}={})=>fetch(origin+path,{method:options.method??'GET',headers:{cookie:'oa_session='+(options.session??owner).cookie,...(options.method==='POST'?{origin,'content-type':'application/json',...(options.csrf===false?{}:{'x-csrf-token':(options.session??owner).csrf})}:{}),...(options.key?{'idempotency-key':options.key}:{}),...(options.ticket?{'x-artifact-download-ticket':options.ticket}:{})},...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})});
 const create=(format='txt',key=randomUUID())=>request(`/api/v1/tasks/${task.taskId}/artifacts`,{method:'POST',body:{runId,format},key});
 const ticket=async(id:string)=>{const response=await request(`/api/v1/artifacts/${id}/download-ticket`,{method:'POST',body:{}});assert.equal(response.status,200);return (await response.json()).data as {ticket:string;expiresAt:string;artifactId:string;sha256:string;byteSize:number};};
 return {ctx,foreign,owner,other,principal,lease,sourceResult:result,sourceCallId:callId,sourceToolName:name,...task,sourceId,capId,cap,value,request,create,ticket,calls:()=>calls,setSourceGate:(hook:()=>Promise<void>)=>{sourceGate=hook;}};
}
