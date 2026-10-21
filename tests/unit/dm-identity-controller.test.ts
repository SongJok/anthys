import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,readdir,readFile,writeFile,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureDmIdentityDiagnostic} from '../../packages/dingtalk/src/dm-identity-controller.js';
import {writeDmIdentityDiagnostic} from '../../packages/dingtalk/src/dm-identity-file.js';
import type {DmCaptureTransport} from '../../packages/dingtalk/src/dm-metadata-controller.js';
const identity={corpId:'SYNTHETIC_CORP',staffId:'SYNTHETIC_SELF',robotCode:'SYNTHETIC_ROBOT'},nonce='a'.repeat(32),roots:string[]=[];
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'oa-identity-controller-')));roots.push(root);return {root,outputFile:join(root,'identity.json')};}
function observation(patch:Record<string,unknown>={}){return {schemaVersion:1,type:'UNTRUSTED_IDENTITY_DIAGNOSTIC',trusted:false,chatbotCorpId:'FOREIGN_CORP_CANARY',senderCorpId:identity.corpId,senderStaffId:identity.staffId,robotCode:identity.robotCode,providerTime:Date.now(),capturedAt:new Date().toISOString(),nonceHash:createHash('sha256').update(nonce).digest('hex'),chatbotCorpMatchesConfigured:false,senderCorpMatchesConfigured:true,sdkVersion:'2.1.5',...patch};}
class Transport implements DmCaptureTransport{identityDiagnosticMode=true;starts=0;alive=false;send:(v:unknown)=>void=()=>{};start(_i:unknown,send:(v:unknown)=>void,_fail:()=>void,ready?:()=>void){this.starts++;this.alive=true;this.send=send;ready?.();}async stop(){this.alive=false;}}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('a transport factory that drops explicit diagnostic mode cannot start or accidentally ACK a normal capture',async()=>{
 const f=await fixture(),transport=new Transport();transport.identityDiagnosticMode=false;await expect(captureDmIdentityDiagnostic({identity,nonce,...f,transport})).rejects.toMatchObject({code:'DM_CAPTURE_DIAGNOSTIC_TRANSPORT_REQUIRED'});expect(transport.starts).toBe(0);expect(await readdir(f.root)).toEqual([]);
});
it('waits for actual stop completion before a private untrusted file is written, then ignores duplicate observations',async()=>{
 const f=await fixture(),transport=new Transport();let release!:()=>void;const stopped=new Promise<void>(resolve=>{release=resolve;});transport.stop=async()=>{await stopped;transport.alive=false;};const p=captureDmIdentityDiagnostic({identity,nonce,...f,transport,windowMs:3000});await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(observation());expect(await readdir(f.root)).toEqual([]);transport.send(observation({chatbotCorpId:'SECOND_VALUE_MUST_NOT_REPLACE'}));release();const result=await p;expect(transport.alive).toBe(false);expect(result.observation.chatbotCorpId).toBe('FOREIGN_CORP_CANARY');expect(JSON.parse(await readFile(f.outputFile,'utf8'))).toEqual(result.observation);expect((await lstat(f.outputFile)).mode&0o777).toBe(0o600);expect((await lstat(f.root)).mode&0o777).toBe(0o700);
});
it.each([{senderStaffId:'OTHER'},{robotCode:'OTHER'},{nonceHash:'b'.repeat(64)},{providerTime:Date.now()-10000},{capturedAt:'2000-01-01T00:00:00.000Z'},{chatbotCorpMatchesConfigured:true},{senderCorpMatchesConfigured:false},{trusted:true},{content:'PRIVATE_CANARY'}])('parent rejects independent IPC projection tampering %# without creating a file',async patch=>{
 const f=await fixture(),transport=new Transport(),pending=captureDmIdentityDiagnostic({identity,nonce,...f,transport}),seen=pending.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(observation(patch));expect(await seen).toMatchObject({code:'DM_IDENTITY_DIAGNOSTIC_INVALID'});expect(await readdir(f.root)).toEqual([]);expect(transport.alive).toBe(false);
});
it('nooverwrite and private directory preflight reject before starting any transport',async()=>{
 const f=await fixture(),transport=new Transport();await writeFile(f.outputFile,'ORIGINAL',{mode:0o600});await expect(captureDmIdentityDiagnostic({identity,nonce,...f,transport})).rejects.toMatchObject({code:'DM_CAPTURE_OUTPUT_EXISTS'});expect(await readFile(f.outputFile,'utf8')).toBe('ORIGINAL');expect(transport.starts).toBe(0);await rm(f.outputFile);await chmod(f.root,0o755);await expect(captureDmIdentityDiagnostic({identity,nonce,...f,transport})).rejects.toMatchObject({code:'DM_CAPTURE_PRIVATE_DIRECTORY_REQUIRED'});expect(transport.starts).toBe(0);
});
it('writer cannot overwrite and cannot write normal metadata or body-bearing schemas',async()=>{
 const f=await fixture();await writeDmIdentityDiagnostic(f.outputFile,observation());await expect(writeDmIdentityDiagnostic(f.outputFile,observation({chatbotCorpId:'OTHER'}))).rejects.toMatchObject({code:'DM_CAPTURE_OUTPUT_EXISTS'});expect(JSON.parse(await readFile(f.outputFile,'utf8')).chatbotCorpId).toBe('FOREIGN_CORP_CANARY');expect((await readdir(f.root))).toEqual(['identity.json']);await expect(writeDmIdentityDiagnostic(join(f.root,'bad.json'),{...observation(),sessionWebhook:'PRIVATE_URL'})).rejects.toMatchObject({code:'DM_IDENTITY_DIAGNOSTIC_INVALID'});
});
it('timeout, abort and hanging stop never create raw identity evidence after cancellation',async()=>{
 for(const mode of ['timeout','abort','stop'] as const){const f=await fixture(),transport=new Transport(),controller=new AbortController();if(mode==='stop')transport.stop=()=>new Promise<void>(()=>{});const p=captureDmIdentityDiagnostic({identity,nonce,...f,transport,windowMs:120,signal:controller.signal}),seen=p.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));if(mode==='abort')controller.abort();if(mode==='stop')transport.send(observation());expect(await seen).toMatchObject({code:mode==='stop'?'DM_CAPTURE_STOP_FAILED':mode==='abort'?'DM_CAPTURE_ABORTED':'DM_CAPTURE_TIMEOUT'});transport.send(observation());expect(await readdir(f.root)).toEqual([]);}
});
