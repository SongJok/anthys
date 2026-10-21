import {registerNativeArtifacts} from '../../packages/artifacts/src/runtime.js';
import {nativeArtifactWorld} from '../support/native-artifact-world.js';
import '../support/isolation.js';
import {randomBytes} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {config,secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {createServer} from '../../apps/api/src/server.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
const isolated=await groupReminderDatabase(),directory=await realpath(await mkdtemp(join(tmpdir(),'oa-artifact-browser-'))),vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),origin='http://localhost:64702';
let app:Awaited<ReturnType<typeof createServer>>['app']|undefined,closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await app?.close();await isolated.close();await rm(directory,{recursive:true,force:true});})();
try{
 await isolated.install();const store=new RuntimeStore(isolated.db,vault),gateway=new Gateway(store),files=new EncryptedFileStore(join(directory,'files'),vault),artifacts=new TaskResultArtifacts(isolated.db,vault,files,gateway);registerNativeArtifacts(gateway,vault,files,{},'DEFAULT');
 const api=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:secret('SESSION_SECRET')!,finalReader:gateway,artifacts,webRoot:resolve('dist/web')});app=api.app;
 const fixtures:Record<string,unknown>={};for(const project of ['desktop','mobile']){const w=await artifactWorld({isolated,store,gateway,sessions:api.sessions},origin);const native=await nativeArtifactWorld({isolated,store,gateway,sessions:api.sessions},origin);fixtures[project]={nativeCookie:native.owner.cookie,nativeTaskId:native.taskId,nativeRunId:native.runId,nativeExpectedValue:native.value,nativeArtifactId:native.artifact.id,ownerCookie:w.owner.cookie,taskId:w.taskId,runId:w.runId,tenantId:w.ctx.tenantId,actorId:w.ctx.actorId,isolatedDatabase:isolated.name,expectedValue:w.value};}
 await writeFile('.data/test-environment/browser-artifacts.json',JSON.stringify(fixtures),{mode:0o600});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
 await app.listen({host:'127.0.0.1',port:64702});
}catch(error){await close();throw error;}
