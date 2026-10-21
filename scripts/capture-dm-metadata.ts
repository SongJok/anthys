import {captureDmIdentityDiagnostic} from '../packages/dingtalk/src/dm-identity-controller.js';
import {dmDiagnosticSnapshotSchema,type DmDiagnosticSnapshot} from '../packages/dingtalk/src/dm-metadata-diagnostics.js';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureDmMetadata} from '../packages/dingtalk/src/dm-metadata-controller.js';
import {type DmCaptureIdentity} from '../packages/dingtalk/src/dm-metadata.js';
import {DmCaptureError} from '../packages/dingtalk/src/dm-metadata-file.js';
import {readDmCaptureConfiguration} from '../packages/dingtalk/src/dm-metadata-configuration.js';
import {OwnedDmMetadataTransport} from '../packages/dingtalk/src/dm-metadata-owned.js';
const help='Offline by default. After separate authorization only: node --import tsx scripts/capture-dm-metadata.ts --live --env-file /absolute/path/to/project/.env --seconds 180 --output .data/dm-capture/metadata.json\nCaptures only one exact self/robot/DM nonce. No tasks, models, chat replies or trial activation. Optional --nonce accepts exactly 32 lowercase hexadecimal characters; without it a fresh CSPRNG nonce is generated. The challenge is printed only after SDK READY. Optional --diagnostics emits only bounded counters and SDK lifecycle flags. Explicit --identity-diagnostic-output <path> is exclusive with --output: it records untrusted private identity evidence only, returns78, and never ACKs or accepts metadata.\n';
export async function runCaptureCli(argv:string[],dependencies:{readConfig?:(envFile:string)=>Promise<{identity:DmCaptureIdentity;credentials:{clientId:string;clientSecret:string}}>;makeTransport?:(credentials:{clientId:string;clientSecret:string},purpose?:'IDENTITY_DIAGNOSTIC')=>OwnedDmMetadataTransport}={}):Promise<number>{
 if(!argv.length||argv.length===1&&argv[0]==='--help'){process.stdout.write(help);return 0;}
 let diagnosticsEnabled=false;let nonce:string|undefined,identityOutput:string|undefined;let seconds=180,output='.data/dm-capture/metadata.json',envFile=resolve('.env');if(argv[0]!=='--live'){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}
 const seen=new Set(['--live']);for(let i=1;i<argv.length;){const key=argv[i];if(!key||seen.has(key)||!['--diagnostics','--seconds','--output','--env-file','--nonce','--identity-diagnostic-output'].includes(key)){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}seen.add(key);if(key==='--diagnostics'){diagnosticsEnabled=true;i++;continue;}const value=argv[i+1];if(!value||value.startsWith('--')){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}if(key==='--nonce'){if(value.length!==32||!/^[a-f0-9]{32}$/.test(value)){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}nonce=value;}else if(key==='--identity-diagnostic-output')identityOutput=value;else if(key==='--seconds')seconds=Number(value);else if(key==='--env-file')envFile=resolve(value);else output=value;i+=2;}
 if(identityOutput!==undefined){if(seen.has('--output')){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}output=identityOutput;}
 if(!Number.isInteger(seconds)||seconds<1||seconds>180||dirname(resolve(output))!==resolve('.data/dm-capture')||!/^[-a-zA-Z0-9_.]+\.json$/.test(basename(output))){process.stderr.write('DM_CAPTURE_USAGE\n');return 64;}
 let transport:OwnedDmMetadataTransport|undefined,watchdog:ReturnType<typeof setTimeout>|undefined,softTimer:ReturnType<typeof setTimeout>|undefined,interruptFallback:ReturnType<typeof setTimeout>|undefined,requestedCode:number|undefined,reported=false;
 let latestDiagnostic:DmDiagnosticSnapshot|undefined,diagnosticPrinted=false;const printDiagnostic=()=>{if(!diagnosticsEnabled||diagnosticPrinted)return;diagnosticPrinted=true;process.stderr.write(JSON.stringify({type:'DM_CAPTURE_DIAGNOSTICS_V1',observed:latestDiagnostic!==undefined,snapshot:latestDiagnostic??null,ownedChildClosed:transport?.ownedChildClosed===true})+'\n');};
 const controller=new AbortController(),exitCleanup=()=>{try{transport?.forceKill();}catch{}},report=(code:string)=>{if(!reported){reported=true;process.stderr.write(code+'\n');}},interrupted=()=>{requestedCode=130;controller.abort();exitCleanup();report('DM_CAPTURE_ABORTED');interruptFallback=setTimeout(()=>{exitCleanup();printDiagnostic();process.exit(130);},200);};
 try{
  const startedMono=performance.now(),softDeadline=startedMono+seconds*1000-250;process.once('exit',exitCleanup);process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  // Reserve bounded cleanup time inside the advertised total window. The hard
  // watchdog still kills the owned child if config, I/O or stop never settles.
  watchdog=setTimeout(()=>{exitCleanup();report('DM_CAPTURE_TIMEOUT');printDiagnostic();process.exit(requestedCode??124);},seconds*1000);
  softTimer=setTimeout(()=>{requestedCode=124;controller.abort();exitCleanup();report('DM_CAPTURE_TIMEOUT');},Math.max(1,seconds*1000-250));
  const config=await(dependencies.readConfig??readDmCaptureConfiguration)(envFile),child=new URL('capture-dm-metadata-child'+(import.meta.url.endsWith('.ts')?'.ts':'.js'),import.meta.url);
  const purpose=identityOutput===undefined?undefined:'IDENTITY_DIAGNOSTIC';transport=dependencies.makeTransport?.(config.credentials,purpose)??new OwnedDmMetadataTransport(config.credentials,child,purpose);
  const remaining=Math.floor(softDeadline-performance.now());if(remaining<=0)throw new DmCaptureError('DM_CAPTURE_TIMEOUT');
  const options={identity:config.identity,outputFile:output,transport,...(nonce===undefined?{}:{nonce}),windowMs:remaining,signal:controller.signal,onChallenge:(text:string)=>process.stdout.write(text+'\n'),...(diagnosticsEnabled?{onDiagnostics:(value:DmDiagnosticSnapshot)=>{latestDiagnostic=dmDiagnosticSnapshotSchema.parse(value);}}:{})};
  if(identityOutput!==undefined){await captureDmIdentityDiagnostic(options);process.stdout.write(JSON.stringify({status:'IDENTITY_DIAGNOSTIC_RECORDED_UNTRUSTED',outputFile:output,trusted:false,metadataAccepted:false,trialActivated:false,modelCalls:0,chatReplies:0})+'\n');return 78;}
  await captureDmMetadata(options);
  process.stdout.write(JSON.stringify({status:'CAPTURED_METADATA_ONLY',outputFile:output,trialActivated:false,modelCalls:0,chatReplies:0})+'\n');return 0;
 }catch(error){report(error instanceof DmCaptureError?error.code:'DM_CAPTURE_FAILED');return requestedCode??1;}
 finally{exitCleanup();try{await transport?.stop();}catch{report('DM_CAPTURE_STOP_FAILED');}printDiagnostic();if(watchdog)clearTimeout(watchdog);if(softTimer)clearTimeout(softTimer);if(interruptFallback)clearTimeout(interruptFallback);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);process.removeListener('exit',exitCleanup);}

}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){void runCaptureCli(process.argv.slice(2)).then(code=>process.exit(code),()=>{process.stderr.write('DM_CAPTURE_FAILED\n');process.exit(1);});}
