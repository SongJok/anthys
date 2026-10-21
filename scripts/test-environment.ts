import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {migrate} from './migrate.js';
// Native direct children are required by backup cancellation/restore acceptance.
// Dynamic import keeps this test-only provisioning out of application runtime.
const {preparePostgresClient}=await import('./prepare-postgres-client.mjs');
const {prepareLinuxNodeRuntime}=await import('./prepare-linux-node-runtime.mjs');
// This setup never reads .env or .secrets and never changes the development cluster.
const flags=process.argv.slice(2);if(flags.some(flag=>flag!=='--fresh')||flags.length>1)throw Error('USAGE: test-environment [--fresh]');
await preparePostgresClient();
if(flags.includes('--fresh'))execFileSync('docker',['compose','--project-name','open-aider-test','-f','deploy/compose/compose.test.yml','down'],{stdio:'inherit'});
const dir=resolve('.data/test-environment');await mkdir(dir,{recursive:true,mode:0o700});
for(const name of ['pg_admin_password','pg_app_password','pg_queue_password','pg_runtime_password','app_master_key','session_secret']){try{await access(`${dir}/${name}`);}catch{await writeFile(`${dir}/${name}`,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}}
execFileSync('docker',['compose','--project-name','open-aider-test','-f','deploy/compose/compose.test.yml','up','-d','--wait','postgres'],{stdio:'inherit'});
// Separate test container recovery runs the exact Node release inside the
// pinned PG image. Download only official pinned public bytes; never execute
// the Linux binary here, mount the workspace or enable enterprise networking.
const imageArchitecture=execFileSync('docker',['image','inspect','postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826','--format','{{.Architecture}}'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
if(imageArchitecture!=='arm64'&&imageArchitecture!=='amd64')throw Error('TEST_IMAGE_ARCHITECTURE_UNSUPPORTED');
const linuxRuntime=await prepareLinuxNodeRuntime({directory:resolve(dir,'linux-node'),architecture:imageArchitecture==='amd64'?'x64':'arm64'});
await writeFile(`${dir}/linux-node-runtime.json`,JSON.stringify(linuxRuntime)+'\n',{mode:0o600});
const env:Record<string,string>={APP_ENV:'test',OA_TEST_ISOLATED:'true',APP_ORIGIN:'http://localhost:52330',PORT:'52330'};
for(const [key,role,password] of [['DATABASE_URL','oa_app','pg_app_password'],['RUNTIME_DATABASE_URL','oa_runtime','pg_runtime_password'],['QUEUE_DATABASE_URL','oa_queue','pg_queue_password'],['MIGRATION_DATABASE_URL','oa_migrator','pg_admin_password']] as const){env[key]=`postgresql://${role}:${(await readFile(`${dir}/${password}`,'utf8')).trim()}@127.0.0.1:53331/open_aider_test`;}
const budgetPolicy={schemaVersion:1,id:'isolated-tests-v1',model:'glm-5.3-flash',currency:'CNY',environment:'SYNTHETIC_TEST',approved:true,approvalReference:'SYNTHETIC_LOCAL_TEST_CEILING_ONLY',validUntil:'2099-01-01T00:00:00.000Z',dayZone:'UTC',maxInputTokens:65536,maxOutputTokens:8192,ceiling:{inputPerMillion:'1',outputPerMillion:'1'},pricing:null,limits:Object.fromEntries(['tenant','department','user','task'].map(scope=>[scope,{tokens:'999999999999',money:'999999999999',concurrent:scope==='task'?1:30}]))};
await writeFile(`${dir}/budget-policy.json`,JSON.stringify(budgetPolicy),{mode:0o600});env['BUDGET_POLICY_FILE']=`${dir}/budget-policy.json`;
env['APP_MASTER_KEY_FILE']=`${dir}/app_master_key`;env['SESSION_SECRET_FILE']=`${dir}/session_secret`;
process.env['APP_ENV']='test';await migrate(env['MIGRATION_DATABASE_URL']!,dir);
await writeFile(`${dir}/environment.json`,JSON.stringify(env),{mode:0o600});console.log('Dedicated synthetic test cluster prepared on loopback:53331; development configuration unchanged.');
