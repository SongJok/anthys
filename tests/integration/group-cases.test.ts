import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {secret,config} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {GroupCases} from '../../packages/groups/src/cases.js';
import type {CaseCommand} from '../../packages/groups/src/case-model.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {createServer} from '../../apps/api/src/server.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,30),appDb=new Database(secret('DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const fixtures:Awaited<ReturnType<typeof groupCaseWorld>>[]=[];
afterAll(async()=>{for(const w of fixtures)await w.f.close();await db.close();await appDb.close();await root.end();});
async function world(ownerReported=false){
 const w=await groupCaseWorld(root,db,appDb,vault);fixtures.push(w);if(ownerReported)w.document.actions.allowed.push('case.owner_reported');await w.approve();await w.save();
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),ownerSession=await sessions.create(w.f.ctx),owner=(await sessions.authenticate(ownerSession.cookie))!;
 return {...w,owner,ownerSession,group:w.f.conversationId};
}
const query=()=>({from:new Date(Date.now()-86400000).toISOString(),until:new Date(Date.now()+86400000).toISOString()});
const details=(resourceRef='release:service-a')=>({title:'发布阻塞',resourceRef,priority:'HIGH' as const,dueAt:null});
type World=Awaited<ReturnType<typeof world>>;
async function submit(w:World,kind:'MENTION'|'CARD'='MENTION',resource='release:service-a',key=randomUUID()){
 return w.cases.create(w.owner,w.group,{contractVersion:1,details:details(resource),source:kind==='MENTION'?{kind,taskId:w.f.taskId}:{kind,shareWithGroup:true}},key);
}
async function change(w:World,item:{id:string;version:number},command:CaseCommand,admin=false,key=randomUUID()){
 return w.cases.update(admin?w.principal:w.owner,w.group,item.id,{contractVersion:1,expectedVersion:item.version,command},key);
}

it('T108 real session/API/PG registers authenticated mention and explicit card sources and discloses limited coverage',async()=>{
 const w=await world(),api=await createServer({config:config(),db:appDb,sessionSecret:secret('SESSION_SECRET')!,groupCases:w.cases});
 try{
  const url='/api/v1/groups/'+encodeURIComponent(w.group)+'/cases';
  const headers={cookie:'oa_session='+w.ownerSession.cookie,origin:config().APP_ORIGIN,'x-csrf-token':w.ownerSession.csrf,'idempotency-key':randomUUID()};
  const accepted=await api.app.inject({url,method:'POST',headers,payload:{contractVersion:1,details:details(),source:{kind:'MENTION',taskId:w.f.taskId}}});
  expect(accepted.statusCode).toBe(201);expect(accepted.json().data.case).toMatchObject({state:'PROPOSED',ownerId:null,dueAt:null,sources:[{kind:'MENTION',source_event_id:expect.any(String),submitted_by:w.owner.actorId}]});
  await submit(w,'CARD','release:service-b');
  const listed=await api.app.inject({url:url+'?'+new URLSearchParams(query()),headers:{cookie:headers.cookie}});
  expect(listed.statusCode).toBe(200);expect(listed.headers['cache-control']).toBe('private, no-store');
  expect(listed.json().data.items).toHaveLength(2);expect(listed.json().data.coverage).toMatchObject({mode:'MENTION_ONLY',completeChat:false});expect(listed.json().data.coverage.notice).toContain('不覆盖全部群聊');
  expect((await root.query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.owner.tenantId])).rows[0].n).toBe(2);expect(w.f.requests).toHaveLength(0);
  expect((await api.app.inject({url,method:'POST',headers:{...headers,'x-csrf-token':''},payload:{}})).statusCode).toBe(401);
  expect((await api.app.inject({url,method:'POST',headers:{...headers,'idempotency-key':randomUUID()},payload:{contractVersion:1,details:details(),source:{kind:'CARD',shareWithGroup:false}}})).statusCode).toBe(400);
 }finally{await api.app.close();}
});

