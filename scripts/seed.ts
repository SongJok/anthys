import pg from 'pg';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
export const ids={tenantA:'00000000-0000-4000-8000-000000000001',tenantB:'00000000-0000-4000-8000-000000000002',alice:'00000000-0000-4000-8000-000000000011',bob:'00000000-0000-4000-8000-000000000012',carol:'00000000-0000-4000-8000-000000000013',dave:'00000000-0000-4000-8000-000000000014',erin:'00000000-0000-4000-8000-000000000021'};
export async function seed(url:string):Promise<void> {
 const c=new pg.Client({connectionString:url});await c.connect();
 try {await c.query('BEGIN');
  for(const [id,name] of [[ids.tenantA,'TENANT_A'],[ids.tenantB,'TENANT_B']]) await c.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,$2,'ACTIVE') ON CONFLICT DO NOTHING",[id,name]);
  for(const [tenant,id,name,external] of [[ids.tenantA,ids.alice,'ALICE','alice'],[ids.tenantA,ids.bob,'BOB','bob'],[ids.tenantA,ids.carol,'CAROL','carol'],[ids.tenantA,ids.dave,'DAVE','dave'],[ids.tenantB,ids.erin,'ALICE','erin']]) await c.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,$4,'ACTIVE') ON CONFLICT DO NOTHING",[tenant,id,external,name]);
  for(const [id,name,user] of [['00000000-0000-4000-8000-000000000101','PAYMENTS_ANALYST',ids.alice],['00000000-0000-4000-8000-000000000102','SECURITY_AUDITOR',ids.dave]]) {
   await c.query('INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ids.tenantA,id,name]);
   await c.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'TENANT',$5) ON CONFLICT DO NOTHING",[ids.tenantA,id,id,user,ids.tenantA]);
  }
  await c.query('COMMIT');
 } catch(e){await c.query('ROLLBACK');throw e;} finally{await c.end();}
}
if(import.meta.url===`file://${process.argv[1]}`) {loadEnvFile();if(process.env['APP_ENV']==='production') throw Error('TEST_SEED_FORBIDDEN');const url=secret('MIGRATION_DATABASE_URL');if(!url) throw Error('MIGRATION_DATABASE_URL_REQUIRED');await seed(url);const {mkdir,writeFile}=await import('node:fs/promises');await mkdir('.data',{recursive:true,mode:0o700});await writeFile('.data/worker-scopes.json',JSON.stringify([ids.alice,ids.bob,ids.carol,ids.dave].map(actorId=>({tenantId:ids.tenantA,actorId})).concat([{tenantId:ids.tenantB,actorId:ids.erin}]),null,2),{mode:0o600});console.log('Seeded synthetic two-tenant test world.');}
