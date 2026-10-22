import {execFile,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,readdir,readFile,lstat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {types} from 'node:util';
import {analysisJobSchema,type AnalysisJob} from '../../analysis/src/job-contract.js';

const maxCodeBytes=1024*1024,maxInputBytes=8*1024*1024,maxOutputFiles=64,defaultLogBytes=64*1024,defaultPidsLimit=64;
const outputExtensions:Record<string,string>= {markdown:'md',txt:'txt',csv:'csv',json:'json',html:'html',xlsx:'xlsx',docx:'docx',pdf:'pdf'};
const containerIdPattern=/^[a-f0-9]{64}$/,fileNamePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,ownerPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type SandboxErrorCode='SANDBOX_IMAGE_INVALID'|'SANDBOX_CONFIGURATION_INVALID'|'SANDBOX_JOB_INVALID'|'SANDBOX_CODE_INVALID'|'SANDBOX_INPUT_INVALID'|'SANDBOX_RUNTIME_UNAVAILABLE'|'SANDBOX_CLEANUP_FAILED';
export class SandboxError extends Error{constructor(readonly code:SandboxErrorCode){super(code);this.name='SandboxError';}}

export type SandboxInput=Readonly<{artifactId:string;bytes:Uint8Array}>;
export type SandboxArtifact=Readonly<{name:string;bytes:Uint8Array;sha256:string}>;
export type SandboxState='SUCCEEDED'|'FAILED'|'TIMEOUT'|'CANCELLED'|'LIMIT_EXCEEDED';
export type SandboxReason='NONE'|'PROCESS_FAILED'|'OOM_KILLED'|'WALL_TIMEOUT'|'CANCELLED'|'OUTPUT_LIMIT'|'OUTPUT_INVALID';
export type SandboxExecutionResult=Readonly<{state:SandboxState;reason:SandboxReason;exitCode:number|null;oomKilled:boolean;outputs:readonly SandboxArtifact[];stdout:string;stderr:string;durationMs:number}>;
export type SandboxOptions=Readonly<{image:string;seccompPath:string;hostSeccompPath?:string;workspaceRoot?:string;hostWorkspaceRoot?:string;docker?:string;logBytes?:number;pidsLimit?:number;owner?:string}>;
export type SandboxReconciliation=Readonly<{removed:number;kept:number}>;
export type SandboxWorkspaceSweep=Readonly<{removed:number;retained:number;failed:number}>;

function configuration(options:SandboxOptions){
 if(typeof options.image!=='string'||!containerIdPattern.test(options.image.replace(/^sha256:/,'')))throw new SandboxError('SANDBOX_IMAGE_INVALID');
 if(typeof options.seccompPath!=='string'||!isAbsolute(options.seccompPath)||!existsSync(options.seccompPath))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
 if(options.hostWorkspaceRoot!==undefined&&(typeof options.hostWorkspaceRoot!=='string'||!isAbsolute(options.hostWorkspaceRoot)||options.hostWorkspaceRoot.includes('\0')))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
 if(options.hostSeccompPath!==undefined&&(typeof options.hostSeccompPath!=='string'||!isAbsolute(options.hostSeccompPath)||options.hostSeccompPath.includes('\0')))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
 if(options.logBytes!==undefined&&(!Number.isSafeInteger(options.logBytes)||options.logBytes<1024||options.logBytes>1024*1024))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
 if(options.pidsLimit!==undefined&&(!Number.isSafeInteger(options.pidsLimit)||options.pidsLimit<8||options.pidsLimit>1024))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
 if(options.owner!==undefined&&(typeof options.owner!=='string'||!ownerPattern.test(options.owner)))throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
}
function command(file:string,args:string[],timeout=30_000):Promise<string>{
 return new Promise((resolvePromise,reject)=>{
  execFile(file,args,{timeout,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>{if(error)reject(error);else resolvePromise(stdout);});
 });
}
function codeCheck(code:unknown){
 if(typeof code!=='string'||code.length===0||code.includes('\0')||Buffer.byteLength(code,'utf8')>maxCodeBytes)throw new SandboxError('SANDBOX_CODE_INVALID');
 return code;
}
function inputsCheck(job:AnalysisJob,raw:readonly SandboxInput[]){
 if(!Array.isArray(raw)||raw.length!==job.inputArtifactIds.length)throw new SandboxError('SANDBOX_INPUT_INVALID');
 const expected=new Set(job.inputArtifactIds),seen=new Set<string>(),values:SandboxInput[]=[];
 let total=0;
 for(const input of raw){
  if(!input||typeof input!=='object'||seen.has(input.artifactId)||!expected.has(input.artifactId))throw new SandboxError('SANDBOX_INPUT_INVALID');
  if(!(input.bytes instanceof Uint8Array)||types.isProxy(input.bytes))throw new SandboxError('SANDBOX_INPUT_INVALID');
  const bytes=Buffer.from(input.bytes);total+=bytes.length;
  if(bytes.length>maxInputBytes||total>maxInputBytes)throw new SandboxError('SANDBOX_INPUT_INVALID');
  seen.add(input.artifactId);values.push(Object.freeze({artifactId:input.artifactId,bytes}));
 }
 return Object.freeze(values);
}
function inspectState(text:string):{exitCode:number|null;oomKilled:boolean}{
 try{
  const state=JSON.parse(text) as {ExitCode?:unknown;OOMKilled?:unknown};const exitCode=typeof state.ExitCode==='number'?state.ExitCode:null;
  return {exitCode,oomKilled:state.OOMKilled===true};
 }catch{return {exitCode:null,oomKilled:false};}
}
async function removeContainer(docker:string,id:string){
 try{await command(docker,['rm','-f',id],15_000);}catch{}
}
async function outputUsage(dir:string,cap:number){
 try{
  const names=await readdir(dir);let bytes=0;
  if(names.length>maxOutputFiles)return {exceeded:true};
  for(const name of names){const stat=await lstat(join(dir,name));if(stat.isDirectory())return {exceeded:true};if(stat.isFile())bytes+=stat.size;if(bytes>cap)return {exceeded:true};}
  return {exceeded:false,bytes};
 }catch{return {exceeded:false,bytes:0};}
}
async function collectOutputs(dir:string,job:AnalysisJob):Promise<{ok:true;outputs:readonly SandboxArtifact[]}|{ok:false;reason:SandboxReason}>{
 let names:string[];
 try{names=await readdir(dir);}catch{return {ok:false,reason:'OUTPUT_INVALID'};}
 if(names.length>maxOutputFiles)return {ok:false,reason:'OUTPUT_LIMIT'};
 const allowed=new Set(job.allowedOutputTypes.map(type=>outputExtensions[type]!)),outputs:SandboxArtifact[]=[];let total=0;
 for(const name of names.sort()){
  if(!fileNamePattern.test(name))return {ok:false,reason:'OUTPUT_INVALID'};
  const extension=name.toLowerCase().split('.').pop()!;if(!allowed.has(extension))return {ok:false,reason:'OUTPUT_INVALID'};
  const path=join(dir,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())return {ok:false,reason:'OUTPUT_INVALID'};
  total+=stat.size;if(total>job.limits.outputBytes)return {ok:false,reason:'OUTPUT_LIMIT'};
  const bytes=await readFile(path);
  outputs.push(Object.freeze({name,bytes,sha256:createHash('sha256').update(bytes).digest('hex')}));
 }
 return {ok:true,outputs:Object.freeze(outputs)};
}
/** Host-side best-effort quota: the container gets no filesystem quota on the
 * bind output directory, so a poll kills it shortly after exceeding the cap. */
function watchOutput(dir:string,cap:number,onExceeded:()=>void){
 let busy=false;const timer=setInterval(()=>{
  if(busy)return;busy=true;
  void outputUsage(dir,cap).then(usage=>{if(usage.exceeded)onExceeded();}).finally(()=>{busy=false;});
 },25);
 timer.unref();return ()=>clearInterval(timer);
}
async function cleanupWorkspace(docker:string,image:string,hostSeccompPath:string,work:string,hostWork=work){
 try{await rm(work,{recursive:true,force:true,maxRetries:2});return;}catch{}
 const script="const fs=require('node:fs');const remove=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=p+'/'+e.name;if(e.isDirectory()){try{fs.chmodSync(q,0o700);}catch{}remove(q);}else{try{fs.chmodSync(q,0o600);}catch{}try{fs.unlinkSync(q);}catch{}}}};remove('/cleanup');";
 try{
  await command(docker,['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=8m','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges=true','--security-opt',`seccomp=${hostSeccompPath}`,'--mount',`type=bind,src=${hostWork},dst=/cleanup`,image,'-e',script],30_000);
 }catch{throw new SandboxError('SANDBOX_CLEANUP_FAILED');}
 try{await rm(work,{recursive:true,force:true,maxRetries:2});}catch{throw new SandboxError('SANDBOX_CLEANUP_FAILED');}
}
/**
 * Executes one already-authorized analysis job in the pinned offline image.
 * The caller must verify signature, current ACL/cancellation and bind artifact
 * contents before calling. This class does not resolve artifacts or persist results.
 */
export class DockerAnalysisSandbox{
 private readonly docker:string;
 private readonly owner:string;
 private readonly hostRoot:string;
 private readonly hostSeccomp:string;
 private readonly active=new Set<string>();
 constructor(private readonly options:SandboxOptions){configuration(options);this.docker=options.docker??'docker';this.owner=options.owner??randomUUID();this.hostRoot=options.hostWorkspaceRoot??resolve(options.workspaceRoot??join(tmpdir(),'anthys-sandbox'));this.hostSeccomp=options.hostSeccompPath??options.seccompPath;}
 async execute(rawJob:unknown,rawCode:unknown,rawInputs:readonly SandboxInput[],signal?:AbortSignal):Promise<SandboxExecutionResult>{
  let job:AnalysisJob;try{job=analysisJobSchema.parse(rawJob);}catch{throw new SandboxError('SANDBOX_JOB_INVALID');}
  const code=codeCheck(rawCode),inputs=inputsCheck(job,rawInputs);
  if(signal?.aborted)return Object.freeze({state:'CANCELLED',reason:'CANCELLED',exitCode:null,oomKilled:false,outputs:Object.freeze([]),stdout:'',stderr:'',durationMs:0});
  const root=resolve(this.options.workspaceRoot??join(tmpdir(),'anthys-sandbox'));
  await mkdir(root,{recursive:true,mode:0o700});
  const work=await mkdtemp(join(root,`job-${this.owner}-`)),hostWork=join(this.hostRoot,basename(work));
  this.active.add(work);
  try{
   const workspace=await this.prepare(work,job,code,inputs),started=Date.now(),name=`anthys-sandbox-${randomUUID()}`;
   const memoryMb=job.limits.memoryMb,heapMb=Math.max(32,memoryMb-32),cpuSeconds=Math.max(1,Math.ceil(job.limits.cpuMillis/1000));
   const inputDir=join(hostWork,'input'),outputDir=join(hostWork,'output');
   const createArgs=['create','--name',name,'--label',`anthys.sandbox.owner=${this.owner}`,'--label',`anthys.sandbox.job=${job.jobId}`,'--pull','never','--network','none','--ipc','none','--read-only',
    '--tmpfs',`/tmp:rw,noexec,nosuid,nodev,size=${Math.min(memoryMb,64)}m`,
    '--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges=true','--security-opt',`seccomp=${this.hostSeccomp}`,
    '--pids-limit',String(this.options.pidsLimit??defaultPidsLimit),'--memory',`${memoryMb}m`,'--memory-swap',`${memoryMb}m`,'--cpus','1',
    '--ulimit',`cpu=${cpuSeconds}:${cpuSeconds+1}`,'--ulimit','nofile=64:64',
    '--mount',`type=bind,src=${inputDir},dst=/sandbox/input,readonly`,'--mount',`type=bind,src=${outputDir},dst=/sandbox/output`,
    '--workdir','/sandbox','--env',`NODE_OPTIONS=--max-old-space-size=${heapMb}`,'--env','NODE_NO_WARNINGS=1',
    '--env','ANTHYS_INPUT_DIR=/sandbox/input','--env','ANTHYS_OUTPUT_DIR=/sandbox/output',this.options.image,
    '--permission','--allow-fs-read=/sandbox/input','--allow-fs-read=/sandbox/output','--allow-fs-write=/sandbox/output','--allow-fs-write=/tmp',
    `/sandbox/input/code.${workspace.extension}`];
   let id:string;
   try{const created=(await command(this.docker,createArgs,30_000)).trim();if(!containerIdPattern.test(created))throw Error();id=created;}
   catch{throw new SandboxError('SANDBOX_RUNTIME_UNAVAILABLE');}
   try{return await this.start(id,work,job,started,signal);}
   finally{await removeContainer(this.docker,id);}
  }finally{
   try{await cleanupWorkspace(this.docker,this.options.image,this.hostSeccomp,work,hostWork);}
   finally{this.active.delete(work);}
  }
 }
 /** Removes this owner's stale workspace directories. Active jobs and other
  * owners are retained; a non-zero minAge avoids racing a just-created workspace. */
 async sweepWorkspaces(options:{minAgeMs?:number;limit?:number}={}):Promise<SandboxWorkspaceSweep>{
  const minAgeMs=options.minAgeMs??60_000,limit=options.limit??100;
  if(!Number.isSafeInteger(minAgeMs)||minAgeMs<0||minAgeMs>7*86_400_000||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new SandboxError('SANDBOX_CONFIGURATION_INVALID');
  const root=resolve(this.options.workspaceRoot??join(tmpdir(),'anthys-sandbox'));
  let entries;
  try{entries=await readdir(root,{withFileTypes:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return Object.freeze({removed:0,retained:0,failed:0});throw new SandboxError('SANDBOX_CLEANUP_FAILED');}
  let removed=0,retained=0,failed=0;const prefix=`job-${this.owner}-`;
  for(const entry of entries){
   if(!entry.isDirectory()||!entry.name.startsWith(prefix)){retained++;continue;}
   const work=join(root,entry.name);
   if(this.active.has(work)){retained++;continue;}
   let stat;try{stat=await lstat(work);}catch{failed++;continue;}
   if(!stat.isDirectory()||stat.isSymbolicLink()||Date.now()-stat.mtimeMs<minAgeMs||removed>=limit){retained++;continue;}
   try{await cleanupWorkspace(this.docker,this.options.image,this.hostSeccomp,work,join(this.hostRoot,entry.name));removed++;}
   catch{failed++;}
  }
  return Object.freeze({removed,retained,failed});
 }
 /**
  * Removes containers carrying this broker's stable owner label unless their
  * job is in the active set. Call at startup with no active jobs after the
  * previous process died; the owner must be unique to one live broker so a
  * second replica's jobs are never reaped.
  */
 async reconcileOrphans(activeJobIds:Iterable<string>=[]):Promise<SandboxReconciliation>{
  const active=new Set<string>();
  for(const id of activeJobIds)if(typeof id==='string')active.add(id.toLowerCase());
  let listing:string;
  try{listing=await command(this.docker,['ps','-a','--filter',`label=anthys.sandbox.owner=${this.owner}`,'--filter',`ancestor=${this.options.image}`,'--format','{{.ID}}\t{{.Labels}}'],30_000);}
  catch{throw new SandboxError('SANDBOX_RUNTIME_UNAVAILABLE');}
  let removed=0,kept=0,failed=false;
  for(const line of listing.split('\n')){
   if(!line.trim())continue;
   const [id='',labels='']=line.split('\t');
   if(!/^[a-f0-9]{12,64}$/.test(id))continue;
   let jobId='';
   for(const pair of labels.split(',')){const separator=pair.indexOf('=');if(separator>0&&pair.slice(0,separator)==='anthys.sandbox.job'){jobId=pair.slice(separator+1);break;}}
   if(jobId&&active.has(jobId.toLowerCase())){kept++;continue;}
   try{await command(this.docker,['rm','-f',id],15_000);removed++;}
   catch{failed=true;}
  }
  if(failed)throw new SandboxError('SANDBOX_CLEANUP_FAILED');
  return Object.freeze({removed,kept});
 }
 private async prepare(work:string,job:AnalysisJob,code:string,inputs:readonly SandboxInput[]){
  const input=join(work,'input'),output=join(work,'output'),extension=job.language==='typescript'?'ts':'js';
  await mkdir(input,{recursive:true,mode:0o755});await mkdir(output,{recursive:true,mode:0o777});
  await chmod(input,0o755);await chmod(output,0o777);
  await writeFile(join(input,`code.${extension}`),code,{mode:0o444});
  for(const item of inputs)await writeFile(join(input,item.artifactId),item.bytes,{mode:0o444});
  await writeFile(join(input,'manifest.json'),JSON.stringify({codeArtifactId:job.codeArtifactId,language:job.language,inputArtifactIds:job.inputArtifactIds}),{mode:0o444});
  return {input,output,extension};
 }
 private start(id:string,work:string,job:AnalysisJob,started:number,signal?:AbortSignal){
  return new Promise<SandboxExecutionResult>((resolvePromise,reject)=>{
   const output=join(work,'output'),logCap=this.options.logBytes??defaultLogBytes;
   let stdout='',stderr='',timedOut=false,cancelled=false,logLimit=false,outputLimit=false,closed=false,killPromise:Promise<void>|undefined;
   const kill=()=>{killPromise??=removeContainer(this.docker,id);return killPromise;};
   const child=spawn(this.docker,['start','-a',id],{stdio:['ignore','pipe','pipe']});
   const stopWatch=watchOutput(output,job.limits.outputBytes,()=>{outputLimit=true;void kill();});
   const timer=setTimeout(()=>{timedOut=true;void kill();},Math.max(1,job.limits.wallMs));
   const abort=()=>{cancelled=true;void kill();};
   signal?.addEventListener('abort',abort,{once:true});
   const capture=(chunk:string,current:string)=>{
    if(Buffer.byteLength(current,'utf8')+Buffer.byteLength(chunk,'utf8')>logCap){logLimit=true;void kill();return current;}
    return current+chunk;
   };
   child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
   child.stdout!.on('data',(chunk:string)=>{stdout=capture(chunk,stdout);});
   child.stderr!.on('data',(chunk:string)=>{stderr=capture(chunk,stderr);});
   child.on('error',()=>{closed=true;clearTimeout(timer);stopWatch();signal?.removeEventListener('abort',abort);void kill().finally(()=>reject(new SandboxError('SANDBOX_RUNTIME_UNAVAILABLE')));});
   child.on('close',code=>{
    if(closed)return;closed=true;clearTimeout(timer);stopWatch();signal?.removeEventListener('abort',abort);
    void (async()=>{
     let state:ReturnType<typeof inspectState>={exitCode:code,oomKilled:false};
     try{state=inspectState(await command(this.docker,['inspect','--format','{{json .State}}',id],15_000));}catch{}
     let result:SandboxExecutionResult;
     if(cancelled)result={state:'CANCELLED',reason:'CANCELLED',exitCode:state.exitCode,oomKilled:false,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     else if(timedOut)result={state:'TIMEOUT',reason:'WALL_TIMEOUT',exitCode:state.exitCode,oomKilled:false,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     else if(logLimit||outputLimit)result={state:'LIMIT_EXCEEDED',reason:'OUTPUT_LIMIT',exitCode:state.exitCode,oomKilled:false,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     else if(state.oomKilled&&state.exitCode!==0)result={state:'FAILED',reason:'OOM_KILLED',exitCode:state.exitCode,oomKilled:true,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     else if(state.exitCode!==0)result={state:'FAILED',reason:'PROCESS_FAILED',exitCode:state.exitCode,oomKilled:false,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     else{
      const outputs=await collectOutputs(output,job);
      result=outputs.ok?{state:'SUCCEEDED',reason:'NONE',exitCode:0,oomKilled:false,outputs:outputs.outputs,stdout,stderr,durationMs:Date.now()-started}
       :{state:outputs.reason==='OUTPUT_LIMIT'?'LIMIT_EXCEEDED':'FAILED',reason:outputs.reason,exitCode:0,oomKilled:false,outputs:[],stdout,stderr,durationMs:Date.now()-started};
     }
     await kill();
     resolvePromise(Object.freeze(result));
    })().catch(error=>{void kill();reject(error instanceof SandboxError?error:new SandboxError('SANDBOX_RUNTIME_UNAVAILABLE'));});
   });
  });
 }
}
