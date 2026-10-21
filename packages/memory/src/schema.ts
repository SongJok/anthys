import {z} from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value));
export const preferenceBody=z.object({title:text(160),content:text(4000)}).strict();
export const preferenceInput=preferenceBody.extend({kind:z.literal('PREFERENCE'),sensitivity:z.enum(['INTERNAL','CONFIDENTIAL','RESTRICTED']),allowModel:z.boolean(),validFrom:z.iso.datetime().optional(),validTo:z.iso.datetime().optional()}).strict();
export type PreferenceInput=z.infer<typeof preferenceInput>;
export const memoryQuery=z.object({query:z.string().trim().max(1000).default(''),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const memoryPolicy=z.object({schemaVersion:z.literal(1),id:z.string().min(1),defaultDays:z.number().int().min(1).max(365),maximumDays:z.number().int().min(1).max(365),scanLimit:z.number().int().min(50).max(500),auditMetadataDays:z.literal(180),backupRetentionDays:z.number().int().positive().nullable(),backupReviewReference:z.string().min(1).nullable()}).strict().refine(v=>v.defaultDays<=v.maximumDays&&(v.backupRetentionDays===null)===(v.backupReviewReference===null));
export type MemoryPolicy=z.infer<typeof memoryPolicy>;
export const defaultMemoryPolicy:MemoryPolicy={schemaVersion:1,id:'private-preference-v1',defaultDays:90,maximumDays:365,scanLimit:200,auditMetadataDays:180,backupRetentionDays:null,backupReviewReference:null};
export const memoryRequestKey=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const memoryIfMatch=z.string().regex(/^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/);
export function tokenize(value:string){const segmenter=new Intl.Segmenter('zh',{granularity:'word'});return [...new Set([...segmenter.segment(value.normalize('NFKC').toLowerCase())].filter(s=>s.isWordLike).map(s=>s.segment))].sort();}
export function relevance(query:string,tokens:string[]){return tokenize(query).reduce((score,word)=>score+(tokens.includes(word)?1:0),0);}
