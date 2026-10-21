import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import fc from 'fast-check';
import pg from 'pg';
import {createServer,type Server} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {RuntimeStore,LeaseLost} from '../../packages/runtime/src/store.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {Gateway,toolName,canonical,type Capability} from '../../packages/gateway/src/index.js';
import {approveViaApi} from '../support/approval.js';
import {referenceAuthorization,type AuthorizationCase} from '../support/gateway-authorization-oracle.js';

const seed=20261016,total=10000,workers=4;
const mostlyTrue=fc.integer({min:0,max:9}).map(n=>n<9);
function preferred<T>(first:T,...others:T[]){return fc.oneof({weight:8,arbitrary:fc.constant(first)},{weight:2,arbitrary:fc.constantFrom(...others)});}
const arbitrary=fc.record({actor:preferred('OWNER' as const,'OTHER_ACTOR','OTHER_TENANT'),identityActive:mostlyTrue,epochCurrent:mostlyTrue,registry:preferred('READY' as const,'UNVERIFIED','DISABLED'),binding:preferred('READY' as const,'DISABLED','WRONG_HASH','WRONG_RISK','WRONG_VERSION','MISSING'),grant:preferred('VALID' as const,'REVOKED','EXPIRED','FOREIGN_ACTOR','FOREIGN_TENANT','WRONG_CAPABILITY','WRONG_RESOURCE','MISSING'),grantAudience:preferred('SELF' as const,'OTHER','GROUP'),taskAudience:preferred('SELF' as const,'OTHER','GROUP','NAMED_USERS'),sourceOwned:mostlyTrue,notCancelled:mostlyTrue,notExpired:mostlyTrue,quotaAvailable:mostlyTrue,killed:mostlyTrue.map(b=>!b),validArguments:mostlyTrue,risk:fc.oneof({weight:5,arbitrary:fc.constant('READ' as const)},{weight:4,arbitrary:fc.constantFrom('PERSONAL_WRITE' as const,'SHARED_WRITE' as const,'SENSITIVE' as const)},{weight:1,arbitrary:fc.constant('FORBIDDEN' as const)}),requestApproval:fc.boolean()});
type Counts={read:number;write:number;verify:number};
type Row={index:number;facts:AuthorizationCase;actorId:string;resourceId:string;expected:'ALLOW'|'DENY';actual:string;requests:Counts};
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!,max:8}),runtime=new Database(secret('RUNTIME_DATABASE_URL')!,16),appDb=new Database(secret('DATABASE_URL')!,12),store=new RuntimeStore(runtime,new Vault(new Map([['1',randomBytes(32)]]),'1')),tasks=new TaskStore(appDb);
let server:Server|undefined;
afterAll(async()=>{if(server?.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));}await runtime.close();await appDb.close();await root.end();});

