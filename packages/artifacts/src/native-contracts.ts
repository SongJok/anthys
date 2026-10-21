import {createHash} from 'node:crypto';
import {types} from 'node:util';
import type pg from 'pg';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import type {Lease} from '../../runtime/src/store.js';
import type {ArtifactRequest,RenderedArtifact} from './index.js';

export const nativeArtifactDraftNotice='UNVERIFIED TOOL DRAFT. File checks do not verify facts, sources or external actions. Access remains protected.';
export const nativeArtifactLimits=Object.freeze({maxInputBytes:1048576,maxTextLength:16384,maxRows:1000,maxColumns:32,maxOutputBytes:8388608,maxPages:100,maxZipEntries:256,maxExpandedBytes:16777216,maxCompressionRatio:1000,maxFontBytes:8388608});
export const nativeArtifactErrorCode=z.enum(['NATIVE_ARTIFACT_INPUT_INVALID','NATIVE_ARTIFACT_CONFIGURATION_INVALID','NATIVE_ARTIFACT_DENIED','NATIVE_ARTIFACT_SOURCE_CHANGED','NATIVE_ARTIFACT_NOT_READY','NATIVE_ARTIFACT_CANCELLED','NATIVE_ARTIFACT_LIMIT','NATIVE_ARTIFACT_HOST_INVALID','NATIVE_ARTIFACT_RENDER_FAILED','NATIVE_ARTIFACT_RECEIPT_INVALID','NATIVE_ARTIFACT_PUBLISH_UNCERTAIN','NATIVE_ARTIFACT_SETTLEMENT_UNCERTAIN']);
export type NativeArtifactErrorCode=z.infer<typeof nativeArtifactErrorCode>;
export class NativeArtifactError extends Error {
  constructor(readonly code:NativeArtifactErrorCode){super(code);this.name='NativeArtifactError';}
}
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
/** Bound and copy unknown JSON without running accessors, toJSON, proxy traps or custom prototypes. */
export function nativeArtifactSnapshot(raw:unknown,maxBytes:number=nativeArtifactLimits.maxInputBytes):Json {
  let nodes=0,bytes=0;
  const active=new Set<object>();
  const visit=(value:unknown,depth:number):Json=>{
    if(++nodes>40000||depth>32)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='string'){
      bytes+=Buffer.byteLength(value,'utf8');
      if(bytes>maxBytes)throw new NativeArtifactError('NATIVE_ARTIFACT_LIMIT');
      return value;
    }
    if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return value;
    if(typeof value!=='object'||types.isProxy(value)||active.has(value))throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
    active.add(value);
    try{
      const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
      if(keys.some(k=>typeof k!=='string'))throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
      if(array){
        const length=ds['length']?.value as unknown;
        if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0||length>1000||keys.length!==length+1)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
        const out:Json[]=[];
        for(let i=0;i<length;i++){
          const d=ds[String(i)];if(!d||!('value' in d)||!d.enumerable)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
          out.push(visit(d.value,depth+1));
        }
        return out;
      }
      if(keys.length>64)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
      const out=Object.create(null) as {[key:string]:Json};
      for(const key of keys){
        const name=key as string,d=ds[name]!;bytes+=Buffer.byteLength(name,'utf8');
        if(bytes>maxBytes)throw new NativeArtifactError('NATIVE_ARTIFACT_LIMIT');
        if(!('value' in d)||!d.enumerable)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
        out[name]=visit(d.value,depth+1);
      }
      return out;
    }finally{active.delete(value);}
  };
  const result=visit(raw,0);
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>maxBytes)throw new NativeArtifactError('NATIVE_ARTIFACT_LIMIT');
  return result;
}
export function freezeNativeArtifactJson<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeNativeArtifactJson(child);Object.freeze(value);}
  return value;
}
/** Canonical UTF-16 key ordering, JSON primitive spelling, array order retained. Input must be a validated snapshot. */
export function nativeArtifactHash(value:unknown):string {
  const canonical=(v:Json):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k]!)).join(',')+'}';
  return createHash('sha256').update(canonical(nativeArtifactSnapshot(value))).digest('hex');
}
const format=z.enum(['md','txt','csv','json','html','xlsx','docx','pdf']);
const text=(max=16384)=>z.string().max(max).refine(v=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(v));
const column=z.strictObject({name:text(200).refine(v=>v.trim().length>0),type:z.enum(['text','boolean','integer','decimal'])});
const table=z.strictObject({columns:z.array(column).min(1).max(32),rows:z.array(z.array(z.union([text(),z.number().safe(),z.boolean(),z.null()])).max(32)).max(1000)}).superRefine((v,c)=>{
  if(new Set(v.columns.map(col=>col.name)).size!==v.columns.length)c.addIssue({code:'custom',message:'DUPLICATE_COLUMN'});
  for(const row of v.rows){
    if(row.length!==v.columns.length){c.addIssue({code:'custom',message:'ROW_WIDTH'});continue;}
    row.forEach((cell,i)=>{
      if(cell===null)return;
      const type=v.columns[i]!.type;
      const valid=type==='text'?typeof cell==='string':type==='boolean'?typeof cell==='boolean':type==='integer'&&typeof cell==='number'?Number.isSafeInteger(cell)&&!Object.is(cell,-0):typeof cell==='string'&&cell.length<=128&&(type==='integer'?/^-?(?:0|[1-9]\d*)$/:/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/).test(cell);
      if(!valid)c.addIssue({code:'custom',message:'CELL_TYPE_OR_PRECISION'});
    });
  }
});
const documentShape={title:text().refine(v=>v.trim().length>0),paragraphs:z.array(text()).max(1000),table:table.optional()};
const inputStructure=z.strictObject({format,source:z.strictObject({mode:z.literal('TOOL_DRAFT'),document:z.strictObject(documentShape)})}).superRefine((v,c)=>{
  if((v.format==='csv'||v.format==='xlsx')&&!v.source.document.table)c.addIssue({code:'custom',message:'TABLE_REQUIRED'});
  if(v.format==='csv'&&v.source.document.paragraphs.length)c.addIssue({code:'custom',message:'CSV_PARAGRAPHS'});
});
export const nativeArtifactInputSchema=z.preprocess((v,c)=>{try{return nativeArtifactSnapshot(v);}catch{c.addIssue({code:'custom',message:'NATIVE_ARTIFACT_INPUT_INVALID'});return z.NEVER;}},inputStructure);
// Only trusted Zod-generated schemas are projected to their enumerable JSON wire data.
// Unknown input never uses JSON.stringify before nativeArtifactSnapshot.
export const nativeArtifactInputJsonSchema=freezeNativeArtifactJson(JSON.parse(JSON.stringify(z.toJSONSchema(inputStructure))) as Record<string,unknown>);
export type NativeArtifactInput=z.infer<typeof inputStructure>;
export function parseNativeArtifactInput(raw:unknown):NativeArtifactInput {
  const r=nativeArtifactInputSchema.safeParse(raw);if(!r.success)throw new NativeArtifactError('NATIVE_ARTIFACT_INPUT_INVALID');
  return freezeNativeArtifactJson(r.data);
}
export const nativeArtifactDraftSourceSchema=z.strictObject({mode:z.literal('TOOL_DRAFT'),verification:z.literal('UNVERIFIED'),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),asOf:z.iso.datetime({offset:true}),notice:z.literal(nativeArtifactDraftNotice)});
export type NativeArtifactDraftSource=z.infer<typeof nativeArtifactDraftSourceSchema>;
export const nativeArtifactSpecifications=freezeNativeArtifactJson({md:{format:'markdown',mime:'text/markdown; charset=utf-8',extension:'.md'},txt:{format:'txt',mime:'text/plain; charset=utf-8',extension:'.txt'},csv:{format:'csv',mime:'text/csv; charset=utf-8',extension:'.csv'},json:{format:'json',mime:'application/json',extension:'.json'},html:{format:'html',mime:'text/html; charset=utf-8',extension:'.html'},xlsx:{format:'xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:'.xlsx'},docx:{format:'docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',extension:'.docx'},pdf:{format:'pdf',mime:'application/pdf',extension:'.pdf'}} as const);
export const nativeArtifactReceiptSchema=z.strictObject({artifact:z.strictObject({id:z.uuid(),taskId:z.uuid(),runId:z.uuid(),format,mime:z.string().min(1).max(256),fileName:z.string().min(1).max(160),byteSize:z.number().int().positive().safe().max(8388608),sha256:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime({offset:true}),source:nativeArtifactDraftSourceSchema}),replayed:z.boolean()}).superRefine((v,c)=>{
  const spec=nativeArtifactSpecifications[v.artifact.format];
  if(v.artifact.mime!==spec.mime||v.artifact.fileName!==`artifact-${v.artifact.id}${spec.extension}`)c.addIssue({code:'custom',message:'FILE_SPEC_MISMATCH'});
});
export type NativeArtifactReceipt=z.infer<typeof nativeArtifactReceiptSchema>;
// Common Gateway blocked statuses carry no data or file authority. This narrower
// success envelope cannot relabel a draft as VERIFIED or invent evidence/remote IDs.
const resultSchema=z.strictObject({status:z.enum(['OK','PARTIAL','EMPTY','NEEDS_AUTH','NEEDS_APPROVAL','DENIED','RETRYABLE_ERROR','PERMANENT_ERROR','UNKNOWN']),data:nativeArtifactReceiptSchema.optional(),evidenceIds:z.array(z.string()).length(0),completeness:z.enum(['COMPLETE','UNKNOWN']),verification:z.strictObject({state:z.literal('UNVERIFIED'),method:z.literal('TOOL_DRAFT_FORMAT_CHECKS_ONLY')}).optional(),remediation:z.strictObject({kind:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)}).optional()}).superRefine((v,c)=>{
  if(v.status==='OK'?(v.data===undefined||v.verification===undefined||v.completeness!=='COMPLETE'||v.remediation!==undefined):(v.data!==undefined||v.verification!==undefined||v.completeness!=='UNKNOWN'||v.remediation===undefined))c.addIssue({code:'custom',message:'NATIVE_ARTIFACT_RESULT_STATE_INVALID'});
});
export const nativeArtifactResultContract={resultSchema,outputSchema:freezeNativeArtifactJson(JSON.parse(JSON.stringify(z.toJSONSchema(resultSchema))) as Record<string,unknown>)};
export const nativeArtifactClaimSchema=z.strictObject({id:z.uuid(),inputHash:z.string().regex(/^[a-f0-9]{64}$/)});
export type NativeArtifactClaim=Readonly<z.infer<typeof nativeArtifactClaimSchema>>;
const requestStructure=z.strictObject({format:z.enum(['markdown','txt','csv','json','html','xlsx','docx','pdf']),...documentShape});
export const nativeArtifactPreparationSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('DENIED'),code:nativeArtifactErrorCode}),z.strictObject({kind:z.literal('UNKNOWN'),code:nativeArtifactErrorCode}),
  z.strictObject({kind:z.literal('REPLAY'),receipt:nativeArtifactReceiptSchema}),
  z.strictObject({kind:z.literal('PREPARED'),claim:nativeArtifactClaimSchema,request:requestStructure,source:nativeArtifactDraftSourceSchema}),
]);
export const nativeArtifactPublicationSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('DENIED'),code:nativeArtifactErrorCode}),z.strictObject({kind:z.literal('UNKNOWN'),code:nativeArtifactErrorCode}),z.strictObject({kind:z.literal('READY'),receipt:nativeArtifactReceiptSchema})]);
export type NativeArtifactHostBlock={kind:'DENIED';code:NativeArtifactErrorCode}|{kind:'UNKNOWN';code:NativeArtifactErrorCode};
export type NativeArtifactPreparation=NativeArtifactHostBlock|{kind:'REPLAY';receipt:NativeArtifactReceipt}|{kind:'PREPARED';claim:NativeArtifactClaim;request:ArtifactRequest;source:NativeArtifactDraftSource};
export type NativeArtifactContext=Readonly<{principal:DbContext;lease:Lease;signal:AbortSignal;actionKey:string}>;
/** Trusted host only. No callback's presence proves actual ACL, durable idempotency or a current source. */
export interface NativeArtifactHostPort {
  authorize(args:NativeArtifactInput,context:{principal:DbContext;lease:Lease;signal?:AbortSignal},db:pg.PoolClient,cached:unknown):Promise<boolean>;
  prepare(context:NativeArtifactContext,args:NativeArtifactInput,inputHash:string):Promise<NativeArtifactPreparation>;
  publish(context:NativeArtifactContext,claim:NativeArtifactClaim,rendered:RenderedArtifact):Promise<NativeArtifactHostBlock|{kind:'READY';receipt:NativeArtifactReceipt}>;
  settleFailure(context:NativeArtifactContext,claim:NativeArtifactClaim,failure:{stage:'RENDER'|'PUBLISH';code:NativeArtifactErrorCode}):Promise<'FAILED_CONFIRMED'|'UNKNOWN'>;
}
