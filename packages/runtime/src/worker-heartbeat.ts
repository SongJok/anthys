import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
export const workerHeartbeatMaxAgeMs=30_000;
export const workerHeartbeatMinIntervalMs=5_000;
export async function writeWorkerHeartbeat(path:string,now:number=Date.now()):Promise<void>{
 await writeFile(path,String(now),{mode:0o600});
}
export function isWorkerHeartbeatFresh(path:string,maxAgeMs:number=workerHeartbeatMaxAgeMs,now:number=Date.now()):boolean{
 let content:string;
 try{content=readFileSync(path,'utf8').trim();}catch{return false;}
 if(content==='')return false;
 const recorded=Number(content);
 if(!Number.isFinite(recorded))return false;
 return now-recorded<=maxAgeMs;
}
export function createWorkerHeartbeat(path:string,minIntervalMs:number=workerHeartbeatMinIntervalMs):{write(now?:number):Promise<boolean>}{
 let writtenAt:number|undefined;
 return {async write(now:number=Date.now()):Promise<boolean>{
  if(writtenAt!==undefined&&now-writtenAt<minIntervalMs)return false;
  await writeWorkerHeartbeat(path,now);
  writtenAt=now;
  return true;
 }};
}
