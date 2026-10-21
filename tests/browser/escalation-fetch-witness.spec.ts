import {test,expect,type Page} from '@playwright/test';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {installEscalationFetchWitness,type EscalationFetchWitness} from '../support/escalation-fetch-witness.js';

const origin='http://127.0.0.1:64702',group='SYNTHETIC witness group/%',prefix='/api/v1/groups/'+encodeURIComponent(group)+'/case-escalations/';
const requests:{path:string;method:string}[]=[],timers=new Set<ReturnType<typeof setTimeout>>();
const modes=new Map<string,'INVALID_JSON'|'OVERSIZE'|'LATE_HEADERS'|'SPLIT_DEADLINE'>();
const server=createServer((req,res)=>{
 const path=req.url??'',method=req.method??'';
 if(!path.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>SYNTHETIC fetch witness contract</title><script>window.syntheticUnhandled=[];addEventListener("unhandledrejection",e=>window.syntheticUnhandled.push(String(e.reason)))</script>');return;}
 if(requests.length>=128){res.writeHead(503);res.end();return;}requests.push({path,method});res.setHeader('content-type','application/json');
 const mode=modes.get(path);
 if(mode==='INVALID_JSON'){res.end('SYNTHETIC_NOT_JSON');return;}
 if(mode==='OVERSIZE'){res.end(JSON.stringify({data:'SYNTHETIC_'+ 'x'.repeat(2048)}));return;}
 const later=(fn:()=>void,ms:number)=>{const timer=setTimeout(()=>{timers.delete(timer);if(!res.destroyed)fn();},ms);timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});};
 if(mode==='LATE_HEADERS'){later(()=>res.end('{"data":"SYNTHETIC_LATE_HEADERS"}'),180);return;}
 if(mode==='SPLIT_DEADLINE'){later(()=>{res.write('{"data":"');later(()=>res.end('SYNTHETIC_SPLIT_DEADLINE"}'),80);},80);return;}
 res.end(JSON.stringify({data:{kind:method==='GET'?'READ':path.endsWith('/cancel')?'CANCELLED_LOCAL':'QUEUED'}}));
});
function count(path:string,method:string){return requests.filter(r=>r.path===path&&r.method===method).length;}
function path(suffix=''){return prefix+randomUUID()+suffix;}
async function setup(page:Page,options:{timeoutMs?:number;maxBodyBytes?:number}={}){
 const witness=await installEscalationFetchWitness(page,{origin,group,timeoutMs:options.timeoutMs??12000,maxBodyBytes:options.maxBodyBytes??512});await page.goto(origin);return witness;
}
async function appFetch(page:Page,path:string,method:'GET'|'POST'='GET'){
 return page.evaluate(async({path,method})=>{const response=await fetch(path,{method});return {status:response.status,text:await response.text()};},{path,method});
}
async function unchangedApplicationErrors(page:Page){expect(await page.evaluate(()=>Reflect.get(window,'syntheticUnhandled'))).toEqual([]);}
async function assertWitnessError(witness:EscalationFetchWitness,query:Parameters<EscalationFetchWitness['read']>[0],code:string){await expect(witness.read(query)).rejects.toThrow(new RegExp('^'+code+'$'));}

