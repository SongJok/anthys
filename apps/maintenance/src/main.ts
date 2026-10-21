import {initializeLifecycle,assertLifecycleScopes} from '../../../packages/config/src/lifecycle.js';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {loadEnvFile,secret} from '../../../packages/config/src/index.js';
import {Database} from '../../../packages/storage/src/database.js';
import {Vault} from '../../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../../packages/storage/src/files.js';
import {TaskResultArtifacts} from '../../../packages/artifacts/src/service.js';
import {Personas} from '../../../packages/personas/src/service.js';
import {PrivatePreferences} from '../../../packages/memory/src/service.js';
import {MaintenanceSupervisor,MaintenanceGuardError} from '../../../packages/memory/src/maintenance.js';
import {PermissionCacheMaintenance} from '../../../packages/gateway/src/permission-maintenance.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
class ReportedMaintenanceFailure extends Error{}
async function main(){let db:Database|undefined;try{
 loadEnvFile();const required=(name:string)=>{const value=secret(name);if(!value)throw Error('REQUIRED_CONFIGURATION');return value;};
 const scopes=z.array(z.object({tenantId:z.uuid().transform(v=>v.toLowerCase()),actorId:z.uuid().transform(v=>v.toLowerCase())}).strict()).min(1).max(10000).parse(JSON.parse(await readFile(process.env['WORKER_SCOPE_FILE']??'.data/worker-scopes.json','utf8')));
 db=new Database(required('RUNTIME_DATABASE_URL'));const database=db,vault=new Vault(new Map([['1',Buffer.from(required('APP_MASTER_KEY'),'hex')]]),'1');
 const supervisor=new MaintenanceSupervisor(scopes,{ready:()=>database.ready(),trialGuard:async()=>{const lifecycle=await initializeLifecycle(database,process.env,scopes,'MAINTENANCE');if(lifecycle.mode==='TRIAL')throw new MaintenanceGuardError('TRIAL_MAINTENANCE_DISABLED');assertLifecycleScopes(lifecycle,scopes);},memory:new PrivatePreferences(database,vault),personas:new Personas(database,vault),diagnostics:new PermissionCacheMaintenance(database),artifacts:new TaskResultArtifacts(database,vault,new EncryptedFileStore(process.env['FILE_STORE_ROOT']??'.data/files',vault),undefined),emit:(event,error)=>{(error?console.error:console.log)(JSON.stringify(event));}});
 let timer:ReturnType<typeof setInterval>|undefined,closing:Promise<void>|undefined;
 const finish=(failed=false,reportExit=true)=>{if(timer)clearInterval(timer);if(failed&&reportExit)process.exitCode=1;closing??=(async()=>{await supervisor.stop();if(reportExit&&supervisor.state==='FAILED')process.exitCode=1;await database.close();})();return closing;};
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void finish();});
 if(!await supervisor.start()){await finish(false,false);if(supervisor.state==='FAILED')throw new ReportedMaintenanceFailure(supervisor.failureCode??'INTERNAL_ERROR');}
 else if(!closing)timer=setInterval(()=>{void supervisor.tick().then(ok=>{if(!ok)void finish(supervisor.state==='FAILED');}).catch(()=>{void finish(true);});},1000);
 }catch(error){if(!(error instanceof ReportedMaintenanceFailure)){console.error(JSON.stringify({kind:'PRIVATE_MEMORY_MAINTENANCE_FAILED',operation:'CONFIGURATION',causeCode:'CONFIGURATION_INVALID',scopeIndex:null,scopeRef:null}));console.error(JSON.stringify({kind:'PRIVATE_MEMORY_MAINTENANCE_STATE',state:'FAILED'}));}await db?.close();throw new Error(error instanceof ReportedMaintenanceFailure?error.message:'MAINTENANCE_STARTUP_FAILED');}}
// Module import awaits the startup gate and rejects with a fixed safe code.
// Only the actual CLI sets its exit status; importing cannot poison a host.
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href)await main().catch(()=>{process.exitCode=1;});else await main();
