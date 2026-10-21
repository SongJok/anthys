import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {trialProfileSchema} from '../../packages/config/src/one-shot-trial.js';
import {hash} from '../../packages/storage/src/crypto.js';
import type {Database} from '../../packages/storage/src/database.js';

const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});afterAll(()=>admin.end());
it.each(['ARMED','CLOSED_SAME','CLOSED_MISSING','ACTIVE_CHANGED'] as const)('actual app startup %s performs zero enterprise connector initializations and provider HTTP calls',async mode=>{
 const tenantId=randomUUID(),actorId=randomUUID(),corpId='SYNTHETIC-'+tenantId,robotCode='synthetic-startup',dir=await mkdtemp(join(tmpdir(),'oa-trial-startup-'));
 const profile=trialProfileSchema.parse({schemaVersion:1,tenantId,actorId,corpId,externalUserId:'owner',robotCode,conversationId:'synthetic-existing-dm',deadline:new Date(Date.now()+3600000).toISOString(),budgetPolicyHash:hash(JSON.stringify(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')))),approvalReference:'SYNTHETIC_STARTUP_ONLY_NO_REAL_APPROVAL'});
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC STARTUP','ACTIVE')",[tenantId,corpId]);await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[tenantId,actorId]);
 await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,$8)",[tenantId,actorId,hash(JSON.stringify(profile)),profile.budgetPolicyHash,corpId,robotCode,profile.conversationId,profile.deadline]);
 if(mode.startsWith('CLOSED'))await admin.query("UPDATE one_shot_trials SET state='CLOSED',closed_at=clock_timestamp(),close_reason='SYNTHETIC_OPERATOR_STOP' WHERE tenant_id=$1",[tenantId]);
 const path=join(dir,'profile.json');await writeFile(path,JSON.stringify(mode==='ACTIVE_CHANGED'?{...profile,approvalReference:'SYNTHETIC_CHANGED'}:profile));await writeFile(join(dir,'scopes.json'),JSON.stringify([{tenantId,actorId}]));await writeFile(join(dir,'bindings.json'),JSON.stringify([{tenantId,corpId}]));
 const settings:Record<string,string>={WORKER_SCOPE_FILE:join(dir,'scopes.json'),TENANT_BINDINGS_FILE:join(dir,'bindings.json'),DINGTALK_CORP_ID:corpId,DINGTALK_ROBOT_CODE:robotCode,DINGTALK_CLIENT_ID:'synthetic-id',DINGTALK_CLIENT_SECRET:'synthetic-secret',...(mode==='CLOSED_MISSING'?{}:{ONE_SHOT_TRIAL_PROFILE_FILE:path})};
 const saved=Object.fromEntries([...Object.keys(settings),'ONE_SHOT_TRIAL_PROFILE_FILE'].map(k=>[k,process.env[k]]));Object.assign(process.env,settings);if(mode==='CLOSED_MISSING')delete process.env['ONE_SHOT_TRIAL_PROFILE_FILE'];
 const databases:Database[]=[],timers:ReturnType<typeof setInterval>[]=[],externalInit=vi.fn(()=>{throw Error('UNEXPECTED_ENTERPRISE_CONNECTOR_INITIALIZATION');}),http=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('UNEXPECTED_PROVIDER_HTTP');}),stream=vi.fn();
 vi.resetModules();
 vi.doMock('../../packages/storage/src/database.js',async original=>{const module=await original<typeof import('../../packages/storage/src/database.js')>();return {...module,Database:class extends module.Database {constructor(...args:ConstructorParameters<typeof module.Database>){super(...args);databases.push(this);}}};});
 vi.doMock('../../packages/company/src/configuration.js',()=>({configureCompanyCode:externalInit}));vi.doMock('../../packages/company/src/log-configuration.js',async original=>{const module=await original<typeof import('../../packages/company/src/log-configuration.js')>();return {...module,configureCompanyLogs:externalInit};});vi.doMock('../../packages/dws/src/configuration.js',()=>({configureDws:externalInit}));
 vi.doMock('../../packages/attachments/src/service.js',()=>({AttachmentService:class {constructor(){externalInit();}}}));vi.doMock('../../packages/gateway/src/cards.js',()=>({CardCoordinator:class {constructor(){externalInit();}}}));
 vi.doMock('dingtalk-stream',async original=>{const module=await original<typeof import('dingtalk-stream')>();return {...module,DWClient:class {registerCallbackListener(){}socketCallBackResponse(){}async connect(){stream();}disconnect(){}}};});
 vi.doMock('../../packages/tasks/src/queue.js',async original=>{const module=await original<typeof import('../../packages/tasks/src/queue.js')>();return {...module,RunQueue:class {boss={on:()=>{}};async start(){}async work(){}async workSourceReplies(){}async workGroupReplies(){}async publish(){return 0;}}};});
 const originalInterval=globalThis.setInterval;vi.spyOn(globalThis,'setInterval').mockImplementation((...args)=>{const timer=originalInterval(...args);timers.push(timer);return timer;});
 const originalOn=process.on.bind(process),originalOnce=process.once.bind(process);vi.spyOn(process,'on').mockImplementation((event,listener)=>['SIGTERM','SIGINT'].includes(String(event))?process:originalOn(event,listener));vi.spyOn(process,'once').mockImplementation((event,listener)=>['SIGTERM','SIGINT'].includes(String(event))?process:originalOnce(event,listener));
 const exitCodeBefore=process.exitCode;
 try{
  for(const entry of [()=>import('../../apps/worker/src/main.js'),()=>import('../../apps/ingress/src/main.js'),()=>import('../../apps/notifier/src/main.js')]){
   await expect(entry()).rejects.toThrow(mode==='ARMED'?'TRIAL_SUPERVISION_REQUIRED':'TRIAL_STARTUP_BLOCKED');
  }
  await expect(import('../../apps/api/src/main.js')).rejects.toThrow('TRIAL_API_DISABLED');await expect(import('../../apps/maintenance/src/main.js')).rejects.toThrow(mode==='ARMED'?'TRIAL_MAINTENANCE_DISABLED':'TRIAL_STARTUP_BLOCKED');
  expect(process.exitCode).toBe(exitCodeBefore);
  expect(externalInit).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();expect(stream).not.toHaveBeenCalled();
  const row=(await admin.query('SELECT state,profile_hash FROM one_shot_trials WHERE tenant_id=$1',[tenantId])).rows[0];expect(row.state).toBe(mode==='ARMED'?'ARMED':'CLOSED');expect(row.profile_hash).toBe(hash(JSON.stringify(profile)));
 }finally{
  timers.forEach(clearInterval);await Promise.all(databases.map(db=>db.close()));vi.restoreAllMocks();for(const name of ['../../packages/storage/src/database.js','../../packages/company/src/configuration.js','../../packages/company/src/log-configuration.js','../../packages/dws/src/configuration.js','../../packages/attachments/src/service.js','../../packages/gateway/src/cards.js','dingtalk-stream','../../packages/tasks/src/queue.js'])vi.doUnmock(name);vi.resetModules();
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});
 }
});
