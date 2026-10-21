import {afterEach,beforeEach,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {chmod,link,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {finitePrivatePilotFingerprint} from '../../packages/config/src/finite-private-pilot.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';

const root=resolve(import.meta.dirname,'../..'),script=join(root,'scripts/finite-private-pilot.ts');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const manifest=randomUUID(),descriptor='9'.repeat(64);
// All connect attempts remain blocked, including separately recorded exact-parent-PID tsx IPC.
// Child never inherits VITEST/OA_TEST_ISOLATED, so observing zero env loads
// proves the branch stayed before loadEnvFile rather than its test-mode bypass.
const preload=String.raw`import fs from 'node:fs';
import fsp from 'node:fs/promises';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const audit={envLoads:0,connections:0,fetches:0,opens:[],blockedToolingIpc:0};
process.loadEnvFile=()=>{audit.envLoads++;throw Error('SYNTHETIC_ENV_LOADING_FORBIDDEN');};
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const ownPipe='/tmp/tsx-'+process.getuid()+'/'+process.ppid+'.pipe';if(first&&typeof first==='object'&&first.path===ownPipe)audit.blockedToolingIpc++;else audit.connections++;throw Error('SYNTHETIC_CONNECTION_FORBIDDEN');};
globalThis.fetch=async()=>{audit.fetches++;throw Error('SYNTHETIC_FETCH_FORBIDDEN');};
const open=fsp.open;fsp.open=async function(path,...rest){audit.opens.push(String(path));return open.call(this,path,...rest);};
syncBuiltinESMExports();process.on('exit',()=>fs.writeFileSync(process.env['SYNTHETIC_CLI_AUDIT'],JSON.stringify(audit),{mode:0o600}));`;
let directory:string,profilePath:string,formalPath:string,preloadPath:string;
let pair:ReturnType<typeof documents>;
function documents(formalPatch:Record<string,unknown>={},pilotPatch:Record<string,unknown>={}){
 const now=Date.now(),validFrom=new Date(now-30_000).toISOString(),expiresAt=new Date(now+600_000).toISOString();
 const formal=formalProfileFingerprint({schemaVersion:1,authorizationId:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),sourceTrialProfileHash:'a'.repeat(64),corpId:'SYNTHETIC_CORP',externalUserId:'SYNTHETIC_OWNER',robotCode:'SYNTHETIC_ROBOT',conversationId:'SYNTHETIC_ORIGINAL_DM',validFrom:new Date(now-60_000).toISOString(),validUntil:new Date(now+1_200_000).toISOString(),budgetPolicyHash:'b'.repeat(64),approvalReference:'SYNTHETIC_FORMAL_REVIEW',modelAllowed:true,modelApprovalReference:'SYNTHETIC_MODEL_REVIEW',entrypoints:['INGRESS','WORKER','NOTIFIER','API'],inputPolicy:{attachments:false,controls:false},capabilities:[{id:'company.agent.ask',version:'1.0.0',bindingHash:'c'.repeat(64)}],...formalPatch});
 const f=formal.profile,pilot=finitePrivatePilotFingerprint({schemaVersion:1,purpose:'FINITE_PRIVATE_ENTERPRISE_PILOT',approved:true,id:randomUUID(),tenantId:f.tenantId,actorId:f.actorId,sourceTrialProfileHash:f.sourceTrialProfileHash,formalAuthorizationId:f.authorizationId,formalProfileHash:formal.hash,corpId:'SYNTHETIC_CORP',externalUserId:'SYNTHETIC_OWNER',robotCode:'SYNTHETIC_ROBOT',conversationId:'SYNTHETIC_ORIGINAL_DM',questionHash:'d'.repeat(64),companyPolicyHash:'e'.repeat(64),enterpriseBudgetHash:'f'.repeat(64),enterpriseUpstreamHash:'1'.repeat(64),budgetPolicyHash:f.budgetPolicyHash,enterpriseResourceId:'enterprise-agent:'+randomUUID(),validFrom,expiresAt,maxModelRequests:4,maxEnterpriseRequests:1,maxPhysicalMessages:1,finalOnly:true,enterpriseWaitMs:60000,modelCurrency:'CNY',modelMaxAmountMinor:100,reviewReference:'SYNTHETIC_FINITE_REVIEW',modelApprovalReference:f.modelApprovalReference,sourceReviewHash:'2'.repeat(64),enterpriseApprovalReference:'SYNTHETIC_ENTERPRISE_REVIEW',enterpriseCost:{kind:'FIXED_INTERNAL',currency:'CNY',maxAmountMinor:0,reviewReference:'SYNTHETIC_USER_COMPANY_COVERED',upstreamReviewHash:'3'.repeat(64)},...pilotPatch});
 return {formal,pilot};
}
async function writePair(value=pair){pair=value;await writeFile(profilePath,pair.pilot.serialized,{mode:0o600});await writeFile(formalPath,pair.formal.serialized,{mode:0o600});}
beforeEach(async()=>{
 directory=await realpath(await mkdtemp(join(tmpdir(),'oa-finite-cli-')));await chmod(directory,0o700);profilePath=join(directory,'pilot.json');formalPath=join(directory,'formal.json');preloadPath=join(directory,'observe.mjs');
 pair=documents();await writePair();await writeFile(preloadPath,preload,{mode:0o600});await writeFile(join(directory,'.env'),'SYNTHETIC_PRIVATE_SENTINEL=must_not_load_or_echo\n',{mode:0o600});
});
afterEach(async()=>{await chmod(directory,0o700);await rm(directory,{recursive:true,force:true});});
const flags=(manifestId:string=manifest,descriptorHash:string=descriptor)=>['--profile',profilePath,'--formal-profile',formalPath,'--manifest-id',manifestId,'--descriptor-hash',descriptorHash];
function planHash(manifestId:string=manifest,descriptorHash:string=descriptor){
 const plan={schemaVersion:1,purpose:'FINITE_PRIVATE_PILOT_INSTALL',profileHash:pair.pilot.hash,pilotKey:pair.pilot.pilotKey,formalProfileHash:pair.formal.hash,manifestId,descriptorHash,sourceSchemaHash:requiredSchema.contractHash};
 return digest('{'+Object.entries(plan).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+JSON.stringify(v)).join(',')+'}');
}
async function cli(args:string[]){
 const auditPath=join(directory,'audit-'+randomUUID()+'.json');
 const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
  const child=spawn(process.execPath,['--import',join(root,'scripts/test-network-guard.mjs'),'--import',preloadPath,'--import',join(root,'node_modules/tsx/dist/loader.mjs'),script,...args],{cwd:directory,env:{PATH:process.env['PATH']??'/usr/bin:/bin',LANG:'C.UTF-8',SYNTHETIC_CLI_AUDIT:auditPath},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('SYNTHETIC_CLI_CHILD_TIMEOUT'));},15000);
  child.stdout.on('data',chunk=>{stdout+=String(chunk);});child.stderr.on('data',chunk=>{stderr+=String(chunk);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});
 });
 const audit=JSON.parse(await readFile(auditPath,'utf8')) as {envLoads:number;connections:number;fetches:number;opens:string[]};
 expect(audit.envLoads).toBe(0);expect(audit.connections).toBe(0);expect(audit.fetches).toBe(0);
 expect(audit.opens.every(p=>p===profilePath||p===formalPath||p===join(directory,'alias.json'))).toBe(true);
 expect(result.stdout+result.stderr).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');expect(result.stdout+result.stderr).not.toContain(directory);
 return {...result,audit};
}
async function refused(args:string[],code?:string){const result=await cli(args);expect(result.code).toBe(1);expect(result.stdout).toBe('');const value=JSON.parse(result.stderr) as Record<string,unknown>;expect(value).toMatchObject({status:'NOT_CONFIRMED',automaticRetry:false});expect(value['code']).toMatch(/^FINITE_(?:PILOT|PRIVATE_PILOT)_[A-Z0-9_]+$/);if(code)expect(value['code']).toBe(code);return result;}
it('plan reads exactly the two private profiles and binds all install pins without environment or database loading',async()=>{
 const result=await cli(['plan',...flags()]);expect(result.code).toBe(0);expect(result.stderr).toBe('');expect(result.audit.opens).toEqual([profilePath,formalPath]);
 expect(JSON.parse(result.stdout)).toEqual({status:'PLAN_ONLY',planHash:planHash(),profileHash:pair.pilot.hash,pilotKey:pair.pilot.pilotKey,sourceSchemaHash:requiredSchema.contractHash,expiresAt:pair.pilot.document.expiresAt,maxModelRequests:4,maxEnterpriseRequests:1,maxPhysicalMessages:1,modelCurrency:'CNY',modelMaxAmountMinor:100,enterpriseCostBasis:'USER_DECLARED_COMPANY_COVERED_NO_INCREMENTAL_CHARGE',databaseAccess:false,installed:false,servicesStarted:false});
});
it('changing manifest or runtime descriptor changes the exact plan, while argument ordering does not',async()=>{
 for(const [m,d] of [[randomUUID(),descriptor],[manifest,'8'.repeat(64)]]){const result=await cli(['plan',...flags(m!,d!)]);expect(result.code).toBe(0);expect(JSON.parse(result.stdout).planHash).toBe(planHash(m!,d!));expect(JSON.parse(result.stdout).planHash).not.toBe(planHash());}
 const reversed=flags().reduce<string[][]>((a,_v,i,all)=>i%2?a:[...a,all.slice(i,i+2)],[]).reverse().flat();expect(JSON.parse((await cli(['plan',...reversed])).stdout).planHash).toBe(planHash());
});
it('changing formal bytes and rebinding the pilot changes its hash and plan without resetting pilotKey',async()=>{
 const originalPlan=planHash(),originalKey=pair.pilot.pilotKey,formal=formalProfileFingerprint({...pair.formal.profile,approvalReference:'SYNTHETIC_DIFFERENT_FORMAL_REVIEW'});
 await writePair({formal,pilot:finitePrivatePilotFingerprint({...pair.pilot.document,formalProfileHash:formal.hash})});const result=await cli(['plan',...flags()]);expect(result.code).toBe(0);expect(JSON.parse(result.stdout).planHash).toBe(planHash());expect(planHash()).not.toBe(originalPlan);expect(pair.pilot.pilotKey).toBe(originalKey);
});
it.each([['execute'],['plan','--unknown','SYNTHETIC'],['plan','--profile'],['plan','--profile','x','--profile','y'],[]].map(args=>[args]))('bad command/arity/unknown/duplicate/missing parameters reject before payload reads: %j',async args=>{const result=await refused(args);expect(result.audit.opens).toEqual([]);});
it.each([['not-uuid',descriptor],[manifest,'bad-digest']])('invalid manifest or descriptor is refused before environment loading: %j',async(m,d)=>{await refused(['plan',...flags(m,d)]);});
it('plan rejects installation flags rather than treating them as consent',async()=>{await refused(['plan',...flags(),'--expected-plan-hash',planHash(),'--review-ref',pair.pilot.document.reviewReference],'FINITE_PILOT_PLAN_ONLY');});
it.each(['missing','hash','review'] as const)('install %s pin is refused before loadEnvFile',async mode=>{
 const extra=mode==='missing'?[]:['--expected-plan-hash',mode==='hash'?'0'.repeat(64):planHash(),'--review-ref',mode==='review'?'SYNTHETIC_WRONG_REVIEW':pair.pilot.document.reviewReference];
 await refused(['install',...flags(),...extra],'FINITE_PILOT_EXACT_INSTALL_REVIEW_REQUIRED');
});
it.each(['past','future'] as const)('install %s window with otherwise exact pins is refused before environment loading',async mode=>{
 const from=mode==='past'?'2020-01-01T00:00:00.000Z':'2099-01-01T00:00:00.000Z',until=mode==='past'?'2020-01-01T00:10:00.000Z':'2099-01-01T00:10:00.000Z';
 await writePair(documents({validFrom:from,validUntil:until},{validFrom:from,expiresAt:until}));await refused(['install',...flags(),'--expected-plan-hash',planHash(),'--review-ref',pair.pilot.document.reviewReference],'FINITE_PILOT_WINDOW_INVALID');
});
it.each(['corpId','externalUserId','robotCode','conversationId'] as const)('formal %s mismatch cannot enter plan/install even with recomputed exact formal hash',async field=>{
 const formal=formalProfileFingerprint({...pair.formal.profile,[field]:'SYNTHETIC_OTHER'});await writePair({formal,pilot:finitePrivatePilotFingerprint({...pair.pilot.document,formalProfileHash:formal.hash})});await refused(['plan',...flags()],'FINITE_PILOT_FORMAL_BINDING_MISMATCH');
});
it('formal capabilities, input controls and window must remain exact private metadata',async()=>{
 const original=pair;for(const patch of [{capabilities:[]},{inputPolicy:{attachments:false,controls:true}},{validUntil:new Date(Date.now()+60_000).toISOString()}]){
  const formal=formalProfileFingerprint({...original.formal.profile,...patch});await writePair({formal,pilot:finitePrivatePilotFingerprint({...original.pilot.document,formalProfileHash:formal.hash})});await refused(['plan',...flags()],'FINITE_PILOT_FORMAL_BINDING_MISMATCH');
 }
});
it('fixed zero company-covered cost is required; alternate cost declarations are not silently accepted',async()=>{
 for(const cost of [{...pair.pilot.document.enterpriseCost,kind:'FIXED_INTERNAL',maxAmountMinor:1},{kind:'EXPLICIT_UNKNOWN_SINGLE_CALL',riskAcceptanceReference:'SYNTHETIC_OTHER_RISK',upstreamReviewHash:'3'.repeat(64)}]){
  await writePair({formal:pair.formal,pilot:finitePrivatePilotFingerprint({...pair.pilot.document,enterpriseCost:cost})});await refused(['plan',...flags()],'FINITE_PILOT_COMPANY_COVERED_COST_DECLARATION_REQUIRED');
 }
});
it('unsafe file/parent permissions, symlink and hardlink inputs cannot load environment or connect',async()=>{
 for(const path of [profilePath,formalPath]){await chmod(path,0o644);await refused(['plan',...flags()]);await chmod(path,0o600);}
 await chmod(directory,0o755);await refused(['plan',...flags()]);await chmod(directory,0o700);
 const alias=join(directory,'alias.json');await symlink(formalPath,alias);await refused(['plan','--profile',profilePath,'--formal-profile',alias,'--manifest-id',manifest,'--descriptor-hash',descriptor]);await rm(alias);await link(profilePath,alias);await refused(['plan',...flags()]);await rm(alias);
});
it('malformed/unknown payload fields fail with safe errors and never echo private content',async()=>{
 for(const bytes of ['{SYNTHETIC_PRIVATE_SENTINEL invalid',JSON.stringify({...pair.pilot.document,credential:'SYNTHETIC_PRIVATE_SENTINEL'})]){await writeFile(profilePath,bytes);await refused(['plan',...flags()]);}
});
