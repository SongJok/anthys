import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,readdir,rm,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {networkInterfaces as configuredNetworkInterfaces} from 'node:os';

// Container-only metadata probe. Never executes contact +me itself or auth commands.
const startedAt=new Date().toISOString(),binary='/usr/local/bin/dws',root='/run/dws';
const lock=JSON.parse(await readFile('/app/config/dws/lock.json','utf8'));
const digest=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';}
if(process.platform!=='linux'||process.getuid()!==10001||process.getgid()!==10001)throw Error('DWS_OFFLINE_PROBE_REQUIRES_NONROOT_LINUX_IMAGE');
// Linux can create inactive tunnel devices even with Docker network=none. Inspect
// their state and the current namespace's addresses/routes instead of name count.
const networkInterfaces=configuredNetworkInterfaces(),networkDevices=[];
for(const name of await readdir('/sys/class/net')){const path=join('/sys/class/net',name);if(!(await stat(path)).isDirectory())continue;const flags=Number.parseInt((await readFile(join(path,'flags'),'utf8')).trim(),16),operstate=(await readFile(join(path,'operstate'),'utf8')).trim();if(!Number.isSafeInteger(flags))throw Error('DWS_OFFLINE_PROBE_NETWORK_STATE_INVALID');networkDevices.push({name,flags,operstate});}
const ipv4Routes=(await readFile('/proc/net/route','utf8')).trim().split('\n').slice(1).filter(Boolean).map(line=>line.trim().split(/\s+/)[0]);
const ipv6Routes=(await readFile('/proc/net/ipv6_route','utf8')).trim().split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/).at(-1));
if(Object.entries(networkInterfaces).some(([name,addresses])=>name!=='lo'||addresses.some(address=>!address.internal))||networkDevices.some(device=>device.name!=='lo'&&(device.flags&1)!==0)||[...ipv4Routes,...ipv6Routes].some(name=>name!=='lo'))throw Error('DWS_OFFLINE_PROBE_NETWORK_NOT_ISOLATED');
const rootStat=await lstat(root);if((await statfs(root)).type!==0x01021994||!rootStat.isDirectory()||rootStat.isSymbolicLink()||rootStat.uid!==10001||(rootStat.mode&0o777)!==0o700)throw Error('DWS_OFFLINE_PROBE_REQUIRES_PRIVATE_TMPFS');
if((await readdir(root)).length!==0)throw Error('DWS_OFFLINE_PROBE_WORKSPACE_NOT_EMPTY');
const platform='linux-'+({arm64:'arm64',x64:'amd64'}[process.arch]??'unsupported'),binaryHash=digest(await readFile(binary)),binaryStat=await lstat(binary);
if(binaryHash!==lock.platforms[platform]?.binarySha256||!binaryStat.isFile()||binaryStat.uid!==0||(binaryStat.mode&0o022)!==0)throw Error('DWS_OFFLINE_PROBE_BINARY_CHANGED');
await lstat('/app/dist/packages/dws/src/process-supervisor.mjs');
process.umask(0o077);const workspace=await mkdtemp(join(root,'offline-')),commands=[];
try{
 for(const directory of ['config','keychain','tmp','data','cache'])await mkdir(join(workspace,directory),{mode:0o700});
 const env={HOME:workspace,DWS_CONFIG_DIR:join(workspace,'config'),DWS_KEYCHAIN_DIR:join(workspace,'keychain'),DWS_DISABLE_KEYCHAIN:'1',XDG_CONFIG_HOME:join(workspace,'config'),XDG_DATA_HOME:join(workspace,'data'),XDG_CACHE_HOME:join(workspace,'cache'),TMPDIR:join(workspace,'tmp'),PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
 const run=args=>{const stdout=execFileSync(binary,args,{cwd:workspace,env,timeout:10000,maxBuffer:262144,encoding:'utf8',stdio:['ignore','pipe','pipe']});commands.push({executable:binary,args,exitCode:0,stdoutSha256:digest(stdout)});return stdout;};
 const version=run(['version']);if(!new RegExp(`^Version:\\s+${lock.version.replaceAll('.','\\.')}\\s*$`,'m').test(version))throw Error('DWS_OFFLINE_PROBE_VERSION_CHANGED');
 const schema=JSON.parse(run(['schema','--cli-path','contact +me','--compact','--format','json'])),schemaHash=digest(canonical(schema));
 if(schemaHash!==lock.commands['contact.me'].schemaHash||schema.cli_path!=='contact +me'||schema.effect!=='read')throw Error('DWS_OFFLINE_PROBE_SCHEMA_CHANGED');
 const documentSchema=JSON.parse(run(['schema','--cli-path','doc +fetch','--compact','--format','json'])),documentSchemaHash=digest(canonical(documentSchema));if(documentSchemaHash!==lock.commands['doc.fetch'].schemaHash||documentSchema.cli_path!=='doc +fetch'||documentSchema.effect!=='read'||documentSchema.result!==undefined)throw Error('DWS_OFFLINE_PROBE_DOCUMENT_SCHEMA_CHANGED');
 console.log(JSON.stringify({kind:'OFFLINE_CLI',status:'PASS',live:false,startedAt,endedAt:new Date().toISOString(),platform,uid:process.getuid(),gid:process.getgid(),networkInterfaces,networkDevices,routeInterfaces:{ipv4:ipv4Routes,ipv6:ipv6Routes},workspace:{filesystem:'tmpfs',mode:'0700',startedEmpty:true,personalProfileMounted:false},version:version.trim(),binaryHash,schemaHash,documentSchemaHash,documentResultSchemaPublished:false,commands,businessCalls:0,authorizationCalls:0,applicationStarted:false,deployed:false},null,2));
}finally{await rm(workspace,{recursive:true,force:true});}
