import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {linuxNodeRuntimePins} from '../../scripts/prepare-linux-node-runtime.mjs';

const image='postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826';
const label='org.open-aider.test-independent-restore';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function reject(code:string):never{throw Error(code);}
type Runtime={schemaVersion:1;version:string;platform:'linux';architecture:'arm64'|'x64';binaryPath:string;binarySha256:string;sourceIntegrity:string};
type Inspection={Id:string;Name:string;Config:{Image:string;Labels:Record<string,string>};State:{Running:boolean};HostConfig:{NetworkMode:string;Binds:unknown[]|null;PortBindings:Record<string,unknown>|null;Tmpfs:Record<string,string>};Mounts:{Type:string;Destination:string}[];NetworkSettings:{Ports:Record<string,unknown>|null}};

/** No host mounts, published ports or bridge. All execution happens in this
 * fixture's nonce container; the unchanged network guard still permits only
 * loopback:53331 inside its independent namespace. No caller supplies an ID. */
export async function independentPostgresCluster(directory:string){
 if(process.env['APP_ENV']!=='test'||process.env['OA_TEST_ISOLATED']!=='true'||Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard'))!==true)reject('INDEPENDENT_TEST_ISOLATION_REQUIRED');
 if(process.env['DOCKER_TLS_VERIFY']||process.env['DOCKER_CERT_PATH'])reject('INDEPENDENT_DOCKER_ENDPOINT_REJECTED');
 const nonce=randomUUID(),name='oa-test-independent-'+nonce,idPattern=/^[a-f0-9]{64}$/;
 const password=randomBytes(32).toString('hex'),database='open_aider_test_restore_'+randomUUID().replaceAll('-','');
 const env={PATH:process.env['PATH']??'/usr/bin:/bin',...(process.env['HOME']?{HOME:process.env['HOME']}:{})};
 const invoke=(args:string[],input?:Buffer,timeout=30000,extra:Record<string,string>={})=>{
  try{return execFileSync('docker',args,{env:{...env,...extra},input,timeout,maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe']});}catch(error){
   const observed=error as {status?:number;stderr?:Buffer;stdout?:Buffer};
   try{writeFileSync(resolve('.data/test-environment/independent-docker-failure-'+nonce+'.json'),JSON.stringify({status:observed.status??null,command:args[0],stdout:observed.stdout?.subarray(0,65536).toString('utf8')??'',stderr:observed.stderr?.subarray(0,65536).toString('utf8')??''}),{mode:0o600,flag:'wx'});}catch{/* Preserve the original finite-operation error. */}
   return reject('INDEPENDENT_DOCKER_COMMAND_FAILED');
  }
 };
 const endpoint=(value:unknown):string=>{if(typeof value!=='string'||!/^unix:\/\/\/[^\s\u0000-\u001f?#%]+$/.test(value)||value.includes('/../')||value.includes('/./'))return reject('INDEPENDENT_DOCKER_ENDPOINT_REJECTED');return value;};
 const context=process.env['DOCKER_CONTEXT']??invoke(['context','show']).toString('utf8').trim();
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context))reject('INDEPENDENT_DOCKER_ENDPOINT_REJECTED');
 const host=endpoint(JSON.parse(invoke(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}']).toString('utf8')) as unknown);
 if(process.env['DOCKER_HOST']&&endpoint(process.env['DOCKER_HOST'])!==host)reject('INDEPENDENT_DOCKER_ENDPOINT_REJECTED');
 const docker=(args:string[],input?:Buffer,timeout?:number,extra?:Record<string,string>)=>invoke(['--host',host,...args],input,timeout,extra);
 const architecture=docker(['image','inspect',image,'--format','{{.Architecture}}']).toString('utf8').trim();
 if(!['arm64','amd64'].includes(architecture))reject('INDEPENDENT_IMAGE_ARCH_REJECTED');
 const runtime=JSON.parse(await readFile('.data/test-environment/linux-node-runtime.json','utf8')) as Runtime;
 if(runtime.schemaVersion!==1||runtime.version!=='24.21.0'||runtime.platform!=='linux'||runtime.architecture!==(architecture==='amd64'?'x64':'arm64')||!/^sha256:[a-f0-9]{64}$/.test(runtime.sourceIntegrity)||!/^[a-f0-9]{64}$/.test(runtime.binarySha256)||await realpath(runtime.binaryPath)!==runtime.binaryPath||hash(await readFile(runtime.binaryPath))!==runtime.binarySha256)reject('INDEPENDENT_NODE_RUNTIME_REJECTED');
 if(runtime.binarySha256!==linuxNodeRuntimePins[runtime.architecture].binarySha256||runtime.sourceIntegrity!==linuxNodeRuntimePins[runtime.architecture].sourceIntegrity)reject('INDEPENDENT_NODE_PIN_REJECTED');
 let id:string|undefined,created=false,closed=false,creationAttempted=false;
 const inspect=(running:boolean)=>{
  const raw=JSON.parse(docker(['inspect',id??name,'--format','{{json .}}']).toString('utf8')) as Inspection;
  const allowed=new Set(['/oa','/oa/runtime','/tmp','/var/run/postgresql','/var/lib/postgresql/data']);
  if(!idPattern.test(raw.Id)||id&&raw.Id!==id||raw.Name!=='/'+name||raw.Config.Image!==image||raw.Config.Labels?.[label]!==nonce||raw.HostConfig.NetworkMode!=='none'||(raw.HostConfig.Binds?.length??0)!==0||Object.keys(raw.HostConfig.PortBindings??{}).length!==0||Object.values(raw.NetworkSettings.Ports??{}).some(v=>v!==null)||raw.Mounts.some(m=>m.Type!=='tmpfs'||!allowed.has(m.Destination))||Object.keys(raw.HostConfig.Tmpfs??{}).sort().join('|')!==[...allowed].sort().join('|')||running&&!raw.State.Running)reject('INDEPENDENT_CONTAINER_IDENTITY_REJECTED');
  return raw;
 };
 const close=async()=>{
  if(!closed&&!created&&creationAttempted){const candidates=docker(['ps','--all','--filter','name=^/'+name+'$','--filter','label='+label+'='+nonce,'--format','{{.ID}}']).toString('utf8').trim();if(!candidates)reject('INDEPENDENT_CREATION_OUTCOME_UNCERTAIN');const observed=inspect(false);id=observed.Id;created=true;}
  if(!closed&&created){const observed=inspect(false);docker(['rm','--force',observed.Id]);if(docker(['ps','--all','--filter','label='+label+'='+nonce,'--format','{{.ID}}']).toString('utf8').trim())reject('INDEPENDENT_CLEANUP_UNCONFIRMED');created=false;}
  closed=true;return {state:'DESTROYED' as const,confirmedAbsent:true as const};
 };
 const exec=(args:string[],input?:Buffer,timeout?:number)=>{if(closed||!created)reject('INDEPENDENT_CONTAINER_CLOSED');inspect(true);return docker(['exec',...(input?['-i']:[]),'--user','postgres',id!,...args],input,timeout);};
 const sql=(query:string)=>exec(['psql','--host=/var/run/postgresql','--port=53331','--username=oa_migrator','--dbname='+database,'--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--tuples-only','--no-align'],Buffer.from(query)).toString('utf8').trim();
 try{
  // create does not start a process. A creation error is reconciled only by the
  // issued name plus exact nonce/image/network/mount checks, never a broad rm.
  try{creationAttempted=true;const candidate=docker(['create','--pull=never','--name',name,'--label',label+'='+nonce,'--network','none','--read-only','--security-opt','no-new-privileges','--tmpfs','/oa:rw,nosuid,nodev,noexec,mode=0755','--tmpfs','/oa/runtime:rw,nosuid,nodev,exec,mode=0755','--tmpfs','/tmp:rw,nosuid,noexec,mode=1777','--tmpfs','/var/run/postgresql:rw,nosuid,noexec,mode=0775','--tmpfs','/var/lib/postgresql/data:rw,nosuid,noexec,mode=0700','--env','POSTGRES_USER=oa_migrator','--env','POSTGRES_DB=postgres','--env','POSTGRES_PASSWORD',image,'postgres','-c','listen_addresses=127.0.0.1','-p','53331'],undefined,30000,{POSTGRES_PASSWORD:password}).toString('utf8').trim();if(!idPattern.test(candidate))reject('INDEPENDENT_CONTAINER_ID_REJECTED');id=candidate;created=true;}
  catch(error){const candidates=docker(['ps','--all','--filter','name=^/'+name+'$','--filter','label='+label+'='+nonce,'--format','{{.ID}}']).toString('utf8').trim();if(candidates){const observed=inspect(false);id=observed.Id;created=true;}throw error;}
  inspect(false);docker(['start',id!]);
  // docker exec is the only transport. There is no forwarder or host listener.
  exec(['sh','-c','for i in $(seq 1 100); do pg_isready --host=127.0.0.1 --port=53331 --username=oa_migrator --dbname=postgres >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1'],undefined,15000);
  inspect(true);docker(['exec','--user','root',id!,'sh','-c','mkdir /oa/private /oa/postgres /oa/filestore /oa/restored && chown -R postgres:postgres /oa && chmod 700 /oa /oa/private /oa/postgres /oa/filestore /oa/restored /oa/runtime']);
  // Write only this owned tmpfs via exec; no Docker archive extraction into
  // the read-only root filesystem and no host bind mount are needed.
  exec(['sh','-c','umask 077; cat > /oa/runtime/node && chmod 700 /oa/runtime/node'],await readFile(runtime.binaryPath));
  if(exec(['sha256sum','/oa/runtime/node']).toString('utf8').split(/\s+/)[0]!==runtime.binarySha256)reject('INDEPENDENT_NODE_TRANSFER_REJECTED');
  const mounts=exec(['cat','/proc/self/mountinfo']).toString('utf8').trim().split('\n').map(line=>line.split(' ')),dataMount=mounts.find(m=>m[4]==='/oa'),runtimeMount=mounts.find(m=>m[4]==='/oa/runtime');
  if(!dataMount?.[5]?.split(',').includes('noexec')||!runtimeMount?.[5]||runtimeMount[5].split(',').includes('noexec'))reject('INDEPENDENT_RUNTIME_MOUNT_REJECTED');
  const observedNode=exec(['/oa/runtime/node','--version']).toString('utf8').trim();if(observedNode!=='v24.21.0')reject('INDEPENDENT_NODE_VERSION_REJECTED');
  const nativeHash=exec(['sha256sum','/usr/lib/postgresql/17/bin/pg_restore']).toString('utf8').split(/\s+/)[0]!,nativeVersion=exec(['/usr/lib/postgresql/17/bin/pg_restore','--version']).toString('utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(nativeHash)||!/^pg_restore \(PostgreSQL\) 17\.[0-9]+/.test(nativeVersion))reject('INDEPENDENT_PG_PIN_REJECTED');
  const psql=(query:string)=>exec(['psql','--host=/var/run/postgresql','--port=53331','--username=oa_migrator','--dbname=postgres','--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--tuples-only','--no-align'],Buffer.from(query)).toString('utf8').trim();
  psql(['oa_app','oa_runtime','oa_queue'].map(role=>'CREATE ROLE '+role+' LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;').join('\n')+'\nCREATE DATABASE '+database+' TEMPLATE template0;');
  const identity=JSON.parse(sql("SELECT json_build_object('database',current_database(),'system',(SELECT system_identifier::text FROM pg_control_system()),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()));")) as {database:string;system:string;oid:string};
  if(identity.database!==database||!/^\d+$/.test(identity.system)||!/^\d+$/.test(identity.oid))reject('INDEPENDENT_PG_IDENTITY_REJECTED');
  const stage=async(name:string,bytes:Buffer)=>{if(!/^(?:private|postgres|filestore|runtime)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)||bytes.length>64*1024*1024)reject('INDEPENDENT_STAGE_PATH_REJECTED');const code="void(async()=>{const fs=require('node:fs');const c=require('node:crypto');const parts=[];for await(const b of process.stdin)parts.push(b);const bytes=Buffer.concat(parts);if(c.createHash('sha256').update(bytes).digest('hex')!==process.argv[2])throw Error('STAGE_HASH');fs.writeFileSync('/oa/'+process.argv[1],bytes,{mode:0o600,flag:'wx'});bytes.fill(0);})().catch(()=>{process.exitCode=1});";exec(['/oa/runtime/node','--input-type=commonjs','-e',code,name,hash(bytes)],bytes);};
  const read=(name:string)=>{if(!/^(?:private|restored)\/[A-Za-z0-9/._-]{1,255}$/.test(name)||name.split('/').some(s=>s==='..'||s==='.'||s===''))reject('INDEPENDENT_READ_PATH_REJECTED');return exec(['/oa/runtime/node','-e',"process.stdout.write(require('node:fs').readFileSync('/oa/'+process.argv[1]))",name]);};
  const runNode=(name:'restore.mjs'|'verification.mjs'|'probe.mjs',args:string[]=[])=>{
   if(closed||!created)reject('INDEPENDENT_CONTAINER_CLOSED');inspect(true);
   const command=['--host',host,'exec','--user','postgres',id!,'/oa/runtime/node','--import','/oa/runtime/guard.mjs','/oa/runtime/'+name,...args];
   const result=spawnSync('docker',command,{env,timeout:65000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
   if(result.error||result.status===null)return reject('INDEPENDENT_COMMAND_OUTCOME_UNCERTAIN');return {code:result.status,stdout:result.stdout?.toString('utf8')??'',stderr:result.stderr?.toString('utf8')??''};
  };
  const bundled=async(entry:string,out:string)=>{
   const require=createRequire(await realpath(resolve('node_modules/tsx/package.json'))),esbuild=require('esbuild') as {build:(options:Record<string,unknown>)=>Promise<unknown>};
   await esbuild.build({entryPoints:[entry],outfile:resolve(directory,out),bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'silent',external:['pg-native'],banner:{js:"import {createRequire as __oaCreateRequire} from 'node:module';const require=__oaCreateRequire(import.meta.url);"}});
   await stage('runtime/'+out,await readFile(resolve(directory,out)));
  };
  await stage('runtime/guard.mjs',await readFile('scripts/test-network-guard.mjs'));
  await bundled('scripts/project-restore.ts','restore.mjs');await bundled('scripts/restore-verification.ts','verification.mjs');await bundled('tests/support/independent-restore-probe.ts','probe.mjs');
  return {database,system:identity.system,databaseOid:identity.oid,connectionString:`postgresql://oa_migrator:${password}@127.0.0.1:53331/${database}`,pgRestore:{path:'/usr/lib/postgresql/17/bin/pg_restore',sha256:nativeHash,version:nativeVersion},stage,read,runNode,sql,close,evidence:{image,nodeBinarySha256:runtime.binarySha256,nodeSourceIntegrity:runtime.sourceIntegrity,network:'none',hostMounts:0,publishedPorts:0,productionBundles:true}};
 }catch(error){await close();throw error;}
}
