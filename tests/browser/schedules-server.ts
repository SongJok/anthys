import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {secret,config} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Schedules} from '../../packages/schedules/src/service.js';
import {ReminderScheduler} from '../../packages/schedules/src/runner.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {createServer} from '../../apps/api/src/server.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),runtime=new Database(secret('RUNTIME_DATABASE_URL')!),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),service=new Schedules(runtime,vault),fixtures:Record<string,unknown>={};
for(const project of ['desktop','mobile']){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='synthetic-ui-reminder-'+ctx.tenantId;
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic reminder UI','ACTIVE')",[ctx.tenantId,corpId]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic reminder UI','ACTIVE')",[ctx.tenantId,ctx.actorId]);
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(ctx),apiSession=await sessions.create(ctx),principal=(await sessions.authenticate(apiSession.cookie))!,past=new Schedules(runtime,vault,()=>Date.now()-10000);
 const seeded=(await past.create(principal,{kind:'PRIVATE_TEXT_REMINDER',text:'合成未知投递 '+project,rule:{schemaVersion:1,kind:'ONCE',tz:'UTC',start:{kind:'UTC',at:new Date(Math.floor((Date.now()-5000)/1000)*1000).toISOString()},misfire:{kind:'REMINDER_LATEST'}}},randomUUID())).schedule;
 await new ReminderScheduler(service).tick(ctx);const occurrence=(await root.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1',[seeded.id])).rows[0];
 const delivery=new DeliveryGateway(runtime,vault,{sendReply:async()=>{throw Error('UNEXPECTED_REPLY');},sendProactive:async()=>({state:'UNKNOWN',reason:'SYNTHETIC_ACCEPTANCE_LOST'})},{corpId,robotCode:'synthetic-reminder-ui',appOrigin:'http://localhost:52339'});if(await delivery.process(ctx,occurrence.delivery_id,new AbortController().signal)!=='UNKNOWN')throw Error('UNKNOWN_FIXTURE_REJECTED');
 fixtures[project]={actorId:ctx.actorId,cookie:session.cookie,apiCookie:apiSession.cookie,apiCsrf:apiSession.csrf,unknownId:seeded.id};
}
await writeFile('.data/test-environment/browser-schedules.json',JSON.stringify(fixtures),{mode:0o600});
const {app}=await createServer({config:{...config(),APP_ORIGIN:'http://localhost:52339'},db:appDb,sessionSecret:secret('SESSION_SECRET')!,schedules:service,webRoot:resolve('dist/web')});await app.listen({host:'127.0.0.1',port:52339});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close().then(async()=>{await runtime.close();await appDb.close();await root.end();});});
