import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const nodeId=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const revision=z.union([z.string().min(1).max(128),z.number().int().safe().min(0)]).transform(value=>String(value));
const noControl=(value:string)=>!/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const text=z.string().max(12000).refine(noControl,'DOCUMENT_TEXT_INVALID');
const replacement=z.strictObject({find:z.string().min(1).max(512).refine(noControl,'DOCUMENT_TEXT_INVALID'),replace:text}).strict().refine(value=>value.find!==value.replace,'DOCUMENT_EDIT_NOOP');
export const documentReadRequestSchema=z.strictObject({nodeId}).strict();
export type DocumentReadRequest=z.infer<typeof documentReadRequestSchema>;
export const documentEditRequestSchema=z.strictObject({nodeId,expectedRevision:revision,replacements:z.array(replacement).min(1).max(16)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.replacements.map(item=>item.find)).size!==value.replacements.length)ctx.addIssue({code:'custom',message:'DOCUMENT_EDIT_DUPLICATE_ANCHOR'});
});
export type DocumentEditRequest=z.infer<typeof documentEditRequestSchema>;
const readShape=z.strictObject({nodeId,revision,text}).strict();
const updateShape=z.strictObject({nodeId,revision}).strict();
export interface DocumentConnector{
 read(input:{nodeId:string},signal:AbortSignal):Promise<{nodeId:string;revision:string|number;text:string}>;
 update(input:{nodeId:string;expectedRevision:string;text:string;requestHash:string},signal:AbortSignal):Promise<{nodeId:string;revision:string|number}>;
}
export type DocumentReplacement=z.infer<typeof replacement>;
export type DocumentResult=
 |{status:'READ';nodeId:string;revision:string;text:string;textHash:string}
 |{status:'PROPOSED_EDIT';proposalId:string;nodeId:string;baseRevision:string;baseTextHash:string;replacements:readonly DocumentReplacement[];requestHash:string;expiresAt:string}
 |{status:'VERIFIED';nodeId:string;revision:string;mode:'DIRECT'|'MERGED';preservedExternalChanges:boolean;textHash:string}
 |{status:'CONFLICT';code:'DOCUMENT_VERSION_CONFLICT'|'DOCUMENT_EDIT_CONFLICT';currentRevision:string;effect:'NONE'}
 |{status:'BLOCKED_EXTERNAL';code:'DOCUMENT_CONNECTOR_UNAVAILABLE'}
 |{status:'READ_FAILED';code:'DOCUMENT_REQUEST_INVALID'|'DOCUMENT_READ_UNAVAILABLE'|'DOCUMENT_READ_INVALID';effect:'NONE'}
 |{status:'INVALID_PROPOSAL';code:'DOCUMENT_REQUEST_INVALID'|'DOCUMENT_PROPOSAL_UNKNOWN'|'DOCUMENT_PROPOSAL_EXPIRED';effect:'NONE'}
 |{status:'VERIFICATION_FAILED';code:'DOCUMENT_READBACK_UNAVAILABLE'|'DOCUMENT_READBACK_MISMATCH';nodeId:string;effect:'UNKNOWN'}
 |{status:'UNKNOWN';code:'DOCUMENT_UPDATE_OUTCOME_UNKNOWN';effect:'UNKNOWN'};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const textHash=(value:string)=>digest('anthys.office.document.text.v1\0'+value);
const requestHash=(request:DocumentEditRequest,baseTextHash:string)=>digest('anthys.office.document.edit.v1\0'+JSON.stringify([request.nodeId,request.expectedRevision,baseTextHash,request.replacements]));
type Range={start:number;end:number;replace:string};
function ranges(value:string,replacements:readonly DocumentReplacement[]):Range[]|null{
 const result:Range[]=[];
 for(const item of replacements){
  const start=value.indexOf(item.find),next=start<0?-1:value.indexOf(item.find,start+item.find.length);
  if(start<0||next>=0)return null;
  result.push({start,end:start+item.find.length,replace:item.replace});
 }
 result.sort((a,b)=>a.start-b.start);
 for(let index=1;index<result.length;index++)if(result[index]!.start<result[index-1]!.end)return null;
 return result;
}
function apply(value:string,planned:readonly Range[]):string{let output='',at=0;for(const range of planned){output+=value.slice(at,range.start)+range.replace;at=range.end;}return output+value.slice(at);}
function lineBlock(value:string,range:Range):string{const start=value.lastIndexOf('\n',range.start-1)+1,end=value.indexOf('\n',range.end);return value.slice(start,end<0?value.length:end);}
/** External changes elsewhere are preserved, but an anchor whose own line block
 * changed is treated as overlapping and rejected. Same-line concurrent edits are
 * therefore conservative conflicts rather than silent partial overwrites. */
function stable(base:string,current:string,source:readonly Range[],target:readonly Range[]):boolean{
 if(source.length!==target.length)return false;
 for(let index=0;index<source.length;index++)if(lineBlock(base,source[index]!)!==lineBlock(current,target[index]!))return false;
 return true;
}
/** Reads and edits one externally stored document without replacing a version
 * the user did not see. Propose observes the exact revision and anchors; confirm
 * re-reads, applies the anchors to the current text (preserving unrelated
 * external edits), writes once with the observed revision and verifies the
 * read-back. A missing or ambiguous anchor is a conflict, never a whole-document
 * overwrite. */
