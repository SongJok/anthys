import {test,expect} from '@playwright/test';
import {build} from 'vite';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {artifactToolDraftNotice} from '../../apps/web/src/artifacts-flow.js';

// Component-only UI evidence: real production React code, all HTTP intercepted.
// This does not start the API, use PG or establish source/download authorization.
const root=fileURLToPath(new URL('../..',import.meta.url)),assets=new Map<string,{body:string|Buffer;contentType:string}>();
const taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',oldId='44444444-4444-4444-8444-444444444444';
const bytes=Buffer.from('SYNTHETIC private tool draft. Not verified facts.\n'),sha=createHash('sha256').update(bytes).digest('hex');
test.beforeAll(async()=>{
 const temporary=await mkdtemp(resolve(tmpdir(),'native-artifact-ui-'));
 try{
  const entry=resolve(temporary,'entry.tsx');
  await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {Artifacts} from ${JSON.stringify(resolve(root,'apps/web/src/artifacts.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(Artifacts,{csrf:'SYNTHETIC_CSRF',taskId:${JSON.stringify(taskId)},runId:${JSON.stringify(runId)}}));`);
  const output=await build({configFile:false,envDir:false,root,logLevel:'silent',define:{'process.env.NODE_ENV':JSON.stringify('production')},resolve:{alias:{react:resolve(root,'node_modules/react'),'react-dom':resolve(root,'node_modules/react-dom')}},build:{write:false,lib:{entry,formats:['es'],fileName:'component'},minify:false}});
  for(const result of Array.isArray(output)?output:[output]){
   if(!('output' in result))throw Error('UNEXPECTED_UI_BUILD');
   for(const item of result.output)assets.set('/'+item.fileName,{body:item.type==='chunk'?item.code:typeof item.source==='string'?item.source:Buffer.from(item.source),contentType:item.fileName.endsWith('.css')?'text/css':'text/javascript'});
  }
  const scripts=[...assets.keys()].filter(p=>p.endsWith('.js')).map(p=>`<script type="module" src="${p}"></script>`).join(''),styles=[...assets.keys()].filter(p=>p.endsWith('.css')).map(p=>`<link rel="stylesheet" href="${p}">`).join('');
  assets.set('/',{body:`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}</style></head><body><main id="root"></main>${scripts}</body></html>`,contentType:'text/html'});
 }finally{await rm(temporary,{recursive:true,force:true});}
});
test('private tool draft is visibly unverified, keeps protected downloads and refuses forged verification',async({page},info)=>{
 const errors:string[]=[];const onError=(error:Error)=>errors.push(error.message);page.on('pageerror',onError);
 let forged=false,grants=0,gets=0,secretMatched=false;const targets:string[]=[];const ticket='S'.repeat(43);
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  expect(url.origin).toBe('http://localhost:52339');targets.push(url.pathname);expect(url.search).toBe('');
  const now=new Date().toISOString(),common={taskId,runId,format:'txt',mime:'text/plain; charset=utf-8',byteSize:bytes.length,sha256:sha,createdAt:now};
  const items=[{...common,id,fileName:'draft.txt',source:{mode:'TOOL_DRAFT',classification:'INTERNAL',verification:forged?'VERIFIED':'UNVERIFIED',asOf:now,notice:artifactToolDraftNotice}},{...common,id:oldId,fileName:'result.txt',source:{mode:'VERIFIED_TASK_RESULT',classification:'INTERNAL',verification:'PARTIAL',asOf:now,notice:'SYNTHETIC existing partial result.'}}];
  if(url.pathname===`/api/v1/tasks/${taskId}/artifacts`){expect(request.method()).toBe('GET');await route.fulfill({json:{data:{items,asOf:now}}});return;}
  if(url.pathname===`/api/v1/artifacts/${id}/download-ticket`){grants++;expect(request.method()).toBe('POST');expect(request.postDataJSON()).toEqual({});expect(request.headers()['x-csrf-token']).toBe('SYNTHETIC_CSRF');await route.fulfill({json:{data:{ticket,expiresAt:new Date(Date.now()+30000).toISOString(),artifactId:id,sha256:sha,byteSize:bytes.length}}});return;}
  if(url.pathname===`/api/v1/artifacts/${id}/download`){gets++;secretMatched=request.headers()['x-artifact-download-ticket']===ticket;expect(request.method()).toBe('GET');expect(secretMatched).toBe(true);await route.fulfill({body:bytes,contentType:'text/plain; charset=utf-8'});return;}
  const asset=assets.get(url.pathname);if(asset){await route.fulfill(asset);return;}
  if(url.pathname==='/favicon.ico'){await route.fulfill({status:204});return;}
  throw Error('UNEXPECTED_COMPONENT_REQUEST');
 });
 try{
  await page.goto('/');
  const panel=page.getByRole('region',{name:'任务成果'}),draft=panel.getByRole('article').filter({has:page.getByRole('heading',{name:'draft.txt'})}),old=panel.getByRole('article').filter({has:page.getByRole('heading',{name:'result.txt'})});
  await expect(draft.getByText('工具草稿 · 事实未核验',{exact:true})).toBeVisible();
  await expect(draft.getByText('这是工具生成的私有草稿。格式检查不证明事实、来源或外部动作已完成，请核对原始资料后再使用。',{exact:true})).toBeVisible();
  await expect(draft.getByText(artifactToolDraftNotice,{exact:true})).toBeVisible();
  await expect(draft.getByText(/草稿检查时间/)).toBeVisible();
  await expect(draft.getByText('来源已核验',{exact:true})).toHaveCount(0);
  await expect(old.getByText('仅支持部分结果',{exact:true})).toBeVisible();
  await expect(old.getByText('请保留部分结果限定，不能据此推断全部情况。',{exact:true})).toBeVisible();
  await expect(panel.getByText(/成果不公开分享/)).toBeVisible();
  await expect(panel.getByRole('button',{name:'生成受保护成果'})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('tool-draft.png'),fullPage:true});
  const completed=page.waitForEvent('download');await draft.getByRole('button',{name:'受保护下载'}).click();const download=await completed;
  expect(download.suggestedFilename()).toBe('draft.txt');const downloaded=await download.path();expect(downloaded).not.toBeNull();expect(createHash('sha256').update(await readFile(downloaded!)).digest('hex')).toBe(sha);
  expect(grants).toBe(1);expect(gets).toBe(1);expect(secretMatched).toBe(true);
  forged=true;await panel.getByRole('button',{name:'重新读取'}).click();
  await expect(panel.getByRole('article')).toHaveCount(0);await expect(panel.getByRole('button',{name:'生成受保护成果'})).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('成果资料无法核实');expect(grants).toBe(1);expect(gets).toBe(1);
  expect(targets.some(path=>path.includes(ticket))).toBe(false);expect(errors).toEqual([]);
 }finally{page.off('pageerror',onError);await page.unrouteAll({behavior:'wait'});}
});
