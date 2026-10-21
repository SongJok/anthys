import '../support/isolation.js';
import {secret,config} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {GroupReminderAudience} from '../../packages/groups/src/reminder-audience.js';
import {GroupReminderScheduler} from '../../packages/groups/src/reminder-runner.js';
import {GroupReminderVerifier} from '../../packages/groups/src/reminder-delivery.js';
import {createServer} from '../../apps/api/src/server.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
import {signedReminderRuntime} from '../support/group-reminder-signed-runtime.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),base='http://127.0.0.1:52339';
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>,rpc:Awaited<ReturnType<typeof signedReminderRuntime>>,scheduler:GroupReminderScheduler,verifier:GroupReminderVerifier,api:Awaited<ReturnType<typeof createServer>>,store:RuntimeStore,q:{scheduleId:string;occurrenceId:string},ownerCookie:string,taskId:string,runId:string,deliveryId:string,body:string,sends=0;
beforeAll(async()=>{
 d=await groupReminderDatabase();await d.install();s=await reminderExecution(d,vault,2);q=await s.queue();rpc=await signedReminderRuntime(d,s,vault,q);scheduler=new GroupReminderScheduler(d.db,vault,new GroupReminderAudience(rpc.identities,'robot-1'),'robot-1');verifier=new GroupReminderVerifier(vault,new GroupReminderAudience(rpc.identities,'robot-1'),'robot-1');
 ownerCookie=(await new Sessions(d.appDb,secret('SESSION_SECRET')!).create(s.w.f.ctx)).cookie;store=new RuntimeStore(d.db,vault);api=await createServer({config:config(),db:d.appDb,sessionSecret:secret('SESSION_SECRET')!,finalReader:new Gateway(store)});await api.app.listen({host:'127.0.0.1',port:52339});
});
afterAll(async()=>{await api?.app.close();await scheduler?.audience.close();await verifier?.close();await rpc?.close();await s?.close();await d?.close();});
const read=async(cookie=ownerCookie)=>{const r=await fetch(base+'/api/v1/tasks/'+taskId,{headers:{cookie:'oa_session='+cookie}});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json() as {data?:{runs:{id:string;result:string|null;result_access?:string}[]}}};};
describe('configured signed scheduled origin, real HTTP and PG',{concurrent:false},()=>{
 it('uses persisted scheduled authority over actual configured signed UDS and CLI before staging',async()=>{
  const before=(await s.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length;expect(rpc.identities.runner?.transport).toBe('SIGNED_GROUP');expect(await scheduler.stage(s.w.f.ctx,q.occurrenceId,new AbortController().signal)).toBe('STAGED');const row=(await d.root.query('SELECT task_id,run_id,delivery_id FROM group_reminder_occurrences WHERE id=$1',[q.occurrenceId])).rows[0];taskId=row.task_id;runId=row.run_id;deliveryId=row.delivery_id;body=(await d.root.query('SELECT result FROM runs WHERE id=$1',[runId])).rows[0].result;
  expect((await s.w.f.fixture.events()).filter(e=>e.phase==='GROUP_READ').length-before).toBe(2);expect(s.w.f.requests).toEqual([]);
 });
 it('defaults to withholding unverified results then explicitly configured proof exposes only the actual owner result',async()=>{
  const denied=await read();expect(denied.status).toBe(200);expect(denied.body.data?.runs.find(r=>r.id===runId)).toMatchObject({result:null,result_access:'CURRENT_SOURCE_UNVERIFIED'});store.configureGroupReminderVerifier(verifier);
  const allowed=await read();expect(allowed.status).toBe(200);expect(allowed.cache).toBe('private, no-store');expect(allowed.body.data?.runs.find(r=>r.id===runId)?.result).toBe(body);expect((await read(s.w.session.cookie)).status).toBe(404);
 });
 it('rechecks signed current sources before one physical synthetic send and hides the old HTTP result after source change',async()=>{
  const gateway=new DeliveryGateway(d.db,vault,{sendReply:async()=>{throw Error('UNEXPECTED');},sendProactive:async(target,text)=>{expect(target).toEqual({kind:'GROUP',externalId:s.w.f.conversationId});expect(text).toBe(body);sends++;return {state:'APPLIED_UNVERIFIED'};}},s.w.f.binding,Date.now,undefined,verifier);
  expect(await gateway.process(s.w.f.ctx,deliveryId,new AbortController().signal)).toBe('APPLIED_UNVERIFIED');expect(await gateway.process(s.w.f.ctx,deliveryId,new AbortController().signal)).toBe('NOT_CLAIMED');expect(sends).toBe(1);await d.root.query('UPDATE group_cases SET version=version+1 WHERE id=$1 AND tenant_id=$2',[s.ids[0],s.w.principal.tenantId]);const stale=await read();expect(stale.status).toBe(200);expect(stale.body.data?.runs.find(r=>r.id===runId)).toMatchObject({result:null,result_access:'CURRENT_SOURCE_UNVERIFIED'});expect(s.w.f.requests).toEqual([]);
 });
});
