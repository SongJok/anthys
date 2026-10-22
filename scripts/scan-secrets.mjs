import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
const secrets=new Set();
for(const [key,value] of Object.entries(process.env)){
 if(!value)continue;
 // A directory/URL-valued variable can contain SECRET in its name without its
 // value being a secret. _FILE stays included: its contents are read below.
 if(/_(?:DIR|PATH|URL|HOST|ORIGIN|ENDPOINT)$/.test(key))continue;
 if(/SECRET|TOKEN|PASSWORD|(?:API|MASTER)_KEY/.test(key)) {const text=key.endsWith('_FILE')?await readFile(value,'utf8'):value;if(text.trim().length>=12)secrets.add(text.trim());}
 try{const u=new URL(value);if(u.password.length>=12)secrets.add(decodeURIComponent(u.password));for(const [k,v] of u.searchParams)if(/secret|token|password|key/i.test(k)&&v.length>=12)secrets.add(v);}catch{}
}
const objects=execFileSync('git',['rev-list','--objects','--all'],{encoding:'utf8'}).trim().split('\n').map(l=>l.split(' ')[0]);
let scanned=0;const findings=[];
for(const oid of new Set(objects)){
 if(!oid)continue;const type=execFileSync('git',['cat-file','-t',oid],{encoding:'utf8'}).trim();if(type!=='blob')continue;
 const body=execFileSync('git',['cat-file','blob',oid],{maxBuffer:20*1024*1024}).toString('utf8');scanned++;
 for(const s of secrets)if(body.includes(s)){findings.push({objectId:oid,reason:'CONFIGURED_SECRET_MATCH'});break;}
}
for(const path of execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split('\n')){
 if(!path)continue;let body;try{body=await readFile(path,'utf8');}catch{continue;}
 for(const s of secrets)if(body.includes(s)){findings.push({path,reason:'CONFIGURED_SECRET_MATCH'});break;}
}
const report={checkedAt:new Date().toISOString(),status:findings.length?'FAIL':'PASS',scope:'all local Git history blobs and current tracked working tree; exact configured secret matching, not a complete heuristic scanner',objectsScanned:scanned,configuredSecretCount:secrets.size,findings};
await writeFile('reports/configured-secret-scan.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(findings.length)process.exitCode=1;