describe('T109 exact source/resource deduplication retains different resources and concurrent request replay is once',{concurrent:false},()=>{
 let w:World,key:string,body:Record<string,unknown>,firstId:string;
 beforeAll(async()=>{w=await world();key=randomUUID();body={contractVersion:1,details:details(),source:{kind:'MENTION',taskId:w.f.taskId}};});
 it('retains the 20-way exact-request race and one persisted mutation',async()=>{
 const repeated=await Promise.all(Array.from({length:20},()=>w.cases.create(w.owner,w.group,body,key)));
 expect(new Set(repeated.map(x=>x.case.id)).size).toBe(1);expect(repeated.filter(x=>!x.replayed)).toHaveLength(1);firstId=repeated[0]!.case.id;
 });
 it('deduplicates the same source while retaining different resource and reporter identities',async()=>{
 expect((await submit(w)).duplicate).toBe(true);
 const different=await submit(w,'MENTION','release:service-b');expect(different.case.id).not.toBe(firstId);
 const admin=await w.cases.create(w.principal,w.group,{contractVersion:1,details:details('release:service-c'),source:{kind:'CARD',shareWithGroup:true}},randomUUID());expect(admin.case.id).not.toBe(different.case.id);
 const list=await w.cases.list(w.owner,w.group,query());expect(list.items).toHaveLength(3);expect(list.items.every(x=>x.title==='发布阻塞'&&x.sources.length===1)).toBe(true);
 });
 it('rejects changed replay intent and returns distinct bounded pages',async()=>{
 await expect(w.cases.create(w.owner,w.group,{...body,details:details('other')},key)).rejects.toMatchObject({code:'GROUP_CASE_REQUEST_CONFLICT'});
 const first=await w.cases.list(w.owner,w.group,{...query(),limit:1});expect(first.nextCursor).not.toBeNull();const second=await w.cases.list(w.owner,w.group,{...query(),limit:1,cursor:first.nextCursor!});expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
});
});
it('different authenticated reporters reusing a card UUID and resource retain separate source identities',async()=>{
 const w=await world(),key=randomUUID(),body={contractVersion:1,details:details(),source:{kind:'CARD',shareWithGroup:true}};
 const owner=await w.cases.create(w.owner,w.group,body,key),admin=await w.cases.create(w.principal,w.group,body,key);
 expect(owner.case.id).not.toBe(admin.case.id);expect(owner.case.sources[0]!.submitted_by).toBe(w.owner.actorId);expect(admin.case.sources[0]!.submitted_by).toBe(w.principal.actorId);
 expect((await w.cases.list(w.owner,w.group,query())).items).toHaveLength(2);
});

// Keep one persisted case across the three phases. Each authenticated command
// still performs both fresh signed-roster reads; the original 20s per-test and
// 12s per-command deadlines apply independently to each phase.
describe('T110 owner completion and independent confirmation provenance',{concurrent:false},()=>{
 let w:World,item:Awaited<ReturnType<typeof submit>>['case'];
 beforeAll(async()=>{w=await world();item=(await submit(w)).case;});
 it('opens, assigns and starts the registered case without granting the owner administrator actions',async()=>{
 await expect(change(w,item,{operation:'ASSIGN',ownerId:w.owner.actorId})).rejects.toMatchObject({code:'GROUP_CASE_TRANSITION_DENIED'});
 item=(await change(w,item,{operation:'OPEN'},true)).case;
 item=(await change(w,item,{operation:'ASSIGN',ownerId:w.owner.actorId},true)).case;
 item=(await change(w,item,{operation:'START'})).case;
 item=(await change(w,item,{operation:'BLOCK',reason:'等待依赖版本'})).case;expect(item.blockedReason).toBe('等待依赖版本');
 });
 it('keeps an owner completion claim waiting and rejects self confirmation',async()=>{
 expect(item.state).toBe('BLOCKED');
 item=(await change(w,item,{operation:'CLAIM_COMPLETE',statement:'已经好了'})).case;
 expect(item).toMatchObject({state:'WAITING_CONFIRMATION',completion:{method:'UNVERIFIED',actorId:w.owner.actorId,statement:'已经好了'}});
 await expect(change(w,item,{operation:'CONFIRM',statement:'自称已验证'})).rejects.toMatchObject({code:'GROUP_CASE_TRANSITION_DENIED'});
 });
 it('records independent administrator confirmation, close and the complete persisted transition history',async()=>{
 expect(item.state).toBe('WAITING_CONFIRMATION');
 item=(await change(w,item,{operation:'CONFIRM',statement:'人工核对发布检查单和负责人交付'},true)).case;
 expect(item).toMatchObject({state:'RESOLVED',completion:{method:'ADMIN_CONFIRMED',actorId:w.principal.actorId}});
 item=(await change(w,item,{operation:'CLOSE'},true)).case;expect(item.state).toBe('CLOSED');
 await expect(change(w,item,{operation:'START'})).rejects.toMatchObject({code:'GROUP_CASE_TRANSITION_DENIED'});
 expect((await root.query('SELECT operation FROM group_case_changes WHERE case_id=$1 ORDER BY case_version',[item.id])).rows.map(x=>x.operation)).toEqual(['CREATE','OPEN','ASSIGN','START','BLOCK','CLAIM_COMPLETE','CONFIRM','CLOSE']);
 });
});

