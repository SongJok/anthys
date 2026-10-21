import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
if(process.argv.length!==2||Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard'))!==true)throw Error('READ_BACK_GUARDED_RUNNER_REQUIRED');
const root=process.cwd(),work=await mkdtemp(join(tmpdir(),'oa-control-readback-')),guard=pathToFileURL(resolve('scripts/test-network-guard.mjs')).href;
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','CI','TERM','NO_COLOR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const require=createRequire(import.meta.url),tsxRequire=createRequire(require.resolve('tsx'));
// Use tsx's installed declared compiler dependency; no install or remote bundle.
const {build}=await import(pathToFileURL(tsxRequire.resolve('esbuild')).href);
async function run(stage,args,extra={}){
 const child=spawn(process.execPath,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);});
 await writeFile(join(work,stage+'.log'),output,{mode:0o600});
 if(code!==0)throw Error('READ_BACK_'+stage.toUpperCase()+'_FAILED: '+join(work,stage+'.log'));
 return output;
}
const unit=await run('flow',['--import',guard,'--import','tsx','--test','--test-reporter=tap','tests/offline/control-readback.test.ts']);
if(!/^# tests 7\s*$/m.test(unit)||!/^# pass 7\s*$/m.test(unit)||!/^# fail 0\s*$/m.test(unit)||!/^# skipped 0\s*$/m.test(unit))throw Error('READ_BACK_FLOW_COUNT_OR_SKIP_MISMATCH');
const entry=join(work,'entry.tsx'),bundle=join(work,'fixture.js');
await writeFile(entry,"import React from 'react';import {createRoot} from 'react-dom/client';import {ControlConsole} from "+JSON.stringify(resolve('apps/web/src/control-console.tsx'))+";const root=createRoot(document.getElementById('root'));const render=csrf=>root.render(<ControlConsole csrf={csrf}/>);Reflect.set(window,'replaceControlCsrf',render);Reflect.set(window,'unmountControl',()=>root.unmount());render('synthetic-csrf');",{mode:0o600});
await build({absWorkingDir:root,entryPoints:[entry],outfile:bundle,bundle:true,format:'iife',platform:'browser',nodePaths:[resolve('node_modules')],tsconfig:resolve('tsconfig.json'),logLevel:'silent'});
const config=join(work,'playwright.config.cjs'),report=join(work,'browser.json');
await writeFile(config,'module.exports='+JSON.stringify({testDir:resolve('tests/e2e'),testMatch:'control-readback.spec.ts',tsconfig:resolve('tsconfig.json'),outputDir:join(work,'results'),forbidOnly:true,maxFailures:1,workers:1,fullyParallel:false,retries:0,reporter:[['json',{outputFile:report}]],use:{browserName:'chromium',channel:env.CI?'chromium':'chrome',headless:true,serviceWorkers:'block'}})+';\n',{mode:0o600});
await run('browser',[require.resolve('@playwright/test/cli'),'test','--config',config],{CONTROL_READBACK_BUNDLE:bundle,NODE_OPTIONS:'--import='+guard});
const result=JSON.parse(await readFile(report,'utf8'));
if(result.errors?.length||result.stats.expected!==19||result.stats.unexpected!==0||result.stats.skipped!==0||result.stats.flaky!==0)throw Error('READ_BACK_BROWSER_COUNT_OR_SKIP_MISMATCH: '+report);
console.log(JSON.stringify({status:'PASS',flow:{passed:7,failed:0,skipped:0},browser:{passed:19,failed:0,skipped:0,flaky:0,durationMs:result.stats.duration},source:'actual ControlConsole and route mocks',backendOrDatabaseStarted:false,realProviderCalls:0,privateEvidenceDirectory:work}));
