import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Database} from '../../packages/storage/src/database.js';
import {config,loadEnvFile,secret} from '../../packages/config/src/index.js';
import {resolveTenantBinding,authorizationUrl} from '../../packages/config/src/tenant-binding.js';
import {createServer} from '../../apps/api/src/server.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {seed,ids} from '../../scripts/seed.js';
loadEnvFile();const db=new Database(secret('DATABASE_URL')!),admin=new Database(secret('MIGRATION_DATABASE_URL')!),ctx={tenantId:ids.tenantA,actorId:randomUUID()};
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);await admin.scope(ctx,c=>c.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic workbench','ACTIVE')",[ctx.tenantId,ctx.actorId,'synthetic-workbench-'+ctx.actorId]));});afterAll(async()=>{await db.close();await admin.close();});
it('tenant binding requires unique configured enterprise and active persisted tenant',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-binding-')),path=join(dir,'bindings.json');try{
  expect(await resolveTenantBinding(db,undefined,path)).toBeNull();expect(await resolveTenantBinding(db,'TENANT_A',path)).toBeNull();
  await writeFile(path,JSON.stringify([{tenantId:ids.tenantA,corpId:'TENANT_A'}]));expect(await resolveTenantBinding(db,'TENANT_A',path)).toEqual({tenantId:ids.tenantA,corpId:'TENANT_A'});
  await expect(resolveTenantBinding(db,'OTHER',path)).rejects.toThrow('TENANT_BINDING_AMBIGUOUS_OR_MISSING');
  await writeFile(path,JSON.stringify([{tenantId:ids.tenantA,corpId:'TENANT_A'},{tenantId:ids.tenantB,corpId:'TENANT_A'}]));await expect(resolveTenantBinding(db,'TENANT_A',path)).rejects.toThrow('AMBIGUOUS');
  await writeFile(path,JSON.stringify([{tenantId:ids.tenantB,corpId:'TENANT_A'}]));await expect(resolveTenantBinding(db,'TENANT_A',path)).rejects.toThrow('TENANT_BINDING_INVALID');
  await writeFile(path,'invalid-json');await expect(resolveTenantBinding(db,'TENANT_A',path)).rejects.toThrow();await expect(resolveTenantBinding(db,'TENANT_A',dir)).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
 const url=new URL(authorizationUrl('client&injected','https://work.example/path','nonce&injected'));expect(url.origin).toBe('https://login.dingtalk.com');expect(url.searchParams.get('state')).toBe('nonce&injected');expect(url.searchParams.get('redirect_uri')).toBe('https://work.example/auth/callback');expect(url.searchParams.get('scope')).toBe('openid corpid');
});
it('public workbench serves CSP/static files while tasks remain owner scoped and paginated',async()=>{
 const {app,sessions}=await createServer({config:config({APP_ENV:'test'}),db,sessionSecret:randomBytes(32).toString('hex'),webRoot:resolve('dist/web')});try{
  for(const path of ['/','/personal','/tasks','/auth/callback']){const r=await app.inject(path);expect(r.statusCode).toBe(200);expect(r.headers['content-security-policy']).toContain("script-src 'self'");expect(r.headers['referrer-policy']).toBe('no-referrer');expect(r.body).toContain('id="root"');}
  const index=await app.inject('/'),asset=index.body.match(/src="(\/assets\/[^" ]+)"/)![1]!;expect((await app.inject(asset)).statusCode).toBe(200);
  expect((await app.inject('/api/v1/tasks')).statusCode).toBe(401);
  const session=await sessions.create(ctx),principal=(await sessions.authenticate(session.cookie))!,headers={cookie:`oa_session=${session.cookie}`};
  const token=await app.inject({url:'/api/v1/auth/csrf',headers});expect(token.headers['cache-control']).toBe('no-store');const csrf=token.json().data.csrfToken as string;expect(await sessions.authenticate(session.cookie,session.csrf)).toBeNull();expect(await sessions.authenticate(session.cookie,csrf)).toMatchObject({actorId:ctx.actorId});
  expect((await app.inject({url:'/api/v1/auth/csrf',headers:{...headers,origin:'https://evil.invalid'}})).statusCode).toBe(403);
  const store=new TaskStore(db),own=await store.create(ctx,'synthetic pagination '+randomUUID(),randomUUID()),other=await store.create({tenantId:ids.tenantA,actorId:ids.bob},'synthetic invisible '+randomUUID(),randomUUID());
  const older=await store.create(ctx,'synthetic pagination extra1',randomUUID()),newest=await store.create(ctx,'synthetic pagination extra2',randomUUID());const first=await app.inject({url:'/api/v1/tasks?limit=1',headers});expect(first.json().data.items[0].id).toBe(newest.taskId);
  const seen=new Set<string>();let cursor:string|null=null;do{const page=await app.inject({url:'/api/v1/tasks?limit=1'+(cursor?'&cursor='+cursor:''),headers});expect(page.statusCode).toBe(200);const data=page.json().data as {items:{id:string}[];nextCursor:string|null};for(const item of data.items){expect(seen.has(item.id)).toBe(false);seen.add(item.id);}cursor=data.nextCursor;}while(cursor);
  expect(seen.has(own.taskId)).toBe(true);expect(seen.has(older.taskId)).toBe(true);expect(seen.has(newest.taskId)).toBe(true);expect(seen.has(other.taskId)).toBe(false);expect((await app.inject({url:'/api/v1/tasks/'+other.taskId,headers})).statusCode).toBe(404);
  expect((await app.inject({url:'/api/v1/tasks?limit=201',headers})).statusCode).toBe(400);expect((await app.inject({url:'/api/v1/tasks?cursor=bad',headers})).statusCode).toBe(400);
  await sessions.revoke(principal);await expect(sessions.rotateCsrf(principal)).rejects.toThrow('SESSION_EXPIRED');
 }finally{await app.close();}
});
