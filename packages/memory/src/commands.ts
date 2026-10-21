import {z} from 'zod';
import {preferenceInput,preferenceBody,type PreferenceInput} from './schema.js';
export type MemoryCommand={action:'HELP'}|{action:'SAVE';input:PreferenceInput}|{action:'CORRECT';id:string;version:number;content:string}|{action:'FORGET';id:string};
export function memoryCommand(text:string):MemoryCommand|null{
 const value=text.trim();if(/^\/memory(?:\s|$)/i.test(value)){const save=/^\/memory\s+save\s+([\s\S]+)$/i.exec(value);if(save){try{return {action:'SAVE',input:preferenceInput.parse(JSON.parse(save[1]!))};}catch{return {action:'HELP'};}}return {action:'HELP'};}
 const remember=/^(?:请)?记住[：:]\s*([\s\S]+)$/u.exec(value);if(remember){try{return {action:'SAVE',input:preferenceInput.parse({kind:'PREFERENCE',title:'个人偏好',content:remember[1],sensitivity:'CONFIDENTIAL',allowModel:true})};}catch{return {action:'HELP'};}}
 const forget=/^(?:请)?忘记(?:记忆)?\s+([0-9a-f-]{36})[。！!]?$/iu.exec(value);if(forget){const id=z.uuid().safeParse(forget[1]?.toLowerCase());return id.success?{action:'FORGET',id:id.data}:{action:'HELP'};}
 const correct=/^(?:请)?纠正记忆\s+([0-9a-f-]{36})\s+版本\s*(\d+)[：:]\s*([\s\S]+)$/iu.exec(value);if(correct){const id=z.uuid().safeParse(correct[1]?.toLowerCase()),version=Number(correct[2]),body=preferenceBody.safeParse({title:'个人偏好',content:correct[3]});return id.success&&Number.isSafeInteger(version)&&version>0&&body.success?{action:'CORRECT',id:id.data,version,content:body.data.content}:{action:'HELP'};}
 if(/^(?:请)?(?:记住[：:]|纠正记忆\s|忘记记忆\s)/u.test(value))return {action:'HELP'};return null;
}
