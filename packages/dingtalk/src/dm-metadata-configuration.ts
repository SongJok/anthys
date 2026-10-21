import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {z} from 'zod';
import {secret} from '../../config/src/index.js';
import {dmCaptureIdentitySchema} from './dm-metadata.js';
import {DmCaptureError} from './dm-metadata-file.js';
// Nonblocking open rejects pipes/devices before reading. Async bounded reads keep
// the parent CLI deadline runnable even when a credential mount is unavailable.
async function readRegular(path:string,maxBytes:number):Promise<string>{
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>maxBytes)throw Error('FILE');
  const bytes=Buffer.alloc(maxBytes+1);let length=0;
  while(length<bytes.length){const result=await file.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
  if(length>maxBytes)throw Error('SIZE');return bytes.subarray(0,length).toString('utf8');
 }finally{await file.close();}
}
const captureAliases:Readonly<Record<string,string>>={DINGTALK_CLIENT_ID:'DINGTALK_APP_KEY',DINGTALK_CLIENT_SECRET:'DINGTALK_APP_SECRET'};
async function captureSecret(name:string,env:NodeJS.ProcessEnv):Promise<string|undefined>{
 for(const key of [name,captureAliases[name]]){if(!key)continue;const path=env[key+'_FILE'];if(path)return (await readRegular(path,4096)).trim();}
 return secret(name,env);
}
export async function readDmCaptureConfiguration(envFile:string){
 try{
  const path=resolve(envFile),parsed=parseEnv(await readRegular(path,1024*1024)),selected:NodeJS.ProcessEnv={};
  for(const name of ['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_APP_KEY','DINGTALK_APP_SECRET','DINGTALK_CORP_ID','DINGTALK_ROBOT_CODE','STAFFID','DINGTALK_STAFFID','DINGTALK_STAFF_ID']){
   if(parsed[name]!==undefined)selected[name]=parsed[name];if(parsed[name+'_FILE'])selected[name+'_FILE']=resolve(dirname(path),parsed[name+'_FILE']!);
  }
  const staff=(await Promise.all(['STAFFID','DINGTALK_STAFFID','DINGTALK_STAFF_ID'].map(k=>captureSecret(k,selected)))).filter((x):x is string=>!!x);if(new Set(staff).size!==1)throw Error('IDENTITY');
  const identity=dmCaptureIdentitySchema.parse({corpId:await captureSecret('DINGTALK_CORP_ID',selected),staffId:staff[0],robotCode:await captureSecret('DINGTALK_ROBOT_CODE',selected)}),credentials=z.object({clientId:z.string().min(1).max(512),clientSecret:z.string().min(1).max(4096)}).strict().parse({clientId:await captureSecret('DINGTALK_CLIENT_ID',selected),clientSecret:await captureSecret('DINGTALK_CLIENT_SECRET',selected)});
  return {identity,credentials};
 }catch{throw new DmCaptureError('DM_CAPTURE_CONFIGURATION_INVALID');}
}
