import type {ToolResult} from '../../contracts/src/index.js';
// Called only for the new registered log capability, after its strict result
// contract and current-source proof have passed. Old capability rendering is
// unchanged, including existing persisted final-answer hashes.
export function logResultCitation(result:ToolResult):string{
 if(result.data===undefined)return '未取得日志查询回执，未声称日志访问成功';
 const d=result.data as {queryId:string;query:{service:string;environment:string;start:string;end:string};timezone:string;totalCount:number|null;sampling:{sampled:boolean;rate:number|null};truncated:boolean;partial:boolean};
 return `日志查询 ${d.queryId} · 服务 ${d.query.service} · 环境 ${d.query.environment} · UTC窗口 ${d.query.start} 至 ${d.query.end} · 来源时区 ${d.timezone} · 采样 ${d.sampling.sampled?'是':'否'}（比例 ${d.sampling.rate===null?'UNKNOWN':d.sampling.rate}） · 截断 ${d.truncated?'是':'否'} · 上游部分响应标记 ${d.partial?'是':'否'} · 总数 ${d.totalCount===null?'UNKNOWN':d.totalCount} · 部署与代码版本关联 UNVERIFIED`;
}
