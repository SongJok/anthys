import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {loadEnvFile,secret} from '../../../packages/config/src/index.js';
import {Database} from '../../../packages/storage/src/database.js';
import {Vault} from '../../../packages/storage/src/crypto.js';
import {Schedules} from '../../../packages/schedules/src/service.js';
import {runReminderCycle} from '../../../packages/schedules/src/cycle.js';
import {ReminderScheduler} from '../../../packages/schedules/src/runner.js';
async function main(){let db:Database|undefined;try{
 loadEnvFile();if(process.env['ONE_SHOT_TRIAL_PROFILE_FILE']||process.env['FORMAL_RUNTIME_PROFILE_FILE'])throw Error('SCHEDULE_LIFECYCLE_BLOCKED');
 const required=(key:string)=>{const value=secret(key);if(!value)throw Error('REQUIRED_CONFIGURATION');return value;};
 const scopes=z.array(z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict()).min(1).max(10000).parse(JSON.parse(await readFile(process.env['WORKER_SCOPE_FILE']??'.data/worker-scopes.json','utf8')));
 if(new Set(scopes.map(s=>`${s.tenantId}:${s.actorId}`)).size!==scopes.length)throw Error('DUPLICATE_SCOPE');
 db=new Database(required('RUNTIME_DATABASE_URL'),4);const database=db;if(!await database.ready())throw Error('SCHEMA_NOT_READY');
 const vault=new Vault(new Map([['1',Buffer.from(required('APP_MASTER_KEY'),'hex')]]),'1'),scheduler=new ReminderScheduler(new Schedules(database,vault)),controller=new AbortController();let busy=false;
 async function tick(){if(busy||controller.signal.aborted)return;busy=true;try{await runReminderCycle(scopes,scheduler,controller.signal,()=>console.error('SCHEDULER_SCOPE_FAILED'));}catch{if(!controller.signal.aborted)console.error('SCHEDULER_TICK_FAILED');}finally{busy=false;}}
 await tick();const timer=setInterval(()=>{void tick();},5000);
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{controller.abort();clearInterval(timer);void database.close();});
 console.log('SCHEDULER_READY: deterministic private reminders; current authority and revision required');
 }catch{await db?.close();throw Error('SCHEDULER_STARTUP_FAILED');}}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href)await main().catch(()=>{console.error('SCHEDULER_STARTUP_FAILED');process.exitCode=1;});else await main();
