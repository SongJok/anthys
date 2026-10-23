import {registerNativeArtifacts} from '../../packages/artifacts/src/runtime.js';
import {nativeArtifactWorld} from '../support/native-artifact-world.js';
import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {config,secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway,toolName} from '../../packages/gateway/src/index.js';
import {ControlPlane} from '../../packages/gateway/src/control-plane.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {createServer} from '../../apps/api/src/server.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
type Server=Awaited<ReturnType<typeof createServer>>;
// T116 seeds one reviewed synthetic write and requests approval through the real
// HTTP control plane, so the browser sees a genuine PENDING approval rather than
// an imagined UI state. The write adapter is never invoked by this fixture.
async function approvalWorld(deps:{isolated:Awaited<ReturnType<typeof groupReminderDatabase>>;store:RuntimeStore;gateway:Gateway;sessions:Server['sessions'];app:Server['app']},origin:string,ctx:{tenantId:string;actorId:string},owner:{cookie:string;csrf:string}){
 const {isolated,store,gateway,sessions,app}=deps,capability='synthetic.t116.approval.'+randomUUID(),goal='Synthetic T116 approval task';
 const task=await new TaskStore(isolated.db).create(ctx,goal,'synthetic-t116-'+randomUUID()),lease=await store.acquire(ctx,task.runId,'synthetic-t116-setup');if(!lease)throw Error('T116_LEASE_UNAVAILABLE');
 gateway.register({...syntheticResultContract,id:capability,version:'1.0.0',description:'Synthetic T116 reviewed write',risk:'SHARED_WRITE',provider:'CORE',state:'READY',bindingHash:'synthetic-t116-reviewed-v1',schema:z.object({note:z.string()}).strict(),jsonSchema:{type:'object',properties:{note:{type:'string'}},required:['note'],additionalProperties:false},resource:(_args,current)=>current.taskId,approvalPreview:()=>({操作:'合成审批演示',对象:'隔离任务'}),operationAudience:(_args,current)=>current.audience,execute:async(args,{principal,actionKey,lease})=>{const id=randomUUID();await store.db.scope(principal,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,'SYNTHETIC_T116_WRITE',$4,$5,$6,now())",[ctx.tenantId,id,ctx.actorId,lease.runId,JSON.stringify(args),actionKey]));return {status:'OK',evidenceIds:[id],completeness:'COMPLETE',data:{id}};}});
 const blocked=await gateway.execute(ctx,lease,toolName(capability,'1.0.0'),{note:'T116_PRIVATE_INPUT_SENTINEL'},AbortSignal.timeout(5000));if(blocked.status!=='NEEDS_APPROVAL')throw Error('T116_APPROVAL_SETUP_'+blocked.status);
 const action=(await store.db.scope(ctx,c=>c.query('SELECT id FROM tool_actions WHERE run_id=$1 AND capability_id=$2',[task.runId,capability]))).rows[0]?.id as string|undefined;if(!action)throw Error('T116_ACTION_MISSING');
 await store.pause(ctx,lease,'WAITING_APPROVAL','APPROVAL_REQUIRED');
 const reviewerId=randomUUID();
 await isolated.root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'Synthetic T116 reviewer','ACTIVE')",[ctx.tenantId,reviewerId]);
 await isolated.root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'ACTION_APPROVER') ON CONFLICT(tenant_id,name) DO NOTHING",[ctx.tenantId,randomUUID()]);
 await isolated.root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='ACTION_APPROVER'),$3,'RESOURCE',$4)",[ctx.tenantId,randomUUID(),reviewerId,task.taskId]);
 const reviewer=await sessions.create({tenantId:ctx.tenantId,actorId:reviewerId}),requested=await app.inject({method:'POST',url:`/api/v1/actions/${action}/approvals`,headers:{cookie:`oa_session=${owner.cookie}`,origin,'x-csrf-token':owner.csrf},payload:{approverId:reviewerId}});
 if(requested.statusCode!==200)throw Error('T116_APPROVAL_REQUEST_'+requested.statusCode+'_'+requested.body);
 return {approvalTaskId:task.taskId,approvalRunId:task.runId,approvalActionId:action,approvalId:requested.json().data.id as string,approvalCapability:capability,approvalGoal:goal,reviewerCookie:reviewer.cookie};
}
const isolated=await groupReminderDatabase(),directory=await realpath(await mkdtemp(join(tmpdir(),'oa-artifact-browser-'))),vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),origin='http://localhost:64702';
let app:Awaited<ReturnType<typeof createServer>>['app']|undefined,closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await app?.close();await isolated.close();await rm(directory,{recursive:true,force:true});})();
try{
 await isolated.install();const store=new RuntimeStore(isolated.db,vault),gateway=new Gateway(store),files=new EncryptedFileStore(join(directory,'files'),vault),artifacts=new TaskResultArtifacts(isolated.db,vault,files,gateway);registerNativeArtifacts(gateway,vault,files,{},'DEFAULT');
 const api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:secret('SESSION_SECRET')!,controls:new ControlPlane(store,secret('SESSION_SECRET')!),finalReader:gateway,artifacts,webRoot:resolve('dist/web')});app=api.app;
 const fixtures:Record<string,unknown>={};for(const project of ['desktop','mobile']){const w=await artifactWorld({isolated,store,gateway,sessions:api.sessions},origin);const native=await nativeArtifactWorld({isolated,store,gateway,sessions:api.sessions},origin);const t116=await artifactWorld({isolated,store,gateway,sessions:api.sessions},origin);const approval=await approvalWorld({isolated,store,gateway,sessions:api.sessions,app},origin,t116.ctx,t116.owner);fixtures[project]={nativeCookie:native.owner.cookie,nativeTaskId:native.taskId,nativeRunId:native.runId,nativeExpectedValue:native.value,nativeArtifactId:native.artifact.id,ownerCookie:w.owner.cookie,taskId:w.taskId,runId:w.runId,tenantId:w.ctx.tenantId,actorId:w.ctx.actorId,isolatedDatabase:isolated.name,expectedValue:w.value,t116Cookie:t116.owner.cookie,t116TaskId:t116.taskId,t116RunId:t116.runId,t116ExpectedValue:t116.value,t116TenantId:t116.ctx.tenantId,foreignCookie:t116.other.cookie,...approval};}
 await writeFile('.data/test-environment/browser-artifacts.json',JSON.stringify(fixtures),{mode:0o600});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
 await app.listen({host:'127.0.0.1',port:64702});
}catch(error){await close();throw error;}
