import pg from 'pg';
import {readdir,readFile} from 'node:fs/promises';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
export async function migrate(url:string,rolePasswordDirectory='.secrets'):Promise<void> {
 const client=new pg.Client({connectionString:url});await client.connect();
 try {
  await client.query("SELECT pg_advisory_lock(hashtext('open_aider_migrations'))");
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const {hash}=await import('../packages/storage/src/crypto.js');
  for(const file of (await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
   const sql=await readFile(`db/migrations/${file}`,'utf8'),digest=hash(sql),existing=await client.query('SELECT hash FROM schema_migrations WHERE name=$1',[file]);
   if(existing.rowCount) {if(existing.rows[0].hash!==digest) throw Error('MIGRATION_DRIFT:'+file);continue;}
   await client.query('BEGIN');
   try {await client.query(sql);await client.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)',[file,digest]);await client.query('COMMIT');console.log('Applied',file);}
   catch(e) {await client.query('ROLLBACK');throw e;}
  }
  for(const [role,name] of [['oa_app','pg_app_password'],['oa_queue','pg_queue_password'],['oa_runtime','pg_runtime_password']] as const) {
   if(process.env['APP_ENV']==='production') continue;
   const pass=(await readFile(`${rolePasswordDirectory}/${name}`,'utf8')).trim();
   const q=await client.query('SELECT format(\'ALTER ROLE %I LOGIN PASSWORD %L\',$1::text,$2::text) sql',[role,pass]);
   await client.query(q.rows[0].sql);
  }
  await client.query('GRANT SELECT ON schema_migrations TO oa_app,oa_runtime');
 } finally {await client.query("SELECT pg_advisory_unlock(hashtext('open_aider_migrations'))");await client.end();}
}
if(import.meta.url===`file://${process.argv[1]}`) {loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url) throw Error('MIGRATION_DATABASE_URL_REQUIRED');await migrate(url);}