export class DocumentEditor{
 private readonly proposals=new Map<string,{request:DocumentEditRequest;baseText:string;baseTextHash:string;requestHash:string;expiresAt:number;claimed:boolean}>();
 constructor(private readonly options:{connector:DocumentConnector|null;now?:()=>number;proposalTtlMs?:number}){}
 private async current(nodeIdValue:string,signal:AbortSignal):Promise<{nodeId:string;revision:string;text:string}|null>{
  try{const parsed=readShape.safeParse(await this.options.connector!.read({nodeId:nodeIdValue},signal));if(!parsed.success||parsed.data.nodeId!==nodeIdValue)return null;return parsed.data;}catch{return null;}
 }
 async read(raw:unknown,signal:AbortSignal):Promise<DocumentResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'DOCUMENT_CONNECTOR_UNAVAILABLE'};
  const parsed=documentReadRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'READ_FAILED',code:'DOCUMENT_REQUEST_INVALID',effect:'NONE'};
  try{const observed=readShape.safeParse(await this.options.connector.read({nodeId:parsed.data.nodeId},signal));if(!observed.success||observed.data.nodeId!==parsed.data.nodeId)return {status:'READ_FAILED',code:'DOCUMENT_READ_INVALID',effect:'NONE'};return {status:'READ',...observed.data,textHash:textHash(observed.data.text)};}
  catch{return {status:'READ_FAILED',code:'DOCUMENT_READ_UNAVAILABLE',effect:'NONE'};}
 }
 async proposeEdit(raw:unknown,signal:AbortSignal):Promise<DocumentResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'DOCUMENT_CONNECTOR_UNAVAILABLE'};
  const parsed=documentEditRequestSchema.safeParse(raw);if(!parsed.success||!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'DOCUMENT_REQUEST_INVALID',effect:'NONE'};
  const request=parsed.data,current=await this.current(request.nodeId,signal);if(!current)return {status:'READ_FAILED',code:signal.aborted?'DOCUMENT_REQUEST_INVALID':'DOCUMENT_READ_UNAVAILABLE',effect:'NONE'};
  if(current.revision!==request.expectedRevision)return {status:'CONFLICT',code:'DOCUMENT_VERSION_CONFLICT',currentRevision:current.revision,effect:'NONE'};
  const planned=ranges(current.text,request.replacements);if(!planned||apply(current.text,planned).length>12000)return {status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT',currentRevision:current.revision,effect:'NONE'};
  const now=(this.options.now??Date.now)(),baseTextHash=textHash(current.text),hash=requestHash(request,baseTextHash),proposalId=randomUUID(),expiresAt=now+(this.options.proposalTtlMs??300000);
  this.proposals.set(proposalId,{request,baseText:current.text,baseTextHash,requestHash:hash,expiresAt,claimed:false});
  if(this.proposals.size>1024)this.proposals.delete(this.proposals.keys().next().value!);
  return {status:'PROPOSED_EDIT',proposalId,nodeId:request.nodeId,baseRevision:current.revision,baseTextHash,replacements:request.replacements,requestHash:hash,expiresAt:new Date(expiresAt).toISOString()};
 }
 async confirm(proposalId:string,signal:AbortSignal):Promise<DocumentResult>{
  if(!this.options.connector)return {status:'BLOCKED_EXTERNAL',code:'DOCUMENT_CONNECTOR_UNAVAILABLE'};
  const proposal=this.proposals.get(proposalId);if(!proposal||proposal.claimed)return {status:'INVALID_PROPOSAL',code:'DOCUMENT_PROPOSAL_UNKNOWN',effect:'NONE'};
  if(proposal.expiresAt<=(this.options.now??Date.now)())return {status:'INVALID_PROPOSAL',code:'DOCUMENT_PROPOSAL_EXPIRED',effect:'NONE'};
  if(!(signal instanceof AbortSignal)||signal.aborted)return {status:'INVALID_PROPOSAL',code:'DOCUMENT_REQUEST_INVALID',effect:'NONE'};
  proposal.claimed=true;
  const current=await this.current(proposal.request.nodeId,signal);if(!current)return {status:'READ_FAILED',code:signal.aborted?'DOCUMENT_REQUEST_INVALID':'DOCUMENT_READ_UNAVAILABLE',effect:'NONE'};
  const baseRanges=ranges(proposal.baseText,proposal.request.replacements),planned=ranges(current.text,proposal.request.replacements);
  if(!baseRanges||!planned||!stable(proposal.baseText,current.text,baseRanges,planned))return {status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT',currentRevision:current.revision,effect:'NONE'};
  const next=apply(current.text,planned);if(next.length>12000)return {status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT',currentRevision:current.revision,effect:'NONE'};
  let update:{nodeId:string;revision:string|number};
  try{update=updateShape.parse(await this.options.connector.update({nodeId:current.nodeId,expectedRevision:current.revision,text:next,requestHash:proposal.requestHash},signal));}catch{return {status:'UNKNOWN',code:'DOCUMENT_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'};}
  if(update.nodeId!==current.nodeId)return {status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_MISMATCH',nodeId:update.nodeId,effect:'UNKNOWN'};
  const expectedRevision=String(update.revision);
  let observed:{nodeId:string;revision:string;text:string};
  try{const parsed=readShape.safeParse(await this.options.connector.read({nodeId:current.nodeId},signal));if(!parsed.success){return {status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_MISMATCH',nodeId:current.nodeId,effect:'UNKNOWN'};}observed=parsed.data;}catch{return {status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_UNAVAILABLE',nodeId:current.nodeId,effect:'UNKNOWN'};}
  if(observed.nodeId!==current.nodeId||observed.revision!==expectedRevision||observed.revision===current.revision||observed.text!==next)return {status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_MISMATCH',nodeId:current.nodeId,effect:'UNKNOWN'};
  return {status:'VERIFIED',nodeId:current.nodeId,revision:observed.revision,mode:current.text===proposal.baseText?'DIRECT':'MERGED',preservedExternalChanges:current.text!==proposal.baseText,textHash:textHash(observed.text)};
 }
}
