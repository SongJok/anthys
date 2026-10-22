import {createHash,sign,verify,KeyObject} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';

export const analysisJobWireLimit=32*1024;
export const analysisJobMaxLifetimeMs=60_000;
/** CPU time is a conservative 1 CPU × 60s ceiling, independently reducible from wall time. */
export const analysisDefaultLimits=Object.freeze({cpuMillis:60_000,memoryMb:512,wallMs:60_000,outputBytes:20*1024*1024});
export type AnalysisJobErrorCode='ANALYSIS_JOB_INVALID'|'ANALYSIS_JOB_WIRE_INVALID'|'ANALYSIS_JOB_WIRE_TOO_LARGE'|'ANALYSIS_JOB_KEY_INVALID'|'ANALYSIS_JOB_CONFIGURATION_INVALID'|'ANALYSIS_JOB_SIGNATURE_INVALID'|'ANALYSIS_JOB_BINDING_MISMATCH'|'ANALYSIS_JOB_EXPIRED';
export class AnalysisJobError extends Error {
  constructor(readonly code:AnalysisJobErrorCode){super(code);this.name='AnalysisJobError';}
}

type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
/** Snapshot JSON data without invoking getters/toJSON, including proxies or array subclasses. */
function jsonSnapshot(raw:unknown):Json {
  let nodes=0,bytes=0;
  const active=new Set<object>();
  const visit=(value:unknown,depth:number):Json=>{
    if(++nodes>4096||depth>12)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='string'){
      bytes+=Buffer.byteLength(value,'utf8');
      if(bytes>analysisJobWireLimit)throw new AnalysisJobError('ANALYSIS_JOB_WIRE_TOO_LARGE');
      return value;
    }
    if(typeof value==='number'&&Number.isFinite(value))return value;
    if(typeof value!=='object'||types.isProxy(value)||active.has(value))throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
    active.add(value);
    try{
      const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
      if(keys.some(key=>typeof key!=='string'))throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
      if(array){
        const length=descriptors['length']?.value as unknown;
        if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>128||keys.length!==length+1)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
        const result:Json[]=[];
        for(let index=0;index<length;index++){
          const d=descriptors[String(index)];
          if(!d||!('value' in d)||!d.enumerable)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
          result.push(visit(d.value,depth+1));
        }
        return result;
      }
      if(keys.length>64)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
      const result=Object.create(null) as {[key:string]:Json};
      for(const key of keys){
        const name=key as string,d=descriptors[name]!;
        bytes+=Buffer.byteLength(name,'utf8');
        if(bytes>analysisJobWireLimit)throw new AnalysisJobError('ANALYSIS_JOB_WIRE_TOO_LARGE');
        if(!('value' in d)||!d.enumerable)throw new AnalysisJobError('ANALYSIS_JOB_INVALID');
        result[name]=visit(d.value,depth+1);
      }
      return result;
    }finally{active.delete(value);}
  };
  return visit(raw,0);
}
const jsonData=z.unknown().transform((raw,ctx)=>{
  try{return jsonSnapshot(raw);}catch{ctx.addIssue({code:'custom',message:'ANALYSIS_JOB_INVALID'});return z.NEVER;}
});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const keyIdSchema=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const instant=z.number().int().nonnegative().safe();
const positive=(max:number)=>z.number().int().positive().safe().max(max);
const outputType=z.enum(['markdown','txt','csv','json','html','xlsx','docx','pdf']);
const jobShape=z.object({
  tenantId:z.uuid(),taskId:z.uuid(),runId:z.uuid(),jobId:z.uuid(),
  language:z.enum(['typescript','javascript']),codeArtifactId:z.uuid(),
  inputArtifactIds:z.array(z.uuid()).max(64).refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length),
  network:z.literal('NONE'),
  limits:z.object({cpuMillis:positive(analysisDefaultLimits.cpuMillis),memoryMb:positive(analysisDefaultLimits.memoryMb),wallMs:positive(analysisDefaultLimits.wallMs),outputBytes:positive(analysisDefaultLimits.outputBytes)}).strict(),
  allowedOutputTypes:z.array(outputType).min(1).max(8).refine(values=>new Set(values).size===values.length),
}).strict();
/** Closed JSON-only job. Artifact IDs are references, never host paths or proof of artifact ACL. */
export const analysisJobSchema=jsonData.pipe(jobShape);
export type AnalysisJob=z.infer<typeof analysisJobSchema>;
const subjectShape=z.object({tenantId:z.uuid(),actorId:z.uuid(),authEpoch:z.number().int().positive().safe(),taskId:z.uuid(),runId:z.uuid(),jobId:z.uuid()}).strict();
const subjectSchema=jsonData.pipe(subjectShape);
export const analysisJobSubjectSchema=subjectSchema;
export type AnalysisJobSubject=z.infer<typeof subjectSchema>;
const payloadShape=z.object({
  protocol:z.literal('OA_ANALYSIS_JOB_V1'),subject:subjectShape,job:jobShape,jobHash:digest,imageDigest:imageDigestSchema,
  nonce:z.uuid(),issuedAt:instant,expiresAt:instant,
}).strict();
export type AnalysisJobPayload=z.infer<typeof payloadShape>;
const envelopeShape=z.object({keyId:keyIdSchema,payload:payloadShape,signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)}).strict();
export type AnalysisSignedJob=z.infer<typeof envelopeShape>;
export type AnalysisJobSigningOptions={subject:AnalysisJobSubject;imageDigest:string;keyId:string;privateKey:KeyObject;nonce:string;issuedAt:number;expiresAt:number;now?:number};
export type AnalysisJobVerificationOptions={expectedSubject:AnalysisJobSubject;imageDigest:string;keyId:string;publicKey:KeyObject;now?:number};

