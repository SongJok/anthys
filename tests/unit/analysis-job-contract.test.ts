import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {analysisJobSchema,analysisDefaultLimits,analysisJobWireLimit,AnalysisJobError,signAnalysisJob,verifyAnalysisJob,type AnalysisJob,type AnalysisJobSubject,type AnalysisJobPayload,type AnalysisSignedJob} from '../../packages/analysis/src/job-contract.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=Date.parse('2026-10-19T00:00:00Z'),imageDigest='sha256:'+'a'.repeat(64);
const keys=generateKeyPairSync('ed25519');
function job():AnalysisJob{return {tenantId:id(1),taskId:id(2),runId:id(3),jobId:id(4),language:'typescript',codeArtifactId:id(5),inputArtifactIds:[id(6)],network:'NONE',limits:{...analysisDefaultLimits},allowedOutputTypes:['markdown','txt','csv','json','html','xlsx','docx','pdf']};}
function subject():AnalysisJobSubject{return {tenantId:id(1),actorId:id(7),authEpoch:2,taskId:id(2),runId:id(3),jobId:id(4)};}
const signing=()=>({subject:subject(),imageDigest,keyId:'synthetic-analysis-key',privateKey:keys.privateKey,nonce:id(8),issuedAt:now,expiresAt:now+60_000,now});
const verifying=()=>({expectedSubject:subject(),imageDigest,keyId:'synthetic-analysis-key',publicKey:keys.publicKey,now});
const wire=(envelope=signAnalysisJob(job(),signing()))=>JSON.stringify(envelope);
function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}
function resign(payload:AnalysisJobPayload):AnalysisSignedJob{return {keyId:verifying().keyId,payload,signature:sign(null,Buffer.from('open_aider.analysis.job.v1\0'+canonical(payload)),keys.privateKey).toString('base64url')};}

