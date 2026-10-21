import {mkdir,lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Vault} from './crypto.js';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',keyPattern=new RegExp(`^${uuid}/${uuid}/${uuid}/${uuid}\\.sealed$`);
const sealed=z.object({version:z.string(),iv:z.string(),tag:z.string(),data:z.string()}).strict();
export interface FileStore {put(key:string,bytes:Buffer):Promise<void>;get(key:string):Promise<Buffer>;remove(key:string):Promise<void>}
export class EncryptedFileStore implements FileStore {
 readonly root:string;
 constructor(root:string,private vault:Vault,private maxBytes=8*1024*1024){this.root=resolve(root);}
 private async path(key:string,create=false):Promise<string>{if(!keyPattern.test(key))throw Error('STORAGE_KEY_DENIED');if(create)await mkdir(this.root,{recursive:true,mode:0o700});const root=await lstat(this.root);if(!root.isDirectory()||root.isSymbolicLink()||await realpath(this.root)!==this.root)throw Error('STORAGE_ROOT_DENIED');
  const path=join(this.root,key),parts=key.split('/').slice(0,-1);let dir=this.root;for(const part of parts){dir=join(dir,part);if(create)await mkdir(dir,{mode:0o700}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;});const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(dir)!==dir)throw Error('STORAGE_DIRECTORY_DENIED');}return path;
 }
 async put(key:string,bytes:Buffer):Promise<void>{if(bytes.length>this.maxBytes)throw Error('STORAGE_SIZE_LIMIT');const path=await this.path(key,true),temporary=join(dirname(path),randomUUID()+'.partial'),handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{try{await handle.writeFile(JSON.stringify(this.vault.seal(bytes.toString('base64'),'file:'+key)),'utf8');await handle.sync();}finally{await handle.close();}await rename(temporary,path);const directory=await open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}catch(e){await unlink(temporary).catch(()=>{});throw e;}}
 async get(key:string):Promise<Buffer>{const path=await this.path(key),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if((await file.stat()).size>this.maxBytes*2+4096)throw Error('STORAGE_SIZE_LIMIT');const envelope=sealed.parse(JSON.parse(await file.readFile('utf8'))),raw=this.vault.open(envelope,'file:'+key);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))throw Error('STORAGE_ENCODING_INVALID');const bytes=Buffer.from(raw,'base64');if(bytes.length>this.maxBytes)throw Error('STORAGE_SIZE_LIMIT');return bytes;}finally{await file.close();}}
 async remove(key:string):Promise<void>{await unlink(await this.path(key));}
}
