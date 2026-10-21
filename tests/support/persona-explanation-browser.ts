import './isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {config,secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {RunPersonas} from '../../packages/personas/src/runtime.js';
import {TaskStore} from '../../packages/tasks/src/store.js';
import {ControlPlane} from '../../packages/gateway/src/control-plane.js';
import {createServer} from '../../apps/api/src/server.js';
import {personaFixture} from './personas.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),f=await personaFixture(root,db,appDb,vault),store=new RuntimeStore(db,vault),tasks=new TaskStore(appDb);
store.configurePersonas(new RunPersonas(db,vault));const gateway=new Gateway(store),fixtures:Record<string,{taskId:string;runId:string;snapshotId:string;unboundId:string;builtinId:string;legacyId:string}>={};
for(const [project,name] of [['desktop','alice'],['mobile','bob']] as const){
 const ctx=f.people[name];await root.query('UPDATE users SET union_id=$2 WHERE id=$1',[ctx.actorId,'synthetic-explanation-'+project+'-union']);const saved=await f.patch(name,f.scope(name),{tone:'DIRECT',address:'PRIVATE_BROWSER_SNAPSHOT_CANARY'}),bound=await tasks.create(ctx,'偏好快照 '+project,randomUUID()),lease=await store.acquire(ctx,bound.runId,'browser-explanation');
 if(!lease||!await gateway.preparePersonas(ctx,lease,new AbortController().signal)||!lease.personaSnapshot)throw Error('BROWSER_SNAPSHOT_PREPARATION_FAILED');await f.patch(name,f.scope(name),{tone:'FORMAL'},saved.etag);
 const unbound=await tasks.create(ctx,'尚未固定 '+project,randomUUID()),builtin=await tasks.create(ctx,'内置默认 '+project,randomUUID());if(!await new RuntimeStore(db,vault).acquire(ctx,builtin.runId,'browser-builtin'))throw Error('BROWSER_BUILTIN_PREPARATION_FAILED');
 const legacy=await tasks.create(ctx,'旧运行 '+project,randomUUID());await root.query("UPDATE runs SET persona_context_state='LEGACY_NONE' WHERE id=$1",[legacy.runId]);fixtures[project]={...bound,snapshotId:lease.personaSnapshot.id,unboundId:unbound.taskId,builtinId:builtin.taskId,legacyId:legacy.taskId};
}
const key=randomBytes(32).toString('hex'),{app}=await createServer({config:config({APP_ENV:'test',APP_ORIGIN:'http://localhost:64702',PORT:'64702'}),db:appDb,sessionSecret:key,personas:f.service,finalReader:gateway,controls:new ControlPlane(store,key),webRoot:resolve('dist/web'),login:{tenantId:f.tenantId,corpId:'synthetic-personas-'+f.tenantId,clientId:'synthetic-explanation-client',provider:{exchange:async code=>{if(!['synthetic-explanation-desktop','synthetic-explanation-mobile'].includes(code))throw Error('SYNTHETIC_LOGIN_CODE_REQUIRED');return {corpId:'synthetic-personas-'+f.tenantId,unionId:code+'-union'};}}}});
app.get('/__synthetic_explanation_fixture',async()=>({fixtures}));await app.listen({host:'127.0.0.1',port:64702});
let stopping=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{if(stopping)return;stopping=true;void app.close().then(()=>f.close()).then(()=>db.close()).then(()=>appDb.close()).then(()=>root.end()).then(()=>process.exit(0));});
