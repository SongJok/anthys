import {constants} from 'node:fs';
import {open,lstat,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
export async function readOperationsPrivateFile(path:string,maxBytes:number):Promise<Buffer>{
 if(!isAbsolute(path)||await realpath(path)!==path)throw Error('OPERATIONS_PRIVATE_INPUT_REQUIRED');
 const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw Error('OPERATIONS_PRIVATE_INPUT_REQUIRED');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=await file.stat();if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<1||before.size>maxBytes)throw Error('OPERATIONS_PRIVATE_INPUT_REQUIRED');
  const bytes=Buffer.alloc(before.size+1);let total=0;while(total<bytes.length){const read=await file.read(bytes,total,bytes.length-total,null);if(!read.bytesRead)break;total+=read.bytesRead;}const after=await file.stat(),named=await lstat(path),currentParent=await lstat(dirname(path));
  if(total!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==named.ino||before.dev!==named.dev||parent.ino!==currentParent.ino||parent.dev!==currentParent.dev||await realpath(path)!==path)throw Error('OPERATIONS_PRIVATE_INPUT_CHANGED');return bytes.subarray(0,total);
 }finally{await file.close();}
}
export type PrivateFileStamp={dev:number;ino:number};
export class PrivateFileCommitUncertain extends Error{constructor(){super('OPERATIONS_PRIVATE_OUTPUT_COMMIT_UNCERTAIN');}}
/** Returns the identity captured from the exclusively CREATED descriptor, never
 * reclaims a later path occupant. Unconfirmed cleanup/close must be reconciled. */
export async function writeOperationsPrivateFile(path:string,bytes:Buffer,signal?:AbortSignal):Promise<PrivateFileStamp>{
 signal?.throwIfAborted();
 if(!isAbsolute(path)||bytes.length>4*1024*1024)throw Error('OPERATIONS_PRIVATE_OUTPUT_REQUIRED');const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0||await realpath(dirname(path))!==dirname(path))throw Error('OPERATIONS_PRIVATE_OUTPUT_REQUIRED');
 signal?.throwIfAborted();let file:Awaited<ReturnType<typeof open>>|undefined,owned:PrivateFileStamp|undefined,created=false;
 try{
  file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;const initial=await file.stat();owned={dev:initial.dev,ino:initial.ino};
  await file.writeFile(bytes);await file.sync();signal?.throwIfAborted();const after=await lstat(path),currentParent=await lstat(dirname(path));
  if(currentParent.ino!==parent.ino||currentParent.dev!==parent.dev||currentParent.uid!==parent.uid||currentParent.mode!==parent.mode||await realpath(dirname(path))!==dirname(path)||after.ino!==owned.ino||after.dev!==owned.dev||after.uid!==process.getuid?.()||(after.mode&0o777)!==0o600||after.nlink!==1)throw Error('OPERATIONS_PRIVATE_OUTPUT_CHANGED');
  await file.close();file=undefined;return owned;
 }catch(error){
  let closed=true;try{await file?.close();}catch{closed=false;}file=undefined;
  if(!created)throw error;
  let cleaned=false;
  try{const named=await lstat(path),currentParent=await lstat(dirname(path));if(owned&&named.ino===owned.ino&&named.dev===owned.dev&&currentParent.ino===parent.ino&&currentParent.dev===parent.dev&&await realpath(dirname(path))===dirname(path)){
   await unlink(path);const dir=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}cleaned=true;
  }}catch{/* Ambiguous identity, unlink, close or fsync is never a clean failure. */}
  if(!closed||!cleaned)throw new PrivateFileCommitUncertain();throw error;
 }
}
