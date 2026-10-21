import {z} from 'zod';
import {trialServiceSchema,trialFixtureSchema,trialOwnedMarker,trialEnvironmentMarker,trialRemainingMs,isolatedTrialFixtureAllowed,type TrialDeadline} from './trial-supervision.js';
const bootSchema=z.object({kind:z.literal('BOOT'),executionToken:z.string().regex(/^[a-f0-9]{32}$/),guardianPid:z.number().int().positive(),profileHash:z.string().regex(/^[a-f0-9]{64}$/),deadlineAt:z.number().int().positive(),monoDeadlineNs:z.string().regex(/^\d{1,30}$/),service:trialServiceSchema,runtimeDirectory:z.string(),fixture:trialFixtureSchema.optional()}).strict();
let boot:z.infer<typeof bootSchema>|undefined,bound:TrialDeadline|undefined,armed=false;
function message(kind:'HELLO'|'SERVICE_READY'|'SERVICE_FAILED'){if(boot&&process.connected)process.send?.({kind,executionToken:boot.executionToken,pid:process.pid,parentPid:process.ppid},undefined,undefined,()=>{});}
function terminate(){if(boot&&boot.guardianPid===process.ppid){try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(78);}}else process.exit(78);}
process.on('message',(raw:unknown)=>{
 if(!boot){
  const parsed=bootSchema.safeParse(raw);if(!parsed.success||!process.connected||parsed.data.guardianPid!==process.ppid){process.exit(78);return;}boot=parsed.data;bound={deadlineAt:boot.deadlineAt,monoDeadlineNs:BigInt(boot.monoDeadlineNs)};
  if(trialRemainingMs(bound)<=100||trialRemainingMs(bound)>1200000||boot.fixture&&!isolatedTrialFixtureAllowed()){terminate();return;}
  Reflect.set(globalThis,trialEnvironmentMarker,true);
  setInterval(()=>{if(!bound||trialRemainingMs(bound)<=50||!process.connected||process.ppid!==boot!.guardianPid)terminate();},20);
  message('HELLO');return;
 }
 const arm=z.object({kind:z.literal('ARM'),executionToken:z.string()}).strict().safeParse(raw);
 if(!arm.success||arm.data.executionToken!==boot.executionToken||armed||!bound||trialRemainingMs(bound)<=100){terminate();return;}armed=true;
 Reflect.set(globalThis,trialOwnedMarker,{profileHash:boot.profileHash,deadlineAt:boot.deadlineAt,service:boot.service,guardianPid:boot.guardianPid,pid:process.pid});
 const spec=boot;
 void (async()=>{
  const extension=import.meta.url.endsWith('.ts')?'.ts':'.js';
  if(spec.fixture&&spec.fixture!=='native-worker'){
   if(!isolatedTrialFixtureAllowed())throw Error('TRIAL_FIXTURE_FORBIDDEN');
   const fixture=await import(new URL('../../../tests/support/trial-service-fixture'+extension,import.meta.url).href) as {runTrialServiceFixture:(mode:string,directory:string,service:string)=>Promise<void>};
   await fixture.runTrialServiceFixture(spec.fixture,spec.runtimeDirectory,spec.service);
  }else{
   if(spec.fixture==='native-worker'&&spec.service!=='worker')throw Error('TRIAL_FIXTURE_ROLE_MISMATCH');
   await import(new URL('../../../apps/'+spec.service+'/src/main'+extension,import.meta.url).href);
  }
  message('SERVICE_READY');
 })().catch(()=>{message('SERVICE_FAILED');terminate();});
});
process.once('disconnect',terminate);
// Actual entrypoints own graceful shutdown; the independent guardian enforces
// the bounded KILL deadline even if their handlers/queue.stop cannot complete.
process.on('SIGTERM',()=>{});
process.on('SIGINT',()=>{});
setTimeout(()=>{if(!armed)terminate();},5000).unref();
