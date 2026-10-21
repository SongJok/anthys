import {constants,type ReadStream} from 'node:fs';
import {lstat,realpath,open,mkdtemp,unlink,rmdir,type FileHandle} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {isAbsolute,join,parse,resolve,sep} from 'node:path';
import {Readable} from 'node:stream';
import {types} from 'node:util';
import {finished} from 'node:stream/promises';
import {z} from 'zod';

// A conservative implementation limit, not the product's backup/RPO requirement.
export const PRIVATE_ARCHIVE_MAX_BYTES=8*1024*1024*1024;
const MAGIC=Buffer.from('OAARC001'),HEADER_LIMIT=4096,SUMMARY_BYTES=96,FOOTER_BYTES=SUMMARY_BYTES+16,CHUNK=64*1024;
const payloadDomain=Buffer.from('OA_ARCHIVE_PAYLOAD_V1\0'),summaryDomain=Buffer.from('OA_ARCHIVE_MANIFEST_V1\0');
const metadataSchema=z.strictObject({keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),sourceSchemaFingerprint:z.string().regex(/^[a-f0-9]{64}$/),type:z.enum(['POSTGRES_DUMP','FILESTORE_SNAPSHOT'])});
export type ArchiveMetadata=z.infer<typeof metadataSchema>;
const headerSchema=z.strictObject({version:z.literal(1),backupId:z.uuid().regex(/^[a-f0-9-]+$/),metadata:metadataSchema,dataIv:z.string().regex(/^[a-f0-9]{24}$/),summaryIv:z.string().regex(/^[a-f0-9]{24}$/)});
type Header=z.infer<typeof headerSchema>;
export type ArchiveErrorCode='ARCHIVE_OPTIONS_INVALID'|'ARCHIVE_ROOT_UNSAFE'|'ARCHIVE_ROOT_CHANGED'|'ARCHIVE_FILE_UNSAFE'|'ARCHIVE_EXISTS'|'ARCHIVE_CANCELLED'|'ARCHIVE_LIMIT'|'ARCHIVE_INPUT_FAILED'|'ARCHIVE_FORMAT_INVALID'|'ARCHIVE_METADATA_MISMATCH'|'ARCHIVE_AUTHENTICATION_FAILED'|'ARCHIVE_INTEGRITY_FAILED'|'ARCHIVE_IO_FAILED'|'ARCHIVE_CLEANUP_FAILED'|'ARCHIVE_LEASE_CLOSED';
export class ArchiveError extends Error{constructor(readonly code:ArchiveErrorCode){super(code);this.name='ArchiveError';}}
function fail(code:ArchiveErrorCode):never{throw new ArchiveError(code);}
function check(signal:AbortSignal){if(signal.aborted)fail('ARCHIVE_CANCELLED');}
type Stamp={path:string;dev:number;ino:number;uid:number;mode:number};
export type PrivateArchiveOptions={root:string;backupId:string;key:Buffer;maxBytes:number;signal:AbortSignal};
export type WritePrivateArchiveInput=PrivateArchiveOptions&{metadata:ArchiveMetadata;input:Readable};
export type OpenPrivateArchiveInput=PrivateArchiveOptions&{expectedMetadata:ArchiveMetadata};
export type ArchiveReceipt={version:1;backupId:string;metadata:ArchiveMetadata;algorithm:'AES-256-GCM';plaintext:{byteSize:number;sha256:string};ciphertext:{byteSize:number;sha256:string};archive:{byteSize:number;sha256:string}};
const receiptBytes=z.strictObject({byteSize:z.number().int().nonnegative().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const archiveReceiptSchema=z.strictObject({version:z.literal(1),backupId:z.uuid().regex(/^[a-f0-9-]+$/),metadata:metadataSchema,algorithm:z.literal('AES-256-GCM'),plaintext:receiptBytes,ciphertext:receiptBytes,archive:receiptBytes});
export type PlaintextLease={receipt:ArchiveReceipt;plaintextPath:string;openReadStream:()=>Promise<ReadStream>;cleanup:()=>Promise<void>};

function metadata(value:unknown):ArchiveMetadata{
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('ARCHIVE_OPTIONS_INVALID');
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!('value'in descriptors[k]!)))fail('ARCHIVE_OPTIONS_INVALID');
 const parsed=metadataSchema.safeParse(value);if(!parsed.success)fail('ARCHIVE_OPTIONS_INVALID');return Object.freeze(parsed.data);
}
function options(value:PrivateArchiveOptions){
 if(typeof value.root!=='string'||!isAbsolute(value.root)||resolve(value.root)!==value.root||value.root===parse(value.root).root||value.root.includes('\0')||!z.uuid().safeParse(value.backupId).success||!Buffer.isBuffer(value.key)||value.key.length!==32||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>PRIVATE_ARCHIVE_MAX_BYTES||!(value.signal instanceof AbortSignal))fail('ARCHIVE_OPTIONS_INVALID');
 check(value.signal);return {backupId:value.backupId.toLowerCase(),key:Buffer.from(value.key)};
}
async function privateRoot(root:string):Promise<Stamp[]>{
 const uid=process.getuid?.();if(uid===undefined)fail('ARCHIVE_ROOT_UNSAFE');let path=parse(root).root;const stamps:Stamp[]=[];
 for(const part of ['',...root.slice(path.length).split(sep)]){
  if(part)path=join(path,part);const s=await lstat(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid&&s.uid!==0||s.mode&0o022&&!(s.mode&0o1000))fail('ARCHIVE_ROOT_UNSAFE');
  if(path===root&&(s.uid!==uid||(s.mode&0o7777)!==0o700))fail('ARCHIVE_ROOT_UNSAFE');
  stamps.push({path,dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode});
 }
 if(await realpath(root)!==root)fail('ARCHIVE_ROOT_UNSAFE');return stamps;
}
async function unchanged(stamps:readonly Stamp[]){for(const old of stamps){const s=await lstat(old.path);if(s.isSymbolicLink()||!s.isDirectory()||s.dev!==old.dev||s.ino!==old.ino||s.uid!==old.uid||s.mode!==old.mode)fail('ARCHIVE_ROOT_CHANGED');}}
async function fileStamp(file:FileHandle,path:string,strict=true):Promise<Stamp>{const s=await file.stat();if(strict&&(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o7777)!==0o600||s.nlink!==1))fail('ARCHIVE_FILE_UNSAFE');return {path,dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode};}
async function pathMatches(stamp:Stamp){const s=await lstat(stamp.path);if(s.isSymbolicLink()||s.dev!==stamp.dev||s.ino!==stamp.ino||s.uid!==stamp.uid||s.mode!==stamp.mode)fail('ARCHIVE_FILE_UNSAFE');}
async function removeOwned(stamp:Stamp){try{await pathMatches(stamp);await unlink(stamp.path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;fail('ARCHIVE_CLEANUP_FAILED');}}
async function removeDirectory(stamp:Stamp){try{await pathMatches(stamp);await rmdir(stamp.path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;fail('ARCHIVE_CLEANUP_FAILED');}}
async function close(file:FileHandle|undefined){try{await file?.close();return true;}catch{return false;}}
async function write(file:FileHandle,bytes:Buffer){let at=0;while(at<bytes.length){const r=await file.write(bytes,at,bytes.length-at);if(!r.bytesWritten)fail('ARCHIVE_IO_FAILED');at+=r.bytesWritten;}}
async function read(file:FileHandle,position:number,length:number){const bytes=Buffer.alloc(length);let at=0;while(at<length){const r=await file.read(bytes,at,length-at,position+at);if(!r.bytesRead)fail('ARCHIVE_FORMAT_INVALID');at+=r.bytesRead;}return bytes;}
const hash=()=>createHash('sha256');
function prefix(header:Header){const bytes=Buffer.from(JSON.stringify(header)),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([MAGIC,length,bytes]);}
function summary(plainSize:number,cipherSize:number,plainHash:Buffer,cipherHash:Buffer,tag:Buffer){const result=Buffer.alloc(SUMMARY_BYTES);result.writeBigUInt64BE(BigInt(plainSize),0);result.writeBigUInt64BE(BigInt(cipherSize),8);plainHash.copy(result,16);cipherHash.copy(result,48);tag.copy(result,80);return result;}
function receipt(backupId:string,m:ArchiveMetadata,plainSize:number,plainHash:Buffer,cipherSize:number,cipherHash:Buffer,archiveSize:number,archiveHash:string):ArchiveReceipt{return {version:1,backupId,metadata:m,algorithm:'AES-256-GCM',plaintext:{byteSize:plainSize,sha256:plainHash.toString('hex')},ciphertext:{byteSize:cipherSize,sha256:cipherHash.toString('hex')},archive:{byteSize:archiveSize,sha256:archiveHash}};}
function safe(error:unknown,signal:AbortSignal):ArchiveError{return error instanceof ArchiveError?error:new ArchiveError(signal.aborted?'ARCHIVE_CANCELLED':'ARCHIVE_IO_FAILED');}

/** The root and its parent chain must stay under exclusive administrative control.
 * NOFOLLOW/inode checks do not claim to defeat a malicious process with the same UID. */
export async function writePrivateArchive(input:WritePrivateArchiveInput):Promise<ArchiveReceipt>{
 const own=options(input);let file:FileHandle|undefined,owned:Stamp|undefined,root:Stamp[]|undefined,inputFailed=false;
 const onError=()=>{inputFailed=true;},onAbort=()=>{input.input.destroy();};
 try{
  const m=metadata(input.metadata);if(!(input.input instanceof Readable))fail('ARCHIVE_OPTIONS_INVALID');
  root=await privateRoot(input.root);check(input.signal);const path=join(input.root,own.backupId+'.oa-archive');
  try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail('ARCHIVE_EXISTS');throw error;}
  owned=await fileStamp(file,path,false);await file.chmod(0o600);owned=await fileStamp(file,path);await unchanged(root);input.input.on('error',onError);input.signal.addEventListener('abort',onAbort,{once:true});check(input.signal);
  const dataIv=randomBytes(12);let summaryIv=randomBytes(12);while(summaryIv.equals(dataIv))summaryIv=randomBytes(12);
  const header:Header={version:1,backupId:own.backupId,metadata:m,dataIv:dataIv.toString('hex'),summaryIv:summaryIv.toString('hex')},head=prefix(header);
  const cipher=createCipheriv('aes-256-gcm',own.key,dataIv);cipher.setAAD(Buffer.concat([payloadDomain,head]));const ph=hash(),ch=hash(),ah=hash();let plainSize=0,cipherSize=0,total=head.length;
  await write(file,head);ah.update(head);
  for await(const raw of input.input){check(input.signal);if(!Buffer.isBuffer(raw)&&!(raw instanceof Uint8Array))fail('ARCHIVE_INPUT_FAILED');const bytes=raw as Buffer;plainSize+=bytes.length;if(plainSize>input.maxBytes)fail('ARCHIVE_LIMIT');ph.update(bytes);const encrypted=cipher.update(bytes);cipherSize+=encrypted.length;ch.update(encrypted);ah.update(encrypted);await write(file,encrypted);total+=encrypted.length;}
  check(input.signal);if(inputFailed)fail('ARCHIVE_INPUT_FAILED');const tail=cipher.final();cipherSize+=tail.length;ch.update(tail);ah.update(tail);await write(file,tail);total+=tail.length;
  const plainHash=ph.digest(),cipherHash=ch.digest(),manifest=createCipheriv('aes-256-gcm',own.key,summaryIv);manifest.setAAD(Buffer.concat([summaryDomain,head]));const footer=Buffer.concat([manifest.update(summary(plainSize,cipherSize,plainHash,cipherHash,cipher.getAuthTag())),manifest.final(),manifest.getAuthTag()]);
  await write(file,footer);ah.update(footer);total+=footer.length;check(input.signal);await file.sync();await unchanged(root);await pathMatches(owned);await file.close();file=undefined;
  const directory=await open(input.root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}check(input.signal);await unchanged(root);
  return receipt(own.backupId,m,plainSize,plainHash,cipherSize,cipherHash,total,ah.digest('hex'));
 }catch(error){const closed=await close(file);file=undefined;if(owned){if(root)await unchanged(root).catch(()=>fail('ARCHIVE_CLEANUP_FAILED'));await removeOwned(owned);}if(!closed)fail('ARCHIVE_CLEANUP_FAILED');throw safe(error instanceof ArchiveError?error:inputFailed?new ArchiveError('ARCHIVE_INPUT_FAILED'):error,input.signal);}
 finally{input.signal.removeEventListener('abort',onAbort);if(input.input instanceof Readable){input.input.removeListener('error',onError);if(!input.input.readableEnded&&!input.input.destroyed)input.input.destroy();}own.key.fill(0);}
}

export async function openPrivateArchive(input:OpenPrivateArchiveInput):Promise<PlaintextLease>{
 const own=options(input);let archive:FileHandle|undefined,staging:FileHandle|undefined,staged:Stamp|undefined,directory:Stamp|undefined,root:Stamp[]|undefined;
 try{
  const expected=metadata(input.expectedMetadata);root=await privateRoot(input.root);check(input.signal);const path=join(input.root,own.backupId+'.oa-archive');archive=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const archived=await fileStamp(archive,path),before=await archive.stat();
  if(!Number.isSafeInteger(before.size)||before.size>input.maxBytes+HEADER_LIMIT+12+FOOTER_BYTES)fail('ARCHIVE_LIMIT');if(before.size<12+FOOTER_BYTES)fail('ARCHIVE_FORMAT_INVALID');
  const lead=await read(archive,0,12);if(!lead.subarray(0,8).equals(MAGIC))fail('ARCHIVE_FORMAT_INVALID');const length=lead.readUInt32BE(8);if(length<1||length>HEADER_LIMIT||12+length+FOOTER_BYTES>before.size)fail('ARCHIVE_FORMAT_INVALID');
  const bytes=await read(archive,12,length);let header:Header;try{header=headerSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{fail('ARCHIVE_FORMAT_INVALID');}
  const head=prefix(header);if(!head.equals(Buffer.concat([lead,bytes]))||header.dataIv===header.summaryIv)fail('ARCHIVE_FORMAT_INVALID');
  if(header.backupId!==own.backupId||JSON.stringify(header.metadata)!==JSON.stringify(expected))fail('ARCHIVE_METADATA_MISMATCH');
  const footer=await read(archive,before.size-FOOTER_BYTES,FOOTER_BYTES);let manifest:Buffer;
  try{const decipher=createDecipheriv('aes-256-gcm',own.key,Buffer.from(header.summaryIv,'hex'));decipher.setAAD(Buffer.concat([summaryDomain,head]));decipher.setAuthTag(footer.subarray(SUMMARY_BYTES));manifest=Buffer.concat([decipher.update(footer.subarray(0,SUMMARY_BYTES)),decipher.final()]);}catch{fail('ARCHIVE_AUTHENTICATION_FAILED');}
  const plainBig=manifest.readBigUInt64BE(0),cipherBig=manifest.readBigUInt64BE(8),actualCipherSize=before.size-head.length-FOOTER_BYTES;
  if(plainBig>BigInt(input.maxBytes)||cipherBig>BigInt(input.maxBytes))fail('ARCHIVE_LIMIT');if(plainBig!==cipherBig||cipherBig!==BigInt(actualCipherSize))fail('ARCHIVE_INTEGRITY_FAILED');check(input.signal);await unchanged(root);
  const dirPath=await mkdtemp(join(input.root,'.restore-'+own.backupId+'-')),ds=await lstat(dirPath);directory={path:dirPath,dev:ds.dev,ino:ds.ino,uid:ds.uid,mode:ds.mode};
  if(ds.uid!==process.getuid?.()||(ds.mode&0o7777)!==0o700)fail('ARCHIVE_ROOT_UNSAFE');await unchanged(root);const plainPath=join(dirPath,'plaintext.bin');staging=await open(plainPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);staged=await fileStamp(staging,plainPath,false);await staging.chmod(0o600);staged=await fileStamp(staging,plainPath);
  const decipher=createDecipheriv('aes-256-gcm',own.key,Buffer.from(header.dataIv,'hex'));decipher.setAAD(Buffer.concat([payloadDomain,head]));decipher.setAuthTag(manifest.subarray(80));const ph=hash(),ch=hash(),ah=hash();ah.update(head);let plainSize=0;
  for(let at=head.length;at<head.length+actualCipherSize;){check(input.signal);const encrypted=await read(archive,at,Math.min(CHUNK,head.length+actualCipherSize-at));at+=encrypted.length;ch.update(encrypted);ah.update(encrypted);const plain=decipher.update(encrypted);plainSize+=plain.length;if(plainSize>input.maxBytes)fail('ARCHIVE_LIMIT');ph.update(plain);await write(staging,plain);}
  let tail:Buffer;try{tail=decipher.final();}catch{fail('ARCHIVE_AUTHENTICATION_FAILED');}plainSize+=tail.length;ph.update(tail);await write(staging,tail);const plainHash=ph.digest(),cipherHash=ch.digest();ah.update(footer);
  if(plainSize!==Number(plainBig)||!plainHash.equals(manifest.subarray(16,48))||!cipherHash.equals(manifest.subarray(48,80)))fail('ARCHIVE_INTEGRITY_FAILED');
  check(input.signal);const after=await archive.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('ARCHIVE_INTEGRITY_FAILED');await pathMatches(archived);await unchanged(root);await staging.sync();await staging.close();staging=undefined;await archive.close();archive=undefined;check(input.signal);
  const value=receipt(own.backupId,expected,plainSize,plainHash,actualCipherSize,cipherHash,before.size,ah.digest('hex')),plainStamp=staged,dirStamp=directory,rootStamps=root;let closed=false,cleaned=false,closing:Promise<void>|undefined;const streams=new Set<ReadStream>();
  return {receipt:value,plaintextPath:plainPath,openReadStream:async()=>{
   if(closed)fail('ARCHIVE_LEASE_CLOSED');let handle:FileHandle|undefined;try{await unchanged(rootStamps);await pathMatches(dirStamp);await pathMatches(plainStamp);handle=await open(plainPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const opened=await fileStamp(handle,plainPath);if(opened.dev!==plainStamp.dev||opened.ino!==plainStamp.ino)fail('ARCHIVE_FILE_UNSAFE');if(closed)fail('ARCHIVE_LEASE_CLOSED');const stream=handle.createReadStream({autoClose:true});streams.add(stream);stream.once('close',()=>streams.delete(stream));return stream;}catch(error){if(!await close(handle))fail('ARCHIVE_CLEANUP_FAILED');if(closed)fail('ARCHIVE_LEASE_CLOSED');throw safe(error,input.signal);}
  },cleanup:async()=>{
   if(cleaned)return;if(closing)return closing;closed=true;closing=(async()=>{for(const stream of streams)stream.destroy();await Promise.allSettled([...streams].map(s=>finished(s)));await unchanged(rootStamps).catch(()=>fail('ARCHIVE_CLEANUP_FAILED'));await removeOwned(plainStamp);await removeDirectory(dirStamp);cleaned=true;})();try{await closing;}finally{closing=undefined;}
  }};
 }catch(error){const stageClosed=await close(staging),archiveClosed=await close(archive);if(staged||directory){if(root)await unchanged(root).catch(()=>fail('ARCHIVE_CLEANUP_FAILED'));if(staged)await removeOwned(staged);if(directory)await removeDirectory(directory);}if(!stageClosed||!archiveClosed)fail('ARCHIVE_CLEANUP_FAILED');throw safe(error,input.signal);}
 finally{own.key.fill(0);}
}
