import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readDmCaptureConfiguration} from '../../packages/dingtalk/src/dm-metadata-configuration.js';
const roots:string[]=[];async function fixture(extra:string){const root=await realpath(await mkdtemp(join(tmpdir(),'oa-dm-config-')));roots.push(root);const path=join(root,'fixture.env');await writeFile(path,'DINGTALK_CORP_ID=synthetic-corp\nDINGTALK_STAFFID=synthetic-self\nDINGTALK_ROBOT_CODE=synthetic-robot\n'+extra,{mode:0o600});return {root,path};}afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('reads an explicit isolated env file with existing APP_KEY/APP_SECRET aliases without changing process env',async()=>{
 const before={...process.env},f=await fixture('DINGTALK_APP_KEY=synthetic-alias-id\nDINGTALK_APP_SECRET=synthetic-alias-secret\nGLM_API_KEY=UNRELATED_SECRET\nDATABASE_URL_FILE=must-never-read\n');expect(await readDmCaptureConfiguration(f.path)).toEqual({identity:{corpId:'synthetic-corp',staffId:'synthetic-self',robotCode:'synthetic-robot'},credentials:{clientId:'synthetic-alias-id',clientSecret:'synthetic-alias-secret'}});expect(process.env).toEqual(before);
});
it('uses canonical inline names ahead of aliases and resolves mounted secrets relative to the env file',async()=>{
 const f=await fixture('DINGTALK_CLIENT_ID=canonical-id\nDINGTALK_APP_KEY=alias-id\nDINGTALK_CLIENT_SECRET_FILE=mounted-secret\nDINGTALK_APP_SECRET=alias-secret\n');await writeFile(join(f.root,'mounted-secret'),'canonical-secret\n',{mode:0o400});expect((await readDmCaptureConfiguration(f.path)).credentials).toEqual({clientId:'canonical-id',clientSecret:'canonical-secret'});
});
it('preserves the existing shared FILE-over-inline precedence and canonical-before-alias mount precedence',async()=>{
 const f=await fixture('DINGTALK_CLIENT_ID=inline-id\nDINGTALK_APP_KEY_FILE=alias-id-file\nDINGTALK_CLIENT_SECRET_FILE=canonical-secret-file\nDINGTALK_APP_SECRET_FILE=alias-secret-file\n');for(const [name,value]of [['alias-id-file','mounted-id'],['canonical-secret-file','canonical-mounted'],['alias-secret-file','alias-mounted']] as const)await writeFile(join(f.root,name),value,{mode:0o400});expect((await readDmCaptureConfiguration(f.path)).credentials).toEqual({clientId:'mounted-id',clientSecret:'canonical-mounted'});
});
it('rejects conflicting self aliases and missing config with a fixed code that does not print file contents',async()=>{
 const f=await fixture('STAFFID=other-self\nDINGTALK_APP_KEY=id\nDINGTALK_APP_SECRET=SECRET_CANARY\n');const error=await readDmCaptureConfiguration(f.path).catch(e=>e);expect(error).toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});expect(error.message).not.toContain('SECRET_CANARY');await expect(readDmCaptureConfiguration(join(f.root,'missing'))).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});
});

it('rejects a pipe or directory mount without blocking and limits credential/env file sizes',async()=>{
 const f=await fixture('DINGTALK_CLIENT_ID=id\nDINGTALK_CLIENT_SECRET_FILE=mount\n'),mount=join(f.root,'mount');
 await mkdir(mount);await expect(readDmCaptureConfiguration(f.path)).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});await rm(mount,{recursive:true});
 execFileSync('mkfifo',[mount]);const started=performance.now();await expect(readDmCaptureConfiguration(f.path)).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});expect(performance.now()-started).toBeLessThan(500);await rm(mount);
 await writeFile(mount,'x'.repeat(4097));await expect(readDmCaptureConfiguration(f.path)).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});
 await writeFile(f.path,'x'.repeat(1024*1024+1));await expect(readDmCaptureConfiguration(f.path)).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});
 execFileSync('mkfifo',[join(f.root,'env-pipe')]);await expect(readDmCaptureConfiguration(join(f.root,'env-pipe'))).rejects.toMatchObject({code:'DM_CAPTURE_CONFIGURATION_INVALID'});
},2000);
it('accepts a mounted regular-file symlink with the shared trim behavior',async()=>{
 const f=await fixture('DINGTALK_CLIENT_ID=id\nDINGTALK_CLIENT_SECRET_FILE=mount\n');await writeFile(join(f.root,'value'),'  mounted-secret\n');await symlink('value',join(f.root,'mount'));expect((await readDmCaptureConfiguration(f.path)).credentials).toEqual({clientId:'id',clientSecret:'mounted-secret'});
});