describe('analysis broker structured signed job contract (no isolation execution)',()=>{
  it('uses real Ed25519, accepts a JSON/UTF-8 wire, and freezes independent job and subject snapshots',()=>{
    const input=job(),options=signing(),signed=signAnalysisJob(input,options),accepted=verifyAnalysisJob(wire(signed),verifying());
    expect(accepted.job).toEqual(input);expect(accepted.subject).toEqual(subject());
    expect(verifyAnalysisJob(Buffer.from(wire(signed)),verifying())).toEqual(accepted);
    expect(verifyAnalysisJob(new TextEncoder().encode(wire(signed)),verifying())).toEqual(accepted);
    input.inputArtifactIds.push(id(20));options.subject.authEpoch=99;
    expect(signed.payload.job.inputArtifactIds).toEqual([id(6)]);expect(signed.payload.subject.authEpoch).toBe(2);
    for(const value of [signed,signed.payload,signed.payload.subject,signed.payload.job,signed.payload.job.limits,signed.payload.job.inputArtifactIds,accepted,accepted.job.allowedOutputTypes])expect(Object.isFrozen(value)).toBe(true);
    expect(()=>{accepted.job.limits.memoryMb=900;}).toThrow();expect(Object.isFrozen(analysisDefaultLimits)).toBe(true);
  });
  it('has documented canonical JSON semantics, deterministic signatures, and binds array order',()=>{
    const input=job(),reordered=Object.fromEntries(Object.entries(input).reverse()),a=signAnalysisJob(input,signing()),b=signAnalysisJob(reordered,signing());
    const expected='{"allowedOutputTypes":["markdown","txt","csv","json","html","xlsx","docx","pdf"],"codeArtifactId":"'+id(5)+'","inputArtifactIds":["'+id(6)+'"],"jobId":"'+id(4)+'","language":"typescript","limits":{"cpuMillis":60000,"memoryMb":512,"outputBytes":20971520,"wallMs":60000},"network":"NONE","runId":"'+id(3)+'","taskId":"'+id(2)+'","tenantId":"'+id(1)+'"}';
    expect(a.payload.jobHash).toBe(createHash('sha256').update(expected).digest('hex'));expect(a).toEqual(b);
    expect(signAnalysisJob({...input,allowedOutputTypes:[...input.allowedOutputTypes].reverse()},signing()).payload.jobHash).not.toBe(a.payload.jobHash);
  });
  it('accepts JavaScript, no input artifacts and independently reduced CPU and wall limits',()=>{
    const input={...job(),language:'javascript',inputArtifactIds:[],limits:{cpuMillis:60_000,memoryMb:1,wallMs:1,outputBytes:1},allowedOutputTypes:['txt']};
    expect(verifyAnalysisJob(wire(signAnalysisJob(input,signing())),verifying()).job).toEqual(input);
  });
  it.each(Object.keys(analysisDefaultLimits) as (keyof typeof analysisDefaultLimits)[])('rejects increased, missing, coerced or unsafe %s and accepts reductions',field=>{
    for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,analysisDefaultLimits[field]+1,'1',undefined]){
      const input=job();(input.limits as Record<string,unknown>)[field]=value;
      expect(analysisJobSchema.safeParse(input).success).toBe(false);
      expect(()=>signAnalysisJob(input,signing())).toThrow('ANALYSIS_JOB_INVALID');
    }
    expect(analysisJobSchema.safeParse({...job(),limits:{...analysisDefaultLimits,[field]:1}}).success).toBe(true);
  });
  it('rejects arbitrary execution settings and unknown keys at every job/subject/envelope level',()=>{
    for(const field of ['image','imageDigest','mount','mounts','path','env','secret','url','command','argv','dockerSocket','approved','acl','ownerId'])expect(analysisJobSchema.safeParse({...job(),[field]:'untrusted'}).success).toBe(false);
    expect(analysisJobSchema.safeParse({...job(),limits:{...analysisDefaultLimits,pids:999}}).success).toBe(false);
    expect(()=>signAnalysisJob(job(),{...signing(),subject:{...subject(),role:'admin'} as AnalysisJobSubject})).toThrow('ANALYSIS_JOB_INVALID');
    const signed=signAnalysisJob(job(),signing());
    for(const input of [{...signed,approved:true},{...signed,payload:{...signed.payload,authorized:true}},{...signed,payload:{...signed.payload,subject:{...subject(),role:'admin'}}}])expect(()=>verifyAnalysisJob(JSON.stringify(input),verifying())).toThrow('ANALYSIS_JOB_WIRE_INVALID');
  });
  it('requires explicit closed language, network, output formats, UUID references and unique bounded arrays',()=>{
    for(const change of [{language:'python'},{network:'DEFAULT'},{network:'https://internal.invalid'},{codeArtifactId:'/etc/passwd'},{inputArtifactIds:['https://internal.invalid']},{allowedOutputTypes:['exe']},{allowedOutputTypes:['md']},{allowedOutputTypes:[]},{allowedOutputTypes:['txt','txt']},{inputArtifactIds:[id(6),id(6)]},{inputArtifactIds:Array.from({length:65},(_,n)=>id(100+n))},{allowedOutputTypes:undefined}])expect(analysisJobSchema.safeParse({...job(),...change}).success).toBe(false);
    expect(analysisJobSchema.safeParse({...job(),inputArtifactIds:Array.from({length:64},(_,n)=>id(100+n))}).success).toBe(true);
    const reference='abcdef00-0000-4000-8000-000000000001';
    expect(analysisJobSchema.safeParse({...job(),inputArtifactIds:[reference,reference.toUpperCase()]}).success).toBe(false);
  });
  it('never invokes getters, toJSON or proxy traps in untrusted job/subject objects',()=>{
    let invoked=0;
    const accessor=Object.defineProperty(job(),'language',{get(){invoked++;return 'typescript';},enumerable:true});
    const toJSON={...job(),toJSON(){invoked++;return job();}};
    const proxy=new Proxy(job(),{get(){invoked++;throw Error('must not execute');},ownKeys(){invoked++;throw Error('must not execute');}});
    const inherited=Object.setPrototypeOf(job(),{get language(){invoked++;return 'typescript';}});
    const invalidSubject=Object.defineProperty(subject(),'actorId',{get(){invoked++;return id(7);},enumerable:true});
    for(const raw of [accessor,toJSON,proxy,inherited]){
      expect(analysisJobSchema.safeParse(raw).success).toBe(false);expect(()=>signAnalysisJob(raw,signing())).toThrow('ANALYSIS_JOB_INVALID');
    }
    expect(()=>signAnalysisJob(job(),{...signing(),subject:invalidSubject})).toThrow('ANALYSIS_JOB_INVALID');
    expect(()=>verifyAnalysisJob(wire(),{...verifying(),expectedSubject:invalidSubject})).toThrow('ANALYSIS_JOB_INVALID');
    expect(invoked).toBe(0);
  });
  it('rejects non-JSON structures, cyclic/deep/large values and sparse or decorated arrays without execution',()=>{
    const cycle:Record<string,unknown>={};cycle['self']=cycle;
    let deep:unknown=job();for(let n=0;n<14;n++)deep={nested:deep};
    const sparse=job();sparse.inputArtifactIds=new Array<string>(1);
    const decorated=job();Object.defineProperty(decorated.inputArtifactIds,'extra',{value:'x',enumerable:false});
    for(const raw of [undefined,null,42,()=>job(),cycle,deep,sparse,decorated,{...job(),[Symbol('secret')]:'x'},{...job(),extra:BigInt(1)},{...job(),extra:new Date()},{...job(),extra:'x'.repeat(analysisJobWireLimit+1)}])expect(()=>signAnalysisJob(raw,signing())).toThrow('ANALYSIS_JOB_INVALID');
  });
  it.each(['tenantId','taskId','runId','jobId'] as const)('requires identical signed job/subject %s and exact expected context',field=>{
    expect(()=>signAnalysisJob({...job(),[field]:id(90)},signing())).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
    expect(()=>verifyAnalysisJob(wire(),{...verifying(),expectedSubject:{...subject(),[field]:id(90)}})).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
    const signed=signAnalysisJob(job(),signing()),payload={...signed.payload,subject:{...subject(),[field]:id(90)}};
    expect(()=>verifyAnalysisJob(wire(resign(payload)),verifying())).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
  });
  it('binds actor and auth epoch independently and validates the subject',()=>{
    for(const change of [{actorId:id(90)},{authEpoch:3}])expect(()=>verifyAnalysisJob(wire(),{...verifying(),expectedSubject:{...subject(),...change}})).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
    for(const change of [{actorId:'not-a-uuid'},{authEpoch:0},{authEpoch:1.1},{authEpoch:Infinity},{authEpoch:Number.MAX_SAFE_INTEGER+1}])expect(()=>signAnalysisJob(job(),{...signing(),subject:{...subject(),...change}})).toThrow('ANALYSIS_JOB_INVALID');
  });
  it('binds every signed payload field with Ed25519 and refuses changed hashes even with a valid signature',()=>{
    const signed=signAnalysisJob(job(),signing());
    for(const change of [{nonce:id(90)},{issuedAt:now-1},{expiresAt:now+1},{jobHash:'b'.repeat(64)},{imageDigest:'sha256:'+'b'.repeat(64)},{job:{...job(),language:'javascript'}}])expect(()=>verifyAnalysisJob(JSON.stringify({...signed,payload:{...signed.payload,...change}}),verifying())).toThrow('ANALYSIS_JOB_SIGNATURE_INVALID');
    const payload={...signed.payload,jobHash:'b'.repeat(64)};
    expect(()=>verifyAnalysisJob(wire(resign(payload)),verifying())).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
    expect(()=>verifyAnalysisJob(wire(),{...verifying(),imageDigest:'sha256:'+'b'.repeat(64)})).toThrow('ANALYSIS_JOB_BINDING_MISMATCH');
  });
  it('requires valid nonce, integral instants and a positive window no longer than 60 seconds',()=>{
    for(const change of [{nonce:'not-uuid'},{issuedAt:-1},{issuedAt:now+0.1},{expiresAt:Infinity}])expect(()=>signAnalysisJob(job(),{...signing(),...change})).toThrow('ANALYSIS_JOB_INVALID');
    for(const change of [{expiresAt:now},{expiresAt:now-1},{expiresAt:now+60_001},{issuedAt:now+1,expiresAt:now+1000}])expect(()=>signAnalysisJob(job(),{...signing(),...change})).toThrow('ANALYSIS_JOB_EXPIRED');
    for(const instant of [NaN,Infinity,-1,now+0.5])expect(()=>verifyAnalysisJob(wire(),{...verifying(),now:instant})).toThrow('ANALYSIS_JOB_EXPIRED');
    expect(verifyAnalysisJob(wire(),{...verifying(),now:now+59_999}).expiresAt).toBe(now+60_000);
    for(const instant of [now-1,now+60_000])expect(()=>verifyAnalysisJob(wire(),{...verifying(),now:instant})).toThrow('ANALYSIS_JOB_EXPIRED');
    const signed=signAnalysisJob(job(),signing());
    expect(()=>verifyAnalysisJob(wire(resign({...signed.payload,expiresAt:now+60_001})),verifying())).toThrow('ANALYSIS_JOB_EXPIRED');
  });
  it('rejects missing or wrong configured key IDs, image digests, key algorithms and key purposes',()=>{
    const ec=generateKeyPairSync('ec',{namedCurve:'P-256'}),other=generateKeyPairSync('ed25519');
    for(const keyId of ['', 'a/b','x'.repeat(65)])expect(()=>signAnalysisJob(job(),{...signing(),keyId})).toThrow('ANALYSIS_JOB_CONFIGURATION_INVALID');
    for(const value of ['latest','registry/image:tag','sha256:'+'A'.repeat(64)])expect(()=>verifyAnalysisJob(wire(),{...verifying(),imageDigest:value})).toThrow('ANALYSIS_JOB_CONFIGURATION_INVALID');
    for(const privateKey of [ec.privateKey,keys.publicKey])expect(()=>signAnalysisJob(job(),{...signing(),privateKey})).toThrow('ANALYSIS_JOB_KEY_INVALID');
    for(const publicKey of [ec.publicKey,keys.privateKey])expect(()=>verifyAnalysisJob(wire(),{...verifying(),publicKey})).toThrow('ANALYSIS_JOB_KEY_INVALID');
    expect(()=>verifyAnalysisJob(wire(),{...verifying(),publicKey:other.publicKey})).toThrow('ANALYSIS_JOB_SIGNATURE_INVALID');
    expect(()=>verifyAnalysisJob(wire(),{...verifying(),keyId:'other-key'})).toThrow('ANALYSIS_JOB_SIGNATURE_INVALID');
  });
  it('separates the analysis signature domain from other signed protocols and rejects noncanonical base64url',()=>{
    const signed=signAnalysisJob(job(),signing());
    const wrongDomain=sign(null,Buffer.from('open_aider.dws.read.v1\0'+canonical(signed.payload)),keys.privateKey).toString('base64url');
    expect(()=>verifyAnalysisJob(JSON.stringify({...signed,signature:wrongDomain}),verifying())).toThrow('ANALYSIS_JOB_SIGNATURE_INVALID');
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',last=alphabet.indexOf(signed.signature.at(-1)!);
    const alias=signed.signature.slice(0,-1)+alphabet[last+1];
    expect(Buffer.from(alias,'base64url')).toEqual(Buffer.from(signed.signature,'base64url'));
    expect(()=>verifyAnalysisJob(JSON.stringify({...signed,signature:alias}),verifying())).toThrow('ANALYSIS_JOB_SIGNATURE_INVALID');
  });
  it('bounds raw bytes before parsing and rejects malformed UTF-8/JSON and object wire inputs',()=>{
    const valid=wire(),padded=valid+' '.repeat(analysisJobWireLimit-Buffer.byteLength(valid));
    expect(verifyAnalysisJob(padded,verifying()).job).toEqual(job());
    for(const raw of [padded+' ',new Uint8Array(analysisJobWireLimit+1),'中'.repeat(analysisJobWireLimit)])expect(()=>verifyAnalysisJob(raw,verifying())).toThrow('ANALYSIS_JOB_WIRE_TOO_LARGE');
    for(const raw of ['{', 'null','[]',JSON.stringify({}),new Uint8Array([0xff])])expect(()=>verifyAnalysisJob(raw,verifying())).toThrow('ANALYSIS_JOB_WIRE_INVALID');
    let invoked=0;const raw={toString(){invoked++;return valid;}};
    expect(()=>verifyAnalysisJob(raw as unknown as string,verifying())).toThrow('ANALYSIS_JOB_WIRE_INVALID');expect(invoked).toBe(0);
    const data=new TextEncoder().encode(valid);Object.defineProperty(data,'byteLength',{get(){invoked++;throw Error('must not run');}});Object.defineProperty(data,'buffer',{get(){invoked++;throw Error('must not run');}});
    expect(verifyAnalysisJob(data,verifying()).job).toEqual(job());expect(invoked).toBe(0);
  });
  it('does not claim nonce persistence, artifact authorization or actual sandbox isolation',()=>{
    const signed=signAnalysisJob(job(),signing()),first=verifyAnalysisJob(wire(signed),verifying());
    expect(verifyAnalysisJob(wire(signed),verifying())).toEqual(first); // Host must persist a nonce claim before executing.
    expect(first.job.codeArtifactId).toBe(id(5)); // A UUID is no evidence of existence, ownership, content or executable safety.
    expect(Object.keys(first).sort()).toEqual(['expiresAt','imageDigest','issuedAt','job','jobHash','nonce','protocol','subject']);
    expect(new AnalysisJobError('ANALYSIS_JOB_EXPIRED').message).toBe('ANALYSIS_JOB_EXPIRED');
  });
});
