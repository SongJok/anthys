import {mkdir,lstat,realpath,open,link,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dmMetadataSchema,type DmMetadata} from './dm-metadata.js';
export class DmCaptureError extends Error{constructor(readonly code:string){super(code);}}
export async function preflightDmMetadataOutput(path:string):Promise<string>{
 const target=resolve(path),parent=dirname(target);try{
  await mkdir(parent,{recursive:true,mode:0o700});const d=await lstat(parent);
  if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o777)!==0o700||await realpath(parent)!==parent)throw new DmCaptureError('DM_CAPTURE_PRIVATE_DIRECTORY_REQUIRED');
  try{await lstat(target);throw new DmCaptureError('DM_CAPTURE_OUTPUT_EXISTS');}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
  return target;
 }catch(error){if(error instanceof DmCaptureError)throw error;throw new DmCaptureError('DM_CAPTURE_OUTPUT_UNAVAILABLE');}
}
export async function writeDmMetadata(path:string,value:unknown,signal?:AbortSignal):Promise<DmMetadata>{
 const parsed=dmMetadataSchema.safeParse(value);if(!parsed.success)throw new DmCaptureError('DM_CAPTURE_METADATA_INVALID');
 signal?.throwIfAborted();const target=await preflightDmMetadataOutput(path),temp=target+'.'+randomUUID()+'.pending';let created=false;
 try{
  const f=await open(temp,'wx',0o600);created=true;try{await f.writeFile(JSON.stringify(parsed.data,null,2)+'\n');await f.sync();}finally{await f.close();}
  signal?.throwIfAborted();await link(temp,target);const d=await open(dirname(target),'r');try{await d.sync();}finally{await d.close();}return parsed.data;
 }catch(error){if(signal?.aborted)throw new DmCaptureError('DM_CAPTURE_ABORTED');if(error instanceof DmCaptureError)throw error;throw new DmCaptureError((error as {code?:string}).code==='EEXIST'?'DM_CAPTURE_OUTPUT_EXISTS':'DM_CAPTURE_OUTPUT_FAILED');}
 finally{if(created)await unlink(temp).catch(()=>{});}
}
