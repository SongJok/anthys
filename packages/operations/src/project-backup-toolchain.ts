import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,dirname,parse,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createProcessReadable,ProcessStreamError} from './process-stream.js';

export type BackupExecutablePin={path:string;sha256:string;version:string};
class ExecutableError extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new ExecutableError(code);};
async function executableParents(path:string){
 const parent=dirname(path),parts=parent.slice(parse(parent).root.length).split(sep).filter(Boolean),stamps:{path:string;ino:number;dev:number;uid:number;mode:number}[]=[];let current=parse(parent).root;
 for(const part of ['',...parts]){if(part)current=join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid?.()].includes(s.uid)||((s.mode&0o022)!==0&&(s.mode&0o1000)===0))fail('BACKUP_EXECUTABLE_PARENT_REJECTED');stamps.push({path:current,ino:s.ino,dev:s.dev,uid:s.uid,mode:s.mode});}return stamps;
}
async function unchangedParents(stamps:Awaited<ReturnType<typeof executableParents>>){for(const old of stamps){const s=await lstat(old.path);if(!s.isDirectory()||s.isSymbolicLink()||s.ino!==old.ino||s.dev!==old.dev||s.uid!==old.uid||s.mode!==old.mode)fail('BACKUP_EXECUTABLE_PARENT_CHANGED');}}


/** Internal executable check, not a certification or a user-command tool.
 * The project profile separately restricts production pins to PG17. A matching
 * version is insufficient without the exact reviewed executable hash. Shared
 * libraries and privileged/same-UID tampering are outside this byte pin. */
export async function verifyBackupExecutable(pin:BackupExecutablePin,signal:AbortSignal,maxDurationMs=5000){
 if(!pin||!isAbsolute(pin.path)||pin.path.length>4096||/[\u0000-\u001f\u007f]/.test(pin.path)||!/^[a-f0-9]{64}$/.test(pin.sha256)||typeof pin.version!=='string'||pin.version.length<1||pin.version.length>256||/[\u0000-\u001f\u007f]/.test(pin.version)||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>10000)fail('BACKUP_EXECUTABLE_OPTIONS_REJECTED');
 const deadline=performance.now()+maxDurationMs;
 const check=()=>{if(signal.aborted)fail('BACKUP_EXECUTABLE_CANCELLED');if(performance.now()>=deadline)fail('BACKUP_EXECUTABLE_TIMEOUT');};
 check();let file:Awaited<ReturnType<typeof open>>|undefined,process:ReturnType<typeof createProcessReadable>|undefined;
 try{
  const parents=await executableParents(pin.path);if(await realpath(pin.path)!==pin.path)fail('BACKUP_EXECUTABLE_PATH_REJECTED');file=await open(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await file.stat();
  if(!before.isFile()||![0,globalThis.process.getuid?.()].includes(before.uid)||(before.mode&0o022)!==0||(before.mode&0o111)===0||before.size<1||before.size>256*1024*1024)fail('BACKUP_EXECUTABLE_FILE_REJECTED');
  const digest=createHash('sha256'),chunk=Buffer.alloc(64*1024);let bytes=0;
  // Keep this descriptor open for the post-process inode comparison. Destroying
  // a FileHandle read stream can close its descriptor even with autoClose:false.
  for(;;){check();const read=await file.read(chunk,0,chunk.length,bytes);if(read.bytesRead===0)break;bytes+=read.bytesRead;if(bytes>before.size)fail('BACKUP_EXECUTABLE_CHANGED');digest.update(chunk.subarray(0,read.bytesRead));}
  if(bytes!==before.size||digest.digest('hex')!==pin.sha256)fail('BACKUP_EXECUTABLE_HASH_REJECTED');check();
  await unchangedParents(parents);check();const remaining=Math.floor(deadline-performance.now());if(remaining<1)fail('BACKUP_EXECUTABLE_TIMEOUT');
  process=createProcessReadable({file:pin.path,args:['--version'],cwd:'/',env:{LC_ALL:'C',LANG:'C'},signal,timeoutMs:remaining,maxStdoutBytes:4096,maxStderrBytes:4096});
  const parts:Buffer[]=[];for await(const chunk of process.stream){check();parts.push(Buffer.from(chunk));}const observed=await process.completion;check();
  const version=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)).trim();if(observed.stderrBytes!==0||version!==pin.version)fail('BACKUP_EXECUTABLE_VERSION_REJECTED');
  await unchangedParents(parents);const after=await file.stat(),named=await lstat(pin.path);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.mode!==after.mode||before.uid!==after.uid||named.dev!==before.dev||named.ino!==before.ino||await realpath(pin.path)!==pin.path)fail('BACKUP_EXECUTABLE_CHANGED');
  return {path:pin.path,sha256:pin.sha256,version:pin.version,sharedLibrariesIndependentlyVerified:false as const,processesStarted:1 as const,databaseAccess:false as const};
 }catch(error){throw error instanceof ExecutableError?error:new ExecutableError(signal.aborted?'BACKUP_EXECUTABLE_CANCELLED':error instanceof ProcessStreamError?'BACKUP_EXECUTABLE_'+error.code:'BACKUP_EXECUTABLE_CHECK_FAILED');}
 finally{await process?.close().catch(()=>{});await file?.close().catch(()=>{});}
}
