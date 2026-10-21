import {createHash} from 'node:crypto';
import {isDeepStrictEqual,types} from 'node:util';
import {z} from 'zod';
import {blocked,type ToolResult} from '../../contracts/src/index.js';
import type {Capability,Gateway} from '../../gateway/src/index.js';
import {renderArtifact,ArtifactFailure,type ArtifactOptions,type ArtifactRequest,type RenderedArtifact} from './index.js';
import {NativeArtifactError,nativeArtifactDraftNotice,nativeArtifactDraftSourceSchema,nativeArtifactHash,nativeArtifactInputJsonSchema,nativeArtifactInputSchema,nativeArtifactLimits,nativeArtifactPreparationSchema,nativeArtifactPublicationSchema,nativeArtifactReceiptSchema,nativeArtifactResultContract,nativeArtifactSnapshot,nativeArtifactSpecifications,parseNativeArtifactInput,freezeNativeArtifactJson,type NativeArtifactClaim,type NativeArtifactContext,type NativeArtifactErrorCode,type NativeArtifactHostPort,type NativeArtifactInput,type NativeArtifactReceipt} from './native-contracts.js';

const id='artifacts.create',version='1.0.0';
type Options=Pick<ArtifactOptions,'limits'|'pdfFont'|'docxFont'>;
function snapshotOptions(raw:Options):Options {
  try{
    if(!raw||types.isProxy(raw))throw Error();
    const ds=Object.getOwnPropertyDescriptors(raw);
    if(Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(ds).some(k=>typeof k!=='string'||!['limits','pdfFont','docxFont'].includes(k)||!('value' in ds[k]!)))throw Error();
    const result:Options={};
    if(raw.limits!==undefined){
      const limits=nativeArtifactSnapshot(raw.limits) as Record<string,unknown>;
      if(Array.isArray(limits)||!limits||typeof limits!=='object')throw Error();
      for(const [k,v] of Object.entries(limits))if(!Object.hasOwn(nativeArtifactLimits,k)||typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>nativeArtifactLimits[k as keyof typeof nativeArtifactLimits])throw Error();
      result.limits=Object.freeze({...limits}) as NonNullable<Options['limits']>;
    }
    for(const key of ['pdfFont','docxFont'] as const){
      const f=raw[key];if(f===undefined)continue;
      if(!f||types.isProxy(f)||![Object.prototype,null].includes(Object.getPrototypeOf(f) as object|null))throw Error();
      const fields=Object.getOwnPropertyDescriptors(f),expected=key==='docxFont'?['bytes','sha256','family']:['bytes','sha256'];
      if(Reflect.ownKeys(fields).length!==expected.length||expected.some(k=>!fields[k]||!('value' in fields[k]!))||Reflect.ownKeys(fields).some(k=>typeof k!=='string'||!expected.includes(k))||!Buffer.isBuffer(f.bytes)||f.bytes.length===0||f.bytes.length>nativeArtifactLimits.maxFontBytes||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error();
      if(key==='docxFont'){
        if(!('family' in f)||typeof f.family!=='string'||!f.family||f.family.length>100||/[\x00-\x1f\x7f]/.test(f.family))throw Error();
        result.docxFont=Object.freeze({bytes:Buffer.from(f.bytes),sha256:f.sha256,family:f.family});
      }else result.pdfFont=Object.freeze({bytes:Buffer.from(f.bytes),sha256:f.sha256});
    }
    return Object.freeze(result);
  }catch{throw new NativeArtifactError('NATIVE_ARTIFACT_CONFIGURATION_INVALID');}
}
function privateContext(context:Pick<NativeArtifactContext,'principal'|'lease'>):boolean {
  const {principal:p,lease:l}=context;
  return z.uuid().safeParse(p.tenantId).success&&z.uuid().safeParse(p.actorId).success&&p.auditAccess!==true&&z.uuid().safeParse(l.taskId).success&&z.uuid().safeParse(l.runId).success&&Number.isSafeInteger(l.authEpoch)&&l.authEpoch>0&&Number.isSafeInteger(l.fence)&&l.fence>0&&typeof l.workerId==='string'&&l.workerId.length>0&&l.audience['kind']==='PRIVATE_USER'&&l.audience['targetId']===p.actorId&&!l.groupAudience&&!l.nativeCaseAudience&&Number.isFinite(Date.parse(l.expiresAt))&&Date.parse(l.expiresAt)>Date.now();
}
function receiptBound(receipt:NativeArtifactReceipt,context:NativeArtifactContext,input:NativeArtifactInput):boolean {
  return receipt.artifact.taskId===context.lease.taskId&&receipt.artifact.runId===context.lease.runId&&receipt.artifact.format===input.format;
}
function success(receipt:NativeArtifactReceipt):ToolResult {
  return {status:'OK',data:receipt,evidenceIds:[],completeness:'COMPLETE',verification:{state:'UNVERIFIED',method:'TOOL_DRAFT_FORMAT_CHECKS_ONLY'}};
}
function renderCode(error:unknown,signal:AbortSignal):NativeArtifactErrorCode {
  if(signal.aborted)return 'NATIVE_ARTIFACT_CANCELLED';
  if(error instanceof ArtifactFailure&&['ARTIFACT_INPUT_LIMIT','ARTIFACT_OUTPUT_LIMIT','ARTIFACT_PAGE_LIMIT','ARTIFACT_ZIP_LIMIT','ARTIFACT_COMPRESSION_LIMIT'].includes(error.code))return 'NATIVE_ARTIFACT_LIMIT';
  return 'NATIVE_ARTIFACT_RENDER_FAILED';
}
function approvedRequest(request:Omit<ArtifactRequest,'table'>&{table?:ArtifactRequest['table']},input:NativeArtifactInput):ArtifactRequest {
  const spec=nativeArtifactSpecifications[input.format];
  if(request.format!==spec.format)throw new NativeArtifactError('NATIVE_ARTIFACT_HOST_INVALID');
  // Reuse exactly the same document/type bounds before handing a host projection to the renderer.
  // The host may prepend the fixed notice to a CSV header while retaining
  // its original name. Strip only that exact prefix for input-bound checking,
  // then restore it for rendering (a 200-character input header still fits).
  const prefix=nativeArtifactDraftNotice+' ',csvPrefix=input.format==='csv'&&request.table?.columns[0]?.name.startsWith(prefix);
  const table=csvPrefix?{...request.table!,columns:request.table!.columns.map((column,index)=>index===0?{...column,name:column.name.slice(prefix.length)}:column)}:request.table;
  const checked=parseNativeArtifactInput({format:input.format,source:{mode:'TOOL_DRAFT',document:{title:request.title,paragraphs:request.paragraphs,...(table?{table}:{})}}});
  const d=checked.source.document;
  const shown=input.format==='csv'?!!d.table&&(d.table.columns.some(c=>c.name===nativeArtifactDraftNotice)||csvPrefix===true||d.table.rows.some(r=>r.includes(nativeArtifactDraftNotice))):d.title.includes(nativeArtifactDraftNotice)||d.paragraphs.includes(nativeArtifactDraftNotice)||!!d.table&&(d.table.columns.some(c=>c.name===nativeArtifactDraftNotice)||d.table.rows.some(r=>r.includes(nativeArtifactDraftNotice)));
  if(!shown)throw new NativeArtifactError('NATIVE_ARTIFACT_HOST_INVALID');
  return freezeNativeArtifactJson({format:spec.format,title:d.title,paragraphs:d.paragraphs,...(d.table?{table:csvPrefix?{...d.table,columns:d.table.columns.map((column,index)=>index===0?{...column,name:prefix+column.name}:column)}:d.table}:{})});
}
/** Factory is inert until the main host explicitly registers it. It creates no session, storage or authorization. */
export function registerNativeArtifactCapability(gateway:Gateway,host:NativeArtifactHostPort,rawOptions:Options):void {
  if(!host||['authorize','prepare','publish','settleFailure'].some(k=>typeof host[k as keyof NativeArtifactHostPort]!=='function'))throw new NativeArtifactError('NATIVE_ARTIFACT_CONFIGURATION_INVALID');
  const authorize=host.authorize.bind(host),prepare=host.prepare.bind(host),publish=host.publish.bind(host),settle=host.settleFailure.bind(host),options=snapshotOptions(rawOptions);
  const capability:Capability={
    ...nativeArtifactResultContract,id,version,description:'Create a protected local draft for this private task. Draft facts remain UNVERIFIED. Does not send files or grant access.',provider:'CORE',risk:'READ',state:'READY',authModes:['CORE'],requiredPermissions:[{name:'Current private task owner, live action/lease/epoch and all original source dependencies checked by host before and after rendering',evidenceRef:'code:packages/artifacts/src/native-contracts.ts#NativeArtifactHostPort'}],supportsIdempotency:false,supportsDryRun:false,protectResult:true,retryableRead:false,bindingRef:'core:artifacts.private-tool-draft.v1',
    bindingHash:nativeArtifactHash({id,version,mode:'TOOL_DRAFT',input:nativeArtifactInputJsonSchema,output:nativeArtifactResultContract.outputSchema,notice:nativeArtifactDraftNotice}),
    schema:nativeArtifactInputSchema,jsonSchema:nativeArtifactInputJsonSchema,resource:(_args,lease)=>lease.taskId,
    classifyResult:result=>{const r=nativeArtifactReceiptSchema.safeParse(result.data);return r.success?r.data.artifact.source.classification:'RESTRICTED';},
    allowResource:async(raw,context,db,cached)=>{
      try{if(!privateContext(context)||context.signal?.aborted)return false;const args=parseNativeArtifactInput(raw);return await authorize(args,context,db,cached)===true&&!context.signal?.aborted&&privateContext(context);}catch{return false;}
    },
    retainFact:async(raw,context,db,result)=>{if(!await authorize(parseNativeArtifactInput(raw),context,db,result))throw new NativeArtifactError('NATIVE_ARTIFACT_SOURCE_CHANGED');},
    execute:async(raw,context)=>{
      if(!privateContext(context))return blocked('DENIED','NATIVE_ARTIFACT_DENIED');
      if(context.signal.aborted)return blocked('DENIED','NATIVE_ARTIFACT_CANCELLED');
      let input:NativeArtifactInput;
      try{input=parseNativeArtifactInput(raw);}catch{return blocked('PERMANENT_ERROR','NATIVE_ARTIFACT_INPUT_INVALID');}
      const inputHash=nativeArtifactHash(input);
      let claim:NativeArtifactClaim|undefined,stage:'RENDER'|'PUBLISH'='RENDER';
      const failClaim=async(code:NativeArtifactErrorCode,alwaysUnknown=false,denied=false):Promise<ToolResult>=>{
        let confirmed=false;
        if(claim)try{confirmed=await settle(context,claim,{stage,code})==='FAILED_CONFIRMED';}catch{/* An unknown settlement never becomes a confirmed failure. */}
        if(alwaysUnknown||!confirmed)return blocked('UNKNOWN',alwaysUnknown?code:'NATIVE_ARTIFACT_SETTLEMENT_UNCERTAIN');
        return blocked(denied||code==='NATIVE_ARTIFACT_CANCELLED'||code==='NATIVE_ARTIFACT_DENIED'||code==='NATIVE_ARTIFACT_SOURCE_CHANGED'?'DENIED':'PERMANENT_ERROR',code);
      };
      try{
        const prepared=nativeArtifactPreparationSchema.parse(nativeArtifactSnapshot(await prepare(context,input,inputHash),nativeArtifactLimits.maxInputBytes+16384));
        if(prepared.kind==='DENIED'||prepared.kind==='UNKNOWN')return blocked(prepared.kind,prepared.code);
        if(prepared.kind==='REPLAY'){
          if(context.signal.aborted||!privateContext(context))return blocked('UNKNOWN','NATIVE_ARTIFACT_CANCELLED');
          if(!prepared.receipt.replayed||!receiptBound(prepared.receipt,context,input))return blocked('UNKNOWN','NATIVE_ARTIFACT_RECEIPT_INVALID');
          return success(freezeNativeArtifactJson(prepared.receipt));
        }
        if(prepared.claim.inputHash!==inputHash)return blocked('UNKNOWN','NATIVE_ARTIFACT_HOST_INVALID');
        claim=freezeNativeArtifactJson(prepared.claim);
        if(context.signal.aborted||!privateContext(context))return failClaim('NATIVE_ARTIFACT_CANCELLED');
        const request=approvedRequest(prepared.request,input),source=freezeNativeArtifactJson(nativeArtifactDraftSourceSchema.parse(prepared.source));
        let rendered:RenderedArtifact;
        try{rendered=await renderArtifact(request,{...options,signal:context.signal});}catch(e){return failClaim(renderCode(e,context.signal));}
        if(context.signal.aborted||!privateContext(context))return failClaim('NATIVE_ARTIFACT_CANCELLED');
        // Capture the trusted renderer digest before a host can consume/mutate its bytes.
        const renderedHash=createHash('sha256').update(rendered.bytes).digest('hex'),size=rendered.bytes.length,mime=rendered.mime;
        if(rendered.sha256!==renderedHash||rendered.format!==nativeArtifactSpecifications[input.format].format)return failClaim('NATIVE_ARTIFACT_RENDER_FAILED');
        stage='PUBLISH';
        const published=nativeArtifactPublicationSchema.parse(nativeArtifactSnapshot(await publish(context,claim,rendered),16384));
        if(published.kind==='UNKNOWN')return failClaim(published.code,true);
        if(published.kind==='DENIED')return failClaim(published.code,false,true);
        if(context.signal.aborted||!privateContext(context))return failClaim('NATIVE_ARTIFACT_CANCELLED',true);
        const receipt=published.receipt;
        if(receipt.replayed||!receiptBound(receipt,context,input)||receipt.artifact.sha256!==renderedHash||receipt.artifact.byteSize!==size||receipt.artifact.mime!==mime||!isDeepStrictEqual(receipt.artifact.source,source))return failClaim('NATIVE_ARTIFACT_RECEIPT_INVALID',true);
        return success(freezeNativeArtifactJson(receipt));
      }catch{
        if(!claim)return blocked('UNKNOWN','NATIVE_ARTIFACT_HOST_INVALID');
        return failClaim(stage==='PUBLISH'?'NATIVE_ARTIFACT_PUBLISH_UNCERTAIN':'NATIVE_ARTIFACT_HOST_INVALID',stage==='PUBLISH');
      }
    },
  };
  gateway.register(capability);
}
