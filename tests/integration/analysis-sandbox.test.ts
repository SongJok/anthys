import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {analysisJobSchema,type AnalysisJob} from '../../packages/analysis/src/job-contract.js';
import {DockerAnalysisSandbox} from '../../packages/sandbox/src/executor.js';

const imageTag=process.env.ANTHYS_SANDBOX_IMAGE??'anthys-analysis-sandbox:check';
let image:string,root:string,executor:DockerAnalysisSandbox;

function makeJob(options:{language?:'javascript'|'typescript';wallMs?:number;memoryMb?:number;outputBytes?:number;allowedOutputTypes?:string[];inputArtifactIds?:string[]}={}):AnalysisJob{
 return analysisJobSchema.parse({
  tenantId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),jobId:randomUUID(),
  language:options.language??'javascript',codeArtifactId:randomUUID(),inputArtifactIds:options.inputArtifactIds??[],
  network:'NONE',limits:{cpuMillis:5000,memoryMb:options.memoryMb??128,wallMs:options.wallMs??5000,outputBytes:options.outputBytes??64*1024},
  allowedOutputTypes:options.allowedOutputTypes??['json','markdown'],
 });
}
const containers=()=>execFileSync('docker',['ps','-a','--filter','name=anthys-sandbox-','--format','{{.Names}}'],{encoding:'utf8',timeout:30000}).trim();

beforeAll(async()=>{
 try{image=execFileSync('docker',['image','inspect','--format','{{.Id}}',imageTag],{encoding:'utf8',timeout:30000}).trim();}
 catch{throw Error(`SANDBOX_TEST_IMAGE_MISSING: build deploy/images/analysis-sandbox.Dockerfile and tag it as ${imageTag}`);}
 const base=join(process.cwd(),'.data','sandbox-tests');await mkdir(base,{recursive:true});root=await mkdtemp(join(base,'run-'));
 executor=new DockerAnalysisSandbox({image,seccompPath:join(process.cwd(),'deploy','policies','seccomp.json'),workspaceRoot:root,logBytes:32*1024});
});
afterAll(async()=>{if(root)await rm(root,{recursive:true,force:true,maxRetries:3});});
afterEach(async()=>{expect(await readdir(root)).toEqual([]);expect(containers()).toBe('');});

it('T097 runs JavaScript and TypeScript with read-only inputs and retrieves flat verified outputs',async()=>{
 const artifactId=randomUUID();
 const js=makeJob({inputArtifactIds:[artifactId]});
 const manifest=await executor.execute(js,`const fs=require('node:fs');const id=${JSON.stringify(artifactId)};const input=fs.readFileSync('/sandbox/input/'+id,'utf8');let write='WRITTEN';try{fs.writeFileSync('/sandbox/input/'+id,'changed');}catch(error){write=error.code??'DENIED';}fs.writeFileSync('/sandbox/output/result.json',JSON.stringify({input,write}));fs.writeFileSync('/sandbox/output/note.md','# ok');`, [{artifactId,bytes:Buffer.from('bound-input')}] ,new AbortController().signal);
 expect(manifest).toMatchObject({state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false});
 expect(manifest.outputs.map(output=>output.name)).toEqual(['note.md','result.json']);
 const result=manifest.outputs.find(output=>output.name==='result.json')!;
 expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({input:'bound-input',write:expect.not.stringMatching(/^WRITTEN$/)});
 expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
 const ts=makeJob({language:'typescript',allowedOutputTypes:['json']});
 const typed=await executor.execute(ts,`const value:number=41;require('node:fs').writeFileSync('/sandbox/output/result.json',JSON.stringify({value:value+1}));`,[]);
 expect(typed).toMatchObject({state:'SUCCEEDED',exitCode:0});
 expect(JSON.parse(new TextDecoder().decode(typed.outputs[0]!.bytes))).toEqual({value:42});
});

it('T097 hides host secrets, the Docker socket, child processes, PG modules and networking from generated code',async()=>{
 process.env.ANTHYS_TEST_SECRET='sandbox-test-secret-must-not-leak';process.env.DATABASE_URL='postgres://must-not-leak';
 try{
  const code=`(async()=>{
   const fs=require('node:fs'),result={envSecret:process.env.ANTHYS_TEST_SECRET??null,databaseUrl:process.env.DATABASE_URL??null};
   try{fs.readFileSync('/etc/passwd');result.passwd='READ';}catch(error){result.passwd=error.code??'DENIED';}
   try{fs.readFileSync('/var/run/docker.sock');result.dockerSocket='READ';}catch(error){result.dockerSocket=error.code??'DENIED';}
   try{require('node:child_process').execSync('id');result.fork='EXECUTED';}catch(error){result.fork=error.code??'DENIED';}
   try{require('pg');result.pg='LOADED';}catch(error){result.pg=error.code??'DENIED';}
   try{await fetch('http://127.0.0.1:64700/',{signal:AbortSignal.timeout(1500)});result.network='CONNECTED';}catch{result.network='BLOCKED';}
   fs.writeFileSync('/sandbox/output/result.json',JSON.stringify(result));
  })().catch(error=>{require('node:fs').writeFileSync('/sandbox/output/error.json',JSON.stringify({error:String(error)}));process.exitCode=1;});`;
  const run=await executor.execute(makeJob({wallMs:10000}),code,[]);
  expect(run.state).toBe('SUCCEEDED');
  const result=JSON.parse(new TextDecoder().decode(run.outputs.find(output=>output.name==='result.json')!.bytes));
  expect(result).toMatchObject({envSecret:null,databaseUrl:null,fork:'ERR_ACCESS_DENIED',pg:'MODULE_NOT_FOUND',network:'BLOCKED'});
  expect(result.passwd).not.toBe('READ');expect(result.dockerSocket).not.toBe('READ');
  expect(run.stdout+run.stderr).not.toContain('must-not-leak');
 }finally{delete process.env.ANTHYS_TEST_SECRET;delete process.env.DATABASE_URL;}
});

