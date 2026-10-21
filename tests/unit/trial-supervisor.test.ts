import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../../packages/storage/src/crypto.js';
import {trialProfileSchema} from '../../packages/config/src/one-shot-trial.js';
import type {TrialSupervisorReceipt} from '../../packages/runtime/src/trial-supervision.js';
const {forkMock}=vi.hoisted(()=>({forkMock:vi.fn()}));
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),fork:forkMock}));
import {TrialSupervisor} from '../../packages/runtime/src/trial-supervisor.js';

class Transport extends EventEmitter {
 readonly pid=5000001;
 connected=true;exitCode:number|null=null;signalCode:NodeJS.Signals|null=null;
 readonly sent:Record<string,unknown>[]=[];readonly signals:NodeJS.Signals[]=[];
 send(message:Record<string,unknown>,callback?:(error:Error|null)=>void){this.sent.push(message);callback?.(null);return true;}
 kill(signal:NodeJS.Signals){this.signals.push(signal);return true;}
 close(){this.connected=false;this.exitCode=0;this.emit('close',0,null);}
}
const groupPids=[5000002,5000003],exitSentinel=new Error('UNIT_PARENT_HARD_EXIT');
let directory:string,argv:string[],transport:Transport,alive:Set<number>,signals:{pid:number;signal:NodeJS.Signals|number|undefined}[];
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'oa-supervisor-protocol-'));argv=[...process.argv];process.argv[1]=resolve('tests/support/trial-supervisor-parent.ts');
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance','hrtime']});vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
 transport=new Transport();alive=new Set(groupPids);signals=[];forkMock.mockReset();forkMock.mockReturnValue(transport);
 vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
  if(!groupPids.includes(-pid)||signal!==0&&signal!=='SIGKILL'&&signal!=='SIGTERM')throw Error('UNIT_UNEXPECTED_OS_SIGNAL');
  signals.push({pid,signal});if(signal===0){if(alive.has(-pid))return true;throw Object.assign(Error('not alive'),{code:'ESRCH'});}alive.delete(-pid);return true;
 });
 vi.spyOn(process,'exit').mockImplementation(()=>{throw exitSentinel;});
});
afterEach(async()=>{transport.removeAllListeners();vi.clearAllTimers();vi.useRealTimers();process.argv.splice(0,process.argv.length,...argv);vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});
async function start(servicesReady=true){
 const deadlineAt=Date.now()+10000,profile=trialProfileSchema.parse({schemaVersion:1,tenantId:randomUUID(),actorId:randomUUID(),corpId:'synthetic-protocol',externalUserId:'synthetic-owner',robotCode:'synthetic-robot',conversationId:'synthetic-dm',deadline:new Date(deadlineAt).toISOString(),budgetPolicyHash:'a'.repeat(64),approvalReference:'SYNTHETIC_PROTOCOL_ONLY'}),profilePath=join(directory,'profile.json'),profileHash=hash(JSON.stringify(profile));
 await writeFile(profilePath,JSON.stringify(profile),{mode:0o600});
 const subject=new TrialSupervisor({profilePath,profileHash,runtimeDirectory:directory,services:[{service:'worker',fixture:'idle'},{service:'notifier',fixture:'idle'}],env:{}}),token=transport.sent[0]!['executionToken'];
 const send=(message:Record<string,unknown>)=>transport.emit('message',{...message,executionToken:token});
 send({kind:'READY',guardianPid:transport.pid,deadlineAt,monoDeadlineNs:(process.hrtime.bigint()+10000000000n).toString()});
 for(const [index,pid]of groupPids.entries()){const service=index===0?'worker':'notifier';send({kind:'REGISTER',pid,service});if(servicesReady)send({kind:'SERVICE_READY',pid,service});}
 const receipt:TrialSupervisorReceipt={reason:'TRIAL_OPERATOR_STOP',profileHash,deadlineAt,guardianPid:transport.pid,parentPid:process.pid,databaseClosed:true,ownedGroupsClosed:true,groups:[{pid:groupPids[0]!,service:'worker',closed:true},{pid:groupPids[1]!,service:'notifier',closed:true}],startedAt:new Date().toISOString(),endedAt:new Date().toISOString()};
 return {subject,send,receipt};
}
it('bound physical closure settles before guardian exit and retains the launcher hard stop after guardian close',async()=>{
 const f=await start();await expect(f.subject.ready).resolves.toBeUndefined();alive.clear();f.send({kind:'STOPPED',receipt:f.receipt});
 await expect(f.subject.finished).resolves.toEqual(f.receipt);expect(transport.connected).toBe(true);expect(transport.exitCode).toBeNull();expect(transport.signalCode).toBeNull();
 transport.close();expect(()=>vi.advanceTimersByTime(9980)).toThrow(exitSentinel);expect(process.exit).toHaveBeenCalledWith(78);
 for(const pid of groupPids)expect(signals).toContainEqual({pid:-pid,signal:'SIGKILL'});
});
it.each(['deadline','parent','guardian','profile'] as const)('a schema-valid receipt with a forged %s binding never completes the launcher',async binding=>{
 const f=await start(false);let fulfilled=false;void f.subject.finished.then(()=>{fulfilled=true;},()=>{});
 const receipt={...f.receipt,...(binding==='deadline'?{deadlineAt:f.receipt.deadlineAt+1}:binding==='parent'?{parentPid:process.pid+1}:binding==='guardian'?{guardianPid:transport.pid+1}:{profileHash:'b'.repeat(64)})};
 f.send({kind:'STOPPED',receipt});await expect(f.subject.ready).rejects.toThrow('TRIAL_PROTOCOL_INVALID');await Promise.resolve();expect(fulfilled).toBe(false);expect(transport.sent).toContainEqual(expect.objectContaining({kind:'STOP',reason:'TRIAL_PROTOCOL_INVALID'}));
});
it.each(['duplicate','unregistered','alive','false-closed'] as const)('a %s group closure claim cannot settle or later turn a rejected receipt into success',async fault=>{
 const f=await start();await f.subject.ready;alive.clear();const receipt=structuredClone(f.receipt);
 if(fault==='duplicate')receipt.groups[1]={...receipt.groups[0]!};
 else if(fault==='unregistered')receipt.groups[1]!.pid=5000099;
 else if(fault==='alive')alive.add(groupPids[1]!);
 else receipt.groups[1]!.closed=false;
 f.send({kind:'STOPPED',receipt});await expect(f.subject.finished).rejects.toThrow('TRIAL_PROCESS_CLOSURE_UNCONFIRMED');alive.clear();transport.close();await expect(f.subject.finished).rejects.toThrow('TRIAL_PROCESS_CLOSURE_UNCONFIRMED');
});
