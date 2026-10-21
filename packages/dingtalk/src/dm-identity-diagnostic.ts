import {createHash} from 'node:crypto';
import {z} from 'zod';
import {DM_CAPTURE_MAX_MS,dmCaptureBodySchema,dmCaptureCallbackSchema,dmCaptureIdSchema,dmCaptureIdentitySchema,isDmCaptureMarker,type DmCaptureIdentity} from './dm-metadata.js';
import type {DmDiagnosticCounters,DmDiagnosticReason} from './dm-metadata-diagnostics.js';

export const dmIdentityDiagnosticSchema=z.object({
 schemaVersion:z.literal(1),type:z.literal('UNTRUSTED_IDENTITY_DIAGNOSTIC'),trusted:z.literal(false),
 chatbotCorpId:dmCaptureIdSchema,senderCorpId:dmCaptureIdSchema,senderStaffId:dmCaptureIdSchema,robotCode:dmCaptureIdSchema,
 providerTime:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),capturedAt:z.string().datetime(),nonceHash:z.string().length(64).regex(/^[a-f0-9]{64}$/),
 chatbotCorpMatchesConfigured:z.boolean(),senderCorpMatchesConfigured:z.boolean(),sdkVersion:z.literal('2.1.5')
}).strict();
export type DmIdentityDiagnostic=z.infer<typeof dmIdentityDiagnosticSchema>;

/** This observer can never issue DmMetadata or increment accepted/ACK counters. */
export class DmIdentityDiagnosticFilter {
 private active=true;private nonce:string;private readonly identity:DmCaptureIdentity;
 private readonly mono:()=>number;private readonly wall:()=>number;private readonly startedMono:number;private readonly startedWall:number;private readonly windowMs:number;
 constructor(private options:{identity:DmCaptureIdentity;nonce:string;windowMs?:number;mono?:()=>number;wall?:()=>number;diagnostics?:DmDiagnosticCounters}){
  this.identity=dmCaptureIdentitySchema.parse(options.identity);this.nonce=z.string().length(32).regex(/^[a-f0-9]{32}$/).parse(options.nonce);
  this.windowMs=z.number().int().positive().max(DM_CAPTURE_MAX_MS).parse(options.windowMs??DM_CAPTURE_MAX_MS);this.mono=options.mono??(()=>performance.now());this.wall=options.wall??Date.now;this.startedMono=this.mono();this.startedWall=this.wall();
 }
 close(){this.active=false;this.nonce='';}
 private reject(reason:DmDiagnosticReason):null{this.options.diagnostics?.reject(reason);return null;}
 accept(value:unknown):DmIdentityDiagnostic|null{
  const elapsed=this.mono()-this.startedMono;if(!this.active||!Number.isFinite(elapsed)||elapsed<0||elapsed>=this.windowMs){this.close();return this.reject('inactive');}
  const callback=dmCaptureCallbackSchema.safeParse(value);if(!callback.success)return this.reject('envelope');if(Buffer.byteLength(callback.data.data,'utf8')>32768)return this.reject('frame_size');
  let raw:unknown;try{raw=JSON.parse(callback.data.data) as unknown;}catch{return this.reject('json');}
  if(raw&&typeof raw==='object'&&['content','attachments','downloadCode','fileName','richText','picture'].some(key=>Object.hasOwn(raw,key)))return this.reject('forbidden_payload');
  const body=dmCaptureBodySchema.safeParse(raw);if(!body.success)return this.reject(raw&&typeof raw==='object'&&'conversationType'in raw&&raw.conversationType!=='1'?'not_private':'body_shape');const m=body.data,now=this.wall();
  // All non-corporation checks precede any projection of raw identifiers.
  if(m.senderStaffId!==this.identity.staffId)return this.reject('staff');if(m.robotCode!==this.identity.robotCode)return this.reject('robot');if(m.senderId===m.chatbotUserId)return this.reject('self_robot');
  if(!isDmCaptureMarker(m.text.content))return this.reject('nonce_format');if(m.text.content!=='OA_BIND_DM_V1 '+this.nonce)return this.reject('nonce_value');
  if(!Number.isSafeInteger(now)||Math.abs(now)>8640000000000000||m.createAt<this.startedWall-5000||m.createAt>now+5000||now-m.createAt>DM_CAPTURE_MAX_MS)return this.reject('time');
  const finalElapsed=this.mono()-this.startedMono;if(!Number.isFinite(finalElapsed)||finalElapsed<0||finalElapsed>=this.windowMs){this.close();return this.reject('inactive');}
  const chatbotCorpMatchesConfigured=m.chatbotCorpId===this.identity.corpId,senderCorpMatchesConfigured=m.senderCorpId===this.identity.corpId;
  if(!chatbotCorpMatchesConfigured)this.options.diagnostics?.reject('chatbot_corp');else if(!senderCorpMatchesConfigured)this.options.diagnostics?.reject('sender_corp');
  const result=dmIdentityDiagnosticSchema.parse({schemaVersion:1,type:'UNTRUSTED_IDENTITY_DIAGNOSTIC',trusted:false,chatbotCorpId:m.chatbotCorpId,senderCorpId:m.senderCorpId,senderStaffId:m.senderStaffId,robotCode:m.robotCode,providerTime:m.createAt,capturedAt:new Date(now).toISOString(),nonceHash:createHash('sha256').update(this.nonce).digest('hex'),chatbotCorpMatchesConfigured,senderCorpMatchesConfigured,sdkVersion:'2.1.5'});
  this.close();return result;
 }
}
