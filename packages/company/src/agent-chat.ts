import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

const MAX_WAIT_MS=20*60*1000;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
/** Input-schema hash only: deliberately distinct from the old scoped-proxy hash. */
export function agentChatInputSchemaHash(inputSchema:unknown):string{
 let nodes=0;
 const encode=(value:unknown,depth=0):string=>{
  if(++nodes>4096||depth>32)throw Error('AGENT_CHAT_SCHEMA_LIMIT');
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>encode(v,depth+1)).join(',')+']';
  if(typeof value==='object'&&value!==null&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+encode((value as Record<string,unknown>)[key],depth+1)).join(',')+'}';
  throw Error('AGENT_CHAT_SCHEMA_INVALID');
 };
 const encoded=encode(inputSchema);if(Buffer.byteLength(encoded,'utf8')>65536)throw Error('AGENT_CHAT_SCHEMA_LIMIT');return sha(encoded);
}
export type AgentChatDispatchSummary=Readonly<{localRequestId:string;toolName:string;inputSchemaHash:string;messageSha256:string;messageBytes:number;absoluteDeadlineMs:number}>;
export type AgentChatRequest=Readonly<{
 localRequestId:string;message:string;absoluteDeadlineMs:number;maxWaitMs:number;signal:AbortSignal;
 /** Host must commit its attempt before resolving. This client cannot prove durability. */
 beforeDispatch:(summary:AgentChatDispatchSummary,signal:AbortSignal)=>Promise<void>;
 /** Separate bounded roster/source observation, outside the 2s local commit.
  * It does not replace beforeDispatch or extend the business deadline. */
 prepareDispatch?:(signal:AbortSignal)=>Promise<void>;
}>;
export type AgentChatNotSentReason='INVALID_CONFIGURATION'|'INVALID_REQUEST'|'CANCELLED'|'DEADLINE_EXCEEDED'|'DISCOVERY_FAILED'|'DISCOVERY_INCOMPLETE'|'TOOL_NOT_FOUND'|'SCHEMA_CHANGED'|'SCHEMA_UNSUPPORTED'|'HOST_REJECTED'|'CONTROL_TIMEOUT';
export type AgentChatUnknownReason='CANCELLED'|'DEADLINE_EXCEEDED'|'UPSTREAM_ERROR'|'RESPONSE_UNUSABLE'|'RESPONSE_LIMIT'|'TRANSPORT_OR_PROTOCOL_ERROR';
export type AgentChatResult=
 |{status:'NOT_SENT';localRequestId:string|null;reason:AgentChatNotSentReason}
 |{status:'UNKNOWN';localRequestId:string;reason:AgentChatUnknownReason;remoteCancellation:'UNCONFIRMED';localCancellationRequested:boolean}
 |{status:'RESPONSE_RECEIVED';localRequestId:string;text:string;textBlocks:readonly string[];source:{protocol:'MCP';toolName:string;inputSchemaHash:string;receivedAt:string;verification:'UNVERIFIED';notice:string}};
const reviewedSchema=z.object({toolName:z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),inputSchemaHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const limitsSchema=z.object({discoveryTimeoutMs:z.number().int().min(1).max(2000).default(2000),controlTimeoutMs:z.number().int().min(1).max(2000).default(2000),maxResponseBytes:z.number().int().min(1).max(262144).default(262144),maxTextBlocks:z.number().int().min(1).max(64).default(64)}).strict();
const requestSchema=z.object({localRequestId:z.uuid(),message:z.string().min(1).refine(v=>!!v.trim()&&Buffer.byteLength(v,'utf8')<=65536),absoluteDeadlineMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),maxWaitMs:z.number().int().min(1).max(MAX_WAIT_MS),signal:z.instanceof(AbortSignal),beforeDispatch:z.custom<AgentChatRequest['beforeDispatch']>(v=>typeof v==='function'),prepareDispatch:z.custom<NonNullable<AgentChatRequest['prepareDispatch']>>(v=>typeof v==='function').optional()}).strict();
class NotSent extends Error{constructor(readonly code:AgentChatNotSentReason){super(code);}}
class Unusable extends Error{constructor(readonly code:AgentChatUnknownReason){super(code);}}
function timedSignal(parent:AbortSignal,deadline:number){
 const controller=new AbortController(),abort=()=>controller.abort();
 parent.addEventListener('abort',abort,{once:true});if(parent.aborted)abort();
 const timer=setTimeout(abort,Math.max(0,deadline-Date.now()));
 return {signal:controller.signal,close:()=>{clearTimeout(timer);parent.removeEventListener('abort',abort);}};
}
async function interruptible<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 let abort:()=>void=()=>{};
 const cancellation=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('AGENT_CHAT_INTERRUPTED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{return await Promise.race([operation,cancellation]);}finally{signal.removeEventListener('abort',abort);}
}
function supportsMessageOnly(schema:unknown):boolean{
 if(!schema||typeof schema!=='object'||Array.isArray(schema))return false;
 const value=schema as Record<string,unknown>,properties=value['properties'];
 if(value['type']!=='object'||!properties||typeof properties!=='object'||Array.isArray(properties))return false;
 const message=(properties as Record<string,unknown>)['message'];
 if(!message||typeof message!=='object'||Array.isArray(message)||(message as Record<string,unknown>)['type']!=='string')return false;
 const required=value['required'];return required===undefined||Array.isArray(required)&&required.every(key=>key==='message');
}
/** One SDK call per invocation. No remote idempotency, authorization, durable
 * recovery, conversation reuse, business protocol or automatic retry is inferred. */