it('T036 actual Gateway matches an independent oracle for 10000 subject/resource/delegation combinations with zero denied provider effects',async()=>{
 const primary=randomUUID(),foreign=randomUUID(),fixtureKey=randomBytes(32).toString('hex'),cases=fc.sample(arbitrary,{seed,numRuns:total}) as AuthorizationCase[],requests=new Map<number,Counts>(),rows:Row[]=[],serverErrors:string[]=[];
 for(const tenant of [primary,foreign])await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$1::uuid::text,'synthetic Gateway matrix','ACTIVE')",[tenant]);
 server=createServer((req,res)=>{void (async()=>{
  if(req.headers['x-synthetic-fixture-key']!==fixtureKey){res.writeHead(401).end();return;}
  const path=new URL(req.url!,'http://127.0.0.1:52339'),index=Number(req.headers['x-case-index']),ctx={tenantId:String(req.headers['x-tenant-id']),actorId:String(req.headers['x-actor-id'])};
  if(!Number.isInteger(index)||index<0||index>=total||![primary,foreign].some(t=>t===ctx.tenantId)||!z.uuid().safeParse(ctx.actorId).success)throw Error('INVALID_SYNTHETIC_PROVIDER_REQUEST');
  const count=requests.get(index)??{read:0,write:0,verify:0};requests.set(index,count);
  if(path.pathname.startsWith('/receipts/')){
   count.verify++;const receipt=path.pathname.slice('/receipts/'.length);z.uuid().parse(receipt);const found=await appDb.scope(ctx,c=>c.query("SELECT id FROM outbox WHERE id=$1 AND owner_id=$2 AND kind='SYNTHETIC_MATRIX_WRITE'",[receipt,ctx.actorId]));res.writeHead(found.rowCount?200:403,{'content-type':'application/json'}).end(JSON.stringify({verified:found.rowCount===1,receiptId:receipt}));return;
  }
  const resource=path.pathname.slice('/sources/'.length);z.uuid().parse(resource);if(req.method==='GET')count.read++;else if(req.method==='POST')count.write++;else throw Error('INVALID_SYNTHETIC_PROVIDER_METHOD');
  const result=await appDb.scope(ctx,async c=>{
   // An independent source owner in actual RLS tables; local resource grants
   // cannot substitute for ownership at this provider.
   const source=await c.query("SELECT payload_ref FROM outbox WHERE id=$1 AND owner_id=$2 AND kind='SYNTHETIC_MATRIX_SOURCE'",[resource,ctx.actorId]);if(!source.rowCount)return null;
   const receiptId=randomUUID(),kind=req.method==='GET'?'SYNTHETIC_MATRIX_READ':'SYNTHETIC_MATRIX_WRITE';
   await c.query('INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',[ctx.tenantId,receiptId,ctx.actorId,kind,resource,JSON.stringify({caseIndex:index,sourceId:resource,value:source.rows[0].payload_ref}),receiptId]);return {receiptId,value:source.rows[0].payload_ref};
  });res.writeHead(result?200:403,{'content-type':'application/json'}).end(JSON.stringify(result??{error:'SOURCE_DENIED'}));
 })().catch(error=>{serverErrors.push((error as Error).name);if(!res.headersSent)res.writeHead(500);res.end();});});
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(52339,'127.0.0.1',resolve);});
 let next=0,completed=0,approvals=0;
 async function one(index:number){
  const facts=cases[index]!,actorId=randomUUID(),other=randomUUID(),resourceId=randomUUID(),ctx:DbContext={tenantId:primary,actorId},capabilityId='synthetic.matrix.'+index,bindingHash=hash(capabilityId),resource='synthetic-source:'+resourceId;
  for(const tenant of [primary,foreign])await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic matrix owner','ACTIVE'),($1,$3,$3::uuid::text,'synthetic matrix other','ACTIVE')",[tenant,actorId,other]);
  await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_MATRIX_SOURCE',$2,$4,$2::uuid::text,now())",[primary,resourceId,facts.sourceOwned?actorId:other,JSON.stringify({caseIndex:index,marker:'SYNTHETIC_SOURCE_'+index})]);
  if(facts.binding!=='MISSING')await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,$4,'{}',$5,$6,$7)",[primary,randomUUID(),capabilityId,facts.binding==='WRONG_VERSION'?'1.0.1':'1.0.0',facts.binding==='WRONG_HASH'?hash('foreign:'+capabilityId):bindingHash,facts.binding==='WRONG_RISK'?(facts.risk==='READ'?'SHARED_WRITE':'READ'):facts.risk,facts.binding==='DISABLED'?'DISABLED':'READY']);
  if(facts.grant!=='MISSING')await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,membership_version,classification_ceiling,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,'INTERNAL',clock_timestamp()+$8::interval,CASE WHEN $9 THEN clock_timestamp() ELSE NULL END)",[facts.grant==='FOREIGN_TENANT'?foreign:primary,randomUUID(),facts.grant==='FOREIGN_ACTOR'?other:actorId,facts.grant==='WRONG_CAPABILITY'?capabilityId+'.foreign':capabilityId,facts.grant==='WRONG_RESOURCE'?'foreign:'+resource:resource,facts.grantAudience==='GROUP'?'GROUP':'PRIVATE_USER',facts.grantAudience==='SELF'?actorId:other,facts.grant==='EXPIRED'?'-1 hour':'1 hour',facts.grant==='REVOKED']);
  const task=await tasks.create(ctx,'synthetic matrix '+index,randomUUID());
  if(facts.taskAudience!=='SELF')await root.query('UPDATE tasks SET audience=$2 WHERE id=$1',[task.taskId,JSON.stringify({kind:facts.taskAudience==='OTHER'?'PRIVATE_USER':facts.taskAudience,targetId:other,classificationCeiling:'INTERNAL',...(facts.taskAudience==='GROUP'?{membershipVersion:1}:{})})]);
  let lease=(await store.acquire(ctx,task.runId,'matrix-'+index))!;expect(lease,'fixture must obtain a genuine lease before revocation').not.toBeNull();
  if(!facts.notCancelled)await tasks.cancel(ctx,task.taskId);
  if(!facts.notExpired)await root.query("UPDATE tasks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[task.taskId]);
  if(!facts.identityActive||!facts.epochCurrent)await root.query("UPDATE users SET status=CASE WHEN $3 THEN status ELSE 'DEPARTED' END,auth_epoch=auth_epoch+CASE WHEN $4 THEN 0 ELSE 1 END WHERE tenant_id=$1 AND id=$2",[primary,actorId,facts.identityActive,facts.epochCurrent]);
  if(!facts.quotaAvailable)await root.query('UPDATE runs SET tool_calls=$2 WHERE id=$1',[task.runId,lease.maxTools]);
  if(facts.killed)await root.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash) VALUES($1,$2,$3,'TASK',$4,'ALL',true,$5)",[primary,randomUUID(),actorId,task.taskId,hash('synthetic matrix stop')]);
  const gateway=new Gateway(store),cap:Capability={...syntheticResultContract,id:capabilityId,version:'1.0.0',description:'Synthetic authorization matrix provider',risk:facts.risk,provider:'MCP',state:facts.registry,bindingHash,jsonSchema:{type:'object',properties:{sourceId:{type:'string'},caseIndex:{type:'integer'}},required:['sourceId','caseIndex'],additionalProperties:false},schema:z.object({sourceId:z.uuid(),caseIndex:z.number().int()}).strict(),resource:a=>'synthetic-source:'+(a as {sourceId:string}).sourceId,approvalPreview:()=>({operation:'Synthetic isolated source operation'}),operationAudience:(_a,l)=>l.audience,
   allowResource:async(a,{principal},c)=>!!(await c.query("SELECT id FROM outbox WHERE id=$1 AND owner_id=$2 AND kind='SYNTHETIC_MATRIX_SOURCE'",[(a as {sourceId:string}).sourceId,principal.actorId])).rowCount,
   execute:async(a,{principal,signal})=>{const response=await fetch('http://127.0.0.1:52339/sources/'+(a as {sourceId:string}).sourceId,{method:facts.risk==='READ'?'GET':'POST',headers:{'x-synthetic-fixture-key':fixtureKey,'x-case-index':String(index),'x-tenant-id':principal.tenantId,'x-actor-id':principal.actorId},signal});if(!response.ok)throw Error('SYNTHETIC_SOURCE_REJECTED');const data=await response.json() as {receiptId:string;value:unknown};return {status:'OK',data,evidenceIds:[data.receiptId],completeness:'COMPLETE'};},
   verify:async(result,_a,{principal,signal})=>{const receipt=(result.data as {receiptId:string}).receiptId,response=await fetch('http://127.0.0.1:52339/receipts/'+receipt,{headers:{'x-synthetic-fixture-key':fixtureKey,'x-case-index':String(index),'x-tenant-id':principal.tenantId,'x-actor-id':principal.actorId},signal}),check=await response.json() as {verified:boolean;receiptId:string};return {...result,verification:{state:response.ok&&check.verified&&check.receiptId===receipt?'VERIFIED':'MISMATCH',method:'SYNTHETIC_POSTGRES_PROVIDER_READ_BACK'}};}
  };gateway.register(cap);
  const invocation=facts.actor==='OTHER_TENANT'?{tenantId:foreign,actorId}:facts.actor==='OTHER_ACTOR'?{tenantId:primary,actorId:other}:ctx,args={sourceId:resourceId,caseIndex:index,...(!facts.validArguments?{actorId:other}:{})};
  let actual:string;
  try{let result=await gateway.execute(invocation,lease,toolName(capabilityId,'1.0.0'),args,AbortSignal.timeout(10000));if(result.status==='NEEDS_APPROVAL'&&facts.requestApproval){const action=(await root.query('SELECT id FROM tool_actions WHERE run_id=$1',[task.runId])).rows[0];lease=await approveViaApi(root,appDb,store,ctx,action.id as string,other);approvals++;result=await gateway.execute(invocation,lease,toolName(capabilityId,'1.0.0'),args,AbortSignal.timeout(10000));}actual=result.status;if(actual==='OK'&&facts.risk!=='READ')expect(result.verification?.state).toBe('VERIFIED');}
  catch(error){if(!(error instanceof LeaseLost))throw error;actual='LEASE_REJECTED';}
  const expected=referenceAuthorization(facts),count=requests.get(index)??{read:0,write:0,verify:0};rows[index]={index,facts,actorId,resourceId,expected:expected?'ALLOW':'DENY',actual,requests:{...count}};
  expect(actual==='OK',JSON.stringify({index,facts,actual})).toBe(expected);
  expect(count,JSON.stringify({index,facts,actual})).toEqual(expected?(facts.risk==='READ'?{read:1,write:0,verify:0}:{read:0,write:1,verify:1}):{read:0,write:0,verify:0});
  completed++;if(completed%1000===0)await writeFile('.data/test-environment/gateway-matrix-progress.json',JSON.stringify({completed,total,seed,live:false}),{mode:0o600});
 }
 const outcomes=await Promise.allSettled(Array.from({length:workers},async()=>{while(next<total){const index=next++;await one(index);}})),failure=outcomes.find(r=>r.status==='rejected');
 const persisted=(await root.query("SELECT owner_id,kind,count(*)::int count FROM outbox WHERE tenant_id=$1 AND kind IN ('SYNTHETIC_MATRIX_READ','SYNTHETIC_MATRIX_WRITE') GROUP BY owner_id,kind",[primary])).rows,byActor=new Map<string,Counts>();
 for(const r of persisted){const count=byActor.get(r.owner_id as string)??{read:0,write:0,verify:0};if(r.kind==='SYNTHETIC_MATRIX_READ')count.read=Number(r.count);else count.write=Number(r.count);byActor.set(r.owner_id as string,count);}
 const finished=rows.filter(Boolean),allowed=finished.filter(r=>r.expected==='ALLOW').length,denied=finished.filter(r=>r.expected==='DENY').length;
 const summary={status:'FAIL',seed,planned:total,completed,oracleCaseHash:hash(canonical(cases)),workers,live:false,environment:'LOCAL_ISOLATED_SYNTHETIC_HTTP_PROVIDER_REAL_POSTGRES',productionProvidersCalled:false,allowed,denied,realApiApprovals:approvals,providerErrors:serverErrors.length,rows:finished};
 if(failure?.status==='rejected'){await writeFile('reports/gateway-matrix-latest.json',JSON.stringify(summary,null,2)+'\n');throw failure.reason;}
 try{
 expect(serverErrors).toEqual([]);expect(completed).toBe(total);expect(finished).toHaveLength(total);expect(new Set(finished.map(r=>r.actorId)).size).toBe(total);expect(new Set(finished.map(r=>r.resourceId)).size).toBe(total);expect(allowed).toBeGreaterThan(100);expect(denied).toBeGreaterThan(1000);expect(approvals).toBeGreaterThan(20);
 for(const row of finished){const count=byActor.get(row.actorId)??{read:0,write:0,verify:0};expect({read:count.read,write:count.write},'persisted provider effects for case '+row.index).toEqual({read:row.requests.read,write:row.requests.write});if(row.expected==='DENY')expect(count).toEqual({read:0,write:0,verify:0});}
 summary.status='PASS';
 }finally{await writeFile('reports/gateway-matrix-latest.json',JSON.stringify(summary,null,2)+'\n');}
},900000);
