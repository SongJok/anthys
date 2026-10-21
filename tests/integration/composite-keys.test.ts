import '../support/isolation.js';
import {Database} from '../../packages/storage/src/database.js';
import {loadEnvFile,secret} from '../../packages/config/src/index.js';
import {ids,seed} from '../../scripts/seed.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
loadEnvFile();const runtime=new Database(secret('RUNTIME_DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await runtime.close();await admin.end();});
it('T023 composite identity foreign key rejects cross-tenant credential reference even when owner RLS passes',async()=>{
 const identityId=randomUUID();await admin.query("INSERT INTO identities(tenant_id,id,owner_id,kind,provider,external_subject,status) VALUES($1,$2,$3,'HUMAN','DWS','synthetic-composite-identity-'||$2::uuid::text,'ACTIVE')",[ids.tenantA,identityId,ids.alice]);
 const ctx={tenantId:ids.tenantB,actorId:ids.erin};
 await expect(runtime.scope(ctx,c=>c.query("INSERT INTO credentials(tenant_id,id,owner_id,identity_id,ciphertext,key_version) VALUES($1,$2,$3,$4,'synthetic-ciphertext','1')",[ctx.tenantId,randomUUID(),ctx.actorId,identityId]))).rejects.toMatchObject({code:'23503'});
 expect((await runtime.scope(ctx,c=>c.query('SELECT id FROM credentials WHERE identity_id=$1',[identityId]))).rowCount).toBe(0);
});
