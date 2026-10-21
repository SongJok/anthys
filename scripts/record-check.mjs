import {spawn,execFileSync} from 'node:child_process';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [label,...argv]=process.argv.slice(2);if(!label||!argv.length||!/^[a-z0-9-]+$/.test(label))throw Error('USAGE: record-check <label> <executable> [args]');
const startedAt=new Date().toISOString();let output='';
let baseCommit=null,sourceTreeHash=null,workingTreeDirty=true;
async function fingerprint(){const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n').filter(p=>p&&!p.startsWith('reports/')&&p!=='config/stages.json').sort();const digest=createHash('sha256');for(const path of paths){digest.update(path+'\0');digest.update(await readFile(path));}return digest.digest('hex');}
try{
 baseCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 const changes=execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trimEnd().split('\n').filter(Boolean);
 workingTreeDirty=changes.some(line=>!line.slice(3).startsWith('reports/')&&line.slice(3)!=='config/stages.json');
 sourceTreeHash=await fingerprint();
}catch{}

const child=spawn(argv[0],argv.slice(1),{shell:false,env:process.env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{output+=b.toString();});child.stderr.on('data',b=>{output+=b.toString();});
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
const sourceTreeHashAfter=await fingerprint(),candidateStable=sourceTreeHash!==null&&sourceTreeHash===sourceTreeHashAfter;
for(const dir of ['.secrets','.data/test-environment'])for(const f of await readdir(dir,{withFileTypes:true}).catch(()=>[])) {if(!f.isFile())continue;const secret=await readFile(`${dir}/${f.name}`,'utf8');if(secret.trim().length>8)output=output.split(secret.trim()).join('[REDACTED_SECRET]');}
output=output.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
output=output.replace(/("(?:cancelToken|csrfToken|accessToken|refreshToken|sessionToken|deviceCode)"\s*:\s*")[^"]*(")/g,'$1[REDACTED_EPHEMERAL_TOKEN]$2').replace(/oa_session=[^\s;"']+/g,'oa_session=[REDACTED_EPHEMERAL_TOKEN]');
await mkdir('reports/checks',{recursive:true});await mkdir('reports/raw',{recursive:true});
const logPath=`reports/raw/${label}.log`;await writeFile(logPath,output);const codeCommit=workingTreeDirty||!candidateStable?null:baseCommit;
const isolated=argv.includes('scripts/run-tests.mjs'),standaloneOffline=isolated&&argv[argv.indexOf('scripts/run-tests.mjs')+1]==='offline';
const status=code===0&&candidateStable?'PASS':candidateStable?'FAIL':'CANDIDATE_UNSTABLE';
const record=JSON.stringify({label,command:argv,startedAt,endedAt:new Date().toISOString(),timezone:'Asia/Shanghai',exitCode:code,status,codeCommit,baseCommit,workingTreeDirty,sourceTreeHash,sourceTreeHashAfter,candidateStable,environment:standaloneOffline?'LOCAL_ISOLATED_STANDALONE_NODE_TEST':isolated?'LOCAL_ISOLATED_SYNTHETIC_PROVIDERS_REAL_POSTGRES':'LOCAL_TOOLCHAIN_OR_NON_ISOLATED_CHECK',testIsolation:isolated?{database:standaloneOffline?null:'127.0.0.1:64711/anthys_test',projectEnvLoaded:false,providerCredentialsInherited:false,nodeNetworkGuard:true}:null,live:false,output,logPath,sha256:createHash('sha256').update(output).digest('hex')},null,2)+'\n';
await mkdir('reports/checks/history',{recursive:true});await writeFile(`reports/checks/history/${label}-${startedAt.replace(/[:.]/g,'-')}.json`,record);await writeFile(`reports/checks/${label}.json`,record);
console.log(JSON.stringify({label,exitCode:code,status,report:`reports/checks/${label}.json`}));process.exitCode=candidateStable?Number(code??1):1;
