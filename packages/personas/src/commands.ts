import {z} from 'zod';
import {personaPatch,type PersonaPatch} from './schema.js';
export type PersonaCommand={action:'ERASE'}|{action:'HELP'}|{action:'CLARIFY';patch?:PersonaPatch}|{action:'RESOLVE';scope:'USER'|'GROUP'|'GLOBAL';proposalId?:string}|{action:'CANCEL'}|{action:'VIEW';scope:'USER'|'GROUP'|'GLOBAL'}|{action:'SET';scope:'USER'|'GROUP'|'GLOBAL';patch:PersonaPatch};
const scopes:Record<string,'USER'|'GROUP'|'GLOBAL'>={personal:'USER',user:'USER',个人:'USER',我的:'USER',group:'GROUP',本群:'GROUP',global:'GLOBAL',企业:'GLOBAL'};
const roles:Record<string,string>={企业助理:'ENTERPRISE_ASSISTANT',群事务秘书:'GROUP_SECRETARY',数据分析助理:'DATA_ANALYST',BI:'DATA_ANALYST',技术排障助理:'TECH_TROUBLESHOOTER',SRE:'SRE_REVIEWER','SRE 架构与事故协调':'SRE_REVIEWER',PMO:'PMO_COORDINATOR',PMO项目协调:'PMO_COORDINATOR'};
const tones:Record<string,string>={直接:'DIRECT',友好:'FRIENDLY',正式:'FORMAL',中性:'NEUTRAL'},lengths:Record<string,string>={简短:'SHORT',适中:'BALANCED',详细:'DETAILED'};
// This bounded, deterministic setting grammar never classifies ordinary tasks
// or trusts a user's claim of authority. Ambiguous requests ask for a scope;
// only the actual encrypted Stream inbox can reach the persistent writer.
export function personaCommand(text:string):PersonaCommand|null{
 if(/^(?:彻底删除我的人设(?:及历史)?|擦除我的人设(?:及历史)?|\/persona\s+personal\s+erase)[。！!]?$/u.test(text.trim()))return {action:'ERASE'};
 const confirmation=/^确认人设\s+(\S+)\s+(个人|本群|企业)[。！!]?$/u.exec(text.trim());if(confirmation){const id=z.uuid().safeParse(confirmation[1]?.toLowerCase());return id.success?{action:'RESOLVE',scope:scopes[confirmation[2]!]!,proposalId:id.data}:{action:'HELP'};}if(text.trim().startsWith('确认人设'))return {action:'HELP'};
 const value=text.trim();if(/^(?:取消人设设置|\/persona\s+cancel)[。！!]?$/i.test(value))return {action:'CANCEL'};const reply=/^(个人|本群|企业)[。！!]?$/u.exec(value);if(reply)return {action:'RESOLVE',scope:scopes[reply[1]!]!};
 const command=/^(?:\/persona|人设)(?:\s+(personal|user|group|global|个人|我的|本群|企业))?(?:\s+(view|查看|set|设置)(?:\s+([\s\S]+))?)?$/i.exec(value);
 if(command){const scope=scopes[command[1]?.toLowerCase()??''];if(!command[2]||['view','查看'].includes(command[2].toLowerCase()))return command[3]?{action:'HELP'}:scope?{action:'VIEW',scope}:{action:'CLARIFY'};try{const patch=personaPatch.parse(JSON.parse(command[3]??''));return scope?{action:'SET',scope,patch}:{action:'CLARIFY',patch};}catch{return {action:'HELP'};}}
 const natural=/^(?:请)?(?:把)?(我的|个人|本群|企业)(?:的)?助理(?:角色)?(?:切换为|切换成|改为|改成|设置为)\s*([^。！!]+)[。！!]?$/i.exec(value);
 if(natural){const role=roles[natural[2]!.trim().toUpperCase()]??roles[natural[2]!.trim()];return role?{action:'SET',scope:scopes[natural[1]!]!,patch:personaPatch.parse({role})}:{action:'HELP'};}
 const preference=/^(?:请)?(?:把)?(我的|个人|本群|企业)(?:的)?助理(?:的)?(语气|回答长度)(?:改为|改成|设置为)\s*([^。！!]+)[。！!]?$/i.exec(value);
 if(preference){const field=preference[2]==='语气'?'tone':'length',choice=(field==='tone'?tones:lengths)[preference[3]!.trim()];return choice?{action:'SET',scope:scopes[preference[1]!]!,patch:personaPatch.parse({[field]:choice})}:{action:'HELP'};}
 // An explicit assistant-setting sentence may omit its scope, just like a role change.
 // Ordinary requests for a shorter/direct answer remain task instructions, not persistent settings.
 const unscopedPreference=/^(?:请)?(?:把)?助理(?:的)?(语气|回答长度)(?:改为|改成|设置为)[ \t\u3000]*([^。！!\r\n\u2028\u2029]+)[。！!]?$/u.exec(value);
 if(unscopedPreference){const field=unscopedPreference[1]==='语气'?'tone':'length',choices=field==='tone'?tones:lengths,choice=unscopedPreference[2]!.trim();return Object.hasOwn(choices,choice)?{action:'CLARIFY',patch:personaPatch.parse({[field]:choices[choice]})}:{action:'HELP'};}
 if(/^(?:\/persona\b|人设(?:\s|$))/.test(value))return {action:'HELP'};
 const unscoped=/^(?:请)?(?:把)?(?:助理)?(?:角色)?(?:切换为|切换成|改为|改成|设置为)\s*(SRE|BI|PMO|企业助理|群事务秘书|数据分析助理|技术排障助理)[。！!]?$/i.exec(value);if(unscoped)return {action:'CLARIFY',patch:personaPatch.parse({role:roles[unscoped[1]!.toUpperCase()]??roles[unscoped[1]!]})};
 return null;
}
