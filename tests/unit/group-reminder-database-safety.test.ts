import {createHash} from 'node:crypto';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';

const fixture=vi.hoisted(()=>({state:{} as Record<string,unknown>}));
type Row={name:string;hash:string};
type State={endpoint:string;containerHost:string;containerPort:string;containerImage:string;containerRunning:boolean;ids:string;system:string;dockerSystem:string;role:string;source:Row[];files:Map<string,string>;ledgers:Map<string,Row[]>;sql:{database:string;text:string;values?:unknown[]}[];docker:{args:string[];input?:Buffer;env:Record<string,string>}[];events:string[];toc:string;rendered:string;archive:Buffer;failRestore:boolean;failInstall:boolean;dropBlocked:boolean;sourceReads:number;changeSource:boolean;applied:number;restoreHasLedger:boolean;createFails:boolean};
const state=()=>fixture.state as unknown as State;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const name95='095_group_reminder_authority.sql',image='postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826';
vi.mock('node:fs/promises',()=>({readdir:vi.fn(async()=>[...state().files.keys()]),readFile:vi.fn(async(path:string)=>{const name=path.split('/').at(-1)!;const value=state().files.get(name);if(value===undefined)throw Error('SYNTHETIC_FILE_MISSING');return value;})}));
vi.mock('node:child_process',()=>({execFileSync:vi.fn((_command:string,args:string[],options:{input?:Buffer;env:Record<string,string>})=>{
 const s=state();s.docker.push({args:[...args],...(options.input?{input:Buffer.from(options.input)}:{}),env:options.env});
 if(args[0]==='context'&&args[1]==='show')return Buffer.from('desktop-linux\n');
 if(args[0]==='context'&&args[1]==='inspect')return Buffer.from(JSON.stringify(s.endpoint));
 if(args.includes('ps'))return Buffer.from(s.ids);
 if(args.includes('inspect'))return Buffer.from(JSON.stringify({Config:{Image:s.containerImage,Labels:{'com.docker.compose.project':'anthys-test','com.docker.compose.service':'postgres'}},State:{Running:s.containerRunning},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:s.containerHost,HostPort:s.containerPort}]}}}));
 if(args.includes('psql'))return Buffer.from(s.dockerSystem+'\n');
 if(args.includes('pg_dump'))return s.archive;
 if(args.includes('pg_restore')){if(args.includes('--list'))return Buffer.from(s.toc);if(args.includes('--file=-'))return Buffer.from(s.rendered);if(s.failRestore)throw Object.assign(Error('SENSITIVE_STDERR_MUST_NOT_ESCAPE'),{stderr:Buffer.from('SYNTHETIC_SECRET')});if(s.restoreHasLedger)for(const key of s.ledgers.keys())s.ledgers.set(key,structuredClone(s.source));s.events.push('restore');return Buffer.alloc(0);}
 throw Error('UNEXPECTED_DOCKER_COMMAND');
})}));
vi.mock('pg',()=>{
 class Client{
  database:string;backup:Row[]|null=null;
  constructor(options:{connectionString:string}){this.database=new URL(options.connectionString).pathname.slice(1);}
  async connect(){}
  async query(text:string,values?:unknown[]){const s=state();s.sql.push({database:this.database,text,...(values?{values}:{})});
   if(text.startsWith('SELECT current_user'))return {rows:[{role:s.role,database:this.database,system:s.system}]};
   if(text==='SELECT pg_export_snapshot() snapshot')return {rows:[{snapshot:'00000001-00000002-1'}]};
   if(text.startsWith('CREATE DATABASE')){if(s.createFails)throw Error('SYNTHETIC_CREATE_FAILED');const name=/"([a-z0-9_]+)"/.exec(text)![1]!;s.ledgers.set(name,[]);s.events.push('create:'+name);return {rows:[]};}
   if(text.startsWith('DROP DATABASE')){if(s.dropBlocked)throw Error('SYNTHETIC_OTHER_CONNECTION_ACTIVE');const name=/"([a-z0-9_]+)"/.exec(text)![1]!;s.ledgers.delete(name);s.events.push('drop:'+name);return {rows:[]};}
   if(text==='SELECT name,hash FROM public.schema_migrations ORDER BY name'){if(this.database==='anthys_test'){s.sourceReads++;const rows=structuredClone(s.source);if(s.changeSource&&s.sourceReads>1)rows[0]!.hash='0'.repeat(64);return {rows};}return {rows:structuredClone(s.ledgers.get(this.database)??[])};}
   if(text.startsWith('INSERT INTO public.schema_migrations')){s.ledgers.get(this.database)!.push({name:values![0] as string,hash:values![1] as string});return {rows:[]};}
   if(text==='BEGIN')this.backup=structuredClone(s.ledgers.get(this.database)??[]);
   if(text==='ROLLBACK'&&this.backup)s.ledgers.set(this.database,this.backup);
   if(text===s.files.get(name95)){if(s.failInstall)throw Error('SYNTHETIC_INSTALL_FAILED');s.applied++;}
   return {rows:[]};
  }
  async end(){}release(){}
 }
 class Pool{database:string;constructor(private options:{connectionString:string}){this.database=new URL(options.connectionString).pathname.slice(1);}async connect(){return new Client(this.options);}async end(){state().events.push('close:root');}}
 return {default:{Client,Pool}};
});
vi.mock('../../packages/storage/src/database.js',()=>({Database:class{constructor(readonly url:string){}async close(){state().events.push('close:'+new URL(this.url).username);}}}));
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {requiredSchema} from '../../packages/storage/src/schema.js';

