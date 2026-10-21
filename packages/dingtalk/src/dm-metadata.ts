import type {DmDiagnosticCounters,DmDiagnosticReason} from './dm-metadata-diagnostics.js';
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';

// Pinned dingtalk-stream2.1.5 constants; this pure parser does not load the SDK.
export const DM_CAPTURE_TOPIC='/v1.0/im/bot/messages/get';
export const DM_CAPTURE_MAX_MS=180000;
const id=z.string().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v));
export const dmCaptureIdentitySchema=z.object({corpId:id,staffId:id,robotCode:id}).strict();
export type DmCaptureIdentity=z.infer<typeof dmCaptureIdentitySchema>;
export const dmMetadataSchema=z.object({
 schemaVersion:z.literal(1),corpId:id,staffId:id,robotCode:id,conversationId:id,conversationType:z.literal('1'),messageId:id,
 providerTime:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),capturedAt:z.string().datetime(),nonceHash:z.string().regex(/^[a-f0-9]{64}$/),
 source:z.literal('DINGTALK_STREAM_ROBOT_CALLBACK'),sdkVersion:z.literal('2.1.5')
}).strict();
export type DmMetadata=z.infer<typeof dmMetadataSchema>;
export function isDmCaptureMarker(text:unknown):text is string{return typeof text==='string'&&/^OA_BIND_DM_V1 [a-f0-9]{32}$/.test(text);}
export function newDmCaptureNonce():string{return randomBytes(16).toString('hex');}
const bodySchema=z.object({
 msgtype:z.literal('text'),msgId:id,chatbotCorpId:id,senderCorpId:id,senderStaffId:id,robotCode:id,conversationId:id,conversationType:z.literal('1'),
 createAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),senderId:id,chatbotUserId:id,text:z.object({content:z.string().max(128)})
});
const callbackSchema=z.object({type:z.literal('CALLBACK'),headers:z.object({topic:z.literal(DM_CAPTURE_TOPIC),messageId:id}),data:z.string()});
// The opt-in untrusted identity observer shares shape validation, not authority.
export const dmCaptureBodySchema=bodySchema,dmCaptureCallbackSchema=callbackSchema,dmCaptureIdSchema=id;
export class DmCaptureFilter {
 private state:'OPEN'|'CAPTURED'|'CLOSED'='OPEN';
 private nonce:string;
 private readonly identity:DmCaptureIdentity;
 private readonly startedMono:number;
 private readonly startedWall:number;
 private readonly windowMs:number;
 constructor(options:{identity:DmCaptureIdentity;nonce:string;windowMs?:number;mono?:()=>number;wall?:()=>number;diagnostics?:DmDiagnosticCounters}){
  this.diagnostics=options.diagnostics;this.identity=dmCaptureIdentitySchema.parse(options.identity);this.nonce=z.string().regex(/^[a-f0-9]{32}$/).parse(options.nonce);
  this.windowMs=z.number().int().positive().max(DM_CAPTURE_MAX_MS).parse(options.windowMs??DM_CAPTURE_MAX_MS);
  this.mono=options.mono??(()=>performance.now());this.wall=options.wall??Date.now;this.startedMono=this.mono();this.startedWall=this.wall();
 }
 private readonly diagnostics:DmDiagnosticCounters|undefined;
 private reject(reason:DmDiagnosticReason):null{this.diagnostics?.reject(reason);return null;}
 private readonly mono:()=>number;
 private readonly wall:()=>number;
 close():void{this.state='CLOSED';this.nonce='';}
 accept(value:unknown):{metadata:DmMetadata;protocolMessageId:string}|null {
  const elapsed=this.mono()-this.startedMono;if(this.state!=='OPEN'||!Number.isFinite(elapsed)||elapsed<0||elapsed>=this.windowMs){this.close();return this.reject('inactive');}
  const callback=callbackSchema.safeParse(value);if(!callback.success)return this.reject('envelope');if(Buffer.byteLength(callback.data.data,'utf8')>32768)return this.reject('frame_size');
  let raw:unknown;try{raw=JSON.parse(callback.data.data) as unknown;}catch{return this.reject('json');}
  if(raw&&typeof raw==='object'&&['content','attachments','downloadCode','fileName','richText','picture'].some(key=>Object.hasOwn(raw,key)))return this.reject('forbidden_payload');
  const body=bodySchema.safeParse(raw);if(!body.success)return this.reject(raw&&typeof raw==='object'&&'conversationType' in raw&&raw.conversationType!=='1'?'not_private':'body_shape');const m=body.data,now=this.wall();
  if(m.chatbotCorpId!==this.identity.corpId)return this.reject('chatbot_corp');if(m.senderCorpId!==this.identity.corpId)return this.reject('sender_corp');if(m.senderStaffId!==this.identity.staffId)return this.reject('staff');if(m.robotCode!==this.identity.robotCode)return this.reject('robot');
  if(m.senderId===m.chatbotUserId)return this.reject('self_robot');if(!isDmCaptureMarker(m.text.content))return this.reject('nonce_format');if(m.text.content!=='OA_BIND_DM_V1 '+this.nonce)return this.reject('nonce_value');
  if(!Number.isSafeInteger(now)||Math.abs(now)>8640000000000000||m.createAt<this.startedWall-5000||m.createAt>now+5000||now-m.createAt>DM_CAPTURE_MAX_MS)return this.reject('time');
  const finalElapsed=this.mono()-this.startedMono;if(!Number.isFinite(finalElapsed)||finalElapsed<0||finalElapsed>=this.windowMs){this.close();return this.reject('inactive');}
  const metadata=dmMetadataSchema.parse({schemaVersion:1,...this.identity,conversationId:m.conversationId,conversationType:'1',messageId:m.msgId,providerTime:m.createAt,capturedAt:new Date(now).toISOString(),nonceHash:createHash('sha256').update(this.nonce).digest('hex'),source:'DINGTALK_STREAM_ROBOT_CALLBACK',sdkVersion:'2.1.5'});
  this.diagnostics?.increment('accepted');this.state='CAPTURED';this.nonce='';return {metadata,protocolMessageId:callback.data.headers.messageId};
 }
}
