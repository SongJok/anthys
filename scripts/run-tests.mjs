import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {preserveTestArtifacts} from './preserve-test-artifacts.mjs';
const prepared=JSON.parse(await readFile('.data/test-environment/environment.json','utf8'));
for(const [name,role] of [['DATABASE_URL','oa_app'],['RUNTIME_DATABASE_URL','oa_runtime'],['QUEUE_DATABASE_URL','oa_queue'],['MIGRATION_DATABASE_URL','oa_migrator']]){const url=new URL(prepared[name]);if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='53331'||url.pathname!=='/open_aider_test'||url.search||url.username!==role||url.password.length<32)throw Error('TEST_DATABASE_TARGET_REJECTED');}
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
const child=spawn(process.execPath,kind==='offline'?['--import',resolve('scripts/test-network-guard.mjs'),'--import','tsx','--test',...args]:[binary,...args],{env:kind==='offline'?baseEnv:env,stdio:'inherit'});child.on('exit',code=>{process.exitCode=code??1;});
