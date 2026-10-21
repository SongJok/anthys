import {DmIdentityDiagnosticFilter,type DmIdentityDiagnostic} from './dm-identity-diagnostic.js';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import type {DWClient,DWClientDownStream} from 'dingtalk-stream';
import {DmDiagnosticCounters} from './dm-metadata-diagnostics.js';
import {createDmMetadataClient,observeDmMetadataClient} from './dm-metadata-sdk.js';
import {DmCaptureFilter,dmCaptureIdentitySchema,DM_CAPTURE_MAX_MS,type DmMetadata,type DmCaptureIdentity} from './dm-metadata.js';
const startSchema=z.object({kind:z.literal('START'),identity:dmCaptureIdentitySchema,nonce:z.string().regex(/^[a-f0-9]{32}$/),windowMs:z.number().int().positive().max(DM_CAPTURE_MAX_MS),deadlineAt:z.number().int().positive(),diagnostics:z.literal(true).optional(),mode:z.literal('IDENTITY_DIAGNOSTIC').optional(),credentials:z.object({clientId:z.string().min(1).max(512),clientSecret:z.string().min(1).max(4096)}).strict()}).strict();
export function runDmMetadataChild(makeClient:(credentials:{clientId:string;clientSecret:string},callback:(message:DWClientDownStream)=>void,context:{identity:DmCaptureIdentity;nonce:string;windowMs:number})=>DWClient=createDmMetadataClient):void {
 if(!process.send){process.exitCode=64;return;}
 let diagnostics:DmDiagnosticCounters|undefined,sequence=0,lastDiagnostic='';
 const publish=(terminal=false)=>{if(done&&!terminal||!diagnostics||!process.connected||sequence>=129||sequence>=128&&!terminal)return;if(sequence===127)diagnostics.mark('truncated');const plain=JSON.stringify(diagnostics.snapshot());if(plain===lastDiagnostic&&!terminal)return;lastDiagnostic=plain;sequence++;try{process.send?.({kind:'DIAGNOSTICS',snapshot:diagnostics.snapshot(sequence)},undefined,undefined,error=>{if(error)failed();});}catch{failed();}};
 let done=false,client:DWClient|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const finish=(payload:{kind:'ERROR'}|{kind:'METADATA';value:DmMetadata}|{kind:'IDENTITY_DIAGNOSTIC';value:DmIdentityDiagnostic},code:number)=>{
  if(done)return;done=true;publish(true);if(timer)clearTimeout(timer);try{client?.disconnect();}catch{}
  const force=setTimeout(()=>process.exit(code),100);force.unref();process.exitCode=code;
  if(process.connected)try{process.send?.(payload,undefined,undefined,()=>process.exit(code));}catch{process.exit(code);}else process.exit(code);
 };
 const failed=()=>finish({kind:'ERROR'},1);
 process.once('disconnect',()=>{done=true;try{client?.disconnect();}catch{}process.exit(1);});
 process.once('SIGINT',()=>finish({kind:'ERROR'},130));process.once('SIGTERM',()=>finish({kind:'ERROR'},143));
 process.once('uncaughtException',failed);process.once('unhandledRejection',failed);
 timer=setTimeout(failed,5000);
 process.once('message',(raw:unknown)=>{
  const parsed=startSchema.safeParse(raw);if(!parsed.success){failed();return;}const input=parsed.data,remaining=Math.min(input.windowMs,input.deadlineAt-Date.now());
  if(remaining<=0){failed();return;}if(timer)clearTimeout(timer);timer=setTimeout(failed,remaining);const cutoff=performance.now()+remaining;
  try{
   const req=createRequire(import.meta.url),version=(JSON.parse(readFileSync(req.resolve('dingtalk-stream/package.json'),'utf8')) as {version?:string}).version;if(version?.replace(/^v/,'')!=='2.1.5'){failed();return;}
   if(input.diagnostics){diagnostics=new DmDiagnosticCounters();publish();}const filterOptions={identity:input.identity,nonce:input.nonce,windowMs:Math.floor(remaining),...(diagnostics?{diagnostics}:{})},filter=input.mode?undefined:new DmCaptureFilter(filterOptions),identityFilter=input.mode?new DmIdentityDiagnosticFilter(filterOptions):undefined;
   client=makeClient(input.credentials,message=>{
    diagnostics?.increment('listenerCallbacks');if(done||performance.now()>=cutoff){diagnostics?.reject('inactive');publish();return;}
    if(identityFilter){const observation=identityFilter.accept(message);publish();if(observation)finish({kind:'IDENTITY_DIAGNOSTIC',value:observation},78);return;}
    const matched=filter!.accept(message);if(!matched){publish();return;}
    try{diagnostics?.increment('protocolAckCalls');client!.socketCallBackResponse(matched.protocolMessageId,{status:'SUCCESS'});publish();finish({kind:'METADATA',value:matched.metadata},0);}catch{diagnostics?.increment('protocolAckErrors');publish();failed();}
   },{identity:input.identity,nonce:input.nonce,windowMs:input.windowMs});
   if(diagnostics)observeDmMetadataClient(client,diagnostics,()=>publish());
   // The pinned SDK can resolve getEndpoint after disconnect. Refuse both new
   // endpoint requests and socket construction after closure or the cutoff.
   const endpoint=client.getEndpoint.bind(client),connect=client._connect.bind(client);
   client.getEndpoint=async()=>{if(done||performance.now()>=cutoff)throw Error('DM_CAPTURE_CLOSED');return endpoint();};
   client._connect=async()=>{if(done||performance.now()>=cutoff)throw Error('DM_CAPTURE_CLOSED');return connect();};
   void client.connect().then(()=>{if(done)return;if(!client?.connected){failed();return;}diagnostics?.mark('readyConnectedFlag');publish();if(process.connected)process.send?.({kind:'READY'},undefined,undefined,error=>{if(error)failed();});},failed);
  }catch{failed();}
 });
}
