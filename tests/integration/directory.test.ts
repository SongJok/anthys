import '../support/isolation.js';
import {Database} from '../../packages/storage/src/database.js';
import {Directory} from '../../packages/identity/src/directory.js';
import {loadEnvFile,secret} from '../../packages/config/src/index.js';
import {ids,seed} from '../../scripts/seed.js';
import pg from 'pg';
loadEnvFile();const db=new Database(secret('DATABASE_URL')!),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),directory=new Directory(db,new Map([['TENANT_A',ids.tenantA],['TENANT_B',ids.tenantB]]));
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();await admin.end();});
it('T024 resolves exact external identifiers and keeps same names in separate tenants',async()=>{
 expect(await directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'alice'})).toEqual({tenantId:ids.tenantA,actorId:ids.alice});
 expect(await directory.resolveVerifiedSubject({corpId:'TENANT_B',userId:'alice'})).toBeNull();
 expect((await directory.search({tenantId:ids.tenantB,actorId:ids.erin},'ALICE')).candidates.map(c=>c.id)).toEqual([ids.erin]);
 expect(await directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'ALICE'})).toBeNull();
});
it('same-tenant names return ambiguity instead of choosing the first match',async()=>{
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,'00000000-0000-4000-8000-000000000099','synthetic-duplicate-name','synthetic-ambiguous','ACTIVE') ON CONFLICT DO NOTHING",[ids.tenantA]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,'00000000-0000-4000-8000-000000000098','synthetic-duplicate-name-two','synthetic-ambiguous','ACTIVE') ON CONFLICT DO NOTHING",[ids.tenantA]);
 const result=await directory.search({tenantId:ids.tenantA,actorId:ids.bob},'synthetic-ambiguous');expect(result.status).toBe('AMBIGUOUS');expect(result.candidates).toHaveLength(2);
});
it('rejects unknown organizations, departed subjects and mismatched union/open identities',async()=>{
 expect(await directory.resolveVerifiedSubject({corpId:'UNKNOWN',userId:'alice'})).toBeNull();
 const id='00000000-0000-4000-8000-000000000097';
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id,open_dingtalk_id) VALUES($1,$2,'synthetic-alias-user','synthetic-alias-user','ACTIVE','union-a','open-a') ON CONFLICT(tenant_id,id) DO UPDATE SET status='ACTIVE'",[ids.tenantA,id]);
 expect(await directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'synthetic-alias-user',unionId:'union-a',openDingTalkId:'open-a'})).toEqual({tenantId:ids.tenantA,actorId:id});
 await expect(directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'synthetic-alias-user',unionId:'union-b'})).rejects.toThrow('IDENTITY_ALIAS_MISMATCH');
 await expect(directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'synthetic-alias-user',openDingTalkId:'open-b'})).rejects.toThrow('IDENTITY_ALIAS_MISMATCH');
 await admin.query("UPDATE users SET status='DEPARTED' WHERE tenant_id=$1 AND id=$2",[ids.tenantA,id]);expect(await directory.resolveVerifiedSubject({corpId:'TENANT_A',userId:'synthetic-alias-user'})).toBeNull();
 expect((await directory.search({tenantId:ids.tenantA,actorId:ids.bob},'no-such-synthetic-person')).status).toBe('EMPTY');
});
