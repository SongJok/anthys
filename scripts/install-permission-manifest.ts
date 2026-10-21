import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {z} from 'zod';
import {installPermissionManifest,permissionManifestSchema} from '../packages/gateway/src/permissions.js';
async function main(){
 const [tenantId,path,mode]=process.argv.slice(2);if(!tenantId||!path||process.argv.length>5||mode!==undefined&&mode!=='--check')throw Error('MANIFEST_USAGE_INVALID');
 const tenant=z.uuid().parse(tenantId),doc=permissionManifestSchema.parse(JSON.parse(await readFile(path,'utf8')));
 if(mode==='--check'){console.log(JSON.stringify({status:'VALID_FORMAT',installed:false,platformPermissionsVerified:false}));return;}
 loadEnvFile();const url=secret('MIGRATION_DATABASE_URL');if(!url)throw Error('MIGRATION_DATABASE_URL_REQUIRED');const c=new pg.Client({connectionString:url});try{await c.connect();await c.query('BEGIN');const result=await installPermissionManifest(c,tenant,doc);await c.query('COMMIT');console.log(JSON.stringify(result));}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end();}
}
try{await main();}catch{console.error(JSON.stringify({error:'PERMISSION_MANIFEST_INSTALL_FAILED'}));process.exitCode=1;}