/** Sorted UTF-16 object keys; array order retained; primitives follow JSON.stringify. */
function canonical(value:Json):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key]!)).join(',')+'}';
}
function hashJob(job:AnalysisJob):string{return createHash('sha256').update(canonical(job)).digest('hex');}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
}
function parsed<T>(schema:z.ZodType<T>,raw:unknown,code:AnalysisJobErrorCode):T {
  const result=schema.safeParse(raw);
  if(!result.success)throw new AnalysisJobError(code);
  return result.data;
}
function configuration(keyId:string,imageDigest:string,key:KeyObject,kind:'private'|'public'){
  if(!keyIdSchema.safeParse(keyId).success||!imageDigestSchema.safeParse(imageDigest).success)throw new AnalysisJobError('ANALYSIS_JOB_CONFIGURATION_INVALID');
  try{if(!(key instanceof KeyObject)||key.type!==kind||key.asymmetricKeyType!=='ed25519')throw Error();}catch{throw new AnalysisJobError('ANALYSIS_JOB_KEY_INVALID');}
}
function bindings(payload:AnalysisJobPayload,expected:AnalysisJobSubject,imageDigest:string){
  for(const field of ['tenantId','taskId','runId','jobId'] as const){
    if(payload.job[field]!==payload.subject[field])throw new AnalysisJobError('ANALYSIS_JOB_BINDING_MISMATCH');
  }
  if(canonical(payload.subject)!==canonical(expected)||payload.imageDigest!==imageDigest||payload.jobHash!==hashJob(payload.job))throw new AnalysisJobError('ANALYSIS_JOB_BINDING_MISMATCH');
}
function timeWindow(payload:AnalysisJobPayload,now:number){
  if(!instant.safeParse(now).success||payload.expiresAt<=payload.issuedAt||payload.expiresAt-payload.issuedAt>analysisJobMaxLifetimeMs||now<payload.issuedAt||now>=payload.expiresAt)throw new AnalysisJobError('ANALYSIS_JOB_EXPIRED');
}
const domain='anthys.analysis.job.v1\0';
/** Trusted host signs only an already-authorized job. This operation performs no authorization or dispatch. */
export function signAnalysisJob(rawJob:unknown,options:AnalysisJobSigningOptions):AnalysisSignedJob {
  configuration(options.keyId,options.imageDigest,options.privateKey,'private');
  const job=parsed(analysisJobSchema,rawJob,'ANALYSIS_JOB_INVALID');
  const subject=parsed(subjectSchema,options.subject,'ANALYSIS_JOB_INVALID');
  const payload=parsed(payloadShape,{protocol:'OA_ANALYSIS_JOB_V1',subject,job,jobHash:hashJob(job),imageDigest:options.imageDigest,nonce:options.nonce,issuedAt:options.issuedAt,expiresAt:options.expiresAt},'ANALYSIS_JOB_INVALID');
  bindings(payload,subject,options.imageDigest);timeWindow(payload,options.now??Date.now());
  const bytes=Buffer.from(domain+canonical(payload),'utf8');
  const signature=sign(null,bytes,options.privateKey).toString('base64url');
  const envelope={keyId:options.keyId,payload,signature};
  if(Buffer.byteLength(JSON.stringify(envelope),'utf8')>analysisJobWireLimit)throw new AnalysisJobError('ANALYSIS_JOB_WIRE_TOO_LARGE');
  return freeze(envelope);
}
/** Raw wire is bounded before decoding/parsing. Caller must persist nonce and recheck ACL/current run before execution. */
export function verifyAnalysisJob(wire:string|Uint8Array,options:AnalysisJobVerificationOptions):AnalysisJobPayload {
  configuration(options.keyId,options.imageDigest,options.publicKey,'public');
  const expected=parsed(subjectSchema,options.expectedSubject,'ANALYSIS_JOB_INVALID');
  let text:string;
  if(typeof wire==='string'){
    if(Buffer.byteLength(wire,'utf8')>analysisJobWireLimit)throw new AnalysisJobError('ANALYSIS_JOB_WIRE_TOO_LARGE');
    text=wire;
  }else{
    if(!wire||types.isProxy(wire)||!(wire instanceof Uint8Array))throw new AnalysisJobError('ANALYSIS_JOB_WIRE_INVALID');
    // Intrinsic getters read internal slots, never user-defined byteLength/buffer getters.
    const prototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
    const field=(name:string)=>Reflect.apply(Object.getOwnPropertyDescriptor(prototype,name)!.get!,wire,[]) as unknown;
    const byteLength=field('byteLength') as number;
    if(byteLength>analysisJobWireLimit)throw new AnalysisJobError('ANALYSIS_JOB_WIRE_TOO_LARGE');
    try{const view=new Uint8Array(field('buffer') as ArrayBuffer,field('byteOffset') as number,byteLength);text=new TextDecoder('utf-8',{fatal:true}).decode(view);}catch{throw new AnalysisJobError('ANALYSIS_JOB_WIRE_INVALID');}
  }
  let raw:unknown;
  try{raw=JSON.parse(text);}catch{throw new AnalysisJobError('ANALYSIS_JOB_WIRE_INVALID');}
  const envelope=parsed(envelopeShape,raw,'ANALYSIS_JOB_WIRE_INVALID');
  if(envelope.keyId!==options.keyId)throw new AnalysisJobError('ANALYSIS_JOB_SIGNATURE_INVALID');
  const signature=Buffer.from(envelope.signature,'base64url');
  if(signature.toString('base64url')!==envelope.signature||!verify(null,Buffer.from(domain+canonical(envelope.payload),'utf8'),options.publicKey,signature))throw new AnalysisJobError('ANALYSIS_JOB_SIGNATURE_INVALID');
  bindings(envelope.payload,expected,options.imageDigest);timeWindow(envelope.payload,options.now??Date.now());
  return freeze(envelope.payload);
}
