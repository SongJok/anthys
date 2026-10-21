import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureDmMetadata,type DmCaptureTransport} from '../../packages/dingtalk/src/dm-metadata-controller.js';
const identity={corpId:'synthetic-corp',staffId:'synthetic-self',robotCode:'synthetic-robot'},nonce='a'.repeat(32),roots:string[]=[];
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'oa-dm-controller-')));roots.push(root);return {root,outputFile:join(root,'metadata.json')};}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function metadata(patch:Record<string,unknown>={}){const now=Date.now();return {schemaVersion:1,...identity,conversationId:'synthetic-cid',conversationType:'1',messageId:'synthetic-message',providerTime:now,capturedAt:new Date(now).toISOString(),nonceHash:createHash('sha256').update(nonce).digest('hex'),source:'DINGTALK_STREAM_ROBOT_CALLBACK',sdkVersion:'2.1.5',...patch};}
class SyntheticTransport implements DmCaptureTransport{
 starts=0;stops=0;alive=false;send:(value:unknown)=>void=()=>{};fail:()=>void=()=>{};
 start(_input:unknown,send:(value:unknown)=>void,fail:()=>void,ready?:()=>void){this.starts++;this.alive=true;this.send=send;this.fail=fail;ready?.();}
 async stop(){if(this.alive){this.stops++;this.alive=false;}}
}
it('accepts one minimum record, stops the transport before saving and ignores duplicate metadata',async()=>{
 const f=await fixture(),transport=new SyntheticTransport(),challenge:string[]=[];const pending=captureDmMetadata({identity,nonce,...f,transport,onChallenge:t=>challenge.push(t)});await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(metadata());transport.send(metadata({messageId:'duplicate'}));const result=await pending;expect(result.metadata.messageId).toBe('synthetic-message');expect(transport.stops).toBe(1);expect(transport.alive).toBe(false);expect(JSON.parse(await readFile(f.outputFile,'utf8'))).toEqual(result.metadata);expect(challenge).toEqual(['OA_BIND_DM_V1 '+nonce]);
});
it.each([{corpId:'foreign'},{staffId:'foreign'},{robotCode:'foreign'},{nonceHash:'b'.repeat(64)},{conversationType:'2'},{sessionWebhook:'SECRET'},{providerTime:Date.now()-10000}])('rejects foreign, stale or oversized transport projections %#',async patch=>{
 const f=await fixture(),transport=new SyntheticTransport(),p=captureDmMetadata({identity,nonce,...f,transport});const observed=p.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(metadata(patch));expect(await observed).toMatchObject({code:'DM_CAPTURE_METADATA_INVALID'});expect(await readdir(f.root)).toEqual([]);expect(transport.alive).toBe(false);
});
it('deadline and abort each stop the transport without accepting late metadata',async()=>{
 for(const reason of ['deadline','abort']){const f=await fixture(),transport=new SyntheticTransport(),controller=new AbortController(),p=captureDmMetadata({identity,nonce,...f,transport,windowMs:80,signal:controller.signal}),observed=p.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));if(reason==='abort')controller.abort();expect(await observed).toMatchObject({code:reason==='abort'?'DM_CAPTURE_ABORTED':'DM_CAPTURE_TIMEOUT'});transport.send(metadata());expect(await readdir(f.root)).toEqual([]);expect(transport.alive).toBe(false);}
});
it('preexisting output and an already-aborted signal cause zero transport starts',async()=>{
 const f=await fixture(),transport=new SyntheticTransport();await writeFile(f.outputFile,'original');await expect(captureDmMetadata({identity,nonce,...f,transport})).rejects.toMatchObject({code:'DM_CAPTURE_OUTPUT_EXISTS'});const controller=new AbortController();controller.abort();await expect(captureDmMetadata({identity,nonce,...f,transport,signal:controller.signal})).rejects.toMatchObject({code:'DM_CAPTURE_ABORTED'});expect(transport.starts).toBe(0);expect(await readFile(f.outputFile,'utf8')).toBe('original');
});
it('transport failures do not leak the original exception or write success metadata',async()=>{
 const f=await fixture(),transport=new SyntheticTransport();transport.start=()=>{throw Error('PRIVATE_CLIENT_SECRET=SECRET_CANARY');};const error=await captureDmMetadata({identity,nonce,...f,transport}).catch(e=>e);expect(error).toMatchObject({code:'DM_CAPTURE_TRANSPORT_FAILED'});expect(error.message).not.toContain('SECRET');expect(await readdir(f.root)).toEqual([]);
});
it('a hanging stop cannot create a proof or hang the capture controller indefinitely',async()=>{
 const f=await fixture(),transport=new SyntheticTransport();transport.stop=()=>new Promise<void>(()=>{});const pending=captureDmMetadata({identity,nonce,...f,transport,windowMs:100}),observed=pending.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(metadata());expect(await observed).toMatchObject({code:'DM_CAPTURE_STOP_FAILED'});expect(await readdir(f.root)).toEqual([]);
});
it('a thrown stop exception is replaced with a safe code and never written as successful metadata',async()=>{
 const f=await fixture(),transport=new SyntheticTransport();transport.stop=()=>{throw Error('PRIVATE_STOP_SECRET=SECRET');};const pending=captureDmMetadata({identity,nonce,...f,transport}),observed=pending.catch(e=>e);await vi.waitFor(()=>expect(transport.starts).toBe(1));transport.send(metadata());const error=await observed;expect(error).toMatchObject({code:'DM_CAPTURE_STOP_FAILED'});expect(error.message).not.toContain('SECRET');expect(await readdir(f.root)).toEqual([]);
});
