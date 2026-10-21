import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,chmod,mkdir,writeFile,readFile,readdir,rm,symlink,link,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';

import * as runtime from '../../scripts/prepare-linux-node-runtime.mjs';
import type {LinuxNodeArchitecture as Arch} from '../../scripts/prepare-linux-node-runtime.mjs';
const root='node-v24.21.0-linux-arm64',target=root+'/bin/node';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function elf(arch:Arch='arm64'){
 const b=Buffer.alloc(128);b.set([127,69,76,70,2,1,1,3]);b.writeUInt16LE(2,16);b.writeUInt16LE(arch==='arm64'?183:62,18);b.writeUInt32LE(1,20);b.writeBigUInt64LE(64n,32);b.writeUInt16LE(64,52);b.writeUInt16LE(56,54);b.writeUInt16LE(1,56);return b;
}
function header(name:string,size:number,type='0',linkName=''){
 const b=Buffer.alloc(512);b.write(name,0,100);b.write('0000700\0',100);b.write(size.toString(8).padStart(11,'0')+'\0',124);b.fill(32,148,156);b.write(type,156);b.write(linkName,157,100);b.write('ustar  \0',257);const sum=b.reduce((a,v)=>a+v,0);b.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return b;
}
function entry(name:string,body=Buffer.alloc(0),type='0',linkName=''){return Buffer.concat([header(name,body.length,type,linkName),body,Buffer.alloc((512-body.length%512)%512)]);}
const end=Buffer.alloc(1024),node=()=>entry(target,elf());
function tar(...entries:Buffer[]){return Buffer.concat([...entries,end]);}
async function scan(bytes:Buffer,options:{signal?:AbortSignal;onChunk?:(chunk:Buffer)=>unknown;chunkSize?:number}={}){
 const chunks:Buffer[]=[];for(let at=0;at<bytes.length;at+=options.chunkSize??37)chunks.push(bytes.subarray(at,at+(options.chunkSize??37)));
 return runtime.scanLinuxNodeTar(Readable.from(chunks),'arm64',options.onChunk??(()=>{}),options.signal);
}
let directory:string;
beforeEach(async()=>{directory=await realpath(await mkdtemp(join(tmpdir(),'oa-linux-runtime-')));await chmod(directory,0o700);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('UNEXPECTED_NETWORK');}));});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});

