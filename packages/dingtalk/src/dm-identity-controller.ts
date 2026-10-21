import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DmDiagnosticSnapshot} from './dm-metadata-diagnostics.js';
import type {DmCaptureTransport} from './dm-metadata-controller.js';
import {DM_CAPTURE_MAX_MS,dmCaptureIdentitySchema,newDmCaptureNonce,type DmCaptureIdentity} from './dm-metadata.js';
import {dmIdentityDiagnosticSchema,type DmIdentityDiagnostic} from './dm-identity-diagnostic.js';
import {DmCaptureError,preflightDmMetadataOutput} from './dm-metadata-file.js';
import {writeDmIdentityDiagnostic} from './dm-identity-file.js';

export async function captureDmIdentityDiagnostic(options:{identity:DmCaptureIdentity;outputFile:string;transport:DmCaptureTransport&{readonly identityDiagnosticMode?:boolean};windowMs?:number;nonce?:string;signal?:AbortSignal;onChallenge?:(text:string)=>void;onDiagnostics?:(snapshot:DmDiagnosticSnapshot)=>void}){
 const identity=dmCaptureIdentitySchema.parse(options.identity),windowMs=z.number().int().positive().max(DM_CAPTURE_MAX_MS).parse(options.windowMs??DM_CAPTURE_MAX_MS),nonce=z.string().length(32).regex(/^[a-f0-9]{32}$/).parse(options.nonce??newDmCaptureNonce());
 if(options.transport.identityDiagnosticMode!==true)throw new DmCaptureError('DM_CAPTURE_DIAGNOSTIC_TRANSPORT_REQUIRED');
 if(options.signal?.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');const startedMono=performance.now(),startedWall=Date.now(),abortController=new AbortController();
 let stopping:Promise<void>|undefined,stopTimer:ReturnType<typeof setTimeout>|undefined,claimed=false,done=false,rejectObservation:(error:Error)=>void=()=>{},rejectAborted:(error:Error)=>void=()=>{};
 const stop=()=>{if(!stopping){let raw:Promise<void>;try{raw=options.transport.stop();}catch{raw=Promise.reject(new DmCaptureError('DM_CAPTURE_STOP_FAILED'));}const timeout=new Promise<never>((_resolve,reject)=>{stopTimer=setTimeout(()=>reject(new DmCaptureError('DM_CAPTURE_STOP_FAILED')),250);});stopping=Promise.race([raw,timeout]).catch(()=>{throw new DmCaptureError('DM_CAPTURE_STOP_FAILED');}).finally(()=>{if(stopTimer)clearTimeout(stopTimer);});void stopping.catch(()=>{});}return stopping;};
 const terminate=(code:string)=>{if(done||abortController.signal.aborted)return;const error=new DmCaptureError(code);abortController.abort();rejectObservation(error);rejectAborted(error);void stop().catch(()=>{});};
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAborted=reject;}),externalAbort=()=>terminate('DM_CAPTURE_ABORTED'),timer=setTimeout(()=>terminate('DM_CAPTURE_TIMEOUT'),windowMs);
 options.signal?.addEventListener('abort',externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
 const flow=async()=>{
  const outputFile=await preflightDmMetadataOutput(options.outputFile);if(abortController.signal.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');
  const observation=await new Promise<DmIdentityDiagnostic>((resolve,reject)=>{
   rejectObservation=reject;try{
    if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}
    options.transport.start({identity,nonce,windowMs,deadlineAt:startedWall+windowMs},value=>{
     if(claimed||abortController.signal.aborted)return;if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}
     const parsed=dmIdentityDiagnosticSchema.safeParse(value);if(!parsed.success){terminate('DM_IDENTITY_DIAGNOSTIC_INVALID');return;}const m=parsed.data,stamp=Date.parse(m.capturedAt),now=Date.now();
     if(m.senderStaffId!==identity.staffId||m.robotCode!==identity.robotCode||m.nonceHash!==createHash('sha256').update(nonce).digest('hex')||m.chatbotCorpMatchesConfigured!==(m.chatbotCorpId===identity.corpId)||m.senderCorpMatchesConfigured!==(m.senderCorpId===identity.corpId)||m.providerTime<startedWall-5000||m.providerTime>now+5000||stamp<startedWall-5000||stamp>now+5000){terminate('DM_IDENTITY_DIAGNOSTIC_INVALID');return;}
     claimed=true;void stop().catch(()=>{});resolve(m);
    },()=>terminate('DM_CAPTURE_TRANSPORT_FAILED'),()=>{if(claimed||abortController.signal.aborted)return;if(performance.now()-startedMono>=windowMs){terminate('DM_CAPTURE_TIMEOUT');return;}try{options.onChallenge?.('OA_BIND_DM_V1 '+nonce);}catch{terminate('DM_CAPTURE_TRANSPORT_FAILED');}},options.onDiagnostics);
   }catch{terminate('DM_CAPTURE_TRANSPORT_FAILED');}
  });
  await stop();const saved=await writeDmIdentityDiagnostic(outputFile,observation,abortController.signal);return {observation:saved,outputFile};
 };
 try{const result=await Promise.race([flow(),aborted]);done=true;return result;}catch(error){if(error instanceof DmCaptureError)throw error;throw new DmCaptureError(options.signal?.aborted?'DM_CAPTURE_ABORTED':'DM_CAPTURE_FAILED');}
 finally{done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort);await stop();}
}
