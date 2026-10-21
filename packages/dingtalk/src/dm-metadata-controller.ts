import type {DmDiagnosticSnapshot} from './dm-metadata-diagnostics.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {DM_CAPTURE_MAX_MS,dmCaptureIdentitySchema,dmMetadataSchema,newDmCaptureNonce,type DmCaptureIdentity,type DmMetadata} from './dm-metadata.js';
import {DmCaptureError,preflightDmMetadataOutput,writeDmMetadata} from './dm-metadata-file.js';
export interface DmCaptureTransport {
 start(input:{identity:DmCaptureIdentity;nonce:string;windowMs:number;deadlineAt:number},onMetadata:(value:unknown)=>void,onFailure:()=>void,onReady?:()=>void,onDiagnostics?:(snapshot:DmDiagnosticSnapshot)=>void):void;
 stop():Promise<void>;
}
export async function captureDmMetadata(options:{identity:DmCaptureIdentity;outputFile:string;transport:DmCaptureTransport;windowMs?:number;nonce?:string;signal?:AbortSignal;onChallenge?:(text:string)=>void;onDiagnostics?:(snapshot:DmDiagnosticSnapshot)=>void}){
 const identity=dmCaptureIdentitySchema.parse(options.identity),windowMs=z.number().int().positive().max(DM_CAPTURE_MAX_MS).parse(options.windowMs??DM_CAPTURE_MAX_MS),nonce=z.string().regex(/^[a-f0-9]{32}$/).parse(options.nonce??newDmCaptureNonce());
 if(options.signal?.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');const startedMono=performance.now(),startedWall=Date.now(),abortController=new AbortController();
 let stopping:Promise<void>|undefined,stopTimer:ReturnType<typeof setTimeout>|undefined,metadataClaimed=false,done=false,rejectMetadata:(error:Error)=>void=()=>{},rejectAborted:(error:Error)=>void=()=>{};
 const stop=()=>{
  if(!stopping){let raw:Promise<void>;try{raw=options.transport.stop();}catch{raw=Promise.reject(new DmCaptureError('DM_CAPTURE_STOP_FAILED'));}
   const timeout=new Promise<never>((_resolve,reject)=>{stopTimer=setTimeout(()=>reject(new DmCaptureError('DM_CAPTURE_STOP_FAILED')),250);});
   stopping=Promise.race([raw,timeout]).catch(()=>{throw new DmCaptureError('DM_CAPTURE_STOP_FAILED');}).finally(()=>{if(stopTimer)clearTimeout(stopTimer);});void stopping.catch(()=>{});
  }return stopping;
 };
 const terminate=(code:string)=>{if(done||abortController.signal.aborted)return;const error=new DmCaptureError(code);abortController.abort();rejectMetadata(error);rejectAborted(error);void stop().catch(()=>{});};
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAborted=reject;}),externalAbort=()=>terminate('DM_CAPTURE_ABORTED'),timer=setTimeout(()=>terminate('DM_CAPTURE_TIMEOUT'),windowMs);
 options.signal?.addEventListener('abort',externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
 const flow=async()=>{
  const outputFile=await preflightDmMetadataOutput(options.outputFile);if(abortController.signal.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');
  const metadata=await new Promise<DmMetadata>((resolve,reject)=>{
   rejectMetadata=reject;
   try{
    if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}
    options.transport.start({identity,nonce,windowMs,deadlineAt:startedWall+windowMs},value=>{
     if(metadataClaimed||abortController.signal.aborted)return;if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}
     const parsed=dmMetadataSchema.safeParse(value);if(!parsed.success){terminate('DM_CAPTURE_METADATA_INVALID');return;}const m=parsed.data,stamp=Date.parse(m.capturedAt),now=Date.now();
     if(m.corpId!==identity.corpId||m.staffId!==identity.staffId||m.robotCode!==identity.robotCode||m.nonceHash!==createHash('sha256').update(nonce).digest('hex')||m.providerTime<startedWall-5000||m.providerTime>now+5000||stamp<startedWall-5000||stamp>now+5000){terminate('DM_CAPTURE_METADATA_INVALID');return;}
     metadataClaimed=true;void stop().catch(()=>{});resolve(m);
    },()=>terminate('DM_CAPTURE_TRANSPORT_FAILED'),()=>{if(metadataClaimed||abortController.signal.aborted)return;if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}try{options.onChallenge?.('OA_BIND_DM_V1 '+nonce);}catch{terminate('DM_CAPTURE_TRANSPORT_FAILED');}},options.onDiagnostics);
   }catch{terminate('DM_CAPTURE_TRANSPORT_FAILED');}
  });
  await stop();const metadataWritten=await writeDmMetadata(outputFile,metadata,abortController.signal);return {metadata:metadataWritten,outputFile};
 };
 try{const result=await Promise.race([flow(),aborted]);done=true;return result;}
 catch(error){if(error instanceof DmCaptureError)throw error;throw new DmCaptureError(options.signal?.aborted?'DM_CAPTURE_ABORTED':'DM_CAPTURE_FAILED');}
 finally{done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort);await stop();}
}
