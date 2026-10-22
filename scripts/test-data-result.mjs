import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
if(process.argv.length!==2||Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard'))!==true)throw Error('DATA_RESULT_GUARDED_RUNNER_REQUIRED');
const root=process.cwd(),work=await mkdtemp(join(tmpdir(),'oa-data-result-')),guard=pathToFileURL(resolve('scripts/test-network-guard.mjs')).href;
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','CI','TERM','NO_COLOR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const require=createRequire(import.meta.url),tsxRequire=createRequire(require.resolve('tsx'));
// Use tsx's installed declared compiler dependency; no install or remote bundle.
const {build}=await import(pathToFileURL(tsxRequire.resolve('esbuild')).href);
async function run(stage,args,extra={}){
 const child=spawn(process.execPath,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);});
 await writeFile(join(work,stage+'.log'),output,{mode:0o600});
 if(code!==0)throw Error('DATA_RESULT_'+stage.toUpperCase()+'_FAILED: '+join(work,stage+'.log'));
 return output;
}
const unit=await run('flow',['--import',guard,'--import','tsx','--test','--test-reporter=tap','tests/offline/data-result.test.ts']);
if(!/^# tests 9\s*$/m.test(unit)||!/^# pass 9\s*$/m.test(unit)||!/^# fail 0\s*$/m.test(unit)||!/^# skipped 0\s*$/m.test(unit))throw Error('DATA_RESULT_FLOW_COUNT_OR_SKIP_MISMATCH');
const entry=join(work,'entry.tsx'),bundle=join(work,'fixture.js');
await writeFile(entry,"import React from 'react';import {createRoot} from 'react-dom/client';import {DataResultView} from "+JSON.stringify(resolve('apps/web/src/data-result.tsx'))+";const root=createRoot(document.getElementById('root'));let csrf='synthetic-csrf';Reflect.set(window,'sessionLosses',0);function Harness(){const [logged,setLogged]=React.useState(true);const lost=React.useCallback(()=>{Reflect.set(window,'sessionLosses',Reflect.get(window,'sessionLosses')+1);setLogged(false);},[]);return logged?<DataResultView csrf={csrf} onSessionLost={lost}/>:<p>需要重新登录</p>;}const render=()=>root.render(<Harness/>);Reflect.set(window,'replaceDataResultCsrf',value=>{csrf=value;render();});render();",{mode:0o600});
await build({absWorkingDir:root,entryPoints:[entry],outfile:bundle,bundle:true,format:'iife',platform:'browser',nodePaths:[resolve('node_modules')],tsconfig:resolve('tsconfig.json'),logLevel:'silent'});
const config=join(work,'playwright.config.cjs'),report=join(work,'browser.json');
await writeFile(config,'module.exports='+JSON.stringify({testDir:resolve('tests/e2e'),testMatch:'data-result.spec.ts',tsconfig:resolve('tsconfig.json'),outputDir:join(work,'results'),forbidOnly:true,maxFailures:1,workers:1,fullyParallel:false,retries:0,reporter:[['json',{outputFile:report}]],use:{browserName:'chromium',channel:env.CI?'chromium':'chrome',headless:true,serviceWorkers:'block',timezoneId:'UTC'}})+';\n',{mode:0o600});
await run('browser',[require.resolve('@playwright/test/cli'),'test','--config',config],{DATA_RESULT_BUNDLE:bundle,NODE_OPTIONS:'--import='+guard});
const result=JSON.parse(await readFile(report,'utf8'));
if(result.errors?.length||result.stats.expected!==9||result.stats.unexpected!==0||result.stats.skipped!==0||result.stats.flaky!==0)throw Error('DATA_RESULT_BROWSER_COUNT_OR_SKIP_MISMATCH: '+report);
console.log(JSON.stringify({status:'PASS',flow:{passed:9,failed:0,skipped:0},browser:{passed:9,failed:0,skipped:0,flaky:0,durationMs:result.stats.duration},source:'actual DataResultView and route mocks',backendOrDatabaseStarted:false,realProviderCalls:0,privateEvidenceDirectory:work}));
