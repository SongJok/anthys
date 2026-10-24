import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const root=join(import.meta.dirname,'../..'),hex=/^[a-f0-9]{64}$/;
const e2ePath='reports/e2e-full-20261023.json',offlinePath='reports/offline-browser-bundles-20261023.json',specializedPath='reports/specialized-browser-20261023.json';
type Stats={startTime:string;duration:number;expected:number;skipped:number;unexpected:number;flaky:number};
type Raw={sha256:string;stats:Stats|null};
type Reference={path:string;sha256:string};
type Run={expected:number;unexpected:number;skipped:number;flaky:number;durationMs:number;startTime?:string};
type Suite=Run&{report:Reference;projects?:string[]};
type SkipSuite=Suite&{skipReasons:Record<string,{count:number;requires:string;exercisedBy:string}>;skipAnnotations:Record<string,number>};
type E2E={schemaVersion:number;case:string;status:string;live:boolean;suites:{main:SkipSuite;personaExplanation:Suite};bundleEvidence:{path:string};disclosure:string};
type Bundle={command:string;flow:{passed:number;failed:number;skipped:number};browser:{passed:number;failed:number;skipped:number;flaky:number;durationMs:number};closesE2ESkips:{spec:string;projectScopedSkips:number}};
type Offline={schemaVersion:number;case:string;status:string;live:boolean;runner:{backendOrDatabaseStarted:boolean;realProviderCalls:number};bundles:Record<string,Bundle>;totals:{flow:{passed:number};browser:{passed:number};tests:number;projectScopedE2ESkipsExplained:number};files:Record<string,string>;disclosure:string};
type Config=Run&{config:string;report:Reference};
type Specialized={schemaVersion:number;case:string;status:string;live:boolean;configs:Record<string,Config>;totals:{expected:number;unexpected:number;skipped:number;flaky:number};disclosure:string};

async function load(path:string):Promise<Raw>{
 const content=await readFile(join(root,path)),sha256=createHash('sha256').update(content).digest('hex');
 if(!path.endsWith('.json'))return {sha256,stats:null};
 const parsed=JSON.parse(content.toString('utf8')) as {stats?:Partial<Stats>},stats=parsed.stats;
 return {sha256,stats:stats&&typeof stats.expected==='number'&&typeof stats.duration==='number'?stats as Stats:null};
}
async function json<T>(path:string):Promise<T>{return JSON.parse(await readFile(join(root,path),'utf8')) as T;}
async function evidence(){
 const e2e=await json<E2E>(e2ePath),offline=await json<Offline>(offlinePath),specialized=await json<Specialized>(specializedPath);
 const paths=new Set<string>([e2e.suites.main.report.path,e2e.suites.personaExplanation.report.path,...Object.keys(offline.files),...Object.values(specialized.configs).map(config=>config.report.path)]);
 const raws=new Map<string,Raw>();
 for(const path of paths)raws.set(path,await load(path));
 return {e2e,offline,specialized,raws};
}

