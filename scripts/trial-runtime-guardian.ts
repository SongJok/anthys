// Owned control process only. No model, robot SDK or task context is imported.
import {fork,type ChildProcess} from 'node:child_process';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {Database} from '../packages/storage/src/database.js';
import {hash} from '../packages/storage/src/crypto.js';
import {secret} from '../packages/config/src/index.js';
import {trialProfileSchema,type TrialProfile} from '../packages/config/src/one-shot-trial.js';
import {loadModelBudgetPolicy} from '../packages/runtime/src/budget-policy.js';
import {trialState} from '../packages/storage/src/trial.js';
import {supervisorInitSchema,guardianControlSchema,isolatedTrialFixtureAllowed,trialRemainingMs,trialProcessEnvironment,signalTrialGroup,trialGroupAlive,type SupervisorInit,type TrialDeadline,type TrialSupervisorReceipt,type TrialStopReason,type TrialService} from '../packages/runtime/src/trial-supervision.js';

type Owned={child:ChildProcess;service:TrialService;hello:boolean;armed:boolean;closed:boolean;done:Promise<void>};
let init:SupervisorInit|undefined,profile:TrialProfile|undefined,db:Database|undefined,bound:TrialDeadline|undefined;
let claimOwned=false,startingServices=false,stopping=false,lastPing=performance.now(),polling=false;
const owned=new Map<number,Owned>(),startedAt=new Date().toISOString();
let ticker:ReturnType<typeof setInterval>|undefined;
let startupStage='INIT';
function send(message:object){if(process.connected)process.send?.(message,undefined,undefined,()=>{});}
function wait(ms:number){return new Promise<void>(resolve=>setTimeout(resolve,Math.max(0,ms)));}
async function privateJson(path:string){const actual=resolve(path),stat=await lstat(actual);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>131072||await realpath(actual)!==actual)throw Error('PRIVATE_FILE');return JSON.parse(await readFile(actual,'utf8')) as unknown;}
async function start(value:unknown){
 if(init||!process.connected)throw Error('OWNED_INIT_REQUIRED');init=supervisorInitSchema.parse(value);
 if(init.parentPid!==process.ppid)throw Error('PARENT_BINDING');
 if(init.services.some(s=>s.fixture)&&!isolatedTrialFixtureAllowed())throw Error('FIXTURE_FORBIDDEN');
 startupStage='PROFILE';profile=trialProfileSchema.parse(await privateJson(init.profilePath));if(hash(JSON.stringify(profile))!==init.profileHash)throw Error('PROFILE_BINDING');
 startupStage='DIRECTORY';const directory=resolve(init.runtimeDirectory),stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||await realpath(directory)!==directory||stat.uid!==process.getuid?.())throw Error('PRIVATE_DIRECTORY');
 startupStage='SCOPES';const scopes=z.array(z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict()).length(1).parse(await privateJson(process.env['WORKER_SCOPE_FILE']??''));if(scopes[0]!.tenantId!==profile.tenantId||scopes[0]!.actorId!==profile.actorId)throw Error('SCOPE_BINDING');
 startupStage='BUDGET';const policy=loadModelBudgetPolicy();if(!policy.policy||hash(JSON.stringify(policy.policy))!==profile.budgetPolicyHash||Date.parse(policy.policy.validUntil)<=Date.now())throw Error('BUDGET_BINDING');
 startupStage='CONFIGURATION';
 if(secret('DINGTALK_CORP_ID')!==profile.corpId||secret('DINGTALK_ROBOT_CODE')!==profile.robotCode)throw Error('CONNECTOR_BINDING');
 const testOnly=isolatedTrialFixtureAllowed()&&init.services.every(s=>s.fixture!==undefined);
 if(!testOnly){
  for(const name of ['APP_MASTER_KEY','DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','GLM_API_KEY','QUEUE_DATABASE_URL'])if(!secret(name))throw Error('REQUIRED_RUNTIME_CONFIGURATION');
 }
 const bindings=z.array(z.object({tenantId:z.uuid(),corpId:z.string().min(1)}).strict()).length(1).parse(await privateJson(process.env['TENANT_BINDINGS_FILE']??''));
 if(bindings[0]!.tenantId!==profile.tenantId||bindings[0]!.corpId!==profile.corpId)throw Error('TENANT_BINDING');
 const url=secret('RUNTIME_DATABASE_URL');if(!url)throw Error('DATABASE_CONFIGURATION');
 if(isolatedTrialFixtureAllowed()){const target=new URL(url);if(target.hostname!=='127.0.0.1'||target.port!=='64711'||target.pathname!=='/anthys_test')throw Error('ISOLATED_TARGET');}
 startupStage='SCHEMA';db=new Database(url,1,150);db.trialProfileHash=init.profileHash;if(!await db.ready())throw Error('SCHEMA_NOT_READY');
 const began=process.hrtime.bigint(),p=profile;
 startupStage='SLOT';const row=await db.scope({tenantId:p.tenantId,actorId:p.actorId},async c=>(await c.query(`SELECT s.state,s.profile_hash,s.budget_policy_hash,s.corp_id,s.external_user_id,s.robot_code,s.conversation_id,
  extract(epoch FROM s.deadline)*1000 deadline_ms,extract(epoch FROM s.created_at)*1000 created_ms,
  floor(extract(epoch FROM (s.deadline-clock_timestamp()))*1000)::text remaining_ms
  FROM one_shot_trials s JOIN tenants t ON t.tenant_id=s.tenant_id AND t.status='ACTIVE' AND t.corp_id=s.corp_id
  JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id AND u.status='ACTIVE' AND u.external_user_id=s.external_user_id
  WHERE s.tenant_id=$1 AND s.owner_id=$2`,[p.tenantId,p.actorId])).rows[0]);
 startupStage='SLOT_BINDING';
 if(!row||row.state!=='ARMED'||row.profile_hash!==init.profileHash||row.budget_policy_hash!==p.budgetPolicyHash||row.corp_id!==p.corpId||row.external_user_id!==p.externalUserId||row.robot_code!==p.robotCode||row.conversation_id!==p.conversationId||Number(row.deadline_ms)!==Date.parse(p.deadline)||Number(row.deadline_ms)-Number(row.created_ms)>1200000)throw Error('EXISTING_ARMED_BINDING_REQUIRED');
 startupStage='DEADLINE';const remaining=Number(row.remaining_ms)-Number((process.hrtime.bigint()-began)/1000000n);if(stopping||!Number.isSafeInteger(remaining)||remaining<=750||remaining>1200000)throw Error('DEADLINE');
 bound={deadlineAt:Date.parse(p.deadline),monoDeadlineNs:process.hrtime.bigint()+BigInt(remaining)*1000000n};
 startupStage='ATOMIC_CLAIM';
 const claimed=await db.scope({tenantId:p.tenantId,actorId:p.actorId},async c=>(await c.query('SELECT public.oa_trial_claim_execution($1,$2) state',[init!.profileHash,init!.executionToken])).rows[0].state as {claimed:boolean});
 if(!claimed.claimed){send({kind:'FAILED',executionToken:init.executionToken,code:'TRIAL_CLAIM_CONSUMED',stage:startupStage});process.exit(78);}claimOwned=true;
 if(stopping||trialRemainingMs(bound)<=500)throw Error('DEADLINE_AFTER_CLAIM');
 startupStage='CLAIM';writeFileSync(join(directory,init.profileHash+'.claim.json'),JSON.stringify({profileHash:init.profileHash,executionToken:init.executionToken,parentPid:init.parentPid,guardianPid:process.pid,deadlineAt:bound.deadlineAt,monoDeadlineNs:bound.monoDeadlineNs.toString(),claimedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
 ticker=setInterval(()=>{
  if(stopping||!init||!bound)return;
  if(trialRemainingMs(bound)<=500){void stop('TRIAL_DEADLINE');return;}
  if(!process.connected||process.ppid!==init.parentPid){void stop('TRIAL_PARENT_LOST');return;}
  if(performance.now()-lastPing>1000){void stop('TRIAL_PARENT_UNRESPONSIVE');return;}
  send({kind:'PONG',executionToken:init.executionToken});
  if(!polling){polling=true;void db!.scope({tenantId:p.tenantId,actorId:p.actorId},c=>trialState(c,undefined,true)).then(state=>{if(state.restricted&&!state.allowed)void stop('TRIAL_CLOSED');}).catch(()=>{void stop('TRIAL_AUTHORITY_UNAVAILABLE');}).finally(()=>{polling=false;});}
 },50);
 send({kind:'READY',executionToken:init.executionToken,guardianPid:process.pid,deadlineAt:bound.deadlineAt,monoDeadlineNs:bound.monoDeadlineNs.toString()});
}
function startServices(){
 if(!init||!bound||startingServices||stopping)throw Error('SERVICES_STATE');startingServices=true;
 const extension=import.meta.url.endsWith('.ts')?'.ts':'.js',url=new URL('../packages/runtime/src/trial-service'+extension,import.meta.url);
 for(const spec of init.services){
  const child=fork(fileURLToPath(url),[],{detached:true,env:{...trialProcessEnvironment(process.env),ONE_SHOT_TRIAL_PROFILE_FILE:init.profilePath},execArgv:extension==='.ts'?['--import','tsx']:[],stdio:['ignore','ignore','ignore','ipc']});
  if(!child.pid)throw Error('SPAWN_FAILED');const pid=child.pid;let resolveClosed!:()=>void;
  const entry:Owned={child,service:spec.service,hello:false,armed:false,closed:false,done:new Promise(resolve=>{resolveClosed=resolve;})};owned.set(pid,entry);
  child.once('error',()=>{if(!stopping)void stop('TRIAL_SERVICE_LOST');});child.once('close',()=>{entry.closed=true;resolveClosed();if(!stopping)void stop('TRIAL_SERVICE_LOST');});
  child.on('message',(raw:unknown)=>{
   const message=z.object({kind:z.enum(['HELLO','SERVICE_READY','SERVICE_FAILED']),executionToken:z.string(),pid:z.number().int().positive(),parentPid:z.number().int().positive()}).strict().safeParse(raw);
   if(!message.success||message.data.executionToken!==init!.executionToken||message.data.pid!==pid||message.data.parentPid!==process.pid){void stop('TRIAL_PROTOCOL_INVALID');return;}
   if(message.data.kind==='HELLO'&&!entry.hello){entry.hello=true;send({kind:'REGISTER',executionToken:init!.executionToken,pid,service:entry.service});}
   else if(message.data.kind==='SERVICE_READY'&&entry.armed)send({kind:'SERVICE_READY',executionToken:init!.executionToken,pid,service:entry.service});
   else void stop('TRIAL_SERVICE_LOST');
  });
  child.send({kind:'BOOT',executionToken:init.executionToken,guardianPid:process.pid,profileHash:init.profileHash,deadlineAt:bound.deadlineAt,monoDeadlineNs:bound.monoDeadlineNs.toString(),service:spec.service,runtimeDirectory:init.runtimeDirectory,...(spec.fixture?{fixture:spec.fixture}:{})},error=>{if(error&&!stopping)void stop('TRIAL_SERVICE_LOST');});
 }
}
async function stop(reason:TrialStopReason){
 if(stopping)return;stopping=true;if(ticker)clearInterval(ticker);
 // Cleanup and receipt I/O must never leave a paused parent without an
 // independent deadline. Arm this before any asynchronous shutdown work,
 // reserving 100ms inside the original window for signal delivery and reaping.
 const hardClose=()=>{for(const [pid]of owned)signalTrialGroup(pid,'SIGKILL');if(init&&process.ppid===init.parentPid){try{process.kill(init.parentPid,'SIGKILL');}catch{/* original parent exited */}}process.exit(78);};
 if(bound){setTimeout(hardClose,Math.max(0,trialRemainingMs(bound)-100));setInterval(()=>{if(bound&&trialRemainingMs(bound)<=100)hardClose();},10);}
 for(const [pid]of owned)signalTrialGroup(pid,'SIGTERM');
 let databaseClosed=false;
 const closeDb=claimOwned&&db&&profile?db.scope({tenantId:profile.tenantId,actorId:profile.actorId},c=>trialState(c,undefined,false,'TRIAL_SUPERVISOR_STOP')).then(state=>{databaseClosed=state.restricted&&state.state==='CLOSED';}).catch(()=>{}):Promise.resolve();
 await Promise.race([Promise.all([...owned.values()].map(o=>o.done)),wait(150)]);
 for(const [pid]of owned)if(trialGroupAlive(pid))signalTrialGroup(pid,'SIGKILL');
 await Promise.race([Promise.all([...owned.values()].map(o=>o.done)),wait(100)]);
 await Promise.race([closeDb,wait(100)]);
 for(let attempt=0;attempt<5&&[...owned.keys()].some(trialGroupAlive);attempt++){if(bound&&trialRemainingMs(bound)<=20)break;await wait(10);}
 if(init&&bound){
  const groups=[...owned].map(([pid,value])=>({pid,service:value.service,closed:value.closed&&!trialGroupAlive(pid)})),receipt:TrialSupervisorReceipt={reason,profileHash:init.profileHash,deadlineAt:bound.deadlineAt,guardianPid:process.pid,parentPid:init.parentPid,databaseClosed,groups,ownedGroupsClosed:groups.every(g=>g.closed),startedAt,endedAt:new Date().toISOString()};
  try{writeFileSync(join(init.runtimeDirectory,init.executionToken+'.receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});}catch{/* process closure remains primary; the parent also receives the exact receipt */}
  send({kind:'STOPPED',executionToken:init.executionToken,receipt});
 }
 // The independent deadline must cover the dedicated launcher's final output.
 // Its own timers cannot run while SIGSTOPped, even after a valid receipt.
 const closeParent=()=>{
  if(!init||process.ppid!==init.parentPid){process.exit(databaseClosed?0:78);return;}
  if(!bound||reason==='TRIAL_PARENT_UNRESPONSIVE'||trialRemainingMs(bound)<=100){
   try{process.kill(init.parentPid,'SIGKILL');}catch{/* original parent may have exited */}
   process.exit(databaseClosed?0:78);return;
  }
  setTimeout(closeParent,Math.min(10,Math.max(1,trialRemainingMs(bound)-100)));
 };
 closeParent();
}
process.on('message',(raw:unknown)=>{
 if(!init){void start(raw).catch(()=>{send({kind:'FAILED',executionToken:init?.executionToken??'',code:'TRIAL_STARTUP_FAILED',stage:startupStage});if(claimOwned)void stop('TRIAL_STARTUP_FAILED');else process.exit(78);});return;}
 const parsed=guardianControlSchema.safeParse(raw);if(!parsed.success||parsed.data.executionToken!==init.executionToken){void stop('TRIAL_PROTOCOL_INVALID');return;}
 const event=parsed.data;
 if(event.kind==='PING'){lastPing=performance.now();if(bound)send({kind:'PONG',executionToken:init.executionToken});}
 else if(event.kind==='STOP')void stop(event.reason);
 else if(event.kind==='START_SERVICES'){try{startServices();}catch{void stop('TRIAL_STARTUP_FAILED');}}
 else{const child=owned.get(event.pid);if(!child||!child.hello||child.armed||stopping){void stop('TRIAL_PROTOCOL_INVALID');return;}child.armed=true;child.child.send({kind:'ARM',executionToken:init.executionToken},error=>{if(error&&!stopping)void stop('TRIAL_SERVICE_LOST');});}
});
process.once('disconnect',()=>{void stop('TRIAL_PARENT_LOST');});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void stop('TRIAL_OPERATOR_STOP');});
setTimeout(()=>{if(!claimOwned&&!stopping)process.exit(78);},5000).unref();
