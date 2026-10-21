import {z} from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(s=>!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s));
export const zone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}});
export const workingHours=z.object({timeZone:zone,days:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(v=>new Set(v).size===v.length),start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)}).strict().refine(v=>v.start<v.end,'WORK_HOURS_RANGE');
export const personaShape={name:text(80),role:z.enum(['ENTERPRISE_ASSISTANT','GROUP_SECRETARY','DATA_ANALYST','TECH_TROUBLESHOOTER','SRE_REVIEWER','PMO_COORDINATOR']),rolePosition:text(240),tone:z.enum(['DIRECT','FRIENDLY','FORMAL','NEUTRAL']),length:z.enum(['SHORT','BALANCED','DETAILED']),address:text(80),responsibilities:z.array(text(512)).max(12),prohibitedImpersonations:z.array(text(160)).max(12),outputTemplate:z.enum(['AUTO','CHECKLIST','REPORT','PLAN']),workingHours};
export const personaFields=z.object(personaShape).partial().strict();
export const personaPatch=z.object(Object.fromEntries(Object.entries(personaShape).map(([key,value])=>[key,value.nullable().optional()])) as {[K in keyof typeof personaShape]:z.ZodOptional<z.ZodNullable<(typeof personaShape)[K]>>}).strict().refine(v=>Object.keys(v).length>0&&Object.values(v).every(value=>value!==undefined),'EMPTY_OR_UNDEFINED_PERSONA_PATCH');
export type PersonaFields=z.infer<typeof personaFields>;
export type PersonaPatch=z.infer<typeof personaPatch>;
export const personaKeys=z.enum(Object.keys(personaShape) as [keyof PersonaFields,...(keyof PersonaFields)[]]);
export const scopeSchema=z.object({kind:z.enum(['GLOBAL','GROUP','USER']),id:text(512)}).strict().refine(v=>v.kind==='GROUP'||z.uuid().safeParse(v.id).success,'SCOPE_ID_INVALID');
export type PersonaScope=z.infer<typeof scopeSchema>;
export const policySchema=z.object({fields:personaFields,lockedFields:z.array(personaKeys).max(10).refine(v=>new Set(v).size===v.length)}).strict().refine(v=>v.lockedFields.every(key=>v.fields[key]!==undefined)&&Object.keys(v.fields).every(key=>v.lockedFields.includes(key as keyof PersonaFields)),'POLICY_FIELDS_MUST_MATCH_LOCKS');
export const requestKey=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const ifMatchSchema=z.string().regex(/^"(?:0|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/);
export const defaults:PersonaFields={name:'anthys',role:'ENTERPRISE_ASSISTANT',tone:'NEUTRAL',length:'BALANCED',outputTemplate:'AUTO',prohibitedImpersonations:['不冒充真实领导或声称获得未经核实的授权']};
export const personaTemplates:Record<NonNullable<PersonaFields['role']>,{label:string;fields:PersonaFields}>={
 ENTERPRISE_ASSISTANT:{label:'企业助理',fields:{role:'ENTERPRISE_ASSISTANT',rolePosition:'提供日常工作指导',outputTemplate:'AUTO'}},
 GROUP_SECRETARY:{label:'群事务秘书',fields:{role:'GROUP_SECRETARY',rolePosition:'整理本群已授权事项与明确分工',tone:'FORMAL',outputTemplate:'CHECKLIST'}},
 DATA_ANALYST:{label:'数据分析助理',fields:{role:'DATA_ANALYST',rolePosition:'解释已获授权的认证统计结果与指标口径',outputTemplate:'REPORT',responsibilities:['优先选择当前有权且已认证的数据模板，说明口径与覆盖限制']}},
 TECH_TROUBLESHOOTER:{label:'技术排障助理',fields:{role:'TECH_TROUBLESHOOTER',rolePosition:'提供基于当前授权证据的排障方案',outputTemplate:'CHECKLIST',responsibilities:['列出可执行检查、依赖、风险和验证方式；建议获认可不等于获准上线']}},
 SRE_REVIEWER:{label:'SRE 架构与事故协调',fields:{role:'SRE_REVIEWER',rolePosition:'架构评审与事故协调',outputTemplate:'CHECKLIST',responsibilities:['在已授权任务内优先选择当前可用代码、日志和审核告警模板；不可用时说明缺口']}},
 PMO_COORDINATOR:{label:'PMO 项目协调',fields:{role:'PMO_COORDINATOR',rolePosition:'协调项目计划、依赖与风险',outputTemplate:'PLAN',responsibilities:['站会催办、待办跟进和风险通知仅在分别具备调度、群合同及发送授权后执行；角色选择本身不创建定时器或发送消息']}}
};
export function composePersona(global:PersonaFields,local:PersonaFields,policy:z.infer<typeof policySchema>={fields:{},lockedFields:[]}){const role=policy.lockedFields.includes('role')?policy.fields.role!:local.role??global.role??defaults.role!,fields=personaFields.parse({...defaults,...personaTemplates[role].fields,...global,...local});for(const key of policy.lockedFields)Reflect.set(fields,key,policy.fields[key]);return fields;}
export function personaFieldSources(global:PersonaFields,local:PersonaFields,policy:z.infer<typeof policySchema>,scope:'GLOBAL'|'GROUP'|'USER'){
 const effective=composePersona(global,local,policy),template=personaTemplates[effective.role!].fields,sources:Partial<Record<keyof PersonaFields,'POLICY'|'GLOBAL'|'GROUP'|'USER'|'TEMPLATE'|'BUILTIN'>>={};for(const key of Object.keys(effective) as (keyof PersonaFields)[])sources[key]=policy.lockedFields.includes(key)?'POLICY':scope!=='GLOBAL'&&local[key]!==undefined?scope:global[key]!==undefined?'GLOBAL':template[key]!==undefined?'TEMPLATE':defaults[key]!==undefined?'BUILTIN':'TEMPLATE';return sources;
}