// Every headline number in the three summaries must be reproducible from a committed raw
// report, digest, or sibling summary; otherwise a hand-edited PASS survives all other tests.
function problems(e2e:E2E,offline:Offline,specialized:Specialized,raws:Map<string,Raw>):string[]{
 const found:string[]=[],near=(a:number,b:number)=>Math.abs(a-b)<0.01;
 const audit=(label:string,ref:Reference,run:Run)=>{
  if(!hex.test(ref.sha256))found.push(label+':digestFormat');
  const raw=raws.get(ref.path);
  if(!raw){found.push(label+':missingReport');return;}
  if(raw.sha256!==ref.sha256)found.push(label+':digestMismatch');
  if(!raw.stats){found.push(label+':rawStatsMissing');return;}
  for(const key of ['expected','unexpected','skipped','flaky'] as const)if(raw.stats[key]!==run[key])found.push(label+':stats'+key[0]!.toUpperCase()+key.slice(1));
  if(!near(raw.stats.duration,run.durationMs))found.push(label+':statsDuration');
  if(run.startTime!==undefined&&raw.stats.startTime!==run.startTime)found.push(label+':statsStartTime');
 };
 if(e2e.schemaVersion!==1||e2e.case!=='BROWSER_E2E_FULL'||e2e.status!=='PASS')found.push('e2e.header');
 if(e2e.live!==false)found.push('e2e.live');
 const main=e2e.suites.main,persona=e2e.suites.personaExplanation,bundles=Object.entries(offline.bundles);
 if(main.projects?.join(',')!=='desktop,mobile')found.push('e2e.projects');
 audit('e2e.main',main.report,main);audit('e2e.persona',persona.report,persona);
 const reasons=Object.entries(main.skipReasons??{}),reasonTotal=reasons.reduce((sum,[,reason])=>sum+reason.count,0);
 if(reasonTotal!==main.skipped)found.push('e2e.skipReasonTotal');
 if(Object.values(main.skipAnnotations??{}).reduce((sum,count)=>sum+count,0)!==main.skipped)found.push('e2e.skipAnnotationTotal');
 for(const [spec,reason] of reasons){
  const bundle=bundles.find(([,value])=>value.closesE2ESkips.spec.endsWith('/'+spec));
  if(!bundle){found.push('e2e.unexplainedSkip:'+spec);continue;}
  if(bundle[1].closesE2ESkips.projectScopedSkips!==reason.count)found.push('e2e.skipCountMismatch:'+spec);
  if(!bundle[1].command.includes(reason.exercisedBy.split(' ')[0]!))found.push('e2e.exercisedByUnlinked:'+spec);
 }
 if(e2e.bundleEvidence.path!==offlinePath)found.push('e2e.bundleEvidence');
 for(const required of ['BLOCKED_EXTERNAL','NOT_RUN','IN_PROGRESS'])if(!e2e.disclosure.includes(required))found.push('e2e.disclosure:'+required);
 if(!/not counted as browser validation/.test(e2e.disclosure))found.push('e2e.skipsNotDisclaimed');
 if(offline.schemaVersion!==1||offline.case!=='OFFLINE_BROWSER_BUNDLES'||offline.status!=='PASS')found.push('offline.header');
 if(offline.live!==false)found.push('offline.live');
 if(offline.runner.backendOrDatabaseStarted!==false||offline.runner.realProviderCalls!==0)found.push('offline.runner');
 if(bundles.length!==4)found.push('offline.bundleCount');
 let browser=0,flow=0,covered=0;
 for(const [name,bundle] of bundles){
  browser+=bundle.browser.passed;flow+=bundle.flow.passed;covered+=bundle.closesE2ESkips.projectScopedSkips;
  if(bundle.browser.failed||bundle.browser.skipped||bundle.browser.flaky||bundle.flow.failed||bundle.flow.skipped)found.push('offline.bundleNotClean:'+name);
  if(!bundle.command.startsWith('node --import ./scripts/test-network-guard.mjs '))found.push('offline.unGuarded:'+name);
 }
 if(browser!==offline.totals.browser.passed)found.push('offline.browserTotal');
 if(flow!==offline.totals.flow.passed)found.push('offline.flowTotal');
 if(offline.totals.tests!==browser+flow)found.push('offline.testTotal');
 if(covered!==offline.totals.projectScopedE2ESkipsExplained||covered!==main.skipped)found.push('offline.skipCoverage');
 for(const [path,sha] of Object.entries(offline.files)){
  if(!hex.test(sha))found.push('offline.digestFormat:'+path);
  const raw=raws.get(path);
  if(!raw){found.push('offline.missingFile:'+path);continue;}
  if(raw.sha256!==sha)found.push('offline.digestMismatch:'+path);
 }
 for(const required of ['NOT_RUN','IN_PROGRESS'])if(!offline.disclosure.includes(required))found.push('offline.disclosure:'+required);
 if(specialized.schemaVersion!==1||specialized.case!=='SPECIALIZED_BROWSER_CONFIGS'||specialized.status!=='PASS')found.push('specialized.header');
 if(specialized.live!==false)found.push('specialized.live');
 const configs=Object.entries(specialized.configs);
 if(configs.length!==8)found.push('specialized.configCount');
 let expected=0,skipped=0;
 for(const [name,config] of configs){
  expected+=config.expected;skipped+=config.skipped;
  if(!config.config.startsWith('tests/browser/')||!config.config.endsWith('.config.ts'))found.push('specialized.configPath:'+name);
  if(config.unexpected||config.flaky)found.push('specialized.notClean:'+name);
  audit('specialized.'+name,config.report,config);
 }
 if(expected!==specialized.totals.expected)found.push('specialized.expectedTotal');
 if(skipped!==specialized.totals.skipped)found.push('specialized.skippedTotal');
 for(const required of ['NOT_RUN','IN_PROGRESS'])if(!specialized.disclosure.includes(required))found.push('specialized.disclosure:'+required);
 return found;
}

