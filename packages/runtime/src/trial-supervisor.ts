import {fork,type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {lstatSync,readFileSync} from 'node:fs';
import {trialProfileSchema,type TrialProfile} from '../../config/src/one-shot-trial.js';
import {secret} from '../../config/src/index.js';
import {Database} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {trialState} from '../../storage/src/trial.js';
import {guardianEventSchema,supervisorInitSchema,trialProcessEnvironment,trialRemainingMs,signalTrialGroup,trialGroupAlive,isolatedTrialFixtureAllowed,type SupervisorInit,type TrialDeadline,type TrialSupervisorReceipt,type TrialStopReason} from './trial-supervision.js';
export type TrialSupervisorOptions=Omit<SupervisorInit,'kind'|'executionToken'|'parentPid'>&{env:NodeJS.ProcessEnv;onEvent?:(event:Record<string,unknown>)=>void};
export class TrialSupervisor {
 readonly ready:Promise<void>;
 readonly finished:Promise<TrialSupervisorReceipt>;
 readonly guardian:ChildProcess;
 private readonly token=randomBytes(16).toString('hex');
 private readonly groups=new Map<number,{service:'ingress'|'worker'|'notifier';ready:boolean}>();
 private resolveReady!:()=>void;private rejectReady!:(error:Error)=>void;
 private resolveFinished!:(receipt:TrialSupervisorReceipt)=>void;private rejectFinished!:(error:Error)=>void;
 private deadline:TrialDeadline|undefined;private terminal:TrialSupervisorReceipt|undefined;
 private stopped=false;private lastMessage=performance.now();private force:ReturnType<typeof setTimeout>|undefined;
 private readonly timer:ReturnType<typeof setInterval>;private readonly startup:ReturnType<typeof setTimeout>;
 private readonly profile:TrialProfile;private hardStop:ReturnType<typeof setTimeout>|undefined;private readonly beganAt=new Date().toISOString();
 constructor(private readonly options:TrialSupervisorOptions){
  if(!['linux','darwin'].includes(process.platform))throw Error('TRIAL_POSIX_SUPERVISION_REQUIRED');
  const extension=import.meta.url.endsWith('.ts')?'.ts':'.js',entry=resolve(process.argv[1]??'');
  if(entry!==fileURLToPath(new URL('../../../scripts/trial-runtime'+extension,import.meta.url))&&!(isolatedTrialFixtureAllowed()&&entry===fileURLToPath(new URL('../../../tests/support/trial-supervisor-parent'+extension,import.meta.url))))throw Error('TRIAL_OWNED_LAUNCHER_REQUIRED');
  const stat=lstatSync(options.profilePath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||stat.size>131072)throw Error('TRIAL_PRIVATE_PROFILE_REQUIRED');
  this.profile=trialProfileSchema.parse(JSON.parse(readFileSync(options.profilePath,'utf8')));if(hash(JSON.stringify(this.profile))!==options.profileHash)throw Error('TRIAL_PROFILE_HASH_MISMATCH');
  const init=supervisorInitSchema.parse({kind:'INIT',executionToken:this.token,parentPid:process.pid,profilePath:options.profilePath,profileHash:options.profileHash,runtimeDirectory:options.runtimeDirectory,services:options.services});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});void this.ready.catch(()=>{});
  this.finished=new Promise((resolve,reject)=>{this.resolveFinished=resolve;this.rejectFinished=reject;});void this.finished.catch(()=>{});
  const url=new URL('../../../scripts/trial-runtime-guardian'+extension,import.meta.url);
  this.guardian=fork(fileURLToPath(url),[],{detached:true,env:trialProcessEnvironment(options.env),execArgv:extension==='.ts'?['--import','tsx']:[],stdio:['ignore','ignore','ignore','ipc']});
  this.guardian.on('message',(raw:unknown)=>this.message(raw));
  this.guardian.once('error',()=>{this.fail('TRIAL_GUARDIAN_LOST');});
  this.guardian.once('close',()=>{clearInterval(this.timer);clearTimeout(this.startup);if(this.force)clearTimeout(this.force);const allClosed=[...this.groups.keys()].every(pid=>!trialGroupAlive(pid));
   if(this.terminal&&allClosed){this.resolveFinished(this.terminal);this.rejectReady(Error('TRIAL_STOPPED_BEFORE_READY'));}
   else if(this.deadline){void this.guardianLost();}
   else{this.rejectReady(Error('TRIAL_GUARDIAN_LOST'));this.rejectFinished(Error('TRIAL_PROCESS_CLOSURE_UNCONFIRMED'));}
  });
  this.timer=setInterval(()=>{
   if(this.stopped)return;
   if(this.deadline&&trialRemainingMs(this.deadline)<=500){void this.stop('TRIAL_DEADLINE');return;}
   if(this.deadline&&performance.now()-this.lastMessage>1000){this.fail('TRIAL_GUARDIAN_LOST');return;}
   this.send({kind:'PING',executionToken:this.token});
  },100);
  this.startup=setTimeout(()=>this.fail('TRIAL_STARTUP_FAILED'),5000);
  this.send(init);
 }
 get ownedPids(){return [...this.groups.keys()];}
 private send(message:object){if(this.guardian.connected)this.guardian.send(message,error=>{if(error&&!this.stopped)this.fail('TRIAL_GUARDIAN_LOST');});}
 private message(raw:unknown){
  const parsed=guardianEventSchema.safeParse(raw);if(!parsed.success||parsed.data.executionToken!==this.token){this.fail('TRIAL_PROTOCOL_INVALID');return;}
  const event=parsed.data;this.lastMessage=performance.now();
  if(event.kind==='READY'){
   if(this.deadline||event.guardianPid!==this.guardian.pid){this.fail('TRIAL_PROTOCOL_INVALID');return;}
   this.deadline={deadlineAt:event.deadlineAt,monoDeadlineNs:BigInt(event.monoDeadlineNs)};
   if(trialRemainingMs(this.deadline)<=500||trialRemainingMs(this.deadline)>1200000){this.fail('TRIAL_DEADLINE');return;}
   this.hardStop=setTimeout(()=>{for(const pid of this.groups.keys())signalTrialGroup(pid,'SIGKILL');if(this.guardian.exitCode===null&&this.guardian.signalCode===null)this.guardian.kill('SIGKILL');process.exit(78);},Math.max(0,trialRemainingMs(this.deadline)-20));
   this.send({kind:'START_SERVICES',executionToken:this.token});
  }else if(event.kind==='REGISTER'){
   if(!this.deadline||this.groups.has(event.pid)||event.pid===process.pid||event.pid===this.guardian.pid){this.fail('TRIAL_PROTOCOL_INVALID');return;}
   this.groups.set(event.pid,{service:event.service,ready:false});this.send({kind:'REGISTER_ACK',executionToken:this.token,pid:event.pid});
  }else if(event.kind==='SERVICE_READY'){
   const owned=this.groups.get(event.pid);if(!owned||owned.service!==event.service||owned.ready){this.fail('TRIAL_PROTOCOL_INVALID');return;}
   owned.ready=true;if(this.groups.size===this.options.services.length&&[...this.groups.values()].every(g=>g.ready)){clearTimeout(this.startup);this.resolveReady();}
  }else if(event.kind==='PONG'){
   // Heartbeat only; it never changes the fixed deadline.
  }else if(event.kind==='STOPPED'){
   if(!this.deadline||event.receipt.parentPid!==process.pid||event.receipt.guardianPid!==this.guardian.pid||event.receipt.profileHash!==this.options.profileHash||event.receipt.deadlineAt!==this.deadline.deadlineAt){this.fail('TRIAL_PROTOCOL_INVALID');return;}
   this.terminal=event.receipt;this.stopped=true;
   const closed=event.receipt.ownedGroupsClosed&&event.receipt.groups.length===this.groups.size&&event.receipt.groups.every(group=>group.closed&&this.groups.get(group.pid)?.service===group.service&&!trialGroupAlive(group.pid))&&new Set(event.receipt.groups.map(group=>group.pid)).size===this.groups.size;
   // The guardian remains alive until this launcher exits. A bound receipt can
   // settle final output only after every registered group physically closes.
   // Keep our hard stop armed through that output and any database cleanup.
   if(closed){this.resolveFinished(event.receipt);this.rejectReady(Error('TRIAL_STOPPED_BEFORE_READY'));}
   else{this.rejectReady(Error('TRIAL_PROCESS_CLOSURE_UNCONFIRMED'));this.rejectFinished(Error('TRIAL_PROCESS_CLOSURE_UNCONFIRMED'));}
  }else{this.stopped=true;this.rejectReady(Error(event.code));this.rejectFinished(Error(event.code));}
  this.options.onEvent?.(event);
 }
 private async guardianLost(){
  this.stopped=true;this.rejectReady(Error('TRIAL_GUARDIAN_LOST'));for(const pid of this.groups.keys())signalTrialGroup(pid,'SIGKILL');
  let databaseClosed=false;const url=secret('RUNTIME_DATABASE_URL',this.options.env),p=this.profile;
  if(url){const db=new Database(url,1,150);db.trialProfileHash=this.options.profileHash;
   try{await Promise.race([db.scope({tenantId:p.tenantId,actorId:p.actorId},c=>trialState(c,undefined,false,'TRIAL_GUARDIAN_LOST')).then(s=>{databaseClosed=s.restricted&&s.state==='CLOSED';}),new Promise(resolve=>setTimeout(resolve,150))]);}catch{/* retain unconfirmed close */}finally{void db.close().catch(()=>{});}
  }
  for(let i=0;i<10&&[...this.groups.keys()].some(trialGroupAlive);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const groups=[...this.groups].map(([pid,g])=>({pid,service:g.service,closed:!trialGroupAlive(pid)}));
  // Keep the independent hard stop armed until the dedicated launcher exits.
  // A pending connection can outlive this bounded fallback after DB loss.
  this.resolveFinished({reason:'TRIAL_GUARDIAN_LOST',profileHash:this.options.profileHash,deadlineAt:this.deadline!.deadlineAt,guardianPid:this.guardian.pid!,parentPid:process.pid,databaseClosed,groups,ownedGroupsClosed:groups.every(g=>g.closed),startedAt:this.beganAt,endedAt:new Date().toISOString()});
 }
 private fail(reason:TrialStopReason){
  if(this.stopped)return;this.stopped=true;this.rejectReady(Error(reason));for(const pid of this.groups.keys())signalTrialGroup(pid,'SIGKILL');
  this.send({kind:'STOP',executionToken:this.token,reason});
  this.force=setTimeout(()=>{if(this.guardian.exitCode===null&&this.guardian.signalCode===null)this.guardian.kill('SIGKILL');},250);
 }
 stop(reason:TrialStopReason='TRIAL_OPERATOR_STOP'){
  if(!this.stopped){this.stopped=true;this.send({kind:'STOP',executionToken:this.token,reason});for(const pid of this.groups.keys())signalTrialGroup(pid,'SIGTERM');
   this.force=setTimeout(()=>{for(const pid of this.groups.keys())signalTrialGroup(pid,'SIGKILL');if(!this.terminal&&this.guardian.exitCode===null&&this.guardian.signalCode===null)this.guardian.kill('SIGKILL');},400);}
  return this.finished;
 }
}
