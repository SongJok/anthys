// Isolated test tooling only. No environment loading, database, shell, container,
// or executable invocation. Official SHA-256 pins are not signature verification.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readdir,unlink,rmdir} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createGunzip} from 'node:zlib';
import {types} from 'node:util';

const version='24.21.0',maxArchive=128*1024*1024,maxTar=256*1024*1024,maxNode=192*1024*1024;
const pins=Object.freeze({
 arm64:Object.freeze({archive:'724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',binary:'0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584',size:122893672,machine:183}),
 x64:Object.freeze({archive:'6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',binary:'7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c',size:126595440,machine:62}),
});
export const linuxNodeRuntimePins=Object.freeze(Object.fromEntries(Object.entries(pins).map(([arch,p])=>[arch,Object.freeze({binarySha256:p.binary,sourceIntegrity:'sha256:'+p.archive})])));
class RuntimeFailure extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new RuntimeFailure(code);};
const stamp=s=>({dev:s.dev,ino:s.ino});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function architecture(value){if(value!=='arm64'&&value!=='x64')fail('NODE_RUNTIME_OPTIONS_REJECTED');return value;}
function checkpoint(signal){if(signal?.aborted)fail('NODE_RUNTIME_TIMEOUT');}
function options(raw){
 if(!raw||typeof raw!=='object'||types.isProxy(raw)||Object.getPrototypeOf(raw)!==Object.prototype)fail('NODE_RUNTIME_OPTIONS_REJECTED');
 const d=Object.getOwnPropertyDescriptors(raw);if(Reflect.ownKeys(d).length!==2||!['directory','architecture'].every(k=>d[k]&&'value'in d[k]&&d[k].enumerable))fail('NODE_RUNTIME_OPTIONS_REJECTED');
 const directory=d.directory.value,a=architecture(d.architecture.value);
 if(typeof directory!=='string'||directory.length>4096||!isAbsolute(directory)||resolve(directory)!==directory||directory===parse(directory).root||/[\\\x00-\x1f\x7f]/.test(directory))fail('NODE_RUNTIME_OPTIONS_REJECTED');
 return {directory,architecture:a};
}
async function ancestors(path){
 if(await realpath(path)!==path)fail('NODE_RUNTIME_PRIVATE_PATH_REQUIRED');
 const root=parse(path).root;let current=root;
 for(const part of path.slice(root.length).split('/').filter(Boolean)){
  current=join(current,part);const s=await lstat(current);
  if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid?.()].includes(s.uid)||((s.mode&0o022)!==0&&!(s.uid===0&&(s.mode&0o1000)!==0)))fail('NODE_RUNTIME_PRIVATE_PATH_REQUIRED');
 }
}
async function privateDirectory(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o7777)!==0o700||await realpath(path)!==path)fail('NODE_RUNTIME_PRIVATE_PATH_REQUIRED');return s;}
function field(bytes){
 const nul=bytes.indexOf(0),end=nul<0?bytes.length:nul;if(nul>=0&&bytes.subarray(nul).some(v=>v!==0))fail('NODE_RUNTIME_ARCHIVE_REJECTED');
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end));}catch{fail('NODE_RUNTIME_ARCHIVE_REJECTED');}
}
function octal(bytes){if(bytes.some(v=>v>=128))fail('NODE_RUNTIME_ARCHIVE_REJECTED');const text=bytes.toString('ascii').replace(/[\0 ]+$/,'').replace(/^ +/,'');if(!text)return 0;if(!/^[0-7]+$/.test(text))fail('NODE_RUNTIME_ARCHIVE_REJECTED');const n=Number.parseInt(text,8);if(!Number.isSafeInteger(n)||n<0)fail('NODE_RUNTIME_ARCHIVE_REJECTED');return n;}
function safeName(name,root){
 if(!name||Buffer.byteLength(name)>1024||name.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(name))fail('NODE_RUNTIME_ARCHIVE_REJECTED');
 const trimmed=name.endsWith('/')?name.slice(0,-1):name,parts=trimmed.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..')||parts[0]!==root)fail('NODE_RUNTIME_ARCHIVE_REJECTED');return trimmed;
}
/** Format validation only: this does NOT authenticate a Node release. The
 * preparer separately pins both the full archive and extracted binary hashes. */