it('every committed browser summary is backed by its committed raw report, config and script digests',async()=>{
 const {e2e,offline,specialized,raws}=await evidence();
 expect(problems(e2e,offline,specialized,raws)).toEqual([]);
 expect({e2e:Object.values(e2e.suites).reduce((sum,suite)=>sum+suite.expected,0),offline:offline.totals.tests,explained:offline.totals.projectScopedE2ESkipsExplained,specialized:specialized.totals.expected}).toEqual({e2e:60,offline:170,explained:230,specialized:55});
});
it('the browser evidence guard rejects a tampered digest, statistic, skip mapping or honesty claim',async()=>{
 const {e2e,offline,specialized,raws}=await evidence(),audit=problems;
 const edited=structuredClone(e2e);edited.suites.main.report.sha256='0'.repeat(64);
 expect(audit(edited,offline,specialized,raws)).toContain('e2e.main:digestMismatch');
 const counted=structuredClone(e2e);counted.suites.main.expected=59;
 expect(audit(counted,offline,specialized,raws)).toContain('e2e.main:statsExpected');
 const skipped=structuredClone(e2e);skipped.suites.main.skipReasons['data-result.spec.ts']!.count=19;
 expect(audit(skipped,offline,specialized,raws)).toEqual(expect.arrayContaining(['e2e.skipReasonTotal','e2e.skipCountMismatch:data-result.spec.ts']));
 const absent=structuredClone(e2e),moved=absent.suites.main.skipReasons['control-readback.spec.ts']!;
 delete absent.suites.main.skipReasons['control-readback.spec.ts'];absent.suites.main.skipReasons['absent.spec.ts']=moved;
 expect(audit(absent,offline,specialized,raws)).toContain('e2e.unexplainedSkip:absent.spec.ts');
 const live=structuredClone(e2e);live.live=true;
 expect(audit(live,offline,specialized,raws)).toContain('e2e.live');
 const claimed=structuredClone(e2e);claimed.disclosure='All browser validation is complete.';
 expect(audit(claimed,offline,specialized,raws)).toEqual(expect.arrayContaining(['e2e.disclosure:BLOCKED_EXTERNAL','e2e.skipsNotDisclaimed']));
 const total=structuredClone(offline);total.totals.browser.passed+=1;
 expect(audit(e2e,total,specialized,raws)).toContain('offline.browserTotal');
 const unguarded=structuredClone(offline);unguarded.bundles['data-result']!.command='node scripts/test-data-result.mjs';
 expect(audit(e2e,unguarded,specialized,raws)).toContain('offline.unGuarded:data-result');
 const fileDigest=structuredClone(offline);fileDigest.files['scripts/test-data-result.mjs']='0'.repeat(64);
 expect(audit(e2e,fileDigest,specialized,raws)).toContain('offline.digestMismatch:scripts/test-data-result.mjs');
 const coverage=structuredClone(offline);coverage.bundles['data-result']!.closesE2ESkips.projectScopedSkips=17;
 expect(audit(e2e,coverage,specialized,raws)).toEqual(expect.arrayContaining(['offline.skipCoverage','e2e.skipCountMismatch:data-result.spec.ts']));
 const configTotal=structuredClone(specialized);configTotal.configs['artifacts']!.expected=9;
 expect(audit(e2e,offline,configTotal,raws)).toEqual(expect.arrayContaining(['specialized.expectedTotal','specialized.artifacts:statsExpected']));
 const configLive=structuredClone(specialized);configLive.live=true;
 expect(audit(e2e,offline,configLive,raws)).toContain('specialized.live');
});
