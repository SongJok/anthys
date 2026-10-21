import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sources={S01:'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash',S02:'https://docs.z.ai/guides/capabilities/thinking-mode',S03:'https://docs.z.ai/api-reference/llm/chat-completion',S04:'https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/',S05:'https://raw.githubusercontent.com/open-dingtalk/dingtalk-stream-sdk-nodejs/master/README.md',S09:'https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/README.md',S12:'https://modelcontextprotocol.io/specification/2026-07-28',S14:'https://www.postgresql.org/docs/17/ddl-rowsecurity.html',S15:'https://raw.githubusercontent.com/timgit/pg-boss/master/README.md',S16:'https://nodejs.org/en/about/previous-releases'};
await mkdir('config/sources',{recursive:true});
const entries=await Promise.all(Object.entries(sources).map(async([id,url])=>{
 try {const r=await fetch(url,{signal:AbortSignal.timeout(20000)});const body=await r.text();if(!r.ok) throw Error('HTTP_'+r.status);await writeFile(`config/sources/${id}.txt`,body);return {id,url,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(body).digest('hex'),path:`config/sources/${id}.txt`,status:'FETCHED',isLiveVerification:false};}
 catch(e){return{id,url,retrievedAt:new Date().toISOString(),status:'BLOCKED_EXTERNAL',reason:e.message,isLiveVerification:false};}
}));
await writeFile('config/source-snapshot.json',JSON.stringify(entries,null,2)+'\n');console.log(entries.map(({id,status})=>({id,status})));
