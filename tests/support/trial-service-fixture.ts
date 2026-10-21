import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isolatedTrialFixtureAllowed} from '../../packages/runtime/src/trial-supervision.js';
export async function runTrialServiceFixture(mode:string,directory:string,service:string){
 if(!isolatedTrialFixtureAllowed())throw Error('TRIAL_FIXTURE_ISOLATION_REQUIRED');
 if(mode==='busy'){setTimeout(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);},10);return;}
 if(mode==='grandchild'){
  const env=Object.fromEntries(['PATH','NODE_OPTIONS','APP_ENV','OA_TEST_ISOLATED'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{env,stdio:'ignore'});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  await writeFile(join(directory,service+'.grandchild.pid'),String(child.pid),{flag:'wx',mode:0o600});
  const interval=setInterval(()=>{},1000);process.once('SIGTERM',()=>{clearInterval(interval);child.kill('SIGTERM');child.once('close',()=>process.exit(0));});return;
 }
 if(mode!=='idle')throw Error('TRIAL_FIXTURE_MODE_INVALID');
 const timer=setInterval(()=>{},1000);process.once('SIGTERM',()=>{clearInterval(timer);process.exit(0);});
}
