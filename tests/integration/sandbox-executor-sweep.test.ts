import '../support/isolation.js';
import {lstat,mkdir,mkdtemp,realpath,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DockerAnalysisSandbox} from '../../packages/sandbox/src/executor.js';

const image='sha256:'+'f'.repeat(64),owner='sweep-owner';

it('sweeps only stale workspaces of this owner and retains fresh, foreign or unrelated directories',async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'anthys-sweep-test-')));
 const workspace=join(base,'workspaces'),policy=join(base,'seccomp.json');
 await mkdir(workspace,{mode:0o700});await writeFile(policy,'{}');
 const sandbox=new DockerAnalysisSandbox({image,seccompPath:policy,workspaceRoot:workspace,owner,docker:join(base,'missing-docker')});
 const stale=join(workspace,`job-${owner}-stale`),fresh=join(workspace,`job-${owner}-fresh`),foreign=join(workspace,'job-other-owner-stale'),unrelated=join(workspace,'not-a-job'),plainFile=join(workspace,`job-${owner}-file`);
 await mkdir(join(stale,'nested'),{recursive:true});await writeFile(join(stale,'nested','input.txt'),'secret');
 await mkdir(fresh,{recursive:true});await mkdir(foreign,{recursive:true});await mkdir(unrelated,{recursive:true});
 try{
  await utimes(stale,new Date(Date.now()-120_000),new Date(Date.now()-120_000));
  await utimes(foreign,new Date(Date.now()-120_000),new Date(Date.now()-120_000));
  const result=await sandbox.sweepWorkspaces({minAgeMs:60_000});
  expect(result).toEqual({removed:1,retained:3,failed:0});
  await expect(lstat(stale)).rejects.toMatchObject({code:'ENOENT'});
  for(const path of [fresh,foreign,unrelated])expect((await lstat(path)).isDirectory()).toBe(true);

  await writeFile(plainFile,'not a directory');
  expect(await sandbox.sweepWorkspaces({minAgeMs:60_000})).toEqual({removed:0,retained:4,failed:0});
  await expect(lstat(plainFile)).resolves.toBeDefined();

  await mkdir(join(workspace,`job-${owner}-one`));await mkdir(join(workspace,`job-${owner}-two`));
  for(const name of ['one','two'])await utimes(join(workspace,`job-${owner}-${name}`),new Date(Date.now()-120_000),new Date(Date.now()-120_000));
  expect(await sandbox.sweepWorkspaces({minAgeMs:60_000,limit:1})).toEqual({removed:1,retained:5,failed:0});
  expect(await sandbox.sweepWorkspaces({minAgeMs:60_000})).toEqual({removed:1,retained:4,failed:0});

  await expect(sandbox.sweepWorkspaces({minAgeMs:-1})).rejects.toMatchObject({code:'SANDBOX_CONFIGURATION_INVALID'});
  await expect(sandbox.sweepWorkspaces({minAgeMs:7*86_400_000+1})).rejects.toMatchObject({code:'SANDBOX_CONFIGURATION_INVALID'});
  await expect(sandbox.sweepWorkspaces({limit:0})).rejects.toMatchObject({code:'SANDBOX_CONFIGURATION_INVALID'});
  await expect(sandbox.sweepWorkspaces({limit:501})).rejects.toMatchObject({code:'SANDBOX_CONFIGURATION_INVALID'});

  const missing=new DockerAnalysisSandbox({image,seccompPath:policy,workspaceRoot:join(base,'missing'),owner,docker:join(base,'missing-docker')});
  expect(await missing.sweepWorkspaces()).toEqual({removed:0,retained:0,failed:0});
 }finally{await rm(base,{recursive:true,force:true});}
});
