import {mkdir,writeFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
await mkdir('.secrets',{recursive:true,mode:0o700});
for (const key of ['pg_admin_password','pg_app_password','pg_queue_password','pg_runtime_password','app_master_key','session_secret']) {
  try { await access(`.secrets/${key}`); } catch {await writeFile(`.secrets/${key}`,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}
}
const {readFile}=await import('node:fs/promises');
const secret=async n=>(await readFile(`.secrets/${n}`,'utf8')).trim();
await writeFile('.secrets/database_url',`postgresql://oa_app:${await secret('pg_app_password')}@127.0.0.1:53330/open_aider`,{mode:0o600});
await writeFile('.secrets/migration_database_url',`postgresql://oa_migrator:${await secret('pg_admin_password')}@127.0.0.1:53330/open_aider`,{mode:0o600});
await writeFile('.secrets/queue_database_url',`postgresql://oa_queue:${await secret('pg_queue_password')}@127.0.0.1:53330/open_aider`,{mode:0o600});
await writeFile('.secrets/runtime_database_url',`postgresql://oa_runtime:${await secret('pg_runtime_password')}@127.0.0.1:53330/open_aider`,{mode:0o600});
try {await writeFile('.env','APP_ENV=development\nAPP_ORIGIN=http://localhost:52330\nPORT=52330\nDATABASE_URL_FILE=.secrets/database_url\nMIGRATION_DATABASE_URL_FILE=.secrets/migration_database_url\nQUEUE_DATABASE_URL_FILE=.secrets/queue_database_url\nRUNTIME_DATABASE_URL_FILE=.secrets/runtime_database_url\nAPP_MASTER_KEY_FILE=.secrets/app_master_key\nSESSION_SECRET_FILE=.secrets/session_secret\nRELEASE_PROFILE=ENTERPRISE_DWS\nMOCK_PROVIDERS=false\n',{mode:0o600,flag:'wx'});} catch(e) {if(e.code!=='EEXIST') throw e;}
console.log('Generated isolated development secrets; existing secrets preserved.');
