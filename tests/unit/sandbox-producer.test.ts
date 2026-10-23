import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import type {AnalysisJobSubject} from '../../packages/analysis/src/job-contract.js';
import type {SandboxArtifactPut,SandboxArtifactRef} from '../../packages/sandbox/src/artifacts.js';
import type {SandboxBrokerOutcome} from '../../packages/sandbox/src/broker.js';
import type {SandboxBrokerClient} from '../../packages/sandbox/src/client.js';
import {SandboxProducer} from '../../packages/sandbox/src/producer.js';
const keyId='unit-sandbox-producer',imageDigest='sha256:'+'a'.repeat(64),keys=generateKeyPairSync('ed25519');
const subject:AnalysisJobSubject={tenantId:randomUUID(),actorId:randomUUID(),authEpoch:1,taskId:randomUUID(),runId:randomUUID(),jobId:randomUUID()};
function artifacts(){
 const puts:{kind:'CODE'|'INPUT';bytes:Uint8Array}[]=[];let submitted:unknown;
 const client={
  async putArtifact(_subject:AnalysisJobSubject,artifact:SandboxArtifactPut):Promise<SandboxArtifactRef>{
   const bytes=Buffer.from(artifact.bytes);puts.push({kind:artifact.kind,bytes});
   return {id:randomUUID(),kind:artifact.kind,name:artifact.name??null,mime:artifact.mime,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,expiresAt:'2099-01-01T00:00:00.000Z'};
  },
  async submit(_subject:AnalysisJobSubject,wire:string):Promise<SandboxBrokerOutcome>{
   submitted=JSON.parse(wire);return {jobId:subject.jobId} as SandboxBrokerOutcome;
  },
 } as unknown as SandboxBrokerClient;
 return {client,puts,envelope:()=>submitted as {payload:{nonce:string;issuedAt:number;expiresAt:number;job:{codeArtifactId:string;inputArtifactIds:string[]}}}|undefined};
}
const producer=(client:SandboxBrokerClient,overrides:{nonce?:()=>string;now?:()=>number;lifetimeMs?:number}={})=>new SandboxProducer({client,keyId,privateKey:keys.privateKey,imageDigest,...overrides});
it('rejects unusable nonce or signing clock before registering any artifact',async()=>{
 const invalid=[
  {nonce:()=>{throw new Error('PRIVATE_NONCE_GENERATOR');}},
  {nonce:()=> 'not-a-nonce'},
  {nonce:()=> '123e4567-e89b-02d3-a456-426614174000'},
  {nonce:()=> new String(randomUUID()) as unknown as string},
  {now:()=> -1},
  {now:()=> Number.MAX_SAFE_INTEGER},
 ];
 for(const overrides of invalid){
  const fake=artifacts();
  await expect(producer(fake.client,overrides).execute({subject,language:'javascript',code:'void 0',allowedOutputTypes:['json']})).rejects.toMatchObject({code:'SANDBOX_PRODUCER_CONFIGURATION_INVALID'});
  expect(fake.puts).toEqual([]);
  expect(fake.envelope()).toBeUndefined();
 }
});
it('reserves one validated nonce and clock, then submits exactly that envelope once',async()=>{
 const fake=artifacts(),nonce=randomUUID(),now=1_800_000_000_000;
 const produced=await producer(fake.client,{nonce:()=>nonce,now:()=>now,lifetimeMs:5000}).execute({subject,language:'javascript',code:'void 0',inputs:[{name:'input.txt',mime:'text/plain',bytes:Buffer.from('input')}],allowedOutputTypes:['json']});
 expect(fake.puts.map(item=>item.kind)).toEqual(['CODE','INPUT']);
 expect(fake.envelope()?.payload).toMatchObject({nonce,issuedAt:now,expiresAt:now+5000});
 expect(fake.envelope()?.payload.job.codeArtifactId).toBe(produced.code.id);
 expect(fake.envelope()?.payload.job.inputArtifactIds).toEqual([produced.inputs[0]!.id]);
 expect(produced.outcome.jobId).toBe(subject.jobId);
});
it('abort wins before consuming a nonce or registering any artifact',async()=>{
 const fake=artifacts();let nonceCalls=0;const controller=new AbortController();controller.abort();
 await expect(producer(fake.client,{nonce:()=>{nonceCalls++;return randomUUID();}}).execute({subject,language:'javascript',code:'void 0',allowedOutputTypes:['json'],signal:controller.signal})).rejects.toMatchObject({code:'SANDBOX_BROKER_CLIENT_ABORTED'});
 expect(nonceCalls).toBe(0);
 expect(fake.puts).toEqual([]);
});