it('T098 terminates an infinite loop at the wall limit and removes the process and workspace',async()=>{
 const started=Date.now(),run=await executor.execute(makeJob({wallMs:1200}),'while(true){}',[]);
 expect(run).toMatchObject({state:'TIMEOUT',reason:'WALL_TIMEOUT',outputs:[]});
 expect(Date.now()-started).toBeLessThan(15000);
 expect(containers()).toBe('');
});

it('T098 contains memory exhaustion and output/file explosion instead of reporting success',async()=>{
 const memory=await executor.execute(makeJob({wallMs:20000,memoryMb:128,allowedOutputTypes:['json']}),`const keep=[];for(let i=0;i<1000000;i++)keep.push('x'.repeat(1024));require('node:fs').writeFileSync('/sandbox/output/result.json','{}');`,[]);
 expect(memory.state).not.toBe('SUCCEEDED');
 expect(memory.exitCode).not.toBe(0);
 expect(memory.exitCode===133||memory.oomKilled||/out of memory|heap limit|allocation failed/i.test(memory.stderr)).toBe(true);
 const explosion=await executor.execute(makeJob({wallMs:10000,outputBytes:4096,allowedOutputTypes:['json']}),`const fs=require('node:fs');for(let i=0;i<100;i++)fs.writeFileSync('/sandbox/output/f'+i+'.json','x'.repeat(1024));`,[]);
 expect(explosion).toMatchObject({state:'LIMIT_EXCEEDED',reason:'OUTPUT_LIMIT',outputs:[]});
});

it('T098 reconciles orphaned containers for a stable owner without touching active jobs or another owner',async()=>{
 const owner='reconcile-'+randomUUID(),scoped=new DockerAnalysisSandbox({image,seccompPath:join(process.cwd(),'deploy','policies','seccomp.json'),workspaceRoot:root,logBytes:32*1024,owner});
 const create=(jobId:string,labelOwner:string)=>execFileSync('docker',['create','--name','anthys-sandbox-reconcile-'+randomUUID(),'--label',`anthys.sandbox.owner=${labelOwner}`,'--label',`anthys.sandbox.job=${jobId}`,'--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=8m','--user','10001:10001',image,'-e','setInterval(()=>{},1000)'],{encoding:'utf8',timeout:30000}).trim();
 const activeJob=randomUUID(),orphanJob=randomUUID(),activeId=create(activeJob,owner),orphanId=create(orphanJob,owner),foreignId=create(randomUUID(),'foreign-'+owner);
 const exists=(id:string)=>execFileSync('docker',['ps','-a','--filter',`id=${id}`,'--format','{{.ID}}'],{encoding:'utf8',timeout:30000}).trim()!=='';
 try{
  await expect(scoped.reconcileOrphans([activeJob.toUpperCase()])).resolves.toEqual({removed:1,kept:1});
  expect(exists(activeId)).toBe(true);expect(exists(orphanId)).toBe(false);expect(exists(foreignId)).toBe(true);
  await expect(scoped.reconcileOrphans()).resolves.toEqual({removed:1,kept:0});
  expect(exists(activeId)).toBe(false);expect(exists(foreignId)).toBe(true);
 }finally{for(const id of [activeId,orphanId,foreignId]){try{execFileSync('docker',['rm','-f',id],{stdio:'ignore',timeout:30000});}catch{}}}
 expect(containers()).toBe('');
});

it('T098 rejects disallowed output extensions, symlinks and nested directories and still removes an unreadable workspace',async()=>{
 const run=await executor.execute(makeJob({allowedOutputTypes:['markdown']}),`const fs=require('node:fs');fs.writeFileSync('/sandbox/output/note.md','ok');fs.writeFileSync('/sandbox/output/result.json','{}');try{fs.symlinkSync('/etc/passwd','/sandbox/output/link.md');}catch{}`,[]);
 expect(run).toMatchObject({state:'FAILED',reason:'OUTPUT_INVALID',outputs:[]});
 const nested=await executor.execute(makeJob({allowedOutputTypes:['markdown']}),`const fs=require('node:fs');fs.writeFileSync('/sandbox/output/result.md','ok');fs.mkdirSync('/sandbox/output/locked',{mode:0o700});fs.chmodSync('/sandbox/output/locked',0o000);`,[]);
 expect(nested).toMatchObject({state:'LIMIT_EXCEEDED',outputs:[]});
 expect(await readdir(root)).toEqual([]);
});