test.describe('native escalation fetch witness contract, real local HTTP only',()=>{
 test.describe.configure({mode:'serial',timeout:30000,retries:0});
 test.beforeAll(async()=>{await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(64702,'127.0.0.1',()=>{server.off('error',reject);done();});});});
 test.afterAll(async()=>{for(const timer of timers)clearTimeout(timer);timers.clear();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));});
 for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
  test(`preserves original Promise/Response and exactly one normal confirm/read/cancel at ${viewport.width}`,async({page})=>{
   await page.setViewportSize(viewport);const witness=await setup(page),proposal=path();
   try{
    const confirm=proposal+'/confirm',seq=await witness.sequence();
    const actual=await page.evaluate(async target=>{
     const originalThen=Promise.prototype.then;let capturedPromise:unknown,capturedResponse:unknown;
     // Observe the original promise at its first attached observer. No HTTP or
     // response is replaced, and the native method is restored in finally.
     Object.defineProperty(Promise.prototype,'then',{configurable:true,writable:true,value:function(this:Promise<unknown>,onFulfilled:unknown,onRejected:unknown){
      if(capturedPromise===undefined){capturedPromise=Promise.resolve(this);const callback=typeof onFulfilled==='function'?function(this:unknown,...args:unknown[]){capturedResponse=args[0];return Reflect.apply(onFulfilled,this,args);}:onFulfilled;return Reflect.apply(originalThen,this,[callback,onRejected]);}
      return Reflect.apply(originalThen,this,[onFulfilled,onRejected]);
     }});
     try{const returned=fetch(target,{method:'POST'}),response=await returned,unusedBeforeAppRead=!response.bodyUsed,text=await response.text();return {samePromise:returned===capturedPromise,sameResponse:response===capturedResponse,unusedBeforeAppRead,status:response.status,text};}
     finally{Object.defineProperty(Promise.prototype,'then',{configurable:true,writable:true,value:originalThen});}
    },confirm);
    expect(actual).toMatchObject({samePromise:true,sameResponse:true,unusedBeforeAppRead:true,status:200});const observed=await witness.read({afterSequence:seq,method:'POST',path:confirm});expect(observed).toMatchObject({url:origin+confirm,status:actual.status,body:JSON.parse(actual.text)});expect(count(confirm,'POST')).toBe(1);
    for(const [method,suffix] of [['GET',''],['POST','/cancel']] as const){const target=proposal+suffix,afterSequence=await witness.sequence(),response=await appFetch(page,target,method);expect(await witness.read({afterSequence,method,path:target})).toMatchObject({url:origin+target,status:response.status,body:JSON.parse(response.text)});expect(count(target,method)).toBe(1);}
    const before=await witness.sequence();await appFetch(page,'/api/v1/groups/OTHER_SYNTHETIC_GROUP/case-escalations/'+randomUUID());await appFetch(page,prefix+'preview','POST');expect(await witness.sequence()).toBe(before);await unchangedApplicationErrors(page);
   }finally{await witness.dispose();}
  });
 }
 for(const [mode,code] of [['INVALID_JSON','ESCALATION_WITNESS_BODY_INVALID'],['OVERSIZE','ESCALATION_WITNESS_BODY_LIMIT']] as const){
  test(`explicitly rejects ${mode} while the actual application response remains readable`,async({page})=>{
   const target=path('/cancel');modes.set(target,mode);const witness=await setup(page,{maxBodyBytes:128});try{const afterSequence=await witness.sequence(),actual=await appFetch(page,target,'POST');expect(actual.status).toBe(200);expect(actual.text).toContain('SYNTHETIC');await assertWitnessError(witness,{afterSequence,method:'POST',path:target},code);expect(count(target,'POST')).toBe(1);await unchangedApplicationErrors(page);}finally{await witness.dispose();}
  });
 }
 for(const mode of ['LATE_HEADERS','SPLIT_DEADLINE'] as const){
  test(`${mode} uses one deadline from fetch invocation and does not abort the original request`,async({page})=>{
   const target=path('/cancel');modes.set(target,mode);const witness=await setup(page,{timeoutMs:120});try{const afterSequence=await witness.sequence(),actual=await appFetch(page,target,'POST');expect(actual).toMatchObject({status:200});expect(JSON.parse(actual.text).data).toBe('SYNTHETIC_'+mode);await assertWitnessError(witness,{afterSequence,method:'POST',path:target},'ESCALATION_WITNESS_TIMEOUT');expect(count(target,'POST')).toBe(1);await unchangedApplicationErrors(page);}finally{await witness.dispose();}
  });
 }
 test('rejects duplicate exact correlations without replaying either request',async({page})=>{
  const target=path('/confirm'),witness=await setup(page);try{const afterSequence=await witness.sequence();await appFetch(page,target,'POST');await appFetch(page,target,'POST');await assertWitnessError(witness,{afterSequence,method:'POST',path:target},'ESCALATION_WITNESS_AMBIGUOUS');expect(count(target,'POST')).toBe(2);await unchangedApplicationErrors(page);}finally{await witness.dispose();}
 });
 test('rejects a new document instead of using a stale request sequence',async({page})=>{
  const target=path(),witness=await setup(page);try{const afterSequence=await witness.sequence();await page.goto(origin+'/?SYNTHETIC_NEW_DOCUMENT');await assertWitnessError(witness,{afterSequence,method:'GET',path:target},'ESCALATION_WITNESS_CONTEXT_CHANGED');expect(count(target,'GET')).toBe(0);}finally{await witness.dispose();}
 });
 test('bounded missing-match wait performs no request',async({page})=>{
  const target=path(),witness=await setup(page);try{const afterSequence=await witness.sequence();await assertWitnessError(witness,{afterSequence,method:'GET',path:target,timeoutMs:50},'ESCALATION_WITNESS_WAIT_OR_CONTEXT_FAILED');expect(count(target,'GET')).toBe(0);}finally{await witness.dispose();}
 });
 test('record overflow fails observation without resending or suppressing application fetches',async({page})=>{
  const target=path('/confirm'),witness=await setup(page);try{const afterSequence=await witness.sequence();for(let i=0;i<33;i++)expect((await appFetch(page,target,'POST')).status).toBe(200);await assertWitnessError(witness,{afterSequence,method:'POST',path:target},'ESCALATION_WITNESS_RECORD_LIMIT');expect(count(target,'POST')).toBe(33);await unchangedApplicationErrors(page);}finally{await witness.dispose();}
 });
 test('dispose is idempotent, restores native fetch and removes future navigation injection',async({page})=>{
  const witness=await setup(page);await witness.sequence();try{await witness.dispose();await witness.dispose();expect(await page.evaluate(()=>String(window.fetch).includes('[native code]'))).toBe(true);expect(await page.evaluate(()=>Object.getOwnPropertyNames(window).filter(k=>k.startsWith('__oaEscalationWitness_')))).toEqual([]);await page.goto(origin+'/?SYNTHETIC_DISPOSED');expect(await page.evaluate(()=>String(window.fetch).includes('[native code]'))).toBe(true);await expect(witness.sequence()).rejects.toThrow('ESCALATION_WITNESS_DISPOSED');await unchangedApplicationErrors(page);}finally{await witness.dispose();}
 });
});