it('exports deeply frozen independent official archive and binary pins for both architectures',()=>{
 expect(Object.keys(runtime.linuxNodeRuntimePins)).toEqual(['arm64','x64']);expect(Object.isFrozen(runtime.linuxNodeRuntimePins)).toBe(true);
 for(const arch of ['arm64','x64'] as const){expect(Object.isFrozen(runtime.linuxNodeRuntimePins[arch])).toBe(true);expect(runtime.linuxNodeRuntimePins[arch].sourceIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);expect(runtime.linuxNodeRuntimePins[arch].binarySha256).toMatch(/^[a-f0-9]{64}$/);}
 expect(runtime.linuxNodeRuntimePins.arm64.binarySha256).toBe('0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584');
 expect(runtime.linuxNodeRuntimePins.x64.sourceIntegrity).toBe('sha256:6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff');
});
it.each(['arm64','x64'] as const)('accepts a structurally valid %s ELF without executing it',arch=>{expect(()=>runtime.validateLinuxNodeElf(elf(arch),128,arch)).not.toThrow();});
it.each(['architecture','class','endian','program-table','truncated'] as const)('rejects malformed ELF: %s',kind=>{
 const b=elf();if(kind==='architecture')b.writeUInt16LE(62,18);if(kind==='class')b[4]=1;if(kind==='endian')b[5]=2;if(kind==='program-table')b.writeBigUInt64LE(1024n,32);
 expect(()=>runtime.validateLinuxNodeElf(kind==='truncated'?b.subarray(0,63):b,128,'arm64')).toThrow('NODE_RUNTIME_ELF_REJECTED');
});
it('streams only the fixed regular executable body across arbitrary chunk boundaries',async()=>{
 const chunks:Buffer[]=[];const result=await scan(tar(entry(root,Buffer.alloc(0),'5'),entry(root+'/README.md',Buffer.from('SYNTHETIC')),entry(root+'/bin/npm',Buffer.alloc(0),'2','../lib/npm.js'),entry(root+'/hardlink',Buffer.alloc(0),'1',target),node()),{onChunk:c=>chunks.push(Buffer.from(c)),chunkSize:7});
 expect(Buffer.concat(chunks)).toEqual(elf());expect(result).toEqual({bytes:128,sha256:sha(elf())});expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('supports the official bounded GNU LongName extension only for a non-target entry',async()=>{
 const name=root+'/include/'+ 'a'.repeat(100),body=Buffer.from(name+'\0');
 expect(await scan(tar(entry('././@LongLink',body,'L'),entry(name,Buffer.from('SYNTHETIC')),node()))).toEqual({bytes:128,sha256:sha(elf())});
});
it.each(['duplicate','missing','truncated','trailing-bytes','checksum','target-link','target-hardlink','target-slash','oversized'] as const)('rejects unsafe/incomplete target: %s',async kind=>{
 let bytes=tar(node());if(kind==='duplicate')bytes=tar(node(),node());if(kind==='missing')bytes=tar(entry(root+'/other'));if(kind==='truncated')bytes=bytes.subarray(0,600);if(kind==='trailing-bytes')bytes=Buffer.concat([bytes,Buffer.from('x')]);if(kind==='checksum')bytes[0]=0;if(kind==='target-link')bytes=tar(entry(target,Buffer.alloc(0),'2','other'));if(kind==='target-hardlink')bytes=tar(entry(target,Buffer.alloc(0),'1','other'));if(kind==='target-slash')bytes=tar(entry(target+'/',elf()));if(kind==='oversized')bytes=tar(header(target,193*1024*1024));
 await expect(scan(bytes)).rejects.toHaveProperty('code');
});
it.each(['/absolute','../escape',root+'/../escape',root+'/./alias',root+'//empty',root+'/bad\\name',root+'/bad\nname','other-release/file'])('rejects every unsafe skipped entry name: %s',async name=>{await expect(scan(tar(entry(name),node()))).rejects.toThrow('NODE_RUNTIME_ARCHIVE_REJECTED');});
it.each(['x','g','K','S','7'])('rejects unsupported TAR extension/type %s rather than ambiguously interpreting the target',async type=>{await expect(scan(tar(entry(root+'/extension',Buffer.alloc(0),type),node()))).rejects.toThrow('NODE_RUNTIME_ARCHIVE_REJECTED');});
it.each(['unsafe','truncated-prefix','nested','target','unterminated'] as const)('rejects ambiguous GNU LongName: %s',async kind=>{
 let name=root+'/include/'+'a'.repeat(100);if(kind==='unsafe')name=root+'/../'+'a'.repeat(110);if(kind==='target')name=target;
 const body=Buffer.from(name+(kind==='unterminated'?'':'\0')),l=entry('././@LongLink',body,'L'),next=entry(kind==='truncated-prefix'?root+'/wrong':name);
 const bytes=kind==='nested'?tar(l,l,next,node()):tar(l,next,node());await expect(scan(bytes)).rejects.toThrow('NODE_RUNTIME_ARCHIVE_REJECTED');
});
it('propagates parser cancellation and write failure without emitting a success receipt',async()=>{
 const c=new AbortController();c.abort();await expect(scan(tar(node()),{signal:c.signal})).rejects.toThrow('NODE_RUNTIME_TIMEOUT');
 await expect(scan(tar(node()),{onChunk:()=>{throw Error('SYNTHETIC_WRITE_FAILURE');}})).rejects.toThrow('SYNTHETIC_WRITE_FAILURE');
});
it.each(['relative','dot','architecture','extra','getter','proxy'] as const)('rejects non-inert/ambiguous prepare options before fetch: %s',async kind=>{
 let raw:unknown={directory,architecture:'arm64'};
 if(kind==='relative')raw={directory:'relative',architecture:'arm64'};if(kind==='dot')raw={directory:directory+'/../alias',architecture:'arm64'};if(kind==='architecture')raw={directory,architecture:'ia32'};if(kind==='extra')raw={directory,architecture:'arm64',token:'SYNTHETIC_NEVER_READ'};
 let gets=0;if(kind==='getter')raw={get directory(){gets++;return directory;},architecture:'arm64'};if(kind==='proxy')raw=new Proxy({directory,architecture:'arm64'},{get(){gets++;throw Error('NEVER');}});
 await expect(runtime.prepareLinuxNodeRuntime(raw)).rejects.toThrow('NODE_RUNTIME_OPTIONS_REJECTED');expect(gets).toBe(0);expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(['root-mode','root-symlink','writable-parent'] as const)('rejects unsafe cache ancestry: %s',async kind=>{
 let path=directory;if(kind==='root-mode')await chmod(directory,0o755);if(kind==='root-symlink'){path=join(directory,'alias');await symlink(directory,path);}if(kind==='writable-parent'){const parent=join(directory,'writable');await mkdir(parent,{mode:0o777});await chmod(parent,0o777);path=join(parent,'cache');}
 await expect(runtime.prepareLinuxNodeRuntime({directory:path,architecture:'arm64'})).rejects.toThrow('NODE_RUNTIME_PRIVATE_PATH_REQUIRED');expect(globalThis.fetch).not.toHaveBeenCalled();
});
async function fakeCache(){
 const folder=join(directory,root),bin=join(folder,'bin'),binaryPath=join(bin,'node');await mkdir(folder,{mode:0o700});await mkdir(bin,{mode:0o700});await writeFile(binaryPath,elf(),{mode:0o700});
 const metadata={schemaVersion:1,version:'24.21.0',platform:'linux',architecture:'arm64',binaryPath,...runtime.linuxNodeRuntimePins.arm64};await writeFile(join(folder,'runtime.json'),JSON.stringify(metadata),{mode:0o600});return {folder,bin,binaryPath,metadata};
}
it.each(['self-reported-hash','symlink','hardlink','file-mode','metadata-extra','unexpected-file'] as const)('rejects untrusted cache bytes/layout without redownload: %s',async kind=>{
 const c=await fakeCache();if(kind==='symlink'){await rm(c.binaryPath);await writeFile(join(directory,'external'),elf(),{mode:0o700});await symlink(join(directory,'external'),c.binaryPath);}if(kind==='hardlink')await link(c.binaryPath,join(directory,'external'));if(kind==='file-mode')await chmod(c.binaryPath,0o755);if(kind==='metadata-extra')await writeFile(join(c.folder,'runtime.json'),JSON.stringify({...c.metadata,approved:true}),{mode:0o600});if(kind==='unexpected-file')await writeFile(join(c.bin,'other'),'',{mode:0o600});
 await expect(runtime.prepareLinuxNodeRuntime({directory,architecture:'arm64'})).rejects.toHaveProperty('code');expect(globalThis.fetch).not.toHaveBeenCalled();expect((await lstat(c.folder)).isDirectory()).toBe(true);
});
it.each(['hash','status','redirect','length'] as const)('download rejection %s cleans only newly created files and leaves caller data',async kind=>{
 const sentinel=join(directory,'sentinel');await writeFile(sentinel,'SYNTHETIC',{mode:0o600});const url='https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz';
 const response=new Response('NOT_AN_OFFICIAL_ARCHIVE',{status:kind==='status'?503:200,headers:kind==='length'?{'content-length':String(129*1024*1024)}:{}});Object.defineProperty(response,'url',{value:url});if(kind==='redirect')Object.defineProperty(response,'redirected',{value:true});
 const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>response);vi.stubGlobal('fetch',fetch);
 await expect(runtime.prepareLinuxNodeRuntime({directory,architecture:'arm64'})).rejects.toHaveProperty('code',kind==='hash'?'NODE_RUNTIME_SOURCE_INTEGRITY_REJECTED':kind==='length'?'NODE_RUNTIME_DOWNLOAD_LIMIT':'NODE_RUNTIME_DOWNLOAD_REJECTED');
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]?.[0]).toBe(url);expect(await readdir(directory)).toEqual(['sentinel']);expect(await readFile(sentinel,'utf8')).toBe('SYNTHETIC');
});
it('cancellation during a bounded download closes the request and removes a newly created cache root',async()=>{
 const c=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValue(c.signal);let received:AbortSignal|undefined;
 const fetch=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{received=init?.signal??undefined;received?.addEventListener('abort',()=>reject(new DOMException('SYNTHETIC','AbortError')),{once:true});queueMicrotask(()=>c.abort());}));vi.stubGlobal('fetch',fetch);
 const cache=join(directory,'new-cache');await expect(runtime.prepareLinuxNodeRuntime({directory:cache,architecture:'arm64'})).rejects.toThrow('NODE_RUNTIME_TIMEOUT');
 expect(fetch).toHaveBeenCalledTimes(1);expect(received?.aborted).toBe(true);expect(await readdir(directory)).toEqual([]);
});
it('cancellation after an emitted body chunk rejects even when that chunk completed the executable',async()=>{
 const c=new AbortController();let calls=0;await expect(scan(tar(node()),{signal:c.signal,chunkSize:2048,onChunk:()=>{calls++;c.abort();}})).rejects.toThrow('NODE_RUNTIME_TIMEOUT');expect(calls).toBe(1);
});