export function validateLinuxNodeElf(header,totalBytes,arch){
 const p=pins[architecture(arch)];if(!Buffer.isBuffer(header)||header.length<64||!Number.isSafeInteger(totalBytes)||totalBytes<120||totalBytes>maxNode||header.subarray(0,4).toString('hex')!=='7f454c46'||header[4]!==2||header[5]!==1||header[6]!==1||![0,3].includes(header[7])||![2,3].includes(header.readUInt16LE(16))||header.readUInt16LE(18)!==p.machine||header.readUInt32LE(20)!==1||header.readUInt16LE(52)!==64||header.readUInt16LE(54)!==56||header.readUInt16LE(56)<1)fail('NODE_RUNTIME_ELF_REJECTED');
 const offset=header.readBigUInt64LE(32),end=offset+BigInt(header.readUInt16LE(54))*BigInt(header.readUInt16LE(56));if(offset<64n||end>BigInt(totalBytes))fail('NODE_RUNTIME_ELF_REJECTED');
}
/** Bounded streaming TAR parser. Only the fixed regular bin/node body reaches
 * the callback. Other normalized release entries (including links) are skipped.
 * The sole supported name extension is GNU L; it cannot name the short target. */
export async function scanLinuxNodeTar(source,arch,onNodeChunk,signal){
 architecture(arch);if(typeof onNodeChunk!=='function')fail('NODE_RUNTIME_OPTIONS_REJECTED');
 const root='node-v'+version+'-linux-'+arch,target=root+'/bin/node',seen=new Set(),digest=createHash('sha256');
 let buffer=Buffer.alloc(0),state='HEADER',remaining=0,padding=0,total=0,entries=0,zeroBlocks=0,nodeCount=0,nodeBytes=0,header=Buffer.alloc(0),emit=false,longBody=false,longChunks=[],longSize=0,pendingName=null;
 for await(const raw of source){
  checkpoint(signal);if(!Buffer.isBuffer(raw)&&!(raw instanceof Uint8Array))fail('NODE_RUNTIME_ARCHIVE_REJECTED');
  total+=raw.byteLength;if(total>maxTar)fail('NODE_RUNTIME_ARCHIVE_LIMIT');
  buffer=Buffer.concat([buffer,raw]);
  for(;;){
   checkpoint(signal);
   if(state==='END'){if(buffer.some(v=>v!==0))fail('NODE_RUNTIME_ARCHIVE_REJECTED');buffer=Buffer.alloc(0);break;}
   if(state==='HEADER'){
    if(buffer.length<512)break;const h=buffer.subarray(0,512);buffer=buffer.subarray(512);
    if(h.every(v=>v===0)){zeroBlocks++;if(zeroBlocks===2)state='END';continue;}
    if(zeroBlocks||++entries>10000)fail('NODE_RUNTIME_ARCHIVE_REJECTED');
    const expected=octal(h.subarray(148,156));let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:h[i];if(expected!==actual)fail('NODE_RUNTIME_ARCHIVE_REJECTED');
    const magic=h.subarray(257,265).toString('hex'),gnu=magic==='7573746172202000';if(!gnu&&magic!=='7573746172003030')fail('NODE_RUNTIME_ARCHIVE_REJECTED');
    const type=h[156]===0?'0':String.fromCharCode(h[156]),size=octal(h.subarray(124,136));if(size>maxTar)fail('NODE_RUNTIME_ARCHIVE_LIMIT');
    emit=false;longBody=false;longChunks=[];longSize=0;
    if(type==='L'){
     if(!gnu||pendingName!==null||field(h.subarray(0,100))!=='././@LongLink'||size<102||size>1024)fail('NODE_RUNTIME_ARCHIVE_REJECTED');longBody=true;
    }else{
     if(!['0','1','2','5'].includes(type))fail('NODE_RUNTIME_ARCHIVE_REJECTED');
     let name;
     if(pendingName!==null){if(!gnu||!h.subarray(0,100).equals(Buffer.from(pendingName).subarray(0,100)))fail('NODE_RUNTIME_ARCHIVE_REJECTED');name=pendingName;pendingName=null;}
     else{const base=field(h.subarray(0,100)),prefix=gnu?'':field(h.subarray(345,500));name=prefix?prefix+'/'+base:base;}
     const normalized=safeName(name,root);if(seen.has(normalized))fail('NODE_RUNTIME_ARCHIVE_REJECTED');seen.add(normalized);
     if(type!=='0'&&size!==0)fail('NODE_RUNTIME_ARCHIVE_REJECTED');
     if(normalized===target){if(name!==target||type!=='0'||field(h.subarray(157,257))!==''||++nodeCount!==1||size<120||size>maxNode)fail('NODE_RUNTIME_ARCHIVE_REJECTED');emit=true;}
    }
    remaining=size;padding=(512-size%512)%512;state=remaining?'BODY':padding?'PADDING':'HEADER';continue;
   }
   if(state==='BODY'){
    if(!buffer.length)break;const n=Math.min(remaining,buffer.length),part=buffer.subarray(0,n);buffer=buffer.subarray(n);remaining-=n;
    if(longBody){longSize+=n;if(longSize>1024)fail('NODE_RUNTIME_ARCHIVE_REJECTED');longChunks.push(Buffer.from(part));}
    if(emit){nodeBytes+=n;if(header.length<64)header=Buffer.concat([header,part.subarray(0,64-header.length)]);digest.update(part);await onNodeChunk(part);checkpoint(signal);}
    if(!remaining){
     if(longBody){const bytes=Buffer.concat(longChunks);if(bytes.at(-1)!==0||bytes.subarray(0,-1).includes(0))fail('NODE_RUNTIME_ARCHIVE_REJECTED');pendingName=field(bytes);safeName(pendingName,root);if(Buffer.byteLength(pendingName)<=100||pendingName===target)fail('NODE_RUNTIME_ARCHIVE_REJECTED');}
     state=padding?'PADDING':'HEADER';
    }continue;
   }
   if(state==='PADDING'){if(!buffer.length)break;const n=Math.min(padding,buffer.length);if(buffer.subarray(0,n).some(v=>v!==0))fail('NODE_RUNTIME_ARCHIVE_REJECTED');buffer=buffer.subarray(n);padding-=n;if(!padding)state='HEADER';}
  }
 }
 checkpoint(signal);if(state!=='END'||buffer.length||pendingName!==null||nodeCount!==1)fail('NODE_RUNTIME_ARCHIVE_REJECTED');validateLinuxNodeElf(header,nodeBytes,arch);return {bytes:nodeBytes,sha256:digest.digest('hex')};
}
async function regular(path,mode,maxBytes,signal,collect=false){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
  const before=await f.stat();if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o7777)!==mode||before.nlink!==1||before.size<1||before.size>maxBytes)fail('NODE_RUNTIME_CACHE_REJECTED');
  const hash=createHash('sha256'),chunks=[];let size=0,head=Buffer.alloc(0);const chunk=Buffer.alloc(Math.min(1024*1024,maxBytes+1));
  for(;;){checkpoint(signal);const r=await f.read(chunk,0,chunk.length,null);if(!r.bytesRead)break;size+=r.bytesRead;if(size>maxBytes)fail('NODE_RUNTIME_CACHE_REJECTED');const part=chunk.subarray(0,r.bytesRead);hash.update(part);if(head.length<64)head=Buffer.concat([head,part.subarray(0,64-head.length)]);if(collect)chunks.push(Buffer.from(part));}
  const after=await f.stat(),named=await lstat(path);if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||!same(before,named)||named.nlink!==1||named.mode!==before.mode||await realpath(path)!==path)fail('NODE_RUNTIME_CACHE_REJECTED');
  checkpoint(signal);return {sha256:hash.digest('hex'),bytes:size,head,data:collect?Buffer.concat(chunks):null};
 }finally{await f.close();}
}
async function download(url,signal){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(90000)]),headers:{accept:'application/octet-stream'}});
 if(response.status!==200||response.redirected||response.url!==url||!response.body){await response.body?.cancel().catch(()=>{});fail('NODE_RUNTIME_DOWNLOAD_REJECTED');}
 const length=response.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>maxArchive)){await response.body.cancel().catch(()=>{});fail('NODE_RUNTIME_DOWNLOAD_LIMIT');}
 const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){checkpoint(signal);const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxArchive)fail('NODE_RUNTIME_DOWNLOAD_LIMIT');chunks.push(Buffer.from(value));}checkpoint(signal);return Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function inspected(directory,arch,signal){
 const folder=join(directory,'node-v'+version+'-linux-'+arch),bin=join(folder,'bin'),binaryPath=join(bin,'node'),p=pins[arch];
 await ancestors(folder);await privateDirectory(directory);await privateDirectory(folder);await privateDirectory(bin);
 if(JSON.stringify((await readdir(folder)).sort())!==JSON.stringify(['bin','runtime.json'])||JSON.stringify(await readdir(bin))!==JSON.stringify(['node']))fail('NODE_RUNTIME_CACHE_REJECTED');
 const raw=await regular(join(folder,'runtime.json'),0o600,8192,signal,true);let metadata;
 try{metadata=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw.data));}catch{fail('NODE_RUNTIME_CACHE_REJECTED');}
 const expected={schemaVersion:1,version,platform:'linux',architecture:arch,binaryPath,binarySha256:p.binary,sourceIntegrity:'sha256:'+p.archive};
 if(!metadata||Array.isArray(metadata)||Object.keys(metadata).sort().join('|')!==Object.keys(expected).sort().join('|')||Object.entries(expected).some(([k,v])=>metadata[k]!==v))fail('NODE_RUNTIME_CACHE_REJECTED');
 const bytes=await regular(binaryPath,0o700,maxNode,signal);validateLinuxNodeElf(bytes.head,bytes.bytes,arch);if(bytes.bytes!==p.size||bytes.sha256!==p.binary)fail('NODE_RUNTIME_CACHE_REJECTED');
 await privateDirectory(folder);await privateDirectory(bin);checkpoint(signal);return Object.freeze(expected);
}
export async function prepareLinuxNodeRuntime(raw){
 const {directory,architecture:arch}=options(raw),signal=AbortSignal.timeout(120000),owned=[];
 const ownDirectory=async path=>{await mkdir(path,{mode:0o700});const s=await lstat(path);owned.push({path,...stamp(s),directory:true});await privateDirectory(path);};
 const ownFile=async(path,mode)=>{const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);try{const s=await f.stat();owned.push({path,...stamp(s),directory:false});return f;}catch(error){await f.close();throw error;}};
 const folder=join(directory,'node-v'+version+'-linux-'+arch),bin=join(folder,'bin'),binaryPath=join(bin,'node'),p=pins[arch];
 try{
  await ancestors(dirname(directory));let present=true;try{await lstat(directory);}catch(error){if(error.code!=='ENOENT')throw error;present=false;}if(!present)await ownDirectory(directory);await privateDirectory(directory);
  let cached=true;try{await lstat(folder);}catch(error){if(error.code!=='ENOENT')throw error;cached=false;}if(cached)return await inspected(directory,arch,signal);
  await ownDirectory(folder);await ownDirectory(bin);checkpoint(signal);
  const name='node-v'+version+'-linux-'+arch+'.tar.gz',archive=await download('https://nodejs.org/dist/v'+version+'/'+name,signal);if(createHash('sha256').update(archive).digest('hex')!==p.archive)fail('NODE_RUNTIME_SOURCE_INTEGRITY_REJECTED');
  const binary=await ownFile(binaryPath,0o600),input=Readable.from([archive]),gzip=createGunzip();input.pipe(gzip);
  try{
   const result=await scanLinuxNodeTar(gzip,arch,async chunk=>{let offset=0;while(offset<chunk.length){checkpoint(signal);const {bytesWritten}=await binary.write(chunk,offset,chunk.length-offset,null);if(bytesWritten<1)fail('NODE_RUNTIME_WRITE_FAILED');offset+=bytesWritten;}},signal);
   if(result.sha256!==p.binary||result.bytes!==p.size)fail('NODE_RUNTIME_SOURCE_INTEGRITY_REJECTED');await binary.chmod(0o700);await binary.sync();checkpoint(signal);
  }finally{gzip.destroy();input.destroy();await binary.close();}
  const metadata={schemaVersion:1,version,platform:'linux',architecture:arch,binaryPath,binarySha256:p.binary,sourceIntegrity:'sha256:'+p.archive},meta=await ownFile(join(folder,'runtime.json'),0o600);
  try{await meta.writeFile(JSON.stringify(metadata)+'\n');await meta.sync();}finally{await meta.close();}
  for(const path of [bin,folder,directory]){const dir=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
  checkpoint(signal);return await inspected(directory,arch,signal);
 }catch(error){
  let clean=true;for(const entry of owned.toReversed()){try{const named=await lstat(entry.path);if(!same(named,entry)||await realpath(dirname(entry.path))!==dirname(entry.path)){clean=false;continue;}if(entry.directory)await rmdir(entry.path);else await unlink(entry.path);}catch{clean=false;}}
  if(!clean)fail('NODE_RUNTIME_CLEANUP_UNCONFIRMED');if(error instanceof RuntimeFailure)throw error;fail(signal.aborted?'NODE_RUNTIME_TIMEOUT':'NODE_RUNTIME_PREPARATION_FAILED');
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),fields=new Map();try{if(args.length!==4)fail('NODE_RUNTIME_OPTIONS_REJECTED');for(let i=0;i<args.length;i+=2){if(!['--directory','--architecture'].includes(args[i])||fields.has(args[i]))fail('NODE_RUNTIME_OPTIONS_REJECTED');fields.set(args[i],args[i+1]);}console.log(JSON.stringify(await prepareLinuxNodeRuntime({directory:fields.get('--directory'),architecture:fields.get('--architecture')})));}catch(error){console.log(JSON.stringify({schemaVersion:1,status:'REJECTED',code:error instanceof RuntimeFailure?error.code:'NODE_RUNTIME_PREPARATION_FAILED'}));process.exitCode=1;}
}
