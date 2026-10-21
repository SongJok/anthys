import '../support/isolation.js';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {secret,config} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {createServer} from '../../apps/api/src/server.js';
import type {GroupReminders} from '../../packages/groups/src/reminders.js';
import {GroupReminderError} from '../../packages/groups/src/reminder-model.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupReminderWorld} from '../support/group-reminder-world.js';
const isolated=await groupReminderDatabase();await isolated.install();const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const worlds:Awaited<ReturnType<typeof groupReminderWorld>>[]=[],fixtures:Record<string,unknown>={};
for(const project of ['desktop','mobile']){const w=await groupReminderWorld(isolated.root,isolated.db,isolated.appDb,vault);worlds.push(w);fixtures[project]={group:w.f.conversationId,actorId:w.principal.actorId,adminCookie:w.session.cookie,tenantId:w.principal.tenantId,isolatedDatabase:isolated.name};}
await writeFile('.data/test-environment/browser-group-reminders.json',JSON.stringify(fixtures),{mode:0o600});
const service=(p:{tenantId:string})=>{const w=worlds.find(w=>w.principal.tenantId===p.tenantId);if(!w)throw new GroupReminderError('GROUP_REMINDER_NOT_FOUND',404);return w.reminders;};
const reminders:Pick<GroupReminders,'list'|'preview'|'create'|'mutate'>={list:(p,...args)=>service(p).list(p,...args),preview:(p,...args)=>service(p).preview(p,...args),create:(p,...args)=>service(p).create(p,...args),mutate:(p,...args)=>service(p).mutate(p,...args)};
const {app}=await createServer({config:{...config(),APP_ORIGIN:'http://localhost:52339'},db:isolated.appDb,sessionSecret:secret('SESSION_SECRET')!,groupReminders:reminders,webRoot:resolve('dist/web')});await app.listen({host:'127.0.0.1',port:52339});
let closing=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{if(closing)return;closing=true;void app.close().then(async()=>{for(const w of worlds)await w.f.close();await isolated.close();});});
