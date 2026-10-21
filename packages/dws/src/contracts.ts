import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
export class DwsError extends Error{constructor(readonly code:string){super(code);this.name='DwsError';}}
export const subjectPart=z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/);
export const exactProfile=(corp:string,user:string)=>subjectPart.parse(corp)+':'+subjectPart.parse(user);
export const stateSchema=z.object({schemaVersion:z.literal(1),files:z.record(z.string(),z.string())}).strict();
export type DwsState=z.infer<typeof stateSchema>;
export type DwsSubject={corpId:string;userId:string};
export const authStatusSchema=z.object({success:z.literal(true),authenticated:z.literal(true),token_valid:z.literal(true),corp_id:subjectPart,user_id:subjectPart,reason:z.string().optional()}).passthrough();
export const profileListSchema=z.object({success:z.literal(true),profiles:z.array(z.object({profile:z.string(),corpId:subjectPart,userId:subjectPart}).passthrough()).length(1)}).passthrough();
export const meDataSchema=z.object({userId:subjectPart,name:z.string().max(1024).optional(),dept:z.string().max(1024).optional(),org:z.string().max(1024).optional(),mobile:z.string().max(256).optional(),email:z.string().max(512).optional()}).strict();
export const meEnvelopeSchema=z.object({ok:z.literal(true),outcome:z.literal('success'),identity:z.literal('user').optional(),dry_run:z.literal(false).optional(),data:meDataSchema,meta:z.object({count:z.number().int().nonnegative().optional()}).strict().optional(),_notice:z.unknown().optional()}).strict();
export function validateState(state:DwsState,subject:DwsSubject):DwsState{
 const parsed=stateSchema.parse(state),files=Object.entries(parsed.files);if(files.length<2||files.length>24)throw new DwsError('DWS_STATE_INVALID');
 const metadata=['config/profiles.json','config/app.json','config/identity.json','config/token.json'],identityFile='auth-token_id_'+hash(subject.corpId+'\0'+subject.userId)+'.enc',corpFile='auth-token_'+subject.corpId.replace(/[^a-zA-Z0-9._-]/g,'_')+'.enc',clients=new Set<string>();let bytes=0;
 const registry=parsed.files['config/profiles.json'];if(!registry)throw new DwsError('DWS_STATE_INVALID');let profiles:unknown;try{profiles=JSON.parse(Buffer.from(registry,'base64').toString('utf8'));}catch{throw new DwsError('DWS_STATE_INVALID');}
 const p=z.object({profiles:z.array(z.object({corpId:subjectPart,userId:subjectPart,clientId:subjectPart.optional()}).passthrough()).length(1)}).passthrough().safeParse(profiles);if(!p.success||p.data.profiles[0]!.corpId!==subject.corpId||p.data.profiles[0]!.userId!==subject.userId)throw new DwsError('DWS_PROFILE_MISMATCH');if(p.data.profiles[0]!.clientId)clients.add(p.data.profiles[0]!.clientId!);
 if(parsed.files['config/app.json'])try{const app=z.object({clientId:subjectPart}).passthrough().parse(JSON.parse(Buffer.from(parsed.files['config/app.json'],'base64').toString('utf8')));clients.add(app.clientId);}catch{throw new DwsError('DWS_STATE_INVALID');}
 const allowedKeys=new Set(['dek','auth-token.enc',identityFile,corpFile,...[...clients].flatMap(id=>['appsecret_'+id+'.enc','app-token_'+id+'.enc'])].map(name=>'keychain/dws-cli/'+name));
 for(const [path,base64] of files){if(!metadata.includes(path)&&!allowedKeys.has(path))throw new DwsError('DWS_STATE_PATH_DENIED');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new DwsError('DWS_STATE_INVALID');const data=Buffer.from(base64,'base64');bytes+=data.length;if(data.length>65536||bytes>262144)throw new DwsError('DWS_STATE_TOO_LARGE');}
 if(!parsed.files['keychain/dws-cli/dek'])throw new DwsError('DWS_STATE_INVALID');return parsed;
}
export function projectMe(data:z.infer<typeof meDataSchema>){const {userId,name,dept,org}=data;return {userId,...(name?{name}:{}),...(dept?{dept}:{}),...(org?{org}:{})};}
