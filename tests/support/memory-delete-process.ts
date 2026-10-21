import './isolation.js';
import type pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {PrivatePreferences,type MemorySession} from '../../packages/memory/src/service.js';
const [mode,ctxJson,sessionJson,id,key]=process.argv.slice(2),ctx=JSON.parse(ctxJson!) as DbContext,session=JSON.parse(sessionJson!) as MemorySession,db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
if(!['before-commit','after-commit'].includes(mode!))throw Error('MEMORY_DELETE_PROCESS_MODE_INVALID');
if(mode==='before-commit'){const scope=db.scope.bind(db);db.scope=<T>(principal:DbContext,fn:(c:pg.PoolClient)=>Promise<T>)=>scope(principal,c=>fn(new Proxy(c,{get(target,property,receiver){if(property==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO memory_deletions')){process.stdout.write('MEMORY_DELETE_UNCOMMITTED\n');await new Promise(()=>{});}return result;};return Reflect.get(target,property,receiver);}})));}
await new PrivatePreferences(db,vault).forget(ctx,id!,key!,session);process.stdout.write('MEMORY_DELETE_COMMITTED\n');setInterval(()=>{},1000);await new Promise(()=>{});
