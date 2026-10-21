import '../support/isolation.js';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {browserSelfDm} from './self-dm-fixtures.js';
const isolated=await groupReminderDatabase(),vault=new Vault(new Map([['1',randomBytes(32)]]),'1');
let fixture:Awaited<ReturnType<typeof browserSelfDm>>|undefined,closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{try{await fixture?.close();}finally{await isolated.close();}})();
try{
 await isolated.install();const queueUrl=new URL(secret('QUEUE_DATABASE_URL')!);
 assert(queueUrl.protocol==='postgresql:'&&queueUrl.hostname==='127.0.0.1'&&queueUrl.port==='64711'&&queueUrl.pathname==='/anthys_test'&&queueUrl.username==='oa_queue'&&!queueUrl.search&&!queueUrl.hash);
 queueUrl.pathname='/'+isolated.name;
 // Read only the installed PgBoss version metadata from the guarded source.
 // Jobs and business rows stay excluded from this own schema-only nonce.
 const source=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!,max:1,connectionTimeoutMillis:3000});try{const rows=(await source.query('SELECT version FROM oa_queue.version')).rows;assert.equal(rows.length,1);assert.deepEqual((await isolated.root.query('SELECT version FROM oa_queue.version')).rows,[]);await isolated.root.query('INSERT INTO oa_queue.version(version) VALUES($1)',[rows[0].version]);}finally{await source.end();}
 fixture=await browserSelfDm(isolated.db,vault,{appDb:isolated.appDb,admin:isolated.root,queueUrl:queueUrl.href});await fixture.app.listen({host:'127.0.0.1',port:64702});
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close().then(()=>process.exit(0));});
}catch(error){await close();throw error;}
