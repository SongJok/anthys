import {readFile,writeFile} from 'node:fs/promises';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {GlmProvider} from '../packages/provider-glm/src/client.js';
loadEnvFile();
const blockers=JSON.parse(await readFile('config/external-blockers.json','utf8')) as {component:string;requires:string[]}[];
const results:{component:string;status:string;reason:string;requestId?:string}[]=blockers.map(b=>({component:b.component,status:'BLOCKED_EXTERNAL',reason:b.requires.join('; ')}));
if(process.env['LIVE_TEST_ENABLED']==='true'&&process.env['GLM_DATA_EGRESS_APPROVED']==='true') {
 const apiKey=secret('GLM_API_KEY'),entry=results.find(r=>r.component==='GLM')!;
 if(apiKey){try{const provider=new GlmProvider({apiKey,baseUrl:secret('GLM_BASE_URL')??'https://open.bigmodel.cn/api/paas/v4',reasoningEffort:'high'});const r=await provider.complete([{role:'user',content:'Return only the text anthys_probe_ok. This is a consented connectivity probe with no enterprise data.'}],[],new AbortController().signal);
  entry.status=r.message.content?.trim()==='anthys_probe_ok'?'PARTIAL':'FAIL';entry.reason='Connectivity/text probe only; native multi-tool, cancellation, modality and full evaluation remain NOT_RUN.';if(r.requestId)entry.requestId=r.requestId;
 }catch{entry.status='FAIL';entry.reason='REAL_MODEL_PROBE_FAILED';}}
}
const report={profile:'ENTERPRISE_DWS',startedAt:new Date().toISOString(),timezone:'Asia/Shanghai',environment:'LIVE',mock:false,status:'BLOCKED_EXTERNAL',results,requiredBaselineLiveTests:['T020','T069','T070','T071','T082','T096'].map(testId=>({testId,status:'BLOCKED_EXTERNAL',reason:'Dedicated enterprise test assets and complete live oracle execution are required; local fixtures do not count.'}))};
await writeFile('reports/live.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=1;