it('explicit contract OWNER_REPORTED is labelled without impersonating an automatic verifier',async()=>{
 const w=await world(true);let item=(await submit(w)).case;item=(await change(w,item,{operation:'OPEN'},true)).case;item=(await change(w,item,{operation:'ASSIGN',ownerId:w.owner.actorId},true)).case;
 item=(await change(w,item,{operation:'CLAIM_COMPLETE',statement:'完成声明'})).case;expect(item).toMatchObject({state:'RESOLVED',completion:{method:'OWNER_REPORTED'}});
});

describe('current session, tenant/group/source, active owner and case/contract versions are checked before writes',{concurrent:false},()=>{
 let w:World,other:World,item:Awaited<ReturnType<typeof submit>>['case'];
 beforeAll(async()=>{w=await world();other=await world();item=(await submit(w)).case;});
 it('isolates colliding group strings, foreign cases and foreign mention sources',async()=>{
 // The external group string deliberately collides across tenants. The other
 // actor may read their own group's empty list but cannot read this case.
 expect((await other.cases.list(other.owner,w.group,query())).items).toEqual([]);
 await expect(other.cases.update(other.owner,w.group,item.id,{contractVersion:1,expectedVersion:1,command:{operation:'CANCEL'}},randomUUID())).rejects.toMatchObject({code:'GROUP_CASE_NOT_FOUND'});
 await expect(w.cases.list(w.owner,'other-group',query())).rejects.toMatchObject({code:'GROUP_CASE_NOT_FOUND'});
 await expect(w.cases.create(w.owner,w.group,{contractVersion:1,details:details(),source:{kind:'MENTION',taskId:other.f.taskId}},randomUUID())).rejects.toMatchObject({code:'GROUP_CASE_SOURCE_DENIED'});
 });
 it('rejects stale versions and nonmember owners before mutation',async()=>{
 await expect(w.cases.update(w.principal,w.group,item.id,{contractVersion:1,expectedVersion:2,command:{operation:'OPEN'}},randomUUID())).rejects.toMatchObject({code:'GROUP_CASE_VERSION_CONFLICT'});
 item=(await change(w,item,{operation:'OPEN'},true)).case;
 await expect(change(w,item,{operation:'ASSIGN',ownerId:other.owner.actorId},true)).rejects.toMatchObject({code:'GROUP_CASE_OWNER_NOT_MEMBER'});
 });
 it('replays cancellation once and enforces contract pause plus database access barriers',async()=>{
 const key=randomUUID(),cancelled=await change(w,item,{operation:'CANCEL'},false,key);expect(cancelled.case.state).toBe('CANCELLED');expect((await change(w,item,{operation:'CANCEL'},false,key)).replayed).toBe(true);
 await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,expectedVersion:1,state:'PAUSED'},randomUUID());
 await expect(w.cases.list(w.owner,w.group,query())).rejects.toMatchObject({code:'GROUP_CASE_NOT_FOUND'});
 expect((await root.query('SELECT count(*)::int n FROM group_cases WHERE tenant_id=$1',[w.owner.tenantId])).rows[0].n).toBe(1);
 expect((await db.scope(w.owner,c=>c.query('SELECT id FROM group_cases'))).rowCount).toBe(0);
 await expect(appDb.scope(w.owner,c=>c.query('SELECT payload_ref FROM group_cases'))).rejects.toMatchObject({code:'42501'});
});
});