function reset(){
 const files=new Map<string,string>();for(const [index,migration] of requiredSchema.migrations.entries())files.set(migration.name,`CREATE TABLE public.synthetic_${index+1}(id int);`);
 fixture.state={endpoint:'unix:///synthetic/docker.sock',containerHost:'127.0.0.1',containerPort:'64711',containerImage:image,containerRunning:true,ids:'a'.repeat(64),system:'12345',dockerSystem:'12345',role:'oa_migrator',source:[...files].slice(0,94).map(([name,sql])=>({name,hash:hash(sql)})),files,ledgers:new Map(),sql:[],docker:[],events:[],toc:'1; 1259 TABLE public schema_migrations oa_migrator\n',rendered:'CREATE TABLE public.schema_migrations(name text,hash text); GRANT SELECT ON TABLE public.schema_migrations TO oa_app;',archive:Buffer.from('PGDMPsynthetic-schema'),failRestore:false,failInstall:false,dropBlocked:false,sourceReads:0,changeSource:false,applied:0,restoreHasLedger:false,createFails:false};
 vi.stubEnv('APP_ENV','test');vi.stubEnv('OA_TEST_ISOLATED','true');for(const [key,role]of [['MIGRATION_DATABASE_URL','oa_migrator'],['RUNTIME_DATABASE_URL','oa_runtime'],['DATABASE_URL','oa_app']])vi.stubEnv(key!,`postgresql://${role}:${'s'.repeat(32)}@127.0.0.1:64711/anthys_test`);
 for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','MIGRATION_DATABASE_URL_FILE','RUNTIME_DATABASE_URL_FILE','DATABASE_URL_FILE'])vi.stubEnv(key,undefined);
}
beforeEach(reset);afterEach(()=>vi.unstubAllEnvs());

