import {createReadStream} from 'node:fs';
import {realpath,mkdtemp,writeFile,symlink,rm,mkdir,chmod,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyBackupExecutable,type BackupExecutablePin} from '../../packages/operations/src/project-backup-toolchain.js';

let pin:BackupExecutablePin;
beforeAll(async()=>{const path=await realpath(process.execPath),h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);pin={path,sha256:h.digest('hex'),version:process.version};},20000);
it('verifies actual reviewed executable bytes and an actual direct version child with a clean environment',async()=>{
 vi.stubEnv('NODE_OPTIONS','--synthetic-invalid-inherited-option');try{expect(await verifyBackupExecutable(pin,new AbortController().signal,10000)).toEqual({...pin,sharedLibrariesIndependentlyVerified:false,processesStarted:1,databaseAccess:false});}finally{vi.unstubAllEnvs();}
 // This uses Node's real binary to exercise the internal primitive. Production
 // profiles separately demand PG17; it is not a successful PostgreSQL-tool test.
},20000);
it('does not accept a valid version as a substitute for the reviewed executable hash',async()=>{await expect(verifyBackupExecutable({...pin,sha256:'b'.repeat(64)},new AbortController().signal,10000)).rejects.toThrow('BACKUP_EXECUTABLE_HASH_REJECTED');},20000);
it('rejects a mismatched actual version without echoing the process output',async()=>{await expect(verifyBackupExecutable({...pin,version:'SYNTHETIC_EXPECTED_MISMATCH'},new AbortController().signal,10000)).rejects.toThrow('BACKUP_EXECUTABLE_VERSION_REJECTED');},20000);
it('rejects pre-cancellation and invalid time limits before inspecting the binary',async()=>{
 const a=new AbortController();a.abort();await expect(verifyBackupExecutable(pin,a.signal)).rejects.toThrow('BACKUP_EXECUTABLE_CANCELLED');for(const limit of [0,10001,1.5,NaN])await expect(verifyBackupExecutable(pin,new AbortController().signal,limit)).rejects.toThrow('BACKUP_EXECUTABLE_OPTIONS_REJECTED');
});
it('refuses a symlink or writable non-executable file before spawning it',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'oa-backup-executable-unit-')));try{
  const alias=join(root,'alias');await symlink(pin.path,alias);await expect(verifyBackupExecutable({...pin,path:alias},new AbortController().signal)).rejects.toThrow('BACKUP_EXECUTABLE_PATH_REJECTED');
  const file=join(root,'not-approved');await writeFile(file,'SYNTHETIC MUST NOT EXECUTE',{mode:0o666});await expect(verifyBackupExecutable({...pin,path:file},new AbortController().signal)).rejects.toThrow('BACKUP_EXECUTABLE_FILE_REJECTED');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('rejects a different-UID-writable parent before executing even a correctly hashed file',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'oa-executable-parent-'))),parent=join(root,'unsafe'),marker=join(root,'executed');await mkdir(parent,{mode:0o777});await chmod(parent,0o777);
 try{const path=join(parent,'tool'),body=Buffer.from('#!/bin/sh\necho BAD > '+marker+'\n');await writeFile(path,body,{mode:0o755});await expect(verifyBackupExecutable({path,sha256:createHash('sha256').update(body).digest('hex'),version:'SYNTHETIC_MUST_NOT_RUN'},new AbortController().signal)).rejects.toThrow('BACKUP_EXECUTABLE_PARENT_REJECTED');await expect(access(marker)).rejects.toMatchObject({code:'ENOENT'});}
 finally{await rm(root,{recursive:true,force:true});}
});
