import {mkdtemp,realpath,chmod,writeFile,readFile,link,symlink,rm,stat,readdir,open,rename,type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOperationsPrivateFile,writeOperationsPrivateFile,PrivateFileCommitUncertain} from '../../packages/operations/src/private-file.js';
import {restoreVerificationCommand} from '../../scripts/restore-verification.js';
import {comparePostgresInventories} from '../../packages/operations/src/postgres-inventory.js';
let root:string;const signal=()=>new AbortController().signal;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-operations-private-')));await chmod(root,0o700);});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('only canonical private current-owner regular single-link inputs are read and preserved',async()=>{const path=join(root,'input');await writeFile(path,'SYNTHETIC_SENTINEL',{mode:0o600});expect((await readOperationsPrivateFile(path,64)).toString()).toBe('SYNTHETIC_SENTINEL');expect(await readFile(path,'utf8')).toBe('SYNTHETIC_SENTINEL');});
it.each(['file-mode','parent-mode','symlink','hardlink','directory','too-large','empty'] as const)('rejects %s private inputs',async kind=>{const path=join(root,'input');await writeFile(path,'SYNTHETIC_SENTINEL',{mode:0o600});if(kind==='file-mode')await chmod(path,0o644);if(kind==='parent-mode')await chmod(root,0o755);if(kind==='symlink'){await rm(path);await writeFile(join(root,'target'),'SYNTHETIC_SENTINEL',{mode:0o600});await symlink(join(root,'target'),path);}if(kind==='hardlink')await link(path,join(root,'second'));if(kind==='directory'){await rm(path);}if(kind==='empty')await writeFile(path,'');await expect(readOperationsPrivateFile(kind==='directory'?root:path,kind==='too-large'?1:64)).rejects.toThrow();});
it('publishes once as0600 without overwriting or following an existing target',async()=>{const path=join(root,'output');await writeOperationsPrivateFile(path,Buffer.from('first'),signal());expect((await stat(path)).mode&0o777).toBe(0o600);await expect(writeOperationsPrivateFile(path,Buffer.from('second'),signal())).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('first');await symlink(path,join(root,'alias'));await expect(writeOperationsPrivateFile(join(root,'alias'),Buffer.from('second'),signal())).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('first');});
it('pre-cancelled and immediately cancelled publications leave no output',async()=>{const first=new AbortController();first.abort();await expect(writeOperationsPrivateFile(join(root,'first'),Buffer.from('private'),first.signal)).rejects.toMatchObject({name:'AbortError'});const second=new AbortController(),pending=writeOperationsPrivateFile(join(root,'second'),Buffer.from('private'),second.signal);second.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(await readdir(root)).toEqual([]);});
it('invalid output directory permissions and oversized outputs fail before creating a file',async()=>{await chmod(root,0o755);await expect(writeOperationsPrivateFile(join(root,'bad'),Buffer.from('private'),signal())).rejects.toThrow();await chmod(root,0o700);await expect(writeOperationsPrivateFile(join(root,'large'),Buffer.alloc(4*1024*1024+1),signal())).rejects.toThrow();expect(await readdir(root)).toEqual([]);});
it('pre-cancelled compare rejects before reading any input or claiming MATCH',async()=>{const controller=new AbortController();controller.abort();await expect(restoreVerificationCommand(['compare','--before',join(root,'absent-before'),'--after',join(root,'absent-after')],controller.signal)).rejects.toMatchObject({name:'AbortError'});});
it('command refuses unknown or repeated flags without loading environment or connecting',async()=>{await expect(restoreVerificationCommand(['execute'],signal())).rejects.toThrow('USAGE_INVALID');await expect(restoreVerificationCommand(['compare','--before','a','--before','b'],signal())).rejects.toThrow('USAGE_INVALID');await expect(restoreVerificationCommand(['capture','--profile','a','--unsafe','b'],signal())).rejects.toThrow('USAGE_INVALID');});
it('malformed or self-inconsistent inventories cannot report restoration MATCH',()=>{expect(()=>comparePostgresInventories({schemaVersion:1,secret:'SYNTHETIC_SENTINEL'},{})).toThrow('INVALID_INVENTORY');});
it('returns the identity of the exclusive created descriptor for later owned-marker cleanup',async()=>{
 const path=join(root,'receipt'),stamp=await writeOperationsPrivateFile(path,Buffer.from('SYNTHETIC_RECEIPT'),signal()),actual=await stat(path);
 expect(stamp).toEqual({dev:actual.dev,ino:actual.ino});
});
it('a replacement after actual fsync is uncertain and preserves the foreign occupant and moved original',async()=>{
 const path=join(root,'receipt'),moved=join(root,'moved-original'),probe=await open(root,'r'),prototype=Object.getPrototypeOf(probe) as FileHandle,original=prototype.sync;await probe.close();let replaced=false;
 const spy=vi.spyOn(prototype,'sync').mockImplementation(async function(this:FileHandle){
  await Reflect.apply(original,this,[]);if((await this.stat()).isFile()&&!replaced){replaced=true;await rename(path,moved);await writeFile(path,'SYNTHETIC_FOREIGN',{mode:0o600});}
 });
 try{await expect(writeOperationsPrivateFile(path,Buffer.from('SYNTHETIC_ORIGINAL'),signal())).rejects.toBeInstanceOf(PrivateFileCommitUncertain);
  expect(replaced).toBe(true);expect(await readFile(path,'utf8')).toBe('SYNTHETIC_FOREIGN');expect(await readFile(moved,'utf8')).toBe('SYNTHETIC_ORIGINAL');
 }finally{spy.mockRestore();}
});
it('unconfirmed descriptor close is uncertain even when the owned marker was removed',async()=>{
 const path=join(root,'receipt'),probe=await open(root,'r'),prototype=Object.getPrototypeOf(probe) as FileHandle,original=prototype.sync;await probe.close();const retained:FileHandle[]=[],restoreSpies:(()=>void)[]=[];let failures=0;
 const spy=vi.spyOn(prototype,'sync').mockImplementation(async function(this:FileHandle){
  await Reflect.apply(original,this,[]);if((await this.stat()).isFile()){retained.push(this);const closeSpy=vi.spyOn(this,'close').mockImplementation(async()=>{failures++;throw Error('SYNTHETIC_CLOSE_FAILURE');});restoreSpies.push(()=>closeSpy.mockRestore());}
 });
 try{await expect(writeOperationsPrivateFile(path,Buffer.from('SYNTHETIC_RECEIPT'),signal())).rejects.toBeInstanceOf(PrivateFileCommitUncertain);
  expect(failures).toBe(2);expect(await readdir(root)).toEqual([]);
 }finally{spy.mockRestore();for(const restore of restoreSpies)restore();for(const file of retained)await file.close();}
});
