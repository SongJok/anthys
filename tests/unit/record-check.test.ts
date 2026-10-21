import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
it('check records survive generated directories, redact secrets and preserve the child failure exit code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oa-check-')),script=resolve('scripts/record-check.mjs'),sentinel='synthetic-check-secret-0123456789';
 try{
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});git('init');await writeFile(join(root,'source.txt'),'stable source');git('add','source.txt');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','synthetic fixture');
  await mkdir(join(root,'.data/test-environment/browser-input-files'),{recursive:true});await mkdir(join(root,'.secrets/nested'),{recursive:true});await writeFile(join(root,'.secrets/key'),sentinel);
  await writeFile(join(root,'.gitignore'),'.secrets/\n.data/\nreports/\n');git('add','.gitignore');git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','synthetic exclusions');
  const child=spawnSync(process.execPath,[script,'synthetic-failure',process.execPath,'-e',`process.stdout.write(${JSON.stringify(sentinel)});process.exitCode=7;`],{cwd:root,encoding:'utf8'});expect(child.status).toBe(7);
  const report=JSON.parse(await readFile(join(root,'reports/checks/synthetic-failure.json'),'utf8'));expect(report).toMatchObject({status:'FAIL',exitCode:7,workingTreeDirty:false,candidateStable:true,live:false,output:'[REDACTED_SECRET]'});expect(report.codeCommit).toMatch(/^[0-9a-f]{40}$/);expect(await readFile(join(root,'reports/raw/synthetic-failure.log'),'utf8')).not.toContain(sentinel);
 }finally{await rm(root,{recursive:true,force:true});}
});
