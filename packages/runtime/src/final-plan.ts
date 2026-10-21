import {z} from 'zod';
export const finalRefSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('TOOL_CALL'),id:z.string().min(1).max(512)}).strict(),
 z.object({kind:z.literal('ACTION'),id:z.uuid()}).strict()
]);
const reference={ref:finalRefSchema};
const observation={...reference,pointer:z.string().max(2048),coverage:z.enum(['OBSERVED','COMPLETE'])};
export const finalClaimSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('LIMITATION'),ref:z.object({kind:z.literal('ACTION'),id:z.uuid()}).strict(),expectedReason:z.string().min(1).max(128)}).strict(),
 z.object({kind:z.literal('VALUE'),...observation,expected:z.json()}).strict(),
 z.object({kind:z.literal('QUOTE'),...observation,quote:z.string().min(1).max(8192)}).strict(),
 z.object({kind:z.literal('STATUS'),...reference,expected:z.enum(['OK','PARTIAL','EMPTY','NEEDS_AUTH','NEEDS_APPROVAL','DENIED','RETRYABLE_ERROR','PERMANENT_ERROR','UNKNOWN'])}).strict(),
 z.object({kind:z.literal('ACTION'),...reference,expected:z.enum(['VERIFIED','FAILED','PREPARED','UNKNOWN','EXECUTING','APPROVAL_REQUIRED','APPROVED','APPLIED_UNVERIFIED'])}).strict()
]);
export const finalPlanSchema=z.object({schemaVersion:z.literal(1),mode:z.enum(['CONVERSATION','REPORT','CLARIFICATION','SOURCE_CHOICE']),text:z.string().max(24000),claims:z.array(finalClaimSchema).max(120),outcome:z.enum(['COMPLETE','PARTIAL','CLARIFICATION']),sourceChoice:z.object({ref:finalRefSchema}).strict().optional()}).strict();
export type FinalPlan=z.infer<typeof finalPlanSchema>;
export type FinalClaim=z.infer<typeof finalClaimSchema>;
export type FinalRef=z.infer<typeof finalRefSchema>;
export class FinalAnswerError extends Error {constructor(readonly code:string){super(code);this.name='FinalAnswerError';}}
export function safeSocialReply(goal:string,text:string):boolean{
 // Positive admission for a very small, non-business social exchange. Arbitrary
 // prose never gains authority just by naming itself CONVERSATION. General
 // narrative needs separate semantic review, not a growing blacklist of verbs.
 const normalize=(v:string)=>v.normalize('NFKC').trim();
 return /^(?:你好|您好|嗨|谢谢|多谢|hi|hello|thanks|thank you)[!！。,.，?？\s]*$/i.test(normalize(goal))&&/^(?:你好|您好|嗨|不客气|很高兴见到你|hello|hi|you are welcome|you're welcome)[!！。,.，\s]*$/i.test(normalize(text));
}
export function parseFinalPlan(content:string):FinalPlan{
 if(Buffer.byteLength(content,'utf8')>96000)throw new FinalAnswerError('FINAL_OUTPUT_TOO_LARGE');
 let candidate:unknown;try{candidate=JSON.parse(content);}catch{
  if(content.trim().startsWith('{')||content.includes('"schemaVersion"'))throw new FinalAnswerError('FINAL_PLAN_INVALID');
  return {schemaVersion:1,mode:'CONVERSATION',text:content,claims:[],outcome:'COMPLETE'};
 }
 const parsed=finalPlanSchema.safeParse(candidate);if(!parsed.success)throw new FinalAnswerError('FINAL_PLAN_INVALID');return parsed.data;
}
// This guard complements typed action claims; it is deliberately not represented
// as an all-language semantic proof. Enterprise factual quality still needs eval.
export function assertNoUnbackedActionProse(text:string):void{
 const normalized=text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'');
 if(/(?:已经|已|成功)(?:为.{0,30})?(?:发送|创建|删除|修改|提交|撤销|取消|安排|开通|付款|转账|保存|执行)|(?:我会|我将|以后|每天|每周|持续)(?:.{0,30})(?:提醒|监控|通知|催办)|\b(?:I(?:'ve| have)?|we(?:'ve| have)?)\s+(?:successfully\s+)?(?:sent|created|deleted|updated|submitted|cancelled|canceled|scheduled|paid|executed)|\b(?:I|we)\s+(?:will|shall)\s+(?:keep\s+)?(?:monitor|remind|notify|send|schedule)\b/i.test(normalized))throw new FinalAnswerError('UNBACKED_ACTION_PROSE');
}
export function readFinalPointer(data:unknown,pointer:string):unknown{
 if(pointer==='')return data;if(!pointer.startsWith('/'))throw new FinalAnswerError('FINAL_POINTER_INVALID');let value=data;
 for(const encoded of pointer.slice(1).split('/')){
  if(/~(?![01])/u.test(encoded))throw new FinalAnswerError('FINAL_POINTER_INVALID');const key=encoded.replace(/~1/g,'/').replace(/~0/g,'~');
  if(['__proto__','prototype','constructor'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new FinalAnswerError('FINAL_POINTER_MISSING');
  value=(value as Record<string,unknown>)[key];
 }
 if(value===undefined)throw new FinalAnswerError('FINAL_POINTER_MISSING');return value;
}
export const FINAL_PLAN_PROMPT='For a business answer grounded in tool results, final content must be JSON {schemaVersion:1,mode:"REPORT",text:"",claims:[...],outcome:"COMPLETE"|"PARTIAL"}. If a reviewed choice-enabled READ adapter returns multiple ambiguous candidates, use {schemaVersion:1,mode:"SOURCE_CHOICE",text:"",claims:[],outcome:"CLARIFICATION",sourceChoice:{ref:{kind:"TOOL_CALL",id:the exact tool_call_id} or {kind:"ACTION",id:an action ID from the current checkpoint}}}. The server derives and binds all options/labels/next READ arguments from that receipt; never supply your own options or use GENERAL/CLARIFICATION to launder tool data. Ask only when a user selection is needed for the goal. Claims: VALUE {kind,ref:{kind:"TOOL_CALL",id:the exact tool_call_id} or {kind:"ACTION",id:an action ID from the current checkpoint},pointer:JSON Pointer into result.data,expected:the exact JSON value,coverage:"COMPLETE"|"OBSERVED"}; QUOTE uses quote instead of expected, exact source substring; STATUS {kind,ref,expected:actual ToolResult.status}; ACTION {kind,ref,expected:actual ledger state}; LIMITATION {kind,ref:{kind:"ACTION",id:an omitted checkpoint action},expectedReason:the exact omission reason}. REPORT.text must be empty: unsupported free narrative is rejected, not silently rewritten. Do not invent references, URLs, metrics or action success. Never infer a complete population from sampled/truncated/unknown results. For ordinary general knowledge, writing or guidance with no enterprise source or action claims, use {schemaVersion:1,mode:"CONVERSATION",text:your answer,claims:[],outcome:"COMPLETE"}; a separate budgeted review must admit it. For material missing user information, use {schemaVersion:1,mode:"CLARIFICATION",text:the relevant question,claims:[],outcome:"CLARIFICATION"}; the task pauses until an authenticated reply. A clarification is not goal completion. Neither mode may launder tool data, promise future work or assert an unexecuted action. General review admission is not source/semantic factual certification. Do not promise future monitoring, messages or reminders without a persisted authorized action; verified action statements are rendered from ACTION claims, never prose.';
