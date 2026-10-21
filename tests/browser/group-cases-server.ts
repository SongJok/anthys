import '../support/isolation.js';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {secret,config} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {GroupCases} from '../../packages/groups/src/cases.js';
import {GroupContracts} from '../../packages/groups/src/contracts.js';
import {createServer} from '../../apps/api/src/server.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {GroupEscalations} from '../../packages/groups/src/escalations.js';
import {createGroupEscalationAdapter} from '../../packages/groups/src/escalation-adapter.js';
import type {GroupEscalationApi} from '../../apps/api/src/group-escalations.js';

const isolated=await groupReminderDatabase();await isolated.install();
const root=isolated.root,runtime=isolated.db,appDb=isolated.appDb,vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const worlds:Awaited<ReturnType<typeof groupCaseWorld>>[]=[];
const fixtures:Record<string,unknown>={},escalations=new Map<string,GroupEscalationApi>(),rosters:GroupCaseRoster[]=[];
for(const project of ['desktop','mobile']){
 const w=await groupCaseWorld(root,runtime,appDb,vault);worlds.push(w);w.document.actions.allowed.push('case.escalate');w.document.escalationUserIds=[w.f.ctx.actorId];w.document.workHours={timezone:'UTC',windows:[{daysOfWeek:[1,2,3,4,5,6,7],start:'00:00',end:'12:00'},{daysOfWeek:[1,2,3,4,5,6,7],start:'12:00',end:'00:00'}]};await w.approve();await w.save();const roster=new GroupCaseRoster(w.f.dws,'robot-1');rosters.push(roster);escalations.set(w.principal.tenantId,createGroupEscalationAdapter(new GroupEscalations(runtime,vault,roster,'robot-1')));
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(w.f.ctx),apiSession=await sessions.create(w.f.ctx),adminApiSession=await sessions.create(w.admin);
 const contractWorld=await groupCaseWorld(root,runtime,appDb,vault);worlds.push(contractWorld);await contractWorld.approve();await contractWorld.save();await contractWorld.service.transition(contractWorld.principal,contractWorld.document.id,{delegationId:contractWorld.profile.document.id,expectedVersion:1,state:'PAUSED'},randomUUID());
 const contractApiSession=await sessions.create(contractWorld.admin),contractOwnerSession=await sessions.create(contractWorld.f.ctx);
 fixtures[project]={group:w.f.conversationId,ownerId:w.f.ctx.actorId,ownerCookie:session.cookie,ownerCsrf:session.csrf,ownerApiCookie:apiSession.cookie,ownerApiCsrf:apiSession.csrf,adminCookie:w.session.cookie,adminCsrf:w.session.csrf,adminApiCookie:adminApiSession.cookie,adminApiCsrf:adminApiSession.csrf,tenantId:w.f.ctx.tenantId,taskId:w.f.taskId,contractAdmin:{delegationId:contractWorld.profile.document.id,contractId:contractWorld.document.id,adminCookie:contractWorld.session.cookie,apiCookie:contractApiSession.cookie,apiCsrf:contractApiSession.csrf,ownerCookie:contractOwnerSession.cookie,ownerCsrf:contractOwnerSession.csrf}};
}
await writeFile('.data/test-environment/browser-group-cases.json',JSON.stringify(fixtures),{mode:0o600});
const cases:Pick<GroupCases,'list'|'create'|'update'>={list:(p,...args)=>worlds.find(w=>w.f.ctx.tenantId===p.tenantId)!.cases.list(p,...args),create:(p,...args)=>worlds.find(w=>w.f.ctx.tenantId===p.tenantId)!.cases.create(p,...args),update:(p,...args)=>worlds.find(w=>w.f.ctx.tenantId===p.tenantId)!.cases.update(p,...args)};
// Synthetic member-list latency applies only during confirmation. The real API,
// signed roster reads, PostgreSQL writes and all production deadlines stay intact.
const enqueue:GroupEscalationApi['enqueue']=async(c,...args)=>{
 const world=worlds.find(w=>w.principal.tenantId===c.principal.tenantId)!;
 await world.f.configure({delayMs:650});
 try{return await escalations.get(c.principal.tenantId)!.enqueue(c,...args);}
 finally{await world.f.configure({delayMs:0});}
};
const {app}=await createServer({config:{...config(),APP_ORIGIN:'http://localhost:52339'},db:appDb,sessionSecret:secret('SESSION_SECRET')!,groupCases:cases,groupEscalations:{prepare:(c,...args)=>escalations.get(c.principal.tenantId)!.prepare(c,...args),read:(c,...args)=>escalations.get(c.principal.tenantId)!.read(c,...args),enqueue,cancel:(c,...args)=>escalations.get(c.principal.tenantId)!.cancel(c,...args)},groupContracts:new GroupContracts(runtime,vault),webRoot:resolve('dist/web')});
await app.listen({host:'127.0.0.1',port:52339});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void app.close().then(async()=>{for(const roster of rosters)await roster.close();for(const w of worlds)await w.f.close();await isolated.close();});});
