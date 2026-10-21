import {dmDiagnosticEnvelopeSchema,type DmDiagnosticSnapshot} from './dm-metadata-diagnostics.js';
import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import type {DmCaptureTransport} from './dm-metadata-controller.js';
import {DmCaptureError} from './dm-metadata-file.js';
export class OwnedDmMetadataTransport implements DmCaptureTransport {
 private child:ChildProcess|undefined;
 private closed:Promise<void>|undefined;
 private stopping:Promise<void>|undefined;
 private closeRequested=false;
 private started=false;private didClose=false;
 constructor(private readonly credentials:{clientId:string;clientSecret:string},private readonly childUrl:URL,private readonly purpose?:'IDENTITY_DIAGNOSTIC'){}
 get ownedChildClosed(){return this.didClose;}
 get identityDiagnosticMode(){return this.purpose==='IDENTITY_DIAGNOSTIC';}
 get ownedPid(){return this.child?.pid;}
 start(input:Parameters<DmCaptureTransport['start']>[0],onMetadata:(value:unknown)=>void,onFailure:()=>void,onReady?:()=>void,onDiagnostics?:(snapshot:DmDiagnosticSnapshot)=>void):void {
  if(this.started)throw new DmCaptureError('DM_CAPTURE_TRANSPORT_REUSED');this.started=true;
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  if(process.env['OA_TEST_ISOLATED']==='true')env['NODE_OPTIONS']='--import '+resolve('scripts/test-network-guard.mjs');
  const child=fork(fileURLToPath(this.childUrl),[],{env,execPath:process.execPath,execArgv:this.childUrl.pathname.endsWith('.ts')?['--import','tsx']:[],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});this.child=child;let captured=false,lastSequence=-1;
  this.closed=new Promise<void>(resolveClosed=>{
   child.once('error',()=>{if(!this.closeRequested)onFailure();});
   child.once('close',()=>{this.didClose=true;if(!captured&&!this.closeRequested)onFailure();resolveClosed();});
  });
  child.on('message',(raw:unknown)=>{
   if(this.closeRequested)return;
   if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='DIAGNOSTICS'){const parsed=dmDiagnosticEnvelopeSchema.safeParse(raw);if(!onDiagnostics||!parsed.success||parsed.data.snapshot.sequence<=lastSequence){onFailure();return;}lastSequence=parsed.data.snapshot.sequence;onDiagnostics(parsed.data.snapshot);return;}
   if(raw&&typeof raw==='object'&&Object.keys(raw).length===1&&'kind'in raw&&raw.kind==='READY'){onReady?.();return;}
   if(raw&&typeof raw==='object'&&Object.keys(raw).length===2&&'kind'in raw&&raw.kind===(this.purpose?'IDENTITY_DIAGNOSTIC':'METADATA')&&'value'in raw){captured=true;onMetadata(raw.value);}
   else onFailure();
  });
  child.send({kind:'START',...input,...(this.purpose?{mode:this.purpose}:{}),...(onDiagnostics?{diagnostics:true}:{}),credentials:this.credentials},error=>{if(error&&!this.closeRequested)onFailure();});
 }
 forceKill():void {
  this.closeRequested=true;const c=this.child;if(c?.pid&&c.exitCode===null&&c.signalCode===null){try{if(!c.kill('SIGKILL')&&c.connected)c.disconnect();}catch{try{if(c.connected)c.disconnect();}catch{}}}
 }
 stop():Promise<void>{
  if(!this.stopping){this.forceKill();if(!this.child){this.stopping=Promise.resolve();}else{let timer:ReturnType<typeof setTimeout>;const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new DmCaptureError('DM_CAPTURE_STOP_FAILED')),200);});this.stopping=Promise.race([this.closed!,timeout]).finally(()=>clearTimeout(timer));}}
  return this.stopping;
 }
}
