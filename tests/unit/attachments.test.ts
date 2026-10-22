import {mkdtemp,realpath,readFile,writeFile,lstat,symlink,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {RequestOptions} from 'node:https';
import type {IncomingMessage,ClientRequest} from 'node:http';
import {deflateRawSync,gzipSync} from 'node:zlib';
import {RestrictedDownloader,DingTalkAttachmentSource,publicAddress} from '../../packages/attachments/src/download.js';
import {inspectFile,safeFileName} from '../../packages/attachments/src/inspect.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {messageInput} from '../../packages/dingtalk/src/message-input.js';
function response(status=200,headers:Record<string,string>={},chunks:Buffer[]=[Buffer.from('safe text')]):IncomingMessage{return Object.assign(Readable.from(chunks),{statusCode:status,headers}) as IncomingMessage;}
function client(responses:IncomingMessage[],seen:{url:string;options:RequestOptions}[]=[]){return (url:URL,options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{seen.push({url:url.toString(),options});const request=new EventEmitter() as EventEmitter&{setTimeout:()=>unknown;end:()=>void};request.setTimeout=()=>request;request.end=()=>{const res=responses.shift();if(res)callback(res);else request.emit('error',Error('synthetic network failure'));};return request as unknown as ClientRequest;};}
const hosts=new Set(['files.example','next.example']);const resolve=async()=>[{address:'8.8.8.8',family:4}];
function crc32(data:Buffer){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zipEntries(entries:readonly {name:string;data:Buffer;deflate?:boolean}[]){
 const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8'),method=entry.deflate?8:0,payload=entry.deflate?deflateRawSync(entry.data):entry.data,checksum=crc32(entry.data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(entry.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,payload);centrals.push(central,name);offset+=local.length+name.length+payload.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
it('T103 blocks literal IPs, unapproved hosts, private/mixed DNS, IPv6 aliases and redirect rebinding before network',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.16.1.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','2001:0db8::1','2001:2::1','2002:7f00:1::','3fff::1','not-ip'])expect(publicAddress(ip)).toBe(false);for(const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888'])expect(publicAddress(ip)).toBe(true);
 const seen:{url:string;options:RequestOptions}[]=[];for(const url of ['http://files.example/a','https://127.0.0.1/a','https://[::1]/a','https://unapproved.example/a','https://files.example:8443/a','https://user:secret@files.example/a','https://files.example/a#fragment'])await expect(new RestrictedDownloader({hosts,resolve,request:client([],seen)}).download(url,new AbortController().signal,async()=>{})).rejects.toThrow('DOWNLOAD_DESTINATION_DENIED');expect(seen).toHaveLength(0);
 for(const addresses of [[],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'8.8.8.8',family:6}]])await expect(new RestrictedDownloader({hosts,resolve:async()=>addresses,request:client([],seen)}).download('https://files.example/a',new AbortController().signal,async()=>{})).rejects.toThrow('DOWNLOAD_DNS_DENIED');
 let lookups=0;const rebind=new RestrictedDownloader({hosts,resolve:async()=>++lookups===1?[{address:'8.8.8.8',family:4}]:[{address:'127.0.0.1',family:4}],request:client([response(302,{location:'https://next.example/a'})],seen)});await expect(rebind.download('https://files.example/a',new AbortController().signal,async()=>{})).rejects.toThrow('DOWNLOAD_DNS_DENIED');expect(seen).toHaveLength(1);
});
it('pinned TLS request receives no provider credential, enforces streaming size/encoding and validates every hop',async()=>{
 const seen:{url:string;options:RequestOptions}[]=[];let authorizations=0;const downloader=new RestrictedDownloader({hosts,maxBytes:20,resolve,request:client([response(302,{location:'/next'}),response(200,{'content-type':'text/plain; charset=utf-8','content-length':'9'})],seen)});expect((await downloader.download('https://files.example/a',new AbortController().signal,async()=>{authorizations++;})).bytes.toString()).toBe('safe text');expect(authorizations).toBe(2);expect(seen[1]!.options['headers']).toEqual({accept:'*/*','accept-encoding':'identity'});expect(seen[0]!.options['agent']).toBe(false);expect(seen[0]!.options['servername']).toBe('files.example');
 const callback=vi.fn();(seen[0]!.options['lookup'] as (host:string,options:unknown,cb:typeof callback)=>void)('files.example',{},callback);expect(callback).toHaveBeenCalledWith(null,'8.8.8.8',4);
 for(const [res,code] of [[response(200,{'content-length':'100'}),'ATTACHMENT_SIZE_LIMIT'],[response(200,{},[Buffer.alloc(21)]),'ATTACHMENT_SIZE_LIMIT'],[response(200,{'content-encoding':'gzip'}),'DOWNLOAD_ENCODING_DENIED'],[response(200,{'content-length':'10'}),'DOWNLOAD_LENGTH_MISMATCH'],[response(200,{},[]),'ATTACHMENT_EMPTY'],[response(403),'DOWNLOAD_HTTP_REJECTED'],[response(302),'DOWNLOAD_REDIRECT_INVALID']] as const)await expect(new RestrictedDownloader({hosts,maxBytes:20,resolve,request:client([res])}).download('https://files.example/a',new AbortController().signal,async()=>{})).rejects.toThrow(code);
 await expect(new RestrictedDownloader({hosts,resolve,request:client(Array.from({length:4},()=>response(302,{location:'/again'})))}).download('https://files.example/a',new AbortController().signal,async()=>{})).rejects.toThrow('DOWNLOAD_REDIRECT_LIMIT');
 await expect(new RestrictedDownloader({hosts,resolve,request:client([])}).download('https://files.example/a',new AbortController().signal,async()=>{})).rejects.toThrow('DOWNLOAD_NETWORK_FAILED');
 const aborted=new AbortController();aborted.abort();await expect(downloader.download('https://files.example/a',aborted.signal,async()=>{})).rejects.toThrow();
});
it('locked DingTalk download API sends its token only to the official origin and refuses business errors',async()=>{
 const seen:{url:string;headers:HeadersInit|undefined}[]=[];const options={robotCode:'synthetic-robot',token:async()=>'synthetic-app-token',downloader:new RestrictedDownloader({hosts,resolve,request:client([response()])}),fetch:async(url:URL|RequestInfo,init?:RequestInit)=>{seen.push({url:String(url),headers:init!.headers});expect(init!.redirect).toBe('error');expect(JSON.parse(init!.body as string)).toEqual({robotCode:'synthetic-robot',downloadCode:'synthetic-download-code'});return new Response('{"downloadUrl":"https://files.example/signed?token=synthetic"}');}};
 expect((await new DingTalkAttachmentSource(options).download('synthetic-download-code',new AbortController().signal,async()=>{})).bytes.toString()).toBe('safe text');expect(seen[0]!.url).toBe('https://api.dingtalk.com/v1.0/robot/messageFiles/download');
 for(const raw of [{code:'Forbidden'},{}])await expect(new DingTalkAttachmentSource({...options,fetch:async()=>new Response(JSON.stringify(raw))}).download('synthetic',new AbortController().signal,async()=>{})).rejects.toThrow('PROVIDER_DOWNLOAD_REPLY_INVALID');
 await expect(new DingTalkAttachmentSource({...options,fetch:async()=>new Response('',{status:403})}).download('synthetic',new AbortController().signal,async()=>{})).rejects.toThrow('PROVIDER_DOWNLOAD_REJECTED');
});
it('T099 input validation rejects paths/MIME spoofing and quarantines archives, executable, active content and credentials',()=>{
 for(const name of ['../secret','a/b.txt','a\\b.txt','.env','CON.txt','a\0.txt','a\n.txt','trailing.'])expect(()=>safeFileName(name)).toThrow('ATTACHMENT_NAME_DENIED');
 expect(inspectFile(Buffer.from('中文 safe'),'safe.txt','text/plain').state).toBe('READY');expect(inspectFile(Buffer.from('{"value":1}'),'safe.json','application/json').mime).toBe('application/json');expect(inspectFile(Buffer.from('a,b\n1,2'),'safe.csv','text/csv').state).toBe('READY');
 expect(()=>inspectFile(Buffer.from('not-json'),'safe.json','application/json')).toThrow('ATTACHMENT_INVALID_JSON');expect(()=>inspectFile(Buffer.from('safe'),'safe.txt','image/png')).toThrow('ATTACHMENT_MIME_MISMATCH');expect(()=>inspectFile(Buffer.from([0xff]),'safe.txt','text/plain')).toThrow('ATTACHMENT_UNKNOWN_BINARY');expect(()=>inspectFile(Buffer.from('a\0b'),'safe.txt','text/plain')).toThrow('ATTACHMENT_BINARY_CONTROLS');
 for(const [bytes,name] of [[Buffer.from('504b0304','hex'),'archive.zip'],[gzipSync(Buffer.alloc(1000000)),'bomb.gz'],[Buffer.from('4d5a','hex'),'file.txt'],[Buffer.from('89504e470d0a1a0a','hex'),'picture'],[Buffer.from('%PDF-1.7'),'file.pdf'],[Buffer.from('<svg><script>evil</script></svg>'),'file.svg'],[Buffer.from('API_KEY=synthetic-secret'),'file.txt'],[Buffer.from('#!/bin/sh\necho evil'),'file.txt'],[Buffer.from('text'),'file.docx']] as const)expect(inspectFile(bytes,name,'application/octet-stream').state).toBe('QUARANTINED');
 const hostile=zipEntries([{name:'../escape.txt',data:Buffer.from('escape')},{name:'/etc/passwd',data:Buffer.from('root')},{name:'duplicate.txt',data:Buffer.from('one')},{name:'duplicate.txt',data:Buffer.from('two')},{name:'bomb.txt',data:Buffer.alloc(8*1024*1024),deflate:true}]);
 const quarantined=inspectFile(hostile,'hostile.zip','application/zip');
 expect(quarantined).toEqual({state:'QUARANTINED',mime:'application/zip',method:'MAGIC_SIGNATURE_QUARANTINE_NO_DECOMPRESSION',reason:'BINARY_INSPECTOR_OR_VERIFIED_MODALITY_REQUIRED'});
 expect(JSON.stringify(quarantined)).not.toMatch(/escape|passwd|duplicate|bomb/);
});
it('inbound file/picture/rich-text fields follow observed contracts and never treat arbitrary URLs as downloads',()=>{
 expect(messageInput({msgtype:'file',content:JSON.stringify({downloadCode:'synthetic',fileName:'safe.txt'})}).attachments[0]).toMatchObject({kind:'FILE',fileName:'safe.txt'});expect(messageInput({msgtype:'picture',content:{downloadCode:'synthetic'}}).attachments[0]?.kind).toBe('PICTURE');
 const rich=messageInput({msgtype:'richText',content:{richText:[{text:'goal'},{downloadCode:'synthetic',type:'picture'},{text:'https://private.example'}]}});expect(rich.goal).toContain('goal');expect(rich.attachments).toHaveLength(1);expect(messageInput({msgtype:'text',text:{content:'http://127.0.0.1'},content:{downloadCode:'untrusted'}}).attachments).toEqual([]);
 expect(()=>messageInput({msgtype:'richText',content:{richText:Array.from({length:9},()=>({downloadCode:'synthetic'}))}})).toThrow('ATTACHMENT_COUNT_LIMIT');expect(()=>messageInput({msgtype:'richText',content:{richText:[{downloadCode:'synthetic',type:'audio'}]}})).toThrow('ATTACHMENT_KIND_UNSUPPORTED');
});
it('encrypted FileStore binds bytes to tenant/key, keeps0600 permissions, rejects symlinks and tampering',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'oa-files-'))),vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),files=new EncryptedFileStore(root,vault,100),key=Array.from({length:4},()=>randomUUID()).join('/')+'.sealed';try{
  await files.put(key,Buffer.from('synthetic private bytes'));await files.put(key,Buffer.from('synthetic private bytes'));expect((await files.get(key)).toString()).toBe('synthetic private bytes');const path=join(root,key),raw=await readFile(path,'utf8');expect(raw).not.toContain('synthetic private bytes');expect((await lstat(path)).mode&0o777).toBe(0o600);
  await expect(files.put('../escape',Buffer.from('x'))).rejects.toThrow('STORAGE_KEY_DENIED');await expect(files.put(key,Buffer.alloc(101))).rejects.toThrow('STORAGE_SIZE_LIMIT');const envelope=JSON.parse(raw) as {tag:string};envelope.tag=Buffer.alloc(16).toString('base64');await writeFile(path,JSON.stringify(envelope));await expect(files.get(key)).rejects.toThrow();await files.remove(key);
  await writeFile(path,'x'.repeat(5000));await expect(files.get(key)).rejects.toThrow('STORAGE_SIZE_LIMIT');await writeFile(path,JSON.stringify(vault.seal('%%%invalid-base64','file:'+key)));await expect(files.get(key)).rejects.toThrow('STORAGE_ENCODING_INVALID');await writeFile(path,JSON.stringify(vault.seal(Buffer.alloc(101).toString('base64'),'file:'+key)));await expect(files.get(key)).rejects.toThrow('STORAGE_SIZE_LIMIT');await files.remove(key);
  await symlink('/etc/passwd',path);await expect(files.get(key)).rejects.toThrow();await rm(path);await mkdir(path);await expect(files.put(key,Buffer.from('x'))).rejects.toThrow();expect((await readdir(join(root,...key.split('/').slice(0,-1)))).some(name=>name.endsWith('.partial'))).toBe(false);
  const sibling=key.split('/');sibling[0]=randomUUID();await symlink(root,join(root,sibling[0]!));await expect(files.put(sibling.join('/'),Buffer.from('x'))).rejects.toThrow('STORAGE_DIRECTORY_DENIED');const regularRoot=join(root,'regular');await writeFile(regularRoot,'x');await expect(new EncryptedFileStore(regularRoot,vault).get(key)).rejects.toThrow('STORAGE_ROOT_DENIED');const linkRoot=join(root,'link');await symlink(root,linkRoot);await expect(new EncryptedFileStore(linkRoot,vault).put(key,Buffer.from('x'))).rejects.toThrow('STORAGE_ROOT_DENIED');
 }finally{await rm(root,{recursive:true,force:true});}
});
