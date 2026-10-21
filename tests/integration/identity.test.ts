import '../support/isolation.js';
import pg from 'pg';
import {Database} from '../../packages/storage/src/database.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {loadEnvFile,secret,config} from '../../packages/config/src/index.js';
import {seed,ids} from '../../scripts/seed.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from '../../apps/api/src/server.js';
loadEnvFile();
const appUrl=secret('DATABASE_URL'),migrationUrl=secret('MIGRATION_DATABASE_URL');
if(!appUrl||!migrationUrl) throw Error('REAL_POSTGRES_REQUIRED: run setup:dev, compose up, db:migrate');
const db=new Database(appUrl,1),admin=new pg.Pool({connectionString:migrationUrl});
const alice={tenantId:ids.tenantA,actorId:ids.alice},bob={tenantId:ids.tenantA,actorId:ids.bob},erin={tenantId:ids.tenantB,actorId:ids.erin};
const signingKey=randomBytes(32).toString('hex'),sessions=new Sessions(db,signingKey);
beforeAll(async()=>{await seed(migrationUrl);});afterAll(async()=>{await db.close();await admin.end();});
describe('P01 real PostgreSQL identity and owner isolation',()=>{
 it('T023 RLS rejects cross-tenant IDs and composite foreign keys',async()=>{
  const q=await db.scope(erin,c=>c.query('SELECT * FROM users WHERE id=$1',[ids.alice]));expect(q.rowCount).toBe(0);
  await expect(db.scope(erin,c=>c.query("INSERT INTO sessions(tenant_id,id,owner_id,token_hash,csrf_hash,auth_epoch,expires_at) VALUES($1,$2,$3,$4,'x',1,now())",[ids.tenantA,randomUUID(),ids.alice,randomUUID()]))).rejects.toMatchObject({code:'42501'});
  await expect(db.scope(erin,c=>c.query("INSERT INTO sessions(tenant_id,id,owner_id,token_hash,csrf_hash,auth_epoch,expires_at) VALUES($1,$2,$3,$4,'x',1,now())",[ids.tenantB,randomUUID(),ids.alice,randomUUID()]))).rejects.toMatchObject({code:'42501'});
 });
 it('T025 uses transaction-local contexts; connection pool has no lingering actor',async()=>{
  await sessions.create(alice);
  const first=await db.scope(alice,c=>c.query('SELECT * FROM sessions'));expect(first.rowCount).toBeGreaterThan(0);
  const second=await db.scope(bob,c=>c.query('SELECT * FROM sessions'));expect(second.rows.every(r=>r.owner_id===ids.bob)).toBe(true);
  const raw=await db.pool.query('SELECT * FROM sessions');expect(raw.rowCount).toBe(0);
  await expect(db.scope(alice,async c=>{await c.query('SELECT 1');throw Error('rollback');})).rejects.toThrow('rollback');
  expect((await db.pool.query('SELECT * FROM sessions')).rowCount).toBe(0);
 });
 it('T034 administrator role does not grant employee session/credential access',async()=>{
  const q=await db.scope({tenantId:ids.tenantA,actorId:ids.dave},c=>c.query('SELECT * FROM sessions WHERE owner_id=$1',[ids.alice]));expect(q.rowCount).toBe(0);
  await expect(db.scope(alice,c=>c.query('SELECT * FROM credentials'))).rejects.toMatchObject({code:'42501'});
 });
 it('authenticates opaque signed sessions, CSRF, epoch revocation and spoof rejection',async()=>{
  const s=await sessions.create(alice);expect((await sessions.authenticate(s.cookie,s.csrf))?.actorId).toBe(ids.alice);
  expect(await sessions.authenticate(s.cookie,'wrong')).toBeNull();expect(await sessions.authenticate(s.cookie+'x')).toBeNull();
  await admin.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND id=$2',[ids.tenantA,ids.alice]);expect(await sessions.authenticate(s.cookie)).toBeNull();
 });
 it('separates liveness/readiness and protects direct URLs and CSRF writes',async()=>{
  const {app}=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:signingKey});
  try {
   expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);expect((await app.inject('/api/v1/health/ready')).statusCode).toBe(200);
   expect((await app.inject('/api/v1/me')).statusCode).toBe(401);
   const s=await sessions.create(alice),headers={cookie:`oa_session=${s.cookie}`};
   expect((await app.inject({url:'/api/v1/me',headers})).json().data.roles).toEqual(['PAYMENTS_ANALYST']);
   expect((await app.inject({url:'/api/v1/auth/logout',method:'POST',headers})).statusCode).toBe(403);
   expect((await app.inject({url:'/api/v1/auth/logout',method:'POST',headers:{...headers,origin:'http://localhost:64700','x-csrf-token':s.csrf}})).statusCode).toBe(200);
   expect(await sessions.authenticate(s.cookie)).toBeNull();
  } finally {await app.close();}
 });
 it('runtime DB user has no superuser, BYPASSRLS or schema DDL privilege',async()=>{
  const q=await db.pool.query("SELECT rolsuper,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') ddl FROM pg_roles WHERE rolname=current_user");expect(q.rows[0]).toEqual({rolsuper:false,rolbypassrls:false,ddl:false});
 });
});
it('rejects malformed and forged session locators before querying private rows',async()=>{
 for(const cookie of [undefined,'','x'.repeat(2049),'a','a.b.c','a.b','..']) expect(await sessions.authenticate(cookie)).toBeNull();
 const {createHmac}=await import('node:crypto');
 const signed=(body:unknown)=>{const payload=Buffer.from(typeof body==='string'?body:JSON.stringify(body)).toString('base64url');return `${payload}.${createHmac('sha256',signingKey).update(payload).digest('base64url')}`;};
 for(const body of ['invalid-json',{tenantId:'bad',actorId:ids.alice,token:'t'},{tenantId:ids.tenantA,actorId:'bad',token:'t'},{tenantId:ids.tenantA,actorId:ids.alice,token:7},{}])expect(await sessions.authenticate(signed(body))).toBeNull();
 expect(await sessions.authenticate(signed({tenantId:ids.tenantB,actorId:ids.erin,token:'synthetic-nonexistent'}))).toBeNull();
 expect(()=>new Sessions(db,'short-key')).toThrow('SESSION_KEY_LENGTH');
});
it('rejects new sessions and active cookies for departed/suspended identity and tenant',async()=>{
 const id='00000000-0000-4000-8000-000000000096',testCtx={tenantId:ids.tenantA,actorId:id};
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'synthetic-session-revocation','synthetic-session-revocation','ACTIVE') ON CONFLICT(tenant_id,id) DO UPDATE SET status='ACTIVE'",[ids.tenantA,id]);
 const first=await sessions.create(testCtx);
 await admin.query("UPDATE users SET status='DEPARTED' WHERE tenant_id=$1 AND id=$2",[ids.tenantA,id]);expect(await sessions.authenticate(first.cookie)).toBeNull();await expect(sessions.create(testCtx)).rejects.toThrow('IDENTITY_INACTIVE');
 await admin.query("UPDATE users SET status='ACTIVE' WHERE tenant_id=$1 AND id=$2",[ids.tenantA,id]);
 const second=await sessions.create(testCtx);await admin.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND owner_id=$2",[ids.tenantA,id]);expect(await sessions.authenticate(second.cookie)).toBeNull();
});
it('DB role assignment and identity mutation cannot be performed by the application role',async()=>{
 const before=await admin.query('SELECT count(*)::int n FROM role_bindings WHERE tenant_id=$1',[ids.tenantA]);
 await expect(db.scope(alice,c=>c.query("UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1",[ids.alice]))).rejects.toMatchObject({code:'42501'});
 await expect(db.scope(alice,c=>c.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'ADMIN')",[ids.tenantA,randomUUID()]))).rejects.toMatchObject({code:'42501'});
 await expect(db.scope(alice,c=>c.query("UPDATE role_bindings SET subject_id=$1",[ids.alice]))).rejects.toMatchObject({code:'42501'});
 const after=await admin.query('SELECT count(*)::int n FROM role_bindings WHERE tenant_id=$1',[ids.tenantA]);expect(after.rows).toEqual(before.rows);
});
it('does not issue sessions when the organization is suspended',async()=>{
 const tenant='00000000-0000-4000-8000-000000000091',actor='00000000-0000-4000-8000-000000000092';
 await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,'SYNTHETIC_SUSPENDED','SYNTHETIC_SUSPENDED','SUSPENDED') ON CONFLICT(tenant_id) DO UPDATE SET status='SUSPENDED'",[tenant]);
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'suspended-subject','suspended-subject','ACTIVE') ON CONFLICT DO NOTHING",[tenant,actor]);
 await expect(sessions.create({tenantId:tenant,actorId:actor})).rejects.toThrow('IDENTITY_INACTIVE');
});
