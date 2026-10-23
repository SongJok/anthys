import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {preserveTestArtifacts} from './preserve-test-artifacts.mjs';
const prepared=JSON.parse(await readFile('.data/test-environment/environment.json','utf8'));
for(const [name,role] of [['DATABASE_URL','oa_app'],['RUNTIME_DATABASE_URL','oa_runtime'],['QUEUE_DATABASE_URL','oa_queue'],['MIGRATION_DATABASE_URL','oa_migrator']]){const url=new URL(prepared[name]);if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='64711'||url.pathname!=='/anthys_test'||url.search||url.username!==role||url.password.length<32)throw Error('TEST_DATABASE_TARGET_REJECTED');}
if(prepared.APP_ENV!=='test'||prepared.OA_TEST_ISOLATED!=='true')throw Error('TEST_ISOLATION_REQUIRED');
const allowedConfig=new Set(['APP_ENV','OA_TEST_ISOLATED','APP_ORIGIN','PORT','DATABASE_URL','RUNTIME_DATABASE_URL','QUEUE_DATABASE_URL','MIGRATION_DATABASE_URL','APP_MASTER_KEY_FILE','SESSION_SECRET_FILE','BUDGET_POLICY_FILE']);
if(Object.keys(prepared).some(k=>!allowedConfig.has(k)))throw Error('TEST_UNEXPECTED_CONFIGURATION');
for(const [key,name] of [['APP_MASTER_KEY_FILE','app_master_key'],['SESSION_SECRET_FILE','session_secret']])if(prepared[key]!==resolve(`.data/test-environment/${name}`))throw Error('TEST_SECRET_PATH_REJECTED');
if(prepared.BUDGET_POLICY_FILE!==resolve('.data/test-environment/budget-policy.json'))throw Error('TEST_BUDGET_POLICY_PATH_REJECTED');
// Allowlist process settings: no inherited enterprise keys, tokens or NODE_OPTIONS.
const baseEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','CI','TERM','NO_COLOR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const env={...baseEnv,...prepared,NODE_OPTIONS:`--import ${resolve('scripts/test-network-guard.mjs')}`};
const [kind,...args]=process.argv.slice(2);if(!['vitest','playwright','probe','offline'].includes(kind))throw Error('TEST_RUNNER_REQUIRED');
const binary=kind==='probe'?resolve('scripts/probe-test-isolation.mjs'):resolve(`node_modules/${kind==='vitest'?'vitest/vitest.mjs':'@playwright/test/cli.js'}`);
if(kind==='offline'&&(!args.length||args.some(a=>!/^tests\/offline\/[A-Za-z0-9._/-]+\.test\.ts$/.test(a)||a.split('/').includes('..'))))throw Error('OFFLINE_TEST_PATH_REQUIRED');
if(kind!=='probe') {const backup=await preserveTestArtifacts();console.log(`Preserved ${backup.files} existing report files: ${backup.manifest}`);}
// Standalone flow tests inherit neither database configuration nor secret paths.
// Preload the guard explicitly so NODE_OPTIONS itself need not be inherited.
// The DM diagnostics oracle installs its own all-IO-denying guard, which also
// denies the private RPC sockets the other offline oracles need, so it runs in
// a separate process with that guard instead of the general network guard.
const dmFile='tests/offline/dm-diagnostic-guard.test.ts',guard=resolve('scripts/test-network-guard.mjs'),dmGuard=resolve('tests/support/dm-diagnostics-offline-guard.mjs');
const offlineEnv={...baseEnv,APP_ENV:'test',OA_TEST_ISOLATED:'true'};
if(kind==='offline'){
 const groups=[...args.some(f=>f!==dmFile)?[{files:args.filter(f=>f!==dmFile),pre:guard}]:[],...args.includes(dmFile)?[{files:[dmFile],pre:dmGuard}]:[]];
 for(const group of groups){const code=await new Promise(resolve=>{const child=spawn(process.execPath,['--import',group.pre,'--import','tsx','--test',...group.files],{env:offlineEnv,stdio:'inherit'});child.on('exit',code=>resolve(code??1));});if(code!==0){process.exitCode=code;break;}}
}else{const child=spawn(process.execPath,[binary,...args],{env,stdio:'inherit'});child.on('exit',code=>{process.exitCode=code??1;});}
