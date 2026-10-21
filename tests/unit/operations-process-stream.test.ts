import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Readable} from 'node:stream';
import {createProcessReadable,type ProcessReadableOptions,type ProcessReadableResult,type ProcessStreamErrorCode} from '../../packages/operations/src/process-stream.js';
let directory:string;const handles=new Set<ProcessReadableResult>();
beforeEach(async()=>{directory=await realpath(await mkdtemp(join(tmpdir(),'oa-process-stream-')));});
afterEach(async()=>{await Promise.all([...handles].map(h=>h.close()));await Promise.all([...handles].map(h=>h.completion.catch(()=>{})));handles.clear();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
function start(code:string,patch:Partial<ProcessReadableOptions>={}){const h=createProcessReadable({file:process.execPath,args:['-e',code],cwd:directory,env:{},signal:new AbortController().signal,timeoutMs:5000,maxStdoutBytes:1024*1024,maxStderrBytes:1024,...patch});handles.add(h);return h;}
async function read(stream:Readable){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
async function failure(h:ProcessReadableResult,code:ProcessStreamErrorCode){const consumed=read(h.stream);void consumed.catch(()=>{});await expect(h.completion).rejects.toMatchObject({code});await expect(consumed).rejects.toMatchObject({code});expect(h.stream.destroyed).toBe(true);}
async function present(path:string){try{await access(path);return true;}catch{return false;}}
function reaped(pid:number){expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);let error:unknown;try{process.kill(pid,0);}catch(caught){error=caught;}expect((error as NodeJS.ErrnoException|undefined)?.code).toBe('ESRCH');}
async function waitFile(path:string){const deadline=Date.now()+3000;while(!await present(path)){if(Date.now()>=deadline)throw Error('SYNTHETIC_CHILD_NOT_READY');await new Promise(r=>setTimeout(r,10));}}

it('counts actual stdout/stderr UTF8 bytes, closes stdin, returns no stderr body and is idempotently closable',async()=>{
 const h=start("process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('a中😀');process.stderr.write('SYNTHETIC_STDERR');});");
 const bytes=await read(h.stream);expect(bytes.toString()).toBe('a中😀');expect(await h.completion).toEqual({stdoutBytes:8,stderrBytes:Buffer.byteLength('SYNTHETIC_STDERR')});expect(h.close()).toBe(h.close());await h.close();
});
it('passes literal argv with shell disabled and uses only the explicit copied environment',async()=>{
 vi.stubEnv('SYNTHETIC_PARENT_SECRET','MUST_NOT_INHERIT');const env={SYNTHETIC_EXPLICIT:'ORIGINAL'},arg='$(not-a-command); echo SYNTHETIC';
 const h=start("process.stdout.write(JSON.stringify([process.argv[1],process.env.SYNTHETIC_PARENT_SECRET??null,process.env.SYNTHETIC_EXPLICIT]));",{args:['-e',"process.stdout.write(JSON.stringify([process.argv[1],process.env.SYNTHETIC_PARENT_SECRET??null,process.env.SYNTHETIC_EXPLICIT]));",arg],env});env.SYNTHETIC_EXPLICIT='MUTATED';
 expect(JSON.parse((await read(h.stream)).toString())).toEqual([arg,null,'ORIGINAL']);await expect(h.completion).resolves.toMatchObject({stderrBytes:0});
});
it('withholds returned EOF after stdout closes until the child actually closes with code zero',async()=>{
 const h=start("process.stdout.end('SYNTHETIC_OK');setTimeout(()=>process.exit(0),200);");let ended=false;h.stream.once('end',()=>{ended=true;});
 const first=new Promise<void>(resolve=>h.stream.once('data',()=>resolve())),consumed=read(h.stream);await first;expect(ended).toBe(false);let completed=false;void h.completion.then(()=>{completed=true;});await new Promise(r=>setTimeout(r,50));expect(ended).toBe(false);expect(completed).toBe(false);
 expect((await consumed).toString()).toBe('SYNTHETIC_OK');expect(await h.completion).toEqual({stdoutBytes:12,stderrBytes:0});expect(ended).toBe(true);
});
it('nonzero exit after stdout EOF cannot finalize a consumer as success or expose stderr/argv',async()=>{
 const h=start("process.stdout.end('PARTIAL');process.stderr.write('SYNTHETIC_PRIVATE_ERROR');setTimeout(()=>process.exit(7),80);");let ended=false;h.stream.once('end',()=>{ended=true;});
 await failure(h,'PROCESS_EXIT_FAILED');expect(ended).toBe(false);try{await h.completion;}catch(error){expect(String(error)).toBe('ProcessStreamError: PROCESS_EXIT_FAILED');expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ERROR');expect(String(error)).not.toContain(directory);}
});
it('monotonic deadline vetoes EOF even before a delayed timeout callback can run',async()=>{
 const realNow=performance.now.bind(performance);let advance=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>realNow()+advance);
 try{const h=start("process.stdout.end('READY');setTimeout(()=>process.exit(0),100);");let ended=false;h.stream.once('end',()=>{ended=true;});const first=new Promise<void>(resolve=>h.stream.once('data',()=>resolve())),consumed=read(h.stream);void consumed.catch(()=>{});await first;advance=6000;await expect(h.completion).rejects.toMatchObject({code:'PROCESS_TIMEOUT'});await expect(consumed).rejects.toMatchObject({code:'PROCESS_TIMEOUT'});expect(ended).toBe(false);}finally{clock.mockRestore();}
});
it('empty output succeeds only after zero exit and consumer EOF',async()=>{const h=start('process.exit(0);');expect(await read(h.stream)).toEqual(Buffer.alloc(0));expect(await h.completion).toEqual({stdoutBytes:0,stderrBytes:0});});
it('successful child close without consumption is not completion and times out fail-closed',async()=>{
 const h=start("process.stdout.end('SYNTHETIC_UNCONSUMED');",{timeoutMs:200});await expect(h.completion).rejects.toMatchObject({code:'PROCESS_TIMEOUT'});expect(h.stream.destroyed).toBe(true);
});
it.each(['stdout','stderr'] as const)('%s byte excess fails and returns no successful completion',async which=>{
 const h=start(`process.${which}.write(Buffer.alloc(65,120));setInterval(()=>{},1000);`,{maxStdoutBytes:64,maxStderrBytes:64});await failure(h,which==='stdout'?'PROCESS_STDOUT_LIMIT':'PROCESS_STDERR_LIMIT');
});
it('exact byte budgets are inclusive',async()=>{const h=start("process.stdout.write(Buffer.alloc(64));process.stderr.write(Buffer.alloc(32));",{maxStdoutBytes:64,maxStderrBytes:32});expect((await read(h.stream)).length).toBe(64);expect(await h.completion).toEqual({stdoutBytes:64,stderrBytes:32});});
it('spawn error is asynchronous, fixed and still closable without leaking the executable path',async()=>{
 const h=start('',{file:join(directory,'SYNTHETIC_MISSING_EXECUTABLE')});await failure(h,'PROCESS_SPAWN_FAILED');await h.close();try{await h.completion;}catch(error){expect(String(error)).not.toContain(directory);}
});
it('abort after start terminates and reaps an actual child',async()=>{
 const controller=new AbortController(),h=start("process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000);",{signal:controller.signal});
 const pid=await new Promise<number>(resolve=>h.stream.once('data',chunk=>resolve(Number(String(chunk).trim()))));controller.abort();await expect(h.completion).rejects.toMatchObject({code:'PROCESS_ABORTED'});reaped(pid);
});
it('SIGTERM-ignoring child is killed and reaped rather than orphaned',async()=>{
 const controller=new AbortController(),h=start("process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000);",{signal:controller.signal});
 const pid=await new Promise<number>(resolve=>h.stream.once('data',chunk=>resolve(Number(String(chunk).trim())))),at=performance.now();controller.abort();await expect(h.completion).rejects.toMatchObject({code:'PROCESS_ABORTED'});expect(performance.now()-at).toBeGreaterThanOrEqual(150);reaped(pid);
});
it('timeout terminates a live child and destroys output',async()=>{await failure(start('setInterval(()=>{},1000);',{timeoutMs:80}),'PROCESS_TIMEOUT');});
it('consumer destroy rejects completion, kills/reaps child and close stays idempotent',async()=>{
 const h=start("process.stdout.write('READY');setInterval(()=>{},1000);");await new Promise<void>(resolve=>h.stream.once('data',()=>resolve()));h.stream.destroy();await expect(h.completion).rejects.toMatchObject({code:'PROCESS_CONSUMER_CLOSED'});expect(h.close()).toBe(h.close());await h.close();
});
it('explicit early close is a failure, never a successful empty archive',async()=>{const h=start('setInterval(()=>{},1000);');const closed=h.close();expect(h.close()).toBe(closed);await closed;await expect(h.completion).rejects.toMatchObject({code:'PROCESS_CLOSED'});expect(h.stream.destroyed).toBe(true);});
it('real pipe backpressure blocks the producer until a slow consumer drains bounded chunks',async()=>{
 const ready=join(directory,'ready'),done=join(directory,'done'),total=4*1024*1024;
 const h=start("const fs=require('node:fs');(async()=>{fs.writeFileSync(process.argv[1],'READY');for(let n=0;n<64;n++)if(!process.stdout.write(Buffer.alloc(65536,7)))await new Promise(r=>process.stdout.once('drain',r));fs.writeFileSync(process.argv[2],'DONE');})();",{args:['-e',"const fs=require('node:fs');(async()=>{fs.writeFileSync(process.argv[1],'READY');for(let n=0;n<64;n++)if(!process.stdout.write(Buffer.alloc(65536,7)))await new Promise(r=>process.stdout.once('drain',r));fs.writeFileSync(process.argv[2],'DONE');})();",ready,done],maxStdoutBytes:total,timeoutMs:10000});
 await waitFile(ready);await new Promise(r=>setTimeout(r,80));expect(await present(done)).toBe(false);expect(h.stream.readableLength).toBeLessThanOrEqual(128*1024);
 let count=0;for await(const chunk of h.stream){count+=Buffer.byteLength(chunk);await new Promise(r=>setTimeout(r,1));}expect(count).toBe(total);expect(await h.completion).toEqual({stdoutBytes:total,stderrBytes:0});expect(await readFile(done,'utf8')).toBe('DONE');
});
it('pre-abort rejects synchronously without creating the synthetic marker child',async()=>{
 const controller=new AbortController();controller.abort();const marker=join(directory,'never-created');expect(()=>start("require('node:fs').writeFileSync(process.argv[1],'BAD');",{args:['-e',"require('node:fs').writeFileSync(process.argv[1],'BAD');",marker],signal:controller.signal})).toThrow('PROCESS_ABORTED_BEFORE_SPAWN');expect(await present(marker)).toBe(false);
});
it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('invalid integer resource limit %s is synchronously rejected',value=>{
 for(const key of ['timeoutMs','maxStdoutBytes','maxStderrBytes'])expect(()=>start('',{[key]:value})).toThrow('PROCESS_OPTIONS_INVALID');
});
it('rejects overlong timeout, implicit cwd/executable, sparse argv, NUL and inherited/accessor options',()=>{
 for(const patch of [{timeoutMs:3600001},{file:'node'},{cwd:'.'},{args:new Array(1)},{args:['x\0y']},{env:{BAD:'x\0y'}},{env:{BAD:undefined}}])expect(()=>start('',patch as Partial<ProcessReadableOptions>)).toThrow('PROCESS_OPTIONS_INVALID');
 let getters=0;const env=Object.defineProperty({},'PRIVATE',{enumerable:true,get(){getters++;throw Error('BAD');}});expect(()=>start('',{env})).toThrow('PROCESS_OPTIONS_INVALID');expect(getters).toBe(0);
});
