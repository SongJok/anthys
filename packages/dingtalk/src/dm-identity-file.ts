import {open,link,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DmCaptureError,preflightDmMetadataOutput} from './dm-metadata-file.js';
import {dmIdentityDiagnosticSchema,type DmIdentityDiagnostic} from './dm-identity-diagnostic.js';

export async function writeDmIdentityDiagnostic(path:string,value:unknown,signal?:AbortSignal):Promise<DmIdentityDiagnostic>{
 const parsed=dmIdentityDiagnosticSchema.safeParse(value);if(!parsed.success)throw new DmCaptureError('DM_IDENTITY_DIAGNOSTIC_INVALID');
 signal?.throwIfAborted();const target=await preflightDmMetadataOutput(path),temp=target+'.'+randomUUID()+'.pending';let created=false;
 try{
  const f=await open(temp,'wx',0o600);created=true;try{await f.writeFile(JSON.stringify(parsed.data,null,2)+'\n');await f.sync();}finally{await f.close();}
  signal?.throwIfAborted();await link(temp,target);const d=await open(dirname(target),'r');try{await d.sync();}finally{await d.close();}return parsed.data;
 }catch(error){if(signal?.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');if(error instanceof DmCaptureError)throw error;throw new DmCaptureError((error as {code?:string}).code==='EEXIST'?'DM_CAPTURE_OUTPUT_EXISTS':'DM_CAPTURE_OUTPUT_FAILED');}
 finally{if(created)await unlink(temp).catch(()=>{});}
}