it('cancelled requests, concurrent stale updates, removed membership and tampered payload never create a false completion',async()=>{
 const w=await world(),body={contractVersion:1,details:details(),source:{kind:'CARD',shareWithGroup:true}};
 await expect(w.cases.create(w.owner,w.group,body,randomUUID(),AbortSignal.abort())).rejects.toMatchObject({code:'GROUP_CASE_CANCELLED'});
 expect((await root.query('SELECT id FROM group_cases WHERE tenant_id=$1',[w.owner.tenantId])).rowCount).toBe(0);
 const item=(await submit(w)).case;
 const race=await Promise.allSettled([change(w,item,{operation:'OPEN'},true),change(w,item,{operation:'OPEN'},true)]);
 expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(race.find(x=>x.status==='rejected')).toMatchObject({reason:{code:'GROUP_CASE_VERSION_CONFLICT'}});
 await root.query("UPDATE group_cases SET payload_hash=$2 WHERE tenant_id=$1 AND id=$3",[w.owner.tenantId,'0'.repeat(64),item.id]);
 await expect(w.cases.list(w.owner,w.group,query())).rejects.toMatchObject({code:'GROUP_CASE_INTEGRITY'});
 await root.query('UPDATE group_directory_bindings SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND user_id=$2',[w.owner.tenantId,w.owner.actorId]);
 await expect(w.cases.list(w.owner,w.group,query())).rejects.toMatchObject({code:'GROUP_CASE_NOT_FOUND'});
 expect(w.f.requests).toHaveLength(0);
});

it('a saturated connection pool reports controlled unavailability while the same idempotent request creates only one case',async()=>{
 const w=await world(),limited=new Database(secret('RUNTIME_DATABASE_URL')!,1),service=new GroupCases(limited,vault,'robot-1',new GroupCaseRoster(new DwsIdentities(limited,vault,w.f.fixture.runner),'robot-1'));
 const connection=await limited.pool.connect(),key=randomUUID(),body={contractVersion:1,details:details(),source:{kind:'CARD',shareWithGroup:true}};
 try{
  const results=await Promise.allSettled(Array.from({length:20},()=>service.create(w.owner,w.group,body,key)));
  expect(results.every(x=>x.status==='rejected')).toBe(true);
  for(const x of results)if(x.status==='rejected'){expect(x.reason).toMatchObject({code:'GROUP_CASE_UNAVAILABLE',status:503});expect(x.reason.cause.message).toContain('timeout exceeded when trying to connect');}
  expect((await root.query('SELECT id FROM group_cases WHERE tenant_id=$1',[w.owner.tenantId])).rowCount).toBe(0);
 }finally{connection.release();}
 try{const first=await service.create(w.owner,w.group,body,key),again=await service.create(w.owner,w.group,body,key);expect(again).toMatchObject({replayed:true,case:{id:first.case.id}});expect((await root.query('SELECT id FROM group_cases WHERE tenant_id=$1',[w.owner.tenantId])).rowCount).toBe(1);}finally{await service.close();await limited.close();}
});

it('cancelling a live request while it waits for the contract lock rolls back every local case/source/receipt write',async()=>{
 const w=await world(),blocker=await root.connect(),controller=new AbortController();
 await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[w.owner.tenantId+':group-contract:'+w.group]);
 const pending=w.cases.create(w.owner,w.group,{contractVersion:1,details:details(),source:{kind:'CARD',shareWithGroup:true}},randomUUID(),controller.signal);
 const observed=pending.then(()=>({code:'UNEXPECTED_COMMIT'}),e=>({code:e.code as string}));
 try{
  let waiting=false;for(let i=0;i<100&&!waiting;i++)waiting=(await root.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='oa_runtime' AND wait_event='advisory') waiting")).rows[0].waiting;
  expect(waiting).toBe(true);controller.abort();
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 expect(await observed).toEqual({code:'GROUP_CASE_CANCELLED'});
 for(const table of ['group_cases','group_case_sources','group_case_changes','group_case_requests'])expect((await root.query('SELECT id FROM '+table+' WHERE tenant_id=$1',[w.owner.tenantId])).rowCount).toBe(0);
});
