import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {socketIsolation,brokerCredentialLeaks as leakNames,endpointFailures as failingEndpoints,heartbeatHealthy,migrationAgreement,overallStatus,credentialPattern,type Check,type Result} from './readiness-checks.js';
const exec=promisify(execFile);
const composeFile=process.env['ANTHYS_READINESS_COMPOSE_FILE']??'deploy/compose/compose.dev.yml';
const envFile=process.env['ANTHYS_READINESS_ENV_FILE']??'.env';
const prodFile=process.env['ANTHYS_READINESS_PROD_COMPOSE_FILE']??'deploy/compose/compose.prod.yml';
const profiles=(process.env['ANTHYS_READINESS_PROFILES']??'sandbox').split(',').map(s=>s.trim()).filter(Boolean);
const services=['api','postgres','worker','sandbox-broker'] as const;
const maxHeartbeatAgeMs=30_000;
const checks:Check[]=[];
const check=(id:string,result:Result,detail:string,evidence:Record<string,unknown>={}):Check=>{const c={id,result,detail,evidence};checks.push(c);return c;};
async function run(command:string,args:string[],env?:NodeJS.ProcessEnv):Promise<string>{
 const {stdout}=await exec(command,args,{maxBuffer:64*1024*1024,...(env?{env:{...process.env,...env}}:{})});
 return stdout;
}
const compose=(args:string[])=>run('docker',['compose','--env-file',envFile,'-f',composeFile,...profiles.flatMap(p=>['--profile',p]),...args]);
const sha256=async(path:string):Promise<string>=>createHash('sha256').update(await readFile(path)).digest('hex');
const containers:Record<string,{id:string;state:string;health:string;user:string;image:string;mounts:{target:string;source:string;type:string}[];envNames:string[]}|null>={};
for(const service of services){
 const ids=(await compose(['ps','-q',service])).trim();
 if(!ids){containers[service]=null;continue;}
 const inspected=JSON.parse(await run('docker',['inspect',ids.split(/\s+/)[0]!])) as {State:{Status:string;Health?:{Status:string}};Config:{User:string;Image:string;Env:string[]};Mounts:{Destination:string;Source:string;Type:string}[]}[];
 const c=inspected[0]!;
 containers[service]={id:ids.split(/\s+/)[0]!,state:c.State.Status,health:c.State.Health?.Status??'none',user:c.Config.User,image:c.Config.Image,mounts:c.Mounts.map(m=>({target:m.Destination,source:m.Source,type:m.Type})),envNames:c.Config.Env.map(e=>e.split('=')[0]??'').sort()};
}
const missing=services.filter(s=>!containers[s]);
check('servicesPresent',missing.length?'FAIL':'PASS',missing.length?`Not running: ${missing.join(', ')}.`:'api, postgres, worker and sandbox-broker are all running.',{running:services.filter(s=>containers[s]),absent:missing});
const unhealthy=services.filter(s=>containers[s]&&containers[s]!.health!=='healthy');
check('serviceHealth',unhealthy.length?'FAIL':'PASS',unhealthy.length?`Not healthy: ${unhealthy.join(', ')}.`:'Every inspected container reports health=healthy.',{health:Object.fromEntries(services.filter(s=>containers[s]).map(s=>[s,containers[s]!.health]))});
async function psql(query:string):Promise<string>{return (await compose(['exec','-T','postgres','psql','-U','oa_migrator','-d','anthys','-tAc',query])).trim();}
async function contractInContainer(service:string):Promise<{count:number;last:string;hash:string}|null>{
 try{return JSON.parse((await compose(['exec','-T',service,'node','-e',"const c=require('/app/dist/packages/storage/src/required-migrations.json');console.log(JSON.stringify({count:c.migrations.length,last:c.lastMigration,hash:c.contractHash}))"])).trim()) as {count:number;last:string;hash:string};}catch{return null;}
}
const apiContract=containers.api?await contractInContainer('api'):null;
const brokerContract=containers['sandbox-broker']?await contractInContainer('sandbox-broker'):null;
let databaseMigrations:number|null=null,lastMigration:string|null=null;
try{lastMigration=(await psql('SELECT name FROM public.schema_migrations ORDER BY name DESC LIMIT 1')).trim()||null;databaseMigrations=Number((await psql('SELECT count(*) FROM public.schema_migrations')).trim());}catch{/* reported below */}
check('imageSchemaContract',apiContract&&brokerContract?'PASS':'FAIL',apiContract&&brokerContract?`The api image and the broker image both embed the ${apiContract.count}-migration contract.`:'The running images do not expose a readable required-migrations contract.',{api:apiContract,broker:brokerContract});
const contractMatch=migrationAgreement(apiContract,brokerContract,databaseMigrations,lastMigration);
check('migrationContractMatch',contractMatch?'PASS':'FAIL',contractMatch?`The image contract (${apiContract!.count}), the broker image contract (${brokerContract!.count}) and the database (${databaseMigrations}) agree on the exact migration set.`:`The image contract (${apiContract?.count??'unknown'}), the broker image contract (${brokerContract?.count??'unknown'}) and the database (${databaseMigrations??'unknown'}) disagree.`,{image:apiContract?.count??null,brokerImage:brokerContract?.count??null,database:databaseMigrations,lastMigration});
let queueVersion:string|null=null,publicTables:number|null=null;
try{queueVersion=(await psql('SELECT version FROM oa_queue.version')).trim();}catch{/* reported below */}
try{publicTables=Number((await psql("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).trim());}catch{/* reported below */}
check('queueSchema',queueVersion?'PASS':'FAIL',queueVersion?`oa_queue.version = ${queueVersion}.`:'The queue schema version could not be read.',{version:queueVersion});
check('publicTables',publicTables!==null?'PASS':'FAIL',publicTables!==null?`The public schema holds ${publicTables} tables.`:'The public table count could not be read.',{tables:publicTables});
async function httpProbe(url:string):Promise<{status:number;body:unknown}>{
 const response=await fetch(url);
 const text=await response.text();
 try{return {status:response.status,body:JSON.parse(text)};}catch{return {status:response.status,body:text};}
}
let apiOrigin:string|null=null;
try{const published=(await compose(['port','api','64700'])).trim().split(/\s+/).pop();if(published)apiOrigin='http://'+published;}catch{/* reported below */}
const endpoints:Record<string,{status:number;body:unknown}|{error:string}>={};
if(apiOrigin){
 for(const [name,path] of [['live','/api/v1/health/live'],['ready','/api/v1/health/ready']] as const){
  try{endpoints['api_'+name]=await httpProbe(apiOrigin+path);}catch(error){endpoints['api_'+name]={error:String((error as Error).message)};}
 }
}
try{
 const raw=(await compose(['exec','-T','sandbox-broker','node','-e',"fetch('http://127.0.0.1:8092/health/ready').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>console.log(JSON.stringify({error:'BROKER_UNREACHABLE'})))"])).trim();
 endpoints['broker_ready']=JSON.parse(raw) as {status:number;body:unknown};
}catch{endpoints['broker_ready']={error:'BROKER_PROBE_FAILED'};}
const endpointFailures=failingEndpoints(endpoints);
check('healthEndpoints',endpointFailures.length?'FAIL':'PASS',endpointFailures.length?`Unhealthy endpoints: ${endpointFailures.join(', ')}.`:'The api live/ready endpoints and the broker readiness endpoint all returned 200.',endpoints);
const socket=socketIsolation(containers);
check('dockerSocketIsolation',socket.isolated?'PASS':'FAIL',socket.isolated?'Only sandbox-broker mounts /var/run/docker.sock; the api, worker and postgres containers mount no socket.':`Docker socket mounts found on: ${socket.owners.join(', ')||'none'}.`,socket.mounts);
const broker=containers['sandbox-broker'];
const brokerSecretMounts=broker?broker.mounts.filter(m=>m.target.startsWith('/run/secrets/')).map(m=>m.target.replace('/run/secrets/','')).sort():[];
const brokerEnvNames=broker?broker.envNames:[];
const brokerCredentialLeaks=leakNames(brokerSecretMounts,brokerEnvNames);
check('brokerCredentialBoundary',broker?brokerCredentialLeaks.length===0?'PASS':'FAIL':'ABSENT',broker?brokerCredentialLeaks.length===0?'The broker holds only its runtime database URL, master key and broker auth/config/public key; no DingTalk, GLM, DWS or company-MCP credential name is present.':`The broker exposes credential-bearing names: ${brokerCredentialLeaks.join(', ')}.`:'The sandbox broker is not running, so its credential boundary was not probed.',{secretsMounted:brokerSecretMounts,envNames:brokerEnvNames});
if(containers.worker){
 let heartbeat:Record<string,unknown>={};
 try{
  await compose(['exec','-T','worker','node','-e',"require('fs').writeFileSync('/tmp/stale-heartbeat',String(Date.now()-120000))"]);
  const verdict=JSON.parse((await compose(['exec','-T','worker','node','-e',"const {isWorkerHeartbeatFresh}=require('/app/dist/packages/runtime/src/worker-heartbeat.js');const now=Date.now();console.log(JSON.stringify({live:isWorkerHeartbeatFresh('/data/worker-heartbeat',30000,now),stale:isWorkerHeartbeatFresh('/tmp/stale-heartbeat',30000,now),missing:isWorkerHeartbeatFresh('/tmp/absent-heartbeat',30000,now)}))"])).trim()) as {live:boolean;stale:boolean;missing:boolean};
  await compose(['exec','-T','worker','node','-e',"require('fs').rmSync('/tmp/stale-heartbeat',{force:true})"]);
  heartbeat=verdict;
 }catch(error){heartbeat={error:String((error as Error).message)};}
 const ok=heartbeatHealthy(heartbeat);
 check('workerHeartbeat',ok?'PASS':'FAIL',ok?'The worker heartbeat module inside the image reports the live heartbeat as fresh and both a two-minute-old and a missing heartbeat as stale.':'The heartbeat predicate inside the running image did not separate the live heartbeat from the stale and missing controls.',{...heartbeat,maxAgeMs:maxHeartbeatAgeMs,probe:"require('/app/dist/packages/runtime/src/worker-heartbeat.js')"});
}else check('workerHeartbeat','ABSENT','The worker is not running, so the heartbeat was not probed.',{});
const prodRender:{profiles:Record<string,'PASS'|'FAIL'>;failClosed:'PASS'|'FAIL'}={profiles:{},failClosed:'PASS'};
const placeholderEnv={ANTHYS_APP_IMAGE:'registry.example/anthys@sha256:'+'0'.repeat(64),ANTHYS_SECRETS_DIR:'/tmp/anthys-prod-secrets',ANTHYS_APP_ORIGIN:'https://anthys.example.com'};
for(const profile of ['','dingtalk','scoped','dws','sandbox']){
 const args=['compose','-f',prodFile,...(profile?['--profile',profile]:[]),'config','--quiet'];
 try{await run('docker',args,placeholderEnv);prodRender.profiles[profile||'default']='PASS';}catch{prodRender.profiles[profile||'default']='FAIL';}
}
try{await run('docker',['compose','-f',prodFile,'config','--quiet'],{ANTHYS_APP_IMAGE:'',ANTHYS_SECRETS_DIR:'',ANTHYS_APP_ORIGIN:''});prodRender.failClosed='FAIL';}catch{prodRender.failClosed='PASS';}
const prodOk=Object.values(prodRender.profiles).every(v=>v==='PASS')&&prodRender.failClosed==='PASS';
check('prodComposeRender',prodOk?'PASS':'FAIL',prodOk?`The production stack renders for every profile and still fails closed when the required variables are missing.`:'The production stack failed to render for at least one profile or no longer fails closed.',prodRender as unknown as Record<string,unknown>);
const providerEnvNames=containers.api?containers.api.envNames.filter(name=>credentialPattern.test(name)):[];
const report={
 schemaVersion:1,
 case:'LOCAL_DOCKER_DEPLOYMENT_READINESS_PROBE',
 generatedAt:new Date().toISOString(),
 status:overallStatus(checks),
 live:false,
 liveProviderCalls:0,
 compose:{file:composeFile,envFile,profiles,prodFile,fileSha256:await sha256(composeFile),prodFileSha256:await sha256(prodFile)},
 source:{workerHeartbeatSha256:await sha256('packages/runtime/src/worker-heartbeat.ts'),workerMainSha256:await sha256('apps/worker/src/main.ts')},
 services:Object.fromEntries(Object.entries(containers).map(([service,c])=>[service,c?{state:c.state,health:c.health,user:c.user,image:c.image,mountTargets:c.mounts.map(m=>m.target).sort(),envNames:c.envNames}:null])),
 api:{origin:apiOrigin,providerEnvNamesPresent:providerEnvNames,note:'Names only; no secret value is recorded. Presence of configuration is not live acceptance.'},
 checks,
 limitations:{
  liveAcceptance:'Live GLM, DingTalk, DWS and upstream company-MCP acceptance remains BLOCKED_EXTERNAL. This probe proves local deployment integrity only; affected T-cases stay NOT_RUN and R items stay IN_PROGRESS.',
  workerHeartbeat:'The worker heartbeat proves that the publish cycle keeps completing. It does not execute a queued model run and is not a substitute for live provider acceptance.',
  secretHandling:'No secret value is reproduced. Only mount names, environment-variable names, counts and statuses are recorded.',
 },
};
const date=new Date().toISOString().slice(0,10).replace(/-/g,'');
const out=process.argv[2]??`reports/deployment-readiness-probe-${date}.json`;
await mkdir('reports',{recursive:true});
await writeFile(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,report:out,checks:checks.map(c=>({id:c.id,result:c.result}))},null,2));
if(report.status!=='PASS')process.exitCode=1;
