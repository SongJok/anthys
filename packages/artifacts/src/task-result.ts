import {z} from 'zod';
import type {ArtifactRequest} from './index.js';
const source=z.object({verification:z.enum(['VERIFIED','PARTIAL','UNVERIFIED']),asOf:z.iso.datetime({offset:true}),notice:z.string().min(1).max(2048)}).strict();
const input=z.object({format:z.enum(['md','txt','csv','json','html','xlsx','docx','pdf']),title:z.string().trim().min(1).max(10000),result:z.string().min(1).max(1048576),source}).strict();
/** Pure projection of a separately authorized persisted result. This adapter
 * neither grants access nor parses/recomputes numbers from generated prose. */
export function taskResultArtifactRequest(raw:unknown):ArtifactRequest{
 const r=input.parse(raw),lines=r.result.replace(/\r\n?/g,'\n').split('\n'),notice=`来源核验状态：${r.source.verification}；截至 ${r.source.asOf}。${r.source.notice}`;
 if(!r.result.trim()||lines.length>997||lines.some(v=>v.length>16384))throw Error('ARTIFACT_RESULT_LIMIT');
 if(r.format==='csv'||r.format==='xlsx')return {format:r.format,title:r.title,paragraphs:[],table:{columns:[{name:'line',type:'integer'},{name:'content',type:'text'}],rows:[[0,notice],...lines.map((text,i)=>[i+1,text])]}};
 return {format:r.format==='md'?'markdown':r.format,title:r.title,paragraphs:[notice,...lines]};
}
