import {TrialSupervisor,type TrialSupervisorOptions} from '../../packages/runtime/src/trial-supervisor.js';
import {isolatedTrialFixtureAllowed} from '../../packages/runtime/src/trial-supervision.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(!isolatedTrialFixtureAllowed()||!process.connected)throw Error('SUPERVISOR_PARENT_FIXTURE_REQUIRED');
let supervisor:TrialSupervisor|undefined;
process.on('message',(raw:unknown)=>{
 if(!supervisor){
  const options=raw as Omit<TrialSupervisorOptions,'env'|'onEvent'>;
  supervisor=new TrialSupervisor({...options,env:process.env,onEvent:event=>{if(event.kind!=='PONG')process.send?.({kind:'EVENT',event},undefined,undefined,()=>{});if(event.kind==='STOPPED'&&process.env['OA_TRIAL_TEST_PAUSE_AFTER_STOPPED']==='true'){writeFileSync(join(options.runtimeDirectory,'pause-after-stopped'),'1',{mode:0o600,flag:'wx'});process.kill(process.pid,'SIGSTOP');}}});
  void supervisor.ready.then(()=>{process.send?.({kind:'READY',guardianPid:supervisor!.guardian.pid,ownedPids:supervisor!.ownedPids},undefined,undefined,()=>{});}).catch(()=>{});
  void supervisor.finished.then(receipt=>{process.send?.({kind:'FINISHED',receipt},undefined,undefined,()=>{process.exit(0);});}).catch(()=>{process.send?.({kind:'FAILED'},undefined,undefined,()=>{process.exit(78);});});
 }else if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='STOP')void supervisor.stop();
});
process.once('disconnect',()=>{if(supervisor)void supervisor.stop();else process.exit(78);});
