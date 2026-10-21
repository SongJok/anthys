import {z} from 'zod';
import {canonical} from '../../gateway/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import {DwsError} from './contracts.js';

// v1.0.61 publishes no result schema for doc +fetch. Only the CLI-owned
// envelope below comes from the pinned implementation. A tenant must review
// the opaque upstream payload mapping separately; there is no guessed default.
export const documentNode=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const pointer=z.string().min(1).max(256).refine(p=>p.startsWith('/')&&p.split('/').length<=12&&p.split('/').slice(1).every(s=>s.length>0&&!['__proto__','constructor','prototype'].includes(s.replace(/~1/g,'/').replace(/~0/g,'~'))&&!/~(?![01])/u.test(s)));
export const documentPayloadProfile=z.object({schemaVersion:z.literal(1),reviewRef:z.string().min(1).max(2048),nodePointer:pointer,revisionPointer:pointer,textPointer:pointer,typePointer:pointer,typeValue:z.literal('adoc'),completePointer:pointer.nullable(),hasMorePointer:pointer.nullable(),cursorPointer:pointer.nullable(),completenessUnit:z.literal('ONE_DOCUMENT_VERSION')}).strict();
export type DocumentPayloadProfile=z.infer<typeof documentPayloadProfile>;
export const documentSelector=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('FULL'),maxCharacters:z.number().int().min(1).max(12000).default(6000)}).strict(),
 z.object({kind:z.literal('RANGE'),start:z.number().int().min(0).max(1000000),end:z.number().int().min(1).max(1000000)}).strict().refine(a=>a.end>a.start&&a.end-a.start<=12000),
 z.object({kind:z.literal('KEYWORD'),query:z.string().trim().min(1).max(128),context:z.number().int().min(0).max(200).default(80),limit:z.number().int().min(1).max(10).default(5)}).strict()
]);
export const documentReadSchema=z.object({nodeId:documentNode,authorizationVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),requestNonce:z.uuid(),selector:documentSelector}).strict();
export type DocumentRead=z.infer<typeof documentReadSchema>;
export const documentEnvelope=z.object({contractVersion:z.literal('doc.content.v1'),status:z.literal('success'),complete:z.literal(true),target:z.object({canonicalId:documentNode,product:z.literal('doc'),name:z.string().optional(),resourceType:z.string().optional(),canonicalUrl:z.string().optional(),containerId:z.string().optional()}).strict(),content:z.record(z.string(),z.unknown())}).strict();
export const documentContractHash=hash('open_aider.dws.doc.read.v1:reviewed-payload-profile:exact-owner:single-document:unicode-ranges:current-source');
// Missing/unpublished is distinct from an explicit null terminal cursor.
const unpublished=Symbol('unpublished-payload-field');
export function payloadValue(value:unknown,path:string|null):unknown{if(path===null)return unpublished;let current=value;for(const part of path.split('/').slice(1)){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(!current||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,key))return unpublished;current=(current as Record<string,unknown>)[key];}return current;}
function maskedCharacters(text:string){const chars=Array.from(text),masked=[...chars],offsets=new Uint32Array(text.length+1);let utf16=0;for(let index=0;index<chars.length;index++){for(let unit=0;unit<chars[index]!.length;unit++)offsets[utf16++]=index;}offsets[text.length]=chars.length;let count=0;for(const pattern of [/(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi,/((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"';,]+)/gi])for(const match of text.matchAll(pattern)){if(++count>2048)throw new DwsError('DWS_DOCUMENT_SECRET_SPAN_LIMIT');const from=match.index!+match[1]!.length,start=offsets[from]!,end=offsets[from+match[2]!.length]!;for(let i=start;i<end;i++)masked[i]='█';}return {chars,masked};}
export function projectDocument(value:unknown,args:DocumentRead,profile:DocumentPayloadProfile){
 const parsed=documentEnvelope.safeParse(value);if(!parsed.success||parsed.data.target.canonicalId!==args.nodeId)throw new DwsError('DWS_DOCUMENT_ENVELOPE_UNVERIFIED');
 const body=parsed.data.content;for(const candidate of [body,body['data']]){if(candidate&&typeof candidate==='object'){const c=candidate as Record<string,unknown>;if(c['ok']===false||c['success']===false||c['error']||['failure','partial_failure','partial_success','unknown'].includes(String(c['status'])))throw new DwsError('DWS_DOCUMENT_PAYLOAD_FAILED');}}
 if(payloadValue(body,profile.nodePointer)!==args.nodeId||payloadValue(body,profile.typePointer)!==profile.typeValue)throw new DwsError('DWS_DOCUMENT_TARGET_MISMATCH');
 const rawText=payloadValue(body,profile.textPointer),rawRevision=payloadValue(body,profile.revisionPointer);
 if(typeof rawText!=='string'||Buffer.byteLength(rawText)>262144||!(typeof rawRevision==='string'&&rawRevision.length>0&&rawRevision.length<=128||typeof rawRevision==='number'&&Number.isSafeInteger(rawRevision)&&rawRevision>=0))throw new DwsError('DWS_DOCUMENT_PAYLOAD_UNVERIFIED');
 const complete=payloadValue(body,profile.completePointer),hasMore=payloadValue(body,profile.hasMorePointer),cursor=payloadValue(body,profile.cursorPointer),upstream=complete===true&&hasMore===false&&(cursor===null||cursor==='')?'COMPLETE':complete===false||hasMore===true||typeof cursor==='string'&&cursor.length>0?'TRUNCATED':'UNKNOWN';
 const {chars,masked}=maskedCharacters(rawText),ranges:{start:number;end:number}[]=[],selector=args.selector;let limited=false,totalMatches:number|null=null;
 if(selector.kind==='FULL'){ranges.push({start:0,end:Math.min(chars.length,selector.maxCharacters)});limited=chars.length>selector.maxCharacters;}
 else if(selector.kind==='RANGE'){if(selector.start>=chars.length&&!(selector.start===0&&chars.length===0))throw new DwsError('DWS_DOCUMENT_RANGE_OUTSIDE_OBSERVATION');ranges.push({start:selector.start,end:Math.min(chars.length,selector.end)});limited=true;}
 else{const needle=Array.from(selector.query);totalMatches=0;for(let at=0;at+needle.length<=chars.length;at++){if(!needle.every((c,i)=>c===masked[at+i]))continue;totalMatches++;if(ranges.length<selector.limit)ranges.push({start:Math.max(0,at-selector.context),end:Math.min(chars.length,at+needle.length+selector.context)});else limited=true;at+=needle.length-1;}limited=limited||ranges.some(r=>r.start>0||r.end<chars.length);}
 let remaining=16000;const fragments:{start:number;end:number;text:string;contentHash:string;redacted:boolean}[]=[];
 for(const range of ranges){let end=range.start,bytes=0;while(end<range.end){const length=Buffer.byteLength(masked[end]!);if(bytes+length>remaining)break;bytes+=length;end++;}if(end<range.end)limited=true;remaining-=bytes;const original=chars.slice(range.start,end).join(''),text=masked.slice(range.start,end).join('');fragments.push({start:range.start,end,text,contentHash:hash(text),redacted:text!==original});if(remaining===0){limited=true;break;}}
 const documentComplete=selector.kind==='FULL'&&upstream==='COMPLETE'&&!limited,completeness=documentComplete?'COMPLETE':upstream==='UNKNOWN'?'UNKNOWN':'TRUNCATED';
 const stopReason=documentComplete?'DOCUMENT_RESPONSE_TERMINAL':upstream==='UNKNOWN'?'UPSTREAM_COMPLETENESS_UNPUBLISHED':upstream==='TRUNCATED'?'UPSTREAM_CONTINUATION_UNCONSUMED':limited?'LOCAL_SELECTION_LIMIT':'SELECTED_FRAGMENT_ONLY';
 const selected=selector.kind==='KEYWORD'?{kind:selector.kind,queryHash:hash(selector.query),context:selector.context,limit:selector.limit}:selector;
 return {nodeId:args.nodeId,revision:String(rawRevision),observedTextHash:hash(rawText),projection:{population:'ONE_DOCUMENT_VERSION' as const,rangeUnit:'UNICODE_CODE_POINTS' as const,selector:selected,observedCharacters:chars.length,upstreamCompleteness:upstream,stopReason,documentComplete,totalMatches,fragments,untrustedContent:true},completeness,status:fragments.every(f=>!f.text)?upstream==='COMPLETE'?'EMPTY':'PARTIAL':documentComplete?'OK':'PARTIAL',projectionHash:hash(canonical({selector:selected,fragments,upstream,documentComplete,totalMatches,observedCharacters:chars.length}))};
}
export type DocumentObservation=ReturnType<typeof projectDocument>;
