import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
loadEnvFile();const url=secret('MIGRATION_DATABASE_URL'),corpId=secret('DINGTALK_CORP_ID');if(!url||!corpId)throw Error('DATABASE_AND_CONFIGURED_CORP_REQUIRED');
const c=new pg.Client({connectionString:url});await c.connect();
try{
 const nameIndex=process.argv.indexOf('--name'),name=nameIndex<0?'Configured enterprise':process.argv[nameIndex+1];if(!name||name.length>200)throw Error('INVALID_TENANT_NAME');
 await c.query('BEGIN');
 const existing=await c.query('SELECT tenant_id FROM tenants WHERE corp_id=$1',[corpId]);const id=existing.rowCount?existing.rows[0].tenant_id as string:randomUUID();
 if(!existing.rowCount)await c.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,$3,'ACTIVE')",[id,corpId,name]);
 await c.query('COMMIT');await mkdir('.data',{recursive:true,mode:0o700});
 let previous:{tenantId:string;corpId:string}[]=[];try{previous=JSON.parse(await readFile('.data/tenant-bindings.json','utf8')) as typeof previous;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await writeFile('.data/tenant-bindings.json',JSON.stringify([...previous.filter(b=>b.corpId!==corpId),{tenantId:id,corpId}],null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'LOCAL_TENANT_REGISTERED',tenantId:id,identityVerification:'NOT_RUN',rolesGranted:0,next:'Import a verified directory before users can log in. No platform authorization or production readiness is implied.'}));
}finally{await c.end();}
