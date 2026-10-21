import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {Database} from '../../packages/storage/src/database.js';
import {loadEnvFile,secret,config} from '../../packages/config/src/index.js';
import {LoginStates} from '../../packages/identity/src/login.js';
import {createServer} from '../../apps/api/src/server.js';
import {ids,seed} from '../../scripts/seed.js';
loadEnvFile();const db=new Database(secret('DATABASE_URL')!,1),admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),key=randomBytes(32).toString('hex');
const user='00000000-0000-4000-8000-000000000094';
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id) VALUES($1,$2,'synthetic-h5-user','synthetic-h5-user','ACTIVE','synthetic-h5-union') ON CONFLICT(tenant_id,id) DO UPDATE SET union_id='synthetic-h5-union',status='ACTIVE'",[ids.tenantA,user]);});afterAll(async()=>{await db.close();await admin.end();});
it('one-time state is browser-bound, expires, and admits only one concurrent consumer',async()=>{
 const states=new LoginStates(db,ids.tenantA,'TENANT_A'),browser=randomBytes(32).toString('base64url');
 const state=await states.create(browser,'/');expect(await states.consume(state,randomBytes(32).toString('base64url'))).toBeNull();
 const results=await Promise.all(Array.from({length:20},()=>states.consume(state,browser)));expect(results.filter(Boolean)).toEqual(['/']);
 const expired=await states.create(browser,'/tasks');await admin.query("UPDATE login_states SET expires_at=now()-interval '1 second' WHERE state_hash IS NOT NULL AND consumed_at IS NULL AND tenant_id=$1",[ids.tenantA]);expect(await states.consume(expired,browser)).toBeNull();
 expect(await states.consume('bad',browser)).toBeNull();await expect(states.create(browser,'https://evil.invalid')).rejects.toThrow('REDIRECT_NOT_ALLOWED');await expect(states.create('bad','/')).rejects.toThrow('BROWSER_BINDING_INVALID');
});
it('exchanges a verified provider subject into a scoped HttpOnly session; client roles are ignored/rejected',async()=>{
 let exchanges=0;
 const {app}=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:key,login:{tenantId:ids.tenantA,corpId:'TENANT_A',provider:{exchange:async()=>{exchanges++;return {corpId:'TENANT_A',unionId:'synthetic-h5-union'};}}}});
 try{
  const start=await app.inject('/api/v1/auth/dingtalk/state'),state=start.json().data.state as string,cookie=start.cookies.find(c=>c.name==='oa_login_browser')!;
  expect(cookie.httpOnly).toBe(true);const headers={origin:'http://localhost:64700',cookie:`oa_login_browser=${cookie.value}`};
  const forged=await app.inject({method:'POST',url:'/api/v1/auth/dingtalk/exchange',headers,payload:{code:'synthetic-code',state,userId:ids.alice,roles:['ADMIN']}});expect(forged.statusCode).toBe(400);expect(exchanges).toBe(0);
  const result=await app.inject({method:'POST',url:'/api/v1/auth/dingtalk/exchange',headers,payload:{code:'synthetic-code',state}});expect(result.statusCode).toBe(200);expect(result.json().data.csrfToken).toBeTypeOf('string');expect(exchanges).toBe(1);
  const session=result.cookies.find(c=>c.name==='oa_session')!;expect(session.httpOnly).toBe(true);expect(session.sameSite).toBe('Lax');
  const me=await app.inject({url:'/api/v1/me',headers:{cookie:`oa_session=${session.value}`}});expect(me.json().data).toMatchObject({id:user,roles:[]});
  expect((await app.inject({method:'POST',url:'/api/v1/auth/dingtalk/exchange',headers,payload:{code:'synthetic-code',state}})).statusCode).toBe(403);expect(exchanges).toBe(1);
 }finally{await app.close();}
});
it('rejects login CSRF, wrong enterprise, unmapped union and missing login configuration',async()=>{
 for(const subject of [{unionId:'synthetic-h5-union'},{corpId:'TENANT_B',unionId:'synthetic-h5-union'},{corpId:'TENANT_A',unionId:randomUUID()}]){
  const {app}=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:key,login:{tenantId:ids.tenantA,corpId:'TENANT_A',provider:{exchange:async()=>subject}}});
  try{const start=await app.inject('/api/v1/auth/dingtalk/state'),browser=start.cookies.find(c=>c.name==='oa_login_browser')!;const payload={code:'synthetic',state:start.json().data.state as string};
   expect((await app.inject({method:'POST',url:'/api/v1/auth/dingtalk/exchange',payload,headers:{origin:'https://evil.invalid'}})).statusCode).toBe(403);
   expect((await app.inject({method:'POST',url:'/api/v1/auth/dingtalk/exchange',payload,headers:{origin:'http://localhost:64700',cookie:`oa_login_browser=${browser.value}`}})).statusCode).toBe(403);
  }finally{await app.close();}
 }
 const {app}=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:key});try{expect((await app.inject('/api/v1/auth/dingtalk/state')).statusCode).toBe(503);}finally{await app.close();}
});
it('does not resolve an ambiguous union ID or a user whose tenant mapping does not match',async()=>{
 const duplicate='00000000-0000-4000-8000-000000000093';
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id) VALUES($1,$2,'synthetic-duplicate-union','synthetic-duplicate-union','ACTIVE','synthetic-ambiguous-union') ON CONFLICT(tenant_id,id) DO UPDATE SET union_id='synthetic-ambiguous-union'",[ids.tenantA,duplicate]);
 await admin.query("UPDATE users SET union_id='synthetic-ambiguous-union' WHERE tenant_id=$1 AND id=$2",[ids.tenantA,user]);
 const states=new LoginStates(db,ids.tenantA,'TENANT_A');expect(await states.resolveUnion('synthetic-ambiguous-union')).toBeNull();expect(await states.resolveUnion('no-such-union')).toBeNull();
 await admin.query("UPDATE users SET union_id='synthetic-h5-union' WHERE tenant_id=$1 AND id=$2",[ids.tenantA,user]);
 expect(await new LoginStates(db,ids.tenantA,'WRONG_CORP').resolveUnion('synthetic-h5-union')).toBeNull();
});
