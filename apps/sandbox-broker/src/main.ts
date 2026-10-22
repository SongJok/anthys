import {execFile} from 'node:child_process';
import {createPublicKey} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {Database} from '../../../packages/storage/src/database.js';
import {Vault} from '../../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../../packages/storage/src/files.js';
import {PgSandboxBrokerStore,SandboxBroker} from '../../../packages/sandbox/src/broker.js';
import {PgSandboxAuthorizer} from '../../../packages/sandbox/src/authorizer.js';
import {PgSandboxArtifactConnector} from '../../../packages/sandbox/src/artifacts.js';
import {DockerAnalysisSandbox} from '../../../packages/sandbox/src/executor.js';
import {readSandboxBrokerAuthKey} from '../../../packages/sandbox/src/service-auth.js';
import {createSandboxBrokerHttpService} from './service.js';

const absolute=z.string().refine(isAbsolute),sha=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const configuration=z.object({
 schemaVersion:z.literal(1),
 brokerId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
 keyId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
 publicKeyFile:absolute,
 imageDigest:image,
 seccompPath:absolute,
 seccompHostPath:absolute.optional(),
 workspaceRoot:absolute,
 workspaceHostRoot:absolute.optional(),
 workspaceVolume:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
 dockerBinary:absolute,
 fileStoreRoot:absolute,
 host:z.enum(['127.0.0.1','0.0.0.0']).default('0.0.0.0'),
 port:z.number().int().min(1).max(65535).default(8092),
 maxActivePerOwner:z.number().int().min(1).max(64).default(2),
 maxJobsPerDay:z.number().int().min(1).max(10_000).default(100),
 maxConcurrent:z.number().int().min(1).max(32).default(4),
 workspaceSweepMs:z.number().int().min(60_000).max(3_600_000).default(300_000)
}).strict();
class BrokerStartError extends Error{constructor(readonly code:string){super(code);this.name='BrokerStartError';}}
const fail=(code:string):never=>{throw new BrokerStartError(code);};
// Config and the Ed25519 public key are not secret material. Reject symlinks and
// group/world writes so a Compose secret mounted 0444 is accepted but a shared
// writable file is not.
async function privateFile(path:string,maxBytes:number):Promise<string>{
 if(!isAbsolute(path))return fail('SANDBOX_BROKER_CONFIG_UNSAFE');
 if(await realpath(path).catch(()=>null)!==path)return fail('SANDBOX_BROKER_CONFIG_UNSAFE');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>fail('SANDBOX_BROKER_CONFIG_UNSAFE'));
 try{
  const info=await handle.stat();
  if(!info.isFile()||(info.mode&0o022)!==0||info.size>maxBytes)return fail('SANDBOX_BROKER_CONFIG_UNSAFE');
  return await handle.readFile('utf8');
 }finally{await handle.close();}
}
async function secretFile(path:string,maxBytes=4096):Promise<string>{
 if(!isAbsolute(path))return fail('SANDBOX_BROKER_SECRET_UNSAFE');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>fail('SANDBOX_BROKER_SECRET_UNSAFE'));
 try{
  const info=await handle.stat();
  if(!info.isFile()||(info.mode&0o022)!==0||info.size>maxBytes)return fail('SANDBOX_BROKER_SECRET_UNSAFE');
  return (await handle.readFile('utf8')).trim();
 }finally{await handle.close();}
}
function envFile(...names:string[]):string{
 for(const name of names){const value=process.env[name];if(value)return value;}
 return fail('SANDBOX_BROKER_SECRET_REQUIRED');
}
function command(file:string,args:string[]):Promise<string>{
 return new Promise((resolvePromise,reject)=>{execFile(file,args,{timeout:15_000,maxBuffer:64*1024,encoding:'utf8'},(error,stdout)=>{if(error)reject(error);else resolvePromise(stdout);});});
}
async function volumeHostRoot(docker:string,volume:string):Promise<string>{
 const output=(await command(docker,['volume','inspect',volume,'--format','{{.Mountpoint}}']).catch(()=>fail('SANDBOX_BROKER_VOLUME_INVALID'))).trim();
 if(!isAbsolute(output)||output.includes('\0')||output.length>4096||output.includes('\n')||output.includes('\r'))return fail('SANDBOX_BROKER_VOLUME_INVALID');
 return output;
}
async function start(){
 const path=process.argv[2];
 if(!path||process.argv.length!==3||!isAbsolute(path))return fail('SANDBOX_BROKER_CONFIG_REQUIRED');
 const config=configuration.parse(JSON.parse(await privateFile(path,64*1024)));
 const appEnv=process.env['APP_ENV']??'development';
 if(appEnv==='production'&&(process.platform!=='linux'||process.getuid?.()===0))return fail('SANDBOX_BROKER_PRODUCTION_HARDENING_REQUIRED');
 const authKey=await readSandboxBrokerAuthKey(envFile('SANDBOX_BROKER_AUTH_KEY_FILE'));
 const databaseUrl=await secretFile(envFile('DATABASE_URL_FILE','RUNTIME_DATABASE_URL_FILE'));
 const master=await secretFile(envFile('APP_MASTER_KEY_FILE'));
 if(!sha.safeParse(master).success)return fail('SANDBOX_BROKER_MASTER_KEY_INVALID');
 const publicKey=await privateFile(config.publicKeyFile,16*1024).then(pem=>createPublicKey(pem)).catch(()=>fail('SANDBOX_BROKER_PUBLIC_KEY_INVALID'));
 if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519')return fail('SANDBOX_BROKER_PUBLIC_KEY_INVALID');
 const hostRoot=config.workspaceHostRoot??(config.workspaceVolume?await volumeHostRoot(config.dockerBinary,config.workspaceVolume):config.workspaceRoot);
 const db=new Database(databaseUrl,8,15_000),vault=new Vault(new Map([['1',Buffer.from(master,'hex')]]),'1'),files=new EncryptedFileStore(config.fileStoreRoot,vault);
 const store=new PgSandboxBrokerStore(db,{maxActivePerOwner:config.maxActivePerOwner,maxJobsPerDay:config.maxJobsPerDay}),connector=new PgSandboxArtifactConnector(db,files);
 const executor=new DockerAnalysisSandbox({image:config.imageDigest,seccompPath:config.seccompPath,...(config.seccompHostPath?{hostSeccompPath:config.seccompHostPath}:{}),workspaceRoot:config.workspaceRoot,hostWorkspaceRoot:hostRoot,docker:config.dockerBinary,owner:config.brokerId});
 const broker=new SandboxBroker({keyId:config.keyId,publicKey,imageDigest:config.imageDigest,brokerId:config.brokerId,store,authorizer:new PgSandboxAuthorizer(db),resolver:connector,sink:connector,executor,cancelPollMs:250});
 let recovered=0,containers=0,workspaces=0;
 try{
  recovered=await store.recoverInterrupted(config.brokerId);
  containers=(await executor.reconcileOrphans()).removed;
  workspaces=(await executor.sweepWorkspaces({minAgeMs:0})).removed;
 }catch{await db.close();fail('SANDBOX_BROKER_STARTUP_RECOVERY_FAILED');}
 const service=createSandboxBrokerHttpService({
  submit:(wire,subject,signal)=>broker.submit(wire,subject,signal),
  get:(subject,jobId)=>store.get(subject,jobId),
  requestCancel:(subject,jobId)=>store.requestCancel(subject,jobId),
  putArtifact:(subject,raw)=>connector.put(subject,raw),
  authKey,host:config.host,port:config.port,maxConcurrent:config.maxConcurrent,ready:()=>db.ready(),
  log:event=>console.error(JSON.stringify(event)),
 });
 const address=await service.listen();
 const sweep=setInterval(()=>{void executor.sweepWorkspaces({minAgeMs:60_000}).then(result=>{if(result.failed)console.error(JSON.stringify({kind:'SANDBOX_BROKER_WORKSPACE_SWEEP_FAILED',failed:result.failed}));},()=>console.error(JSON.stringify({kind:'SANDBOX_BROKER_WORKSPACE_SWEEP_FAILED'})));},config.workspaceSweepMs);
 sweep.unref();
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;clearInterval(sweep);try{await service.close();await db.close();}catch{process.exitCode=1;}process.exit(process.exitCode??0);};
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
 console.log(JSON.stringify({kind:'SANDBOX_BROKER_READY',port:address.port,recovered,containers,workspaces}));
 process.send?.({type:'ready',port:address.port});
}
start().catch(error=>{process.stderr.write(JSON.stringify({error:error instanceof BrokerStartError?error.code:error instanceof z.ZodError?'SANDBOX_BROKER_CONFIG_INVALID':'SANDBOX_BROKER_START_FAILED'})+'\n');process.exitCode=1;});
