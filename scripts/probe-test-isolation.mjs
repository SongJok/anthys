import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
const check=`
if(!globalThis[Symbol.for('open_aider.testNetworkGuard')])throw Error('GUARD_MISSING');
for(const key of Object.keys(process.env))if(/^(DINGTALK_|GLM_API_KEY|AIDER_AI_|DWS_)/.test(key))throw Error('PROVIDER_ENV_INHERITED');
if(!process.env.NODE_OPTIONS?.includes('test-network-guard.mjs')||process.env.NODE_OPTIONS.includes('--no-warnings'))throw Error('NODE_OPTIONS_INHERITED');
if(new URL(process.env.DATABASE_URL).port!=='53331')throw Error('DATABASE_ENV_INHERITED');
let blocked=false;try{await fetch('https://api.dingtalk.com/');}catch(e){blocked=e.message==='TEST_NETWORK_UNDECLARED_DESTINATION';}if(!blocked)throw Error('NETWORK_NOT_BLOCKED');`;
await import('data:text/javascript,'+encodeURIComponent(check));
// An independent process inherits NODE_OPTIONS and must install the guard without an explicit import in its code.
execFileSync(process.execPath,['--input-type=module','-e',check],{env:process.env,stdio:'pipe'});
await new Promise((resolve,reject)=>{const worker=new Worker(`(async()=>{await import(${JSON.stringify(new URL('./test-network-guard.mjs',import.meta.url).href)});${check}})().catch(e=>{console.error(e.message);process.exit(1)});`,{eval:true});worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(Error('WORKER_ISOLATION_FAILED')));});
console.log(JSON.stringify({childCredentialSentinelsRemoved:true,childDatabaseOverridden:true,childNetworkGuard:true,independentProcessAutomaticGuard:true,workerCredentialSentinelsRemoved:true,workerExplicitNetworkGuard:true}));
