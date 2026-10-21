import './isolation.js';
import type pg from 'pg';
import type {DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
const [mode,bindingText,eventText]=process.argv.slice(2),binding=JSON.parse(bindingText!) as {tenantId:string;corpId:string;robotCode:string},event=JSON.parse(eventText!) as DWClientDownStream,db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
if(!['before-commit','after-commit'].includes(mode!))throw Error('INVALID_PERSONA_PROCESS_MODE');
if(mode==='before-commit'){const scope=db.scope.bind(db);db.scope=<T>(ctx:DbContext,fn:(c:pg.PoolClient)=>Promise<T>)=>scope(ctx,c=>fn(new Proxy(c,{get(target,key,receiver){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO persona_revisions')){process.stdout.write('PERSONA_UNCOMMITTED\n');await new Promise(()=>{});}return result;};return Reflect.get(target,key,receiver);}})));}
const result=await new DingTalkIngress(db,vault,binding).acceptTrustedCallback(event);if(!result)throw Error('PERSONA_PROCESS_NO_RECEIPT');process.stdout.write('PERSONA_COMMITTED\n');setInterval(()=>{},1000);await new Promise(()=>{});
