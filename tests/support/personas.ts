import './isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type pg from 'pg';
import {config,secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import {Personas} from '../../packages/personas/src/service.js';
import type {PersonaScope} from '../../packages/personas/src/schema.js';
import {createServer} from '../../apps/api/src/server.js';
export async function personaFixture(root:pg.Pool,db:Database,appDb:Database,vault:Vault){
 const tenantId=randomUUID(),people=Object.fromEntries(['alice','bob','admin','groupAdmin','member'].map(name=>[name,{tenantId,actorId:randomUUID()}])) as Record<'alice'|'bob'|'admin'|'groupAdmin'|'member',DbContext>,groupA='persona-group-a-'+randomUUID(),groupB='persona-group-b-'+randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic personas','ACTIVE')",[tenantId,'synthetic-personas-'+tenantId]);
 for(const [name,ctx]of Object.entries(people))await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,$3,'ACTIVE')",[tenantId,ctx.actorId,'synthetic-persona-'+name]);
 const grant=async(ctx:DbContext,role:string,scopeKind:string,scopeId:string)=>{const roleId=(await root.query('INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO UPDATE SET name=excluded.name RETURNING id',[tenantId,randomUUID(),role])).rows[0].id as string,id=randomUUID();await root.query('INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,id,roleId,ctx.actorId,scopeKind,scopeId]);return id;};
 const adminGrant=await grant(people.admin,'TENANT_ADMIN','TENANT',tenantId),groupGrant=await grant(people.groupAdmin,'GROUP_ADMIN','GROUP',groupA);await grant(people.alice,'GROUP_MEMBER','GROUP',groupA);await grant(people.member,'GROUP_MEMBER','GROUP',groupA);await grant(people.bob,'GROUP_MEMBER','GROUP',groupB);
 const service=new Personas(db,vault),api=await createServer({config:config(),db:appDb,sessionSecret:randomBytes(32).toString('hex'),personas:service}),login=async(ctx:DbContext)=>{const s=await api.sessions.create(ctx),principal=(await api.sessions.authenticate(s.cookie))!;return {source:{sessionId:principal.sessionId,authEpoch:principal.authEpoch},cookie:'oa_session='+s.cookie,csrf:s.csrf};},sessions={alice:await login(people.alice),bob:await login(people.bob),admin:await login(people.admin),groupAdmin:await login(people.groupAdmin),member:await login(people.member)};
 const headers=(name:keyof typeof people,key=randomUUID())=>({cookie:sessions[name].cookie,origin:config().APP_ORIGIN,'x-csrf-token':sessions[name].csrf,'idempotency-key':key}),scope=(name:keyof typeof people):PersonaScope=>({kind:'USER',id:people[name].actorId}),global:PersonaScope={kind:'GLOBAL',id:tenantId},group:PersonaScope={kind:'GROUP',id:groupA};
 const get=(name:keyof typeof people,target=scope(name))=>service.get(people[name],target,sessions[name].source),patch=(name:keyof typeof people,target:PersonaScope,input:unknown,etag='"0"',key=randomUUID())=>service.patch(people[name],target,input,etag,key,sessions[name].source);
 return {tenantId,people,groupA,groupB,grant,adminGrant,groupGrant,service,api,login,sessions,headers,scope,global,group,get,patch,close:()=>api.app.close()};
}
export function personaReadBarrier(vault:Vault){
 const db=new Database(secret('RUNTIME_DATABASE_URL')!,2),scope=db.scope.bind(db);let entered!:()=>void,release!:()=>void,seen=false;const ready=new Promise<void>(resolve=>{entered=resolve;}),resumed=new Promise<void>(resolve=>{release=resolve;});
 db.scope=<T>(ctx:DbContext,fn:(client:pg.PoolClient)=>Promise<T>)=>scope(ctx,c=>fn(new Proxy(c,{get(target,key,receiver){if(key==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(target.query,target,args);if(!seen&&typeof args[0]==='string'&&args[0].includes('FROM personas p')){seen=true;entered();await resumed;}return result;};return Reflect.get(target,key,receiver);}})));
 return {db,service:new Personas(db,vault),ready,release};
}