describe('disposable group reminder schema-only database safety, all side effects mocked',()=>{
 it('creates only template0 nonce DB, privately restores schema/ACL and copies checked ledger, never user data',async()=>{
  const f=await groupReminderDatabase(),s=state();expect(f.name).toMatch(/^anthys_test_group_reminder_[a-f0-9]{32}$/);expect(Buffer.byteLength(f.name)).toBeLessThanOrEqual(63);expect(s.ledgers.get(f.name)).toEqual(s.source);
  expect(s.sql.find(q=>q.text.startsWith('CREATE DATABASE'))?.text).toBe(`CREATE DATABASE "${f.name}" TEMPLATE template0`);
  expect(s.docker.find(c=>c.args.includes('pg_dump'))?.args).toContain('--schema-only');expect(s.docker.find(c=>c.args.includes('pg_dump'))?.args).toContain('--format=custom');
  const restore=s.docker.find(c=>c.args.includes('pg_restore')&&c.args.includes('--exit-on-error'))!;expect(restore.args).toContain('--dbname='+f.name);expect(restore.args).toContain('--schema-only');expect(restore.args).toContain('--single-transaction');expect(restore.args).not.toContain('--no-acl');expect(restore.input).toEqual(s.archive);
  for(const call of s.docker.filter(c=>c.args[0]!=='context'))expect(call.args.slice(0,2)).toEqual(['--host',s.endpoint]);
  for(const call of s.docker)expect(Object.keys(call.env).some(k=>/DATABASE|PASSWORD|SECRET|TOKEN|DOCKER_HOST|DOCKER_CONTEXT/.test(k))).toBe(false);
  expect(s.sql.filter(q=>q.database==='anthys_test').every(q=>q.text.startsWith('SELECT'))).toBe(true);
  expect(s.sql.some(q=>/ALTER ROLE|PASSWORD|pg_terminate_backend|DROP DATABASE.*FORCE/.test(q.text))).toBe(false);
  await f.close();expect(s.events.slice(-4)).toEqual(['close:oa_runtime','close:oa_app','close:root','drop:'+f.name]);await f.close();expect(s.events.filter(e=>e.startsWith('drop:'))).toHaveLength(1);
 });
 it('installs every pending live-contract migration only inside the own nonce database and preserves source94',async()=>{
  const s=state(),pending=requiredSchema.migrations.slice(94),last=pending.at(-1)!,f=await groupReminderDatabase();
  try{
   expect(await f.install()).toBe(hash(s.files.get(last.name)!));
   expect(s.ledgers.get(f.name)).toHaveLength(requiredSchema.migrations.length);
   expect(s.ledgers.get(f.name)!.slice(94)).toEqual(pending.map(m=>({name:m.name,hash:hash(s.files.get(m.name)!)})));
   expect(s.source).toHaveLength(94);
   for(const migration of pending)expect(s.sql.filter(q=>q.text===s.files.get(migration.name))).toEqual([expect.objectContaining({database:f.name})]);
   await f.install();expect(s.ledgers.get(f.name)).toHaveLength(requiredSchema.migrations.length);
  }finally{await f.close();}
 });
 it.each(['APP_ENV','OA_TEST_ISOLATED'])('rejects missing %s before any Docker or DB action',async key=>{vi.stubEnv(key,'false');await expect(groupReminderDatabase()).rejects.toThrow('TEST_ISOLATION_REQUIRED');expect(state().docker).toHaveLength(0);expect(state().sql).toHaveLength(0);});
 it('requires the global network guard before side effects',async()=>{const key=Symbol.for('anthys.testNetworkGuard'),old=Reflect.get(globalThis,key);Reflect.set(globalThis,key,false);try{await expect(groupReminderDatabase()).rejects.toThrow('TEST_ISOLATION_REQUIRED');expect(state().docker).toHaveLength(0);}finally{Reflect.set(globalThis,key,old);}});
 it.each(['MIGRATION_DATABASE_URL','RUNTIME_DATABASE_URL','DATABASE_URL'])('rejects unsafe targets in %s before any daemon call',async key=>{
  const role=key==='MIGRATION_DATABASE_URL'?'oa_migrator':key==='RUNTIME_DATABASE_URL'?'oa_runtime':'oa_app';
  for(const bad of [`postgresql://${role}:${'s'.repeat(32)}@127.0.0.1:64710/anthys`,`postgresql://${role}:${'s'.repeat(32)}@remote.invalid:64711/anthys_test`,`postgresql://${role}:${'s'.repeat(32)}@127.0.0.1:64711/other`,`postgresql://${role}:${'s'.repeat(32)}@127.0.0.1:64711/anthys_test?host=remote.invalid`,`postgresql://${role}:${'s'.repeat(32)}@127.0.0.1:64711/anthys_test#x`,`postgresql://postgres:${'s'.repeat(32)}@127.0.0.1:64711/anthys_test`,`postgresql://${role}:short@127.0.0.1:64711/anthys_test`]){vi.stubEnv(key,bad);await expect(groupReminderDatabase()).rejects.toThrow('TEST_DATABASE_TARGET_REJECTED');expect(state().docker).toHaveLength(0);}
 });
 it('rejects query/hash delimiters, encoded-short passwords and credential-file overrides',async()=>{const base=process.env['DATABASE_URL']!;for(const tail of ['?','#']){vi.stubEnv('DATABASE_URL',base+tail);await expect(groupReminderDatabase()).rejects.toThrow('TEST_DATABASE_TARGET_REJECTED');}vi.stubEnv('DATABASE_URL',base.replace('s'.repeat(32),'%41'.repeat(11)));await expect(groupReminderDatabase()).rejects.toThrow('TEST_DATABASE_TARGET_REJECTED');vi.stubEnv('DATABASE_URL',base);vi.stubEnv('DATABASE_URL_FILE','/synthetic/must-not-read');await expect(groupReminderDatabase()).rejects.toThrow('TEST_DATABASE_TARGET_REJECTED');expect(state().docker).toHaveLength(0);});
 it.each(['tcp://127.0.0.1:2375','tcp://remote.invalid:2376','ssh://remote.invalid','unix:///tmp/docker.sock?host=remote'])('rejects non-local or ambiguous Docker endpoint %s',async endpoint=>{state().endpoint=endpoint;await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_ENDPOINT_REJECTED');expect(state().docker.every(c=>c.args[0]==='context')).toBe(true);expect(state().sql).toHaveLength(0);});
 it('rejects remote DOCKER_HOST, remote selected context, host/context disagreement and TLS overrides',async()=>{vi.stubEnv('DOCKER_HOST','tcp://remote.invalid:2375');await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_ENDPOINT_REJECTED');expect(state().docker).toHaveLength(0);vi.stubEnv('DOCKER_HOST',undefined);vi.stubEnv('DOCKER_CONTEXT','remote');state().endpoint='ssh://remote.invalid';await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_ENDPOINT_REJECTED');state().endpoint='unix:///synthetic/docker.sock';vi.stubEnv('DOCKER_HOST','unix:///different/docker.sock');await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_ENDPOINT_REJECTED');vi.stubEnv('DOCKER_HOST',undefined);vi.stubEnv('DOCKER_TLS_VERIFY','1');await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_ENDPOINT_REJECTED');expect(state().sql).toHaveLength(0);});
 it.each(['containerHost','containerPort','containerImage','containerRunning','ids'] as const)('rejects Docker container mismatch %s before SQL',async field=>{Object.assign(state(),{[field]:field==='containerRunning'?false:field==='containerHost'?'0.0.0.0':field==='containerPort'?'64710':'wrong'});await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_CONTAINER_REJECTED');expect(state().sql).toHaveLength(0);});
 it('cross-checks source role and Docker/TCP cluster identities before create',async()=>{state().role='oa_app';await expect(groupReminderDatabase()).rejects.toThrow('TEST_CLUSTER_IDENTITY_REJECTED');reset();state().dockerSystem='999';await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_CLUSTER_MISMATCH');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it.each(['hash','missing','duplicate','96'])('rejects source migration ledger drift: %s',async kind=>{const s=state();if(kind==='hash')s.source[0]!.hash='0'.repeat(64);else if(kind==='missing')s.source.pop();else if(kind==='duplicate')s.source[1]=s.source[0]!;else{s.source.push({name:name95,hash:hash(s.files.get(name95)!)});s.source.push({name:'096_unreviewed.sql',hash:'0'.repeat(64)});}await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_LEDGER_REJECTED');expect(s.sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it.each(['TABLE DATA','MATERIALIZED VIEW DATA','SEQUENCE SET','BLOB','DATABASE PROPERTIES'])('rejects non-schema archive TOC %s before create',async item=>{state().toc='1; 0 0 '+item+' public synthetic oa_migrator';await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_DATA_REJECTED');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it.each(['CREATE ROLE dangerous;','ALTER ROLE oa_app PASSWORD \'synthetic\';','DROP ROLE oa_app;','CREATE DATABASE other;','DROP DATABASE anthys_test;','ALTER DATABASE anthys_test SET x=y;','ALTER SYSTEM SET x=y;','GRANT oa_runtime TO oa_app;','\\connect anthys_test','\\! echo unsafe'])('rejects cluster-operation SQL before restore: %s',async sql=>{state().rendered=sql;await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it('accepts complete schema shapes with quoted function bodies, comments, ownership and multiline object ACLs',async()=>{
  state().rendered=String.raw`\restrict SyntheticGuard123
-- CREATE DATABASE must not be interpreted inside comments.
/* outer /* ALTER ROLE */ still a comment */
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE FUNCTION public.synthetic() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN RETURN 'ALTER ROLE oa_app PASSWORD ''synthetic'';'; END
$body$;
ALTER FUNCTION public.synthetic() OWNER TO oa_migrator;
COMMENT ON FUNCTION public.synthetic() IS 'PASSWORD policy; CREATE DATABASE example';
GRANT EXECUTE
ON FUNCTION public.synthetic() TO oa_runtime;
REVOKE ALL ON FUNCTION public.synthetic() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE oa_migrator IN SCHEMA public GRANT SELECT ON TABLES TO oa_app;
\unrestrict SyntheticGuard123
`;
  const f=await groupReminderDatabase();await f.close();
 });
 it.each(["CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT 'safe'; $$; CREATE ROLE unsafe;","DO $$ BEGIN EXECUTE 'CREATE ROLE unsafe'; END $$;","SELECT pg_catalog.set_config('search_path','',false); SELECT dangerous();","/* unterminated","CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $body$ no closing tag",'REVOKE oa_runtime\nFROM oa_app;'])('rejects actual commands after function bodies, executable top-level code and malformed schema',async rendered=>{state().rendered=rendered;await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it('checks source ledger twice and rejects invalid archive before create',async()=>{state().changeSource=true;await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_LEDGER_REJECTED');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);reset();state().archive=Buffer.from('not-custom');await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_ARCHIVE_REJECTED');expect(state().sql.some(q=>q.text.startsWith('CREATE DATABASE'))).toBe(false);});
 it('installs the pending contract in its own DB transaction, is idempotent and coalesces concurrent calls',async()=>{
  const f=await groupReminderDatabase(),last=requiredSchema.migrations.at(-1)!,pending=requiredSchema.migrations.slice(94);
  const [a,b]=await Promise.all([f.install(),f.install()]);expect(a).toBe(hash(state().files.get(last.name)!));expect(b).toBe(a);expect(state().applied).toBe(1);expect(await f.install()).toBe(a);expect(state().applied).toBe(1);
  expect(state().sql.filter(q=>pending.some(m=>q.text===state().files.get(m.name))).every(q=>q.database===f.name)).toBe(true);
  await f.close();await expect(f.install()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');
 });
 it('leaves the shared source ledger at94 and never applies pending migrations to it',async()=>{
  const s=state(),pending=requiredSchema.migrations.slice(94),f=await groupReminderDatabase();
  expect(await f.install()).toBe(hash(s.files.get(pending.at(-1)!.name)!));
  expect(s.source).toHaveLength(94);expect(s.ledgers.get(f.name)).toHaveLength(requiredSchema.migrations.length);
  expect(s.source.map(row=>row.name)).toEqual(requiredSchema.migrations.slice(0,94).map(m=>m.name));
  expect(s.sql.filter(q=>q.database==='anthys_test').every(q=>q.text.startsWith('SELECT'))).toBe(true);
  await f.close();
 });
 it('supports source already95 with exact checked hash without reapplying 095',async()=>{
  const s=state();s.source.push({name:name95,hash:hash(s.files.get(name95)!)});const last=requiredSchema.migrations.at(-1)!;
  const f=await groupReminderDatabase();expect(await f.install()).toBe(hash(s.files.get(last.name)!));expect(s.applied).toBe(0);expect(s.ledgers.get(f.name)).toHaveLength(requiredSchema.migrations.length);await f.close();
 });
 it('rejects own ledger/file drift and rolls back a failed095 without mutating source',async()=>{const f=await groupReminderDatabase(),s=state();s.failInstall=true;await expect(f.install()).rejects.toThrow('TEST_OWN_MIGRATION_FAILED');expect(s.ledgers.get(f.name)).toHaveLength(94);expect(s.source).toHaveLength(94);s.failInstall=false;await f.install();s.files.set(name95,'CREATE TABLE changed_definition(id int);');await expect(f.install()).rejects.toThrow('TEST_SCHEMA_LEDGER_REJECTED');await f.close();});
 it('sanitizes restore errors, cleans only confirmed-created own DB, and never forces a blocked drop',async()=>{state().failRestore=true;await expect(groupReminderDatabase()).rejects.toThrow('TEST_DOCKER_COMMAND_FAILED');expect(state().events.filter(e=>e.startsWith('drop:'))).toHaveLength(1);reset();const f=await groupReminderDatabase();state().dropBlocked=true;await expect(f.close()).rejects.toThrow('TEST_OWN_DATABASE_DROP_FAILED');expect(state().ledgers.has(f.name)).toBe(true);expect(state().sql.every(q=>!q.text.includes('FORCE')&&!q.text.includes('terminate'))).toBe(true);state().dropBlocked=false;await f.close();expect(state().ledgers.has(f.name)).toBe(false);});
 it('does not drop an unconfirmed database on CREATE failure, retains its exact nonce as UNKNOWN, and rejects a restored data ledger',async()=>{state().createFails=true;const error=await groupReminderDatabase().catch(e=>e as Error&{ownDatabaseName:string;creationState:string});if(!(error instanceof Error))throw Error('Expected rejected CREATE');expect(error).toMatchObject({message:'TEST_DISPOSABLE_SCHEMA_SETUP_FAILED',creationState:'UNKNOWN'});const attempted=state().sql.find(q=>q.text.startsWith('CREATE DATABASE'))!;expect(attempted.text).toBe(`CREATE DATABASE "${error.ownDatabaseName}" TEMPLATE template0`);expect(error.ownDatabaseName).toMatch(/^anthys_test_group_reminder_[a-f0-9]{32}$/);expect(state().sql.some(q=>q.text.startsWith('DROP DATABASE'))).toBe(false);reset();state().restoreHasLedger=true;await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_LEDGER_NOT_EMPTY');expect(state().events.filter(e=>e.startsWith('drop:'))).toHaveLength(1);expect(state().sql.filter(q=>q.text.startsWith('INSERT'))).toHaveLength(0);});
 it('rejects installed095 hash drift and cluster SQL in the pending install file',async()=>{state().source.push({name:name95,hash:'0'.repeat(64)});await expect(groupReminderDatabase()).rejects.toThrow('TEST_SCHEMA_LEDGER_REJECTED');reset();const f=await groupReminderDatabase();state().files.set(name95,'ALTER ROLE oa_app LOGIN;');await expect(f.install()).rejects.toThrow('TEST_SCHEMA_CLUSTER_OPERATION_REJECTED');expect(state().applied).toBe(0);await f.close();});
 it('backup operations reject after close and only privately issued dump bytes can create a restore nonce',async()=>{const f=await groupReminderDatabase();await expect(f.restoreOwn(Buffer.from('PGDMPunissued'))).rejects.toThrow('TEST_OWN_ARCHIVE_REJECTED');const count=state().sql.filter(q=>q.text.startsWith('CREATE DATABASE')).length;expect(count).toBe(1);await f.close();await expect(f.dumpOwn()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');await expect(f.restoreOwn(state().archive)).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');});
 it('restore create failure is sanitized UNKNOWN and is never automatically dropped or retried',async()=>{const f=await groupReminderDatabase(),archive=await f.dumpOwn();state().createFails=true;const error=await f.restoreOwn(archive).catch(e=>e as Error&{ownDatabaseName:string;creationState:string});expect(error).toMatchObject({message:'TEST_RESTORE_DATABASE_CREATE_FAILED',creationState:'UNKNOWN'});if(!(error instanceof Error))throw Error('EXPECTED_RESTORE_CREATE_FAILURE');const named=(error as Error&{ownDatabaseName:string}).ownDatabaseName;expect(named).toMatch(/^anthys_test_group_reminder_[a-f0-9]{32}$/);expect(named).not.toBe(f.name);state().createFails=false;await f.close();expect(state().sql.some(q=>q.text.startsWith('DROP DATABASE')&&q.text.includes(named))).toBe(false);});

 it('destruction is restricted to the confirmed own nonce and preserves issued backups for a later fresh target',async()=>{const f=await groupReminderDatabase(),archive=await f.dumpOwn();expect(await f.destroyOwnSource()).toEqual({name:f.name,state:'DESTROYED'});expect(state().source).toHaveLength(94);expect(state().ledgers.has(f.name)).toBe(false);await expect(f.dumpOwn()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');await expect(f.install()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');await expect(f.destroyOwnSource()).rejects.toThrow('TEST_OWN_DATABASE_CLOSED');const restored=await f.restoreOwn(archive);expect(restored.name).not.toBe(f.name);expect(state().ledgers.has(restored.name)).toBe(true);await f.close();expect(state().ledgers.has(restored.name)).toBe(false);expect(state().sql.filter(q=>q.text.startsWith('DROP DATABASE')).every(q=>!q.text.includes('"anthys_test"')&&!q.text.includes('FORCE'))).toBe(true);});
 it('source destruction refuses an in-flight restore or an existing restoration instead of closing their pools',async()=>{const f=await groupReminderDatabase(),archive=await f.dumpOwn(),pending=f.restoreOwn(archive);await expect(f.destroyOwnSource()).rejects.toThrow('TEST_OWN_DISASTER_REQUIRES_IDLE_SOURCE');await pending;await expect(f.destroyOwnSource()).rejects.toThrow('TEST_OWN_DISASTER_REQUIRES_IDLE_SOURCE');expect(state().ledgers.has(f.name)).toBe(true);expect(state().events.filter(e=>e.startsWith('close:'))).toEqual([]);await f.close();});

});
