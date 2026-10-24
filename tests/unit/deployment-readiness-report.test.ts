import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {overallStatus,brokerCredentialLeaks,type Check} from '../../scripts/readiness-checks.js';

const root=join(import.meta.dirname,'../..'),reportDirectory=join(root,'reports');
const checkIds=['servicesPresent','serviceHealth','imageSchemaContract','migrationContractMatch','queueSchema','publicTables','healthEndpoints','dockerSocketIsolation','brokerCredentialBoundary','workerHeartbeat','prodComposeRender'];
const services=['api','postgres','sandbox-broker','worker'];
type Service={health:string;envNames:string[];mountTargets:string[]}|null;
type ProbeReport={schemaVersion:number;case:string;generatedAt:string;status:'PASS'|'FAIL';live:boolean;liveProviderCalls:number;compose:{file:string;prodFile:string;fileSha256:string;prodFileSha256:string};source:{workerHeartbeatSha256:string;workerMainSha256:string};services:Record<string,Service>;api:{providerEnvNamesPresent?:string[]};checks:Check[];limitations:Record<string,string>};
const nameOnly=/^[A-Za-z_][A-Za-z0-9_]*$/,digest=/^[a-f0-9]{64}$/;
const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];

async function reports():Promise<{name:string;report:ProbeReport}[]>{
 const names=(await readdir(reportDirectory)).filter(name=>/^deployment-readiness-probe-\d{8}\.json$/.test(name)).sort();
 return Promise.all(names.map(async name=>({name,report:JSON.parse(await readFile(join(reportDirectory,name),'utf8')) as ProbeReport})));
}
function problems(report:ProbeReport):string[]{
 const found:string[]=[];
 if(report.schemaVersion!==1)found.push('schemaVersion');
 if(report.case!=='LOCAL_DOCKER_DEPLOYMENT_READINESS_PROBE')found.push('case');
 if(report.live!==false)found.push('live');
 if(report.liveProviderCalls!==0)found.push('liveProviderCalls');
 if(!report.generatedAt||Number.isNaN(Date.parse(report.generatedAt)))found.push('generatedAt');
 const checks=report.checks??[];
 if(checks.map(check=>check.id).join(',')!==checkIds.join(','))found.push('checkIds');
 if(report.status!=='PASS'&&report.status!=='FAIL')found.push('status');
 if(report.status==='PASS'&&overallStatus(checks)!=='PASS')found.push('statusNotDerivedFromChecks');
 const limitations=report.limitations??{};
 const liveAcceptance=limitations['liveAcceptance']??'';
 if(!/BLOCKED_EXTERNAL/.test(liveAcceptance)||!/NOT_RUN/.test(liveAcceptance)||!/IN_PROGRESS/.test(liveAcceptance))found.push('liveAcceptanceLimitation');
 if(!/No secret value/.test(limitations['secretHandling']??''))found.push('secretHandlingLimitation');
 if(report.compose?.file!=='deploy/compose/compose.dev.yml'||report.compose?.prodFile!=='deploy/compose/compose.prod.yml')found.push('composePaths');
 for(const key of ['fileSha256','prodFileSha256'] as const)if(!digest.test(report.compose?.[key]??''))found.push('compose.'+key);
 for(const key of ['workerHeartbeatSha256','workerMainSha256'] as const)if(!digest.test(report.source?.[key]??''))found.push('source.'+key);
 if(Object.keys(report.services??{}).sort().join(',')!==services.join(','))found.push('services');
 for(const [service,view] of Object.entries(report.services??{})){
  if(!view){if(report.status==='PASS')found.push('serviceAbsent:'+service);continue;}
  if(report.status==='PASS'&&view.health!=='healthy')found.push('unhealthy:'+service);
  for(const env of view.envNames??[])if(!nameOnly.test(env))found.push('envValueRecorded:'+service+':'+env);
  for(const target of view.mountTargets??[])if(!target.startsWith('/'))found.push('mountTarget:'+service+':'+target);
 }
 for(const name of report.api?.providerEnvNamesPresent??[])if(!nameOnly.test(name))found.push('providerEnvNotName:'+name);
 const broker=report.services?.['sandbox-broker'];
 if(report.status==='PASS'&&broker){
  const evidence=checks.find(check=>check.id==='brokerCredentialBoundary')?.evidence??{};
  const mounted=strings(evidence['secretsMounted']),envNames=strings(evidence['envNames']);
  const leaks=brokerCredentialLeaks(mounted,envNames);
  if(leaks.length)found.push('brokerCredentialLeak:'+leaks.join(','));
  if(mounted.some(name=>name.includes('/')))found.push('secretMountRecordedAsPath');
 }
 return found;
}

it('every committed readiness probe report keeps the local-only honesty contract',async()=>{
 const committed=await reports();
 expect(committed.map(entry=>entry.name)).toEqual(['deployment-readiness-probe-20261023.json','deployment-readiness-probe-20261024.json']);
 for(const {name,report} of committed)expect({name,problems:problems(report)}).toEqual({name,problems:[]});
});
it('the report guard rejects a report that claims live verification, records secret values, or lets a failed check pass',async()=>{
 const {report}= (await reports())[0]!;
 const live=structuredClone(report);live.live=true;live.liveProviderCalls=2;
 expect(problems(live)).toEqual(expect.arrayContaining(['live','liveProviderCalls']));
 const failed=structuredClone(report);failed.checks[3]!.result='FAIL';
 expect(problems(failed)).toEqual(expect.arrayContaining(['statusNotDerivedFromChecks']));
 const leaked=structuredClone(report);leaked.checks.find(check=>check.id==='brokerCredentialBoundary')!.evidence['envNames']=['ANTHYS_DATABASE_URL','GLM_API_KEY'];
 expect(problems(leaked)).toContain('brokerCredentialLeak:GLM_API_KEY');
 const mountedPath=structuredClone(report);mountedPath.checks.find(check=>check.id==='brokerCredentialBoundary')!.evidence['secretsMounted']=['/run/secrets/runtime_database_url'];
 expect(problems(mountedPath)).toContain('secretMountRecordedAsPath');
 const value=structuredClone(report);value.services['api']!.envNames=['DINGTALK_CLIENT_SECRET_FILE=stored-value'];
 expect(problems(value)).toEqual(expect.arrayContaining(['envValueRecorded:api:DINGTALK_CLIENT_SECRET_FILE=stored-value']));
 const dropped=structuredClone(report);dropped.checks.pop();
 expect(problems(dropped)).toContain('checkIds');
 const dishonest=structuredClone(report);dishonest.limitations['liveAcceptance']='Deployment verified end to end.';
 expect(problems(dishonest)).toContain('liveAcceptanceLimitation');
 const silent=structuredClone(report);silent.limitations['secretHandling']='';
 expect(problems(silent)).toContain('secretHandlingLimitation');
});
