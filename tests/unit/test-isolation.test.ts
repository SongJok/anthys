import testConfig from '../../vitest.config.js';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,relative} from 'node:path';
import {trialProcessEnvironment,isolatedTrialFixtureAllowed} from '../../packages/runtime/src/trial-supervision.js';
it.each([true,false])('owned trial environment propagates only fixed authority and enforces reply-only isolation; isolated=%s',isolated=>{
 expect(isolatedTrialFixtureAllowed()).toBe(true);
 try{
  if(!isolated){vi.stubEnv('OA_TEST_ISOLATED','false');vi.stubEnv('APP_ENV','production');}
  const input={APP_ENV:'production',PATH:'/synthetic/bin',RUNTIME_DATABASE_URL_FILE:'/synthetic/runtime-url',GLM_API_KEY_FILE:'/synthetic/glm-key',DINGTALK_CLIENT_SECRET:'synthetic-child-only',MIGRATION_DATABASE_URL:'synthetic-migrator-must-not-propagate',DWS_PROFILE:'synthetic-dws-must-not-propagate',ONE_SHOT_TRIAL_PROFILE_FILE:'/synthetic/foreign-trial',FORMAL_RUNTIME_PROFILE_FILE:'/synthetic/foreign-formal',UNDECLARED_CREDENTIAL:'synthetic-forbidden',NODE_OPTIONS:'--import /synthetic/network-guard.mjs',OA_TEST_ISOLATED:'true',OA_TRIAL_TEST_WALL_SHIFT_MS:'-100',DINGTALK_REPLY_ONLY:'false',DWS_ENABLED:'true',MOCK_PROVIDERS:'true'};
  expect(trialProcessEnvironment(input)).toEqual({APP_ENV:isolated?'test':'production',PATH:input.PATH,RUNTIME_DATABASE_URL_FILE:input.RUNTIME_DATABASE_URL_FILE,GLM_API_KEY_FILE:input.GLM_API_KEY_FILE,DINGTALK_CLIENT_SECRET:input.DINGTALK_CLIENT_SECRET,DINGTALK_REPLY_ONLY:'true',DWS_ENABLED:'false',MOCK_PROVIDERS:'false',...(isolated?{OA_TEST_ISOLATED:'true',NODE_OPTIONS:input.NODE_OPTIONS,OA_TRIAL_TEST_WALL_SHIFT_MS:'-100'}:{})});
  expect(trialProcessEnvironment({APP_ENV:'production'})).toEqual({APP_ENV:isolated?'test':'production',DINGTALK_REPLY_ONLY:'true',DWS_ENABLED:'false',MOCK_PROVIDERS:'false',...(isolated?{OA_TEST_ISOLATED:'true'}:{})});
  expect(input).toMatchObject({DINGTALK_REPLY_ONLY:'false',DWS_ENABLED:'true',MOCK_PROVIDERS:'true'});
 }finally{vi.unstubAllEnvs();}
});
it('isolated tests ignore a .env pointing to production and provider credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-isolation-'));try{
  await writeFile(join(dir,'.env'),'APP_ENV=production\nDATABASE_URL=postgresql://real@production.example/production\nGLM_API_KEY=synthetic-forbidden-sentinel\n');
  const module=resolve('packages/config/src/index.ts');const output=execFileSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',`const {loadEnvFile}=await import(${JSON.stringify(module)});loadEnvFile();if(process.env.DATABASE_URL||process.env.GLM_API_KEY||process.env.APP_ENV)throw Error('ENV_LOADED');console.log('IGNORED');`],{cwd:dir,env:{PATH:process.env['PATH'],OA_TEST_ISOLATED:'true'},encoding:'utf8'});expect(output.trim()).toBe('IGNORED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('guarded runner removes inherited credential/database/NODE_OPTIONS sentinels in child and worker',()=>{
 const env={...process.env,GLM_API_KEY:'synthetic-parent-only',DINGTALK_CLIENT_SECRET:'synthetic-parent-only',AIDER_AI_DD_MCP_TOKEN:'synthetic-parent-only',DWS_PROFILE:'synthetic-parent-only',DATABASE_URL:'postgresql://synthetic@production.invalid/db',NODE_OPTIONS:'--no-warnings'};
 const output=execFileSync(process.execPath,[resolve('scripts/run-tests.mjs'),'probe'],{env,encoding:'utf8'});expect(JSON.parse(output)).toEqual({childCredentialSentinelsRemoved:true,childDatabaseOverridden:true,childNetworkGuard:true,independentProcessAutomaticGuard:true,workerCredentialSentinelsRemoved:true,workerExplicitNetworkGuard:true});
});
it('missing isolated environment refuses all runner entry points before starting a provider or database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-missing-'));try{for(const kind of ['vitest','playwright','probe']){let output='',stdout='';try{execFileSync(process.execPath,[resolve('scripts/run-tests.mjs'),kind],{cwd:dir,env:{PATH:process.env['PATH']},stdio:'pipe'});}catch(e){output=String((e as {stderr:Buffer}).stderr);stdout=String((e as {stdout:Buffer}).stdout);}expect(output).toContain('ENOENT');expect(stdout).toBe('');}}finally{await rm(dir,{recursive:true,force:true});}
});
it('default network guard rejects fetch, HTTP, HTTPS, TCP and TLS outside declared loopback ports',()=>{
 const code=`import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
let blocked=0;try{await fetch('https://api.dingtalk.com/');}catch(e){if(e.message==='TEST_NETWORK_UNDECLARED_DESTINATION')blocked++;}
for(const fn of [()=>http.get('http://example.com/'),()=>https.request('https://example.com/'),()=>net.connect(443,'example.com'),()=>tls.connect({host:'example.com',port:443}),()=>net.connect(53330,'127.0.0.1'),()=>net.connect({path:'/tmp/undeclared.sock'})]){try{fn();}catch(e){if(e.message.startsWith('TEST_NETWORK_UNDECLARED'))blocked++;}}
if(blocked!==7)throw Error('GUARD_DID_NOT_BLOCK');console.log(blocked);`;
 const output=execFileSync(process.execPath,['--import',resolve('scripts/test-network-guard.mjs'),'--input-type=module','-e',code],{env:{PATH:process.env['PATH']},encoding:'utf8'});expect(output.trim()).toBe('7');
});
it('test runner rejects production, development and non-loopback database targets before launching tests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-target-'));try{
  const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'.data/test-environment'),{recursive:true});
  for(const target of ['postgresql://test@production.example:53331/open_aider_test','postgresql://test@127.0.0.1:53330/open_aider','postgresql://test@127.0.0.1:53331/production','postgresql://test@127.0.0.1:53331/open_aider_test?host=production.example']){
   await writeFile(join(dir,'.data/test-environment/environment.json'),JSON.stringify({DATABASE_URL:target}));let output='';try{execFileSync(process.execPath,[resolve('scripts/run-tests.mjs'),'vitest','run'],{cwd:dir,env:{PATH:process.env['PATH']},stdio:'pipe'});}catch(e){output=String((e as {stderr:Buffer}).stderr);}expect(output).toContain('TEST_DATABASE_TARGET_REJECTED');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('backend discovery retains the original 90 project files and rejects nested dependency, backup and build noise',async()=>{
 const baseline=JSON.parse(await readFile('tests/support/backend-discovery-baseline.json','utf8')) as {originalFiles:string[];originalCount:number;originalTestSpecification:Record<string,unknown>;knownExcludedOnlyByCLI:string;approvedAddedFiles?:string[];approvedExecutionPolicy:{maxWorkers:number;reason:string;evidence:string};approvedCoverageThresholdAdditions:Record<string,{branches:number}>};
 const discovery=(extra:string[]=[])=>execFileSync(process.execPath,['scripts/run-tests.mjs','vitest','list','--filesOnly',...extra],{env:process.env,encoding:'utf8',timeout:10000}).split(/\r?\n/).map(x=>x.trim()).filter(x=>/\.test\.(ts|mjs)$/.test(x)).map(x=>relative(process.cwd(),x)).sort();
 const nonce=randomUUID(),roots=['.data/discovery-noise-'+nonce,'tests/support/discovery-backup-'+nonce,'dist/discovery-build-'+nonce].map(x=>resolve(x));
 try{
  const expected=[...baseline.originalFiles,...baseline.approvedAddedFiles??[]].sort(),before=discovery();expect(baseline.originalCount).toBe(90);expect(baseline.originalFiles).toHaveLength(90);expect(new Set(expected).size).toBe(expected.length);expect(before).toEqual(expected);
  for(const [index,root]of roots.entries()){const directory=index===0?join(root,'node_modules','vendor','test'):root;await mkdir(directory,{recursive:true});await writeFile(join(directory,'noise.test.ts'),"throw Error('DISCOVERY_NOISE_MUST_NOT_EXECUTE');\n");}
  expect(discovery()).toEqual(before);const withoutKnown=discovery(['--exclude',baseline.knownExcludedOnlyByCLI]);expect(withoutKnown).toEqual(expected.filter(x=>x!==baseline.knownExcludedOnlyByCLI));expect(withoutKnown).toHaveLength(expected.length-1);
  const {include:_include,maxWorkers,...remaining}=testConfig.test!,{maxWorkers:originalMaxWorkers,...originalRemaining}=baseline.originalTestSpecification;
  expect(originalMaxWorkers).toBe(4);expect(baseline.approvedExecutionPolicy.maxWorkers).toBe(1);expect(baseline.approvedExecutionPolicy.evidence).toBe('reports/ci-process-closure-20261018/controlled-diagnosis.json');expect(maxWorkers).toBe(baseline.approvedExecutionPolicy.maxWorkers);const additions=baseline.approvedCoverageThresholdAdditions;
  expect(additions).toEqual({'packages/gateway/src/permission-administration.ts':{branches:90},'packages/gateway/src/control-plane.ts':{branches:90},'packages/gateway/src/reconciliation.ts':{branches:90},'packages/dingtalk/src/clarification.ts':{branches:90},'packages/groups/src/case-model.ts':{branches:90},'packages/groups/src/read-capability.ts':{branches:90},'packages/groups/src/case-roster.ts':{branches:90},'packages/dws/src/case-roster-protocol.ts':{branches:90},'packages/schedules/src/**/*.ts':{branches:90}});
  const originalCoverage=originalRemaining['coverage'] as Record<string,unknown>&{thresholds:Record<string,unknown>};
  for(const path of Object.keys(additions))expect(Object.hasOwn(originalCoverage.thresholds,path)).toBe(false);
  expect(remaining).toEqual({...originalRemaining,coverage:{...originalCoverage,thresholds:{...originalCoverage.thresholds,...additions}}});
 }finally{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));}
});
