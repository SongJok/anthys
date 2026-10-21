import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {hash} from '../packages/storage/src/crypto.js';
// Reuses the existing synthetic cluster without touching passwords, Compose or .env.
const prepared=JSON.parse(await readFile('.data/test-environment/environment.json','utf8')) as Record<string,string>;
if(prepared['APP_ENV']!=='test'||prepared['OA_TEST_ISOLATED']!=='true')throw Error('TEST_ISOLATION_REQUIRED');
for(const [name,role] of [['DATABASE_URL','oa_app'],['RUNTIME_DATABASE_URL','oa_runtime'],['QUEUE_DATABASE_URL','oa_queue'],['MIGRATION_DATABASE_URL','oa_migrator']]){const url=new URL(prepared[name!]!);if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='64711'||url.pathname!=='/anthys_test'||url.username!==role||url.password.length<32||url.search||url.hash)throw Error('TEST_DATABASE_TARGET_REJECTED');}
const client=new pg.Client({connectionString:prepared['MIGRATION_DATABASE_URL']});await client.connect();
try{
 await client.query("SELECT pg_advisory_lock(hashtext('anthys_migrations'))");
 const names=(await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort(),rows=(await client.query('SELECT name,hash FROM schema_migrations ORDER BY name')).rows;
 if(rows.some(r=>!names.includes(r.name as string)))throw Error('TEST_UNEXPECTED_MIGRATION');
 for(const name of names){const sql=await readFile('db/migrations/'+name,'utf8'),digest=hash(sql),old=rows.find(r=>r.name===name);if(old){if(old.hash!==digest)throw Error('TEST_MIGRATION_DRIFT:'+name);continue;}
  await client.query('BEGIN');try{await client.query(sql);await client.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)',[name,digest]);await client.query('COMMIT');console.log(JSON.stringify({applied:name,hash:digest,target:'LOCAL_SYNTHETIC_64711'}));}catch(error){await client.query('ROLLBACK');throw error;}
 }
 console.log(JSON.stringify({status:'PASS',migrations:names.length,passwordChanges:0,enterpriseOperations:0}));
}finally{await client.query("SELECT pg_advisory_unlock(hashtext('anthys_migrations'))");await client.end();}