export class CompanyAgentChat{
 private readonly reviewed:z.infer<typeof reviewedSchema>|undefined;
 private readonly limits:z.infer<typeof limitsSchema>|undefined;
 constructor(private readonly client:Client,reviewed:{toolName:string;inputSchemaHash:string},limits:{discoveryTimeoutMs?:number;controlTimeoutMs?:number;maxResponseBytes?:number;maxTextBlocks?:number}={}){
  const pin=reviewedSchema.safeParse(reviewed),bounds=limitsSchema.safeParse(limits);this.reviewed=pin.success?pin.data:undefined;this.limits=bounds.success?bounds.data:undefined;
 }
 async request(raw:AgentChatRequest):Promise<AgentChatResult>{
  const parsed=requestSchema.safeParse(raw),candidate=raw&&typeof raw==='object'?Reflect.get(raw,'localRequestId'):undefined,id=z.uuid().safeParse(candidate);
  const localRequestId=id.success?id.data:null;
  if(!this.reviewed||!this.limits)return {status:'NOT_SENT',localRequestId,reason:'INVALID_CONFIGURATION'};
  if(!parsed.success)return {status:'NOT_SENT',localRequestId,reason:'INVALID_REQUEST'};
  const input=parsed.data,pin=this.reviewed,limits=this.limits,deadline=Math.min(input.absoluteDeadlineMs,Date.now()+input.maxWaitMs);
  const notSent=(reason:AgentChatNotSentReason):AgentChatResult=>({status:'NOT_SENT',localRequestId:input.localRequestId,reason});
  if(input.signal.aborted)return notSent('CANCELLED');if(deadline<=Date.now())return notSent('DEADLINE_EXCEEDED');
  const business=timedSignal(input.signal,deadline);let started=false,phase:AgentChatNotSentReason='DISCOVERY_FAILED';
  const checkpoint=()=>{business.signal.throwIfAborted();if(Date.now()>=deadline)throw Error('AGENT_CHAT_DEADLINE');};
  try{
   const discoveryDeadline=Math.min(deadline,Date.now()+limits.discoveryTimeoutMs),discovery=timedSignal(business.signal,discoveryDeadline);
   try{
    if(!this.client.getServerCapabilities()?.tools)throw new NotSent('TOOL_NOT_FOUND');
    let cursor:string|undefined,found:unknown;const names=new Set<string>(),cursors=new Set<string>();let complete=false;
    for(let page=0;page<4;page++){
     checkpoint();const remaining=discoveryDeadline-Date.now();if(remaining<=0)throw new NotSent('DISCOVERY_FAILED');
     const listed=await this.client.listTools(cursor?{cursor}:{},{signal:discovery.signal,timeout:remaining,maxTotalTimeout:remaining,resetTimeoutOnProgress:false});
     if(discovery.signal.aborted||Date.now()>=discoveryDeadline)throw new NotSent('DISCOVERY_FAILED');
     if(Buffer.byteLength(JSON.stringify(listed),'utf8')>262144)throw new NotSent('DISCOVERY_INCOMPLETE');
     for(const tool of listed.tools){if(names.has(tool.name)||names.size>=64)throw new NotSent('DISCOVERY_INCOMPLETE');names.add(tool.name);if(tool.name===pin.toolName)found=tool.inputSchema;}
     cursor=listed.nextCursor;if(!cursor){complete=true;break;}if(cursors.has(cursor))throw new NotSent('DISCOVERY_INCOMPLETE');cursors.add(cursor);
    }
    if(!complete)throw new NotSent('DISCOVERY_INCOMPLETE');if(!found)throw new NotSent('TOOL_NOT_FOUND');
    if(agentChatInputSchemaHash(found)!==pin.inputSchemaHash)throw new NotSent('SCHEMA_CHANGED');
    if(!supportsMessageOnly(found))throw new NotSent('SCHEMA_UNSUPPORTED');
    if(discovery.signal.aborted||Date.now()>=discoveryDeadline)throw new NotSent('DISCOVERY_FAILED');
   }finally{discovery.close();}
   checkpoint();phase='HOST_REJECTED';
   if(input.prepareDispatch){const observationDeadline=Math.min(deadline,Date.now()+12000),observation=timedSignal(business.signal,observationDeadline);try{await interruptible(Promise.resolve().then(()=>input.prepareDispatch!(observation.signal)),observation.signal);if(observation.signal.aborted||Date.now()>=observationDeadline)throw new NotSent('CONTROL_TIMEOUT');}finally{observation.close();}checkpoint();}
   const controlDeadline=Math.min(deadline,Date.now()+limits.controlTimeoutMs),control=timedSignal(business.signal,controlDeadline);
   try{await interruptible(Promise.resolve().then(()=>{control.signal.throwIfAborted();return input.beforeDispatch(Object.freeze({localRequestId:input.localRequestId,toolName:pin.toolName,inputSchemaHash:pin.inputSchemaHash,messageSha256:sha(input.message),messageBytes:Buffer.byteLength(input.message,'utf8'),absoluteDeadlineMs:deadline}),control.signal);}),control.signal);if(control.signal.aborted||Date.now()>=controlDeadline)throw new NotSent('CONTROL_TIMEOUT');}
   catch(error){if(control.signal.aborted&&!business.signal.aborted)throw new NotSent('CONTROL_TIMEOUT');throw error;}finally{control.close();}
   checkpoint();const remaining=deadline-Date.now();
   // From this point failure is conservatively UNKNOWN, even if a transport
   // refuses the send: this component has no physical dispatch receipt.
   started=true;
   const reply=CallToolResultSchema.parse(await this.client.callTool({name:pin.toolName,arguments:{message:input.message}},CallToolResultSchema,{signal:business.signal,timeout:remaining,maxTotalTimeout:remaining,resetTimeoutOnProgress:false,onprogress:()=>{}}));
   checkpoint();if(reply.isError)throw new Unusable('UPSTREAM_ERROR');
   if(Buffer.byteLength(JSON.stringify(reply),'utf8')>limits.maxResponseBytes||reply.content.length>limits.maxTextBlocks)throw new Unusable('RESPONSE_LIMIT');
   if(!reply.content.length||reply.content.some(block=>block.type!=='text'))throw new Unusable('RESPONSE_UNUSABLE');
   const textBlocks=reply.content.map(block=>{if(block.type!=='text')throw new Unusable('RESPONSE_UNUSABLE');return block.text;}),text=textBlocks.join('\n');
   if(!text.trim())throw new Unusable('RESPONSE_UNUSABLE');if(Buffer.byteLength(text,'utf8')>limits.maxResponseBytes)throw new Unusable('RESPONSE_LIMIT');
   checkpoint();return {status:'RESPONSE_RECEIVED',localRequestId:input.localRequestId,text,textBlocks,source:{protocol:'MCP',toolName:pin.toolName,inputSchemaHash:pin.inputSchemaHash,receivedAt:new Date().toISOString(),verification:'UNVERIFIED',notice:'上游原始文本，仅确认收到 MCP 回复；不证明身份、权限、事实、根因或外部动作已完成。'}};
  }catch(error){
   const cancelled=input.signal.aborted,expired=Date.now()>=deadline;
   if(!started)return notSent(cancelled?'CANCELLED':expired?'DEADLINE_EXCEEDED':error instanceof NotSent?error.code:phase);
   return {status:'UNKNOWN',localRequestId:input.localRequestId,reason:cancelled?'CANCELLED':expired?'DEADLINE_EXCEEDED':error instanceof Unusable?error.code:'TRANSPORT_OR_PROTOCOL_ERROR',remoteCancellation:'UNCONFIRMED',localCancellationRequested:business.signal.aborted};
  }finally{business.close();}
 }
}
