import {mkdtemp,readFile,readdir,lstat,rm,chmod,symlink,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {preflightDmMetadataOutput,writeDmMetadata} from '../../packages/dingtalk/src/dm-metadata-file.js';
const metadata={schemaVersion:1,corpId:'synthetic-corp',staffId:'synthetic-self',robotCode:'synthetic-robot',conversationId:'synthetic-cid',conversationType:'1',messageId:'synthetic-msg',providerTime:Date.UTC(2026,9,17),capturedAt:new Date(Date.UTC(2026,9,17)).toISOString(),nonceHash:'a'.repeat(64),source:'DINGTALK_STREAM_ROBOT_CALLBACK',sdkVersion:'2.1.5'};
const roots:string[]=[];async function fresh(){const root=await realpath(await mkdtemp(join(tmpdir(),'oa-dm-metadata-')));roots.push(root);return {root,path:join(root,'metadata.json')};}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('writes the exact minimal metadata atomically in a private directory with no temporary remnants',async()=>{
 const f=await fresh();expect(await writeDmMetadata(f.path,metadata)).toEqual(metadata);expect(JSON.parse(await readFile(f.path,'utf8'))).toEqual(metadata);expect((await lstat(f.root)).mode&0o777).toBe(0o700);expect((await lstat(f.path)).mode&0o777).toBe(0o600);expect(await readdir(f.root)).toEqual(['metadata.json']);
});
it('existing output and concurrent writers never overwrite a captured proof',async()=>{
 const f=await fresh(),r=await Promise.allSettled([writeDmMetadata(f.path,metadata),writeDmMetadata(f.path,{...metadata,messageId:'other-synthetic'})]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);const before=await readFile(f.path);await expect(writeDmMetadata(f.path,metadata)).rejects.toMatchObject({code:'DM_CAPTURE_OUTPUT_EXISTS'});expect(await readFile(f.path)).toEqual(before);expect(await readdir(f.root)).toEqual(['metadata.json']);
});
it('rejects a public directory, symlink destination and symlink parent without overwriting the target',async()=>{
 const f=await fresh();await chmod(f.root,0o755);await expect(preflightDmMetadataOutput(f.path)).rejects.toMatchObject({code:'DM_CAPTURE_PRIVATE_DIRECTORY_REQUIRED'});await chmod(f.root,0o700);const original=join(f.root,'original');await writeFile(original,'private-original');await symlink(original,f.path);await expect(writeDmMetadata(f.path,metadata)).rejects.toMatchObject({code:'DM_CAPTURE_OUTPUT_EXISTS'});expect(await readFile(original,'utf8')).toBe('private-original');const linked=join(f.root,'linked');await symlink(f.root,linked);await expect(preflightDmMetadataOutput(join(linked,'new.json'))).rejects.toMatchObject({code:'DM_CAPTURE_PRIVATE_DIRECTORY_REQUIRED'});
});
it('aborted capture or arbitrary extra body/secret fields cannot create a file',async()=>{
 const f=await fresh(),controller=new AbortController();controller.abort();await expect(writeDmMetadata(f.path,metadata,controller.signal)).rejects.toBeDefined();await expect(writeDmMetadata(f.path,{...metadata,sessionWebhook:'PRIVATE_SECRET'})).rejects.toMatchObject({code:'DM_CAPTURE_METADATA_INVALID'});expect(await readdir(f.root)).toEqual([]);
});
