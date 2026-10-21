import {loadEnvFile,config,secret} from '../packages/config/src/index.js';
import {Database} from '../packages/storage/src/database.js';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {modelBudgetDiagnostic} from '../packages/runtime/src/budget-policy.js';
loadEnvFile();
const checks:{component:string;status:string;reason:string}[]=[];
try{config();checks.push({component:'configuration',status:'PASS',reason:'VALIDATED'});}catch{checks.push({component:'configuration',status:'FAIL',reason:'INVALID_CONFIGURATION'});}
const budget=modelBudgetDiagnostic();checks.push({component:'model-budget',status:budget.status,reason:budget.reason??'MODEL_BUDGET_POLICY_INVALID'});
const url=secret('DATABASE_URL');if(url){const db=new Database(url,1);try{checks.push({component:'database',status:await db.ready()?'PASS':'FAIL',reason:'REAL_DATABASE_SCHEMA_CHECK'});}catch{checks.push({component:'database',status:'FAIL',reason:'DATABASE_OR_SCHEMA_UNAVAILABLE'});}finally{await db.close();}}else checks.push({component:'database',status:'BLOCKED_EXTERNAL',reason:'DATABASE_URL_MISSING'});
for(const [component,names] of [['glm',['GLM_API_KEY']],['dingtalk',['DINGTALK_CORP_ID','DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE']],['dws',['DWS_RUNNER_URL','DWS_RUNNER_AUTH_KEY']]] as const){
 let missing=false;try{missing=names.some(n=>!secret(n));}catch{missing=true;}checks.push({component,status:missing?'BLOCKED_EXTERNAL':'UNVERIFIED',reason:missing?'REQUIRED_CONFIGURATION_MISSING':'CONFIGURED_NOT_LIVE_VERIFIED'});
}
for(const [component,path] of [['mcp','config/mcp-connections.json'],['data','config/data-connections.json'],['search','config/search-connections.json']] as const){try{const entries=JSON.parse(await readFile(path,'utf8')) as unknown[];checks.push({component,status:entries.length?'UNVERIFIED':'BLOCKED_EXTERNAL',reason:entries.length?'REGISTERED_NOT_LIVE_VERIFIED':'NO_REGISTERED_PROVIDER'});}catch{checks.push({component,status:'BLOCKED_EXTERNAL',reason:'NO_REGISTERED_PROVIDER'});}}
const queueUrl=secret('QUEUE_DATABASE_URL');if(queueUrl){const queue=new pg.Pool({connectionString:queueUrl,max:1,connectionTimeoutMillis:3000});try{const q=await queue.query('SELECT version FROM oa_queue.version');checks.push({component:'queue',status:q.rows[0]?.version===46?'PASS':'FAIL',reason:'REAL_PG_BOSS_SCHEMA_CHECK'});}catch{checks.push({component:'queue',status:'FAIL',reason:'QUEUE_SCHEMA_UNAVAILABLE'});}finally{await queue.end();}}else checks.push({component:'queue',status:'BLOCKED_EXTERNAL',reason:'QUEUE_DATABASE_URL_MISSING'});
checks.push({component:'storage',status:'UNVERIFIED',reason:'ARTIFACT_ACL_AND_STORAGE_NOT_YET_SYSTEM_VERIFIED'});
console.log(JSON.stringify({checkedAt:new Date().toISOString(),timezone:'Asia/Shanghai',profile:process.argv.includes('BASE')?'BASE':'ENTERPRISE_DWS',checks},null,2));if(checks.some(c=>c.status!=='PASS'))process.exitCode=1;
