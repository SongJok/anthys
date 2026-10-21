import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {vi} from 'vitest';
import {Vault} from '../../packages/storage/src/crypto.js';
import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {GroupEscalations} from '../../packages/groups/src/escalations.js';
import {GroupEscalationRunner} from '../../packages/groups/src/escalation-runner.js';
import {DingTalkSender} from '../../packages/dingtalk/src/sender.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {createGroupEscalationAdapter} from '../../packages/groups/src/escalation-adapter.js';
import type {GroupEscalationContext} from '../../packages/groups/src/escalation-contracts.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {groupCaseWorld} from '../support/group-cases.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
import {createServer} from '../../apps/api/src/server.js';
import {config,secret} from '../../packages/config/src/index.js';
import type {GroupEscalationApi} from '../../apps/api/src/group-escalations.js';
let isolated:Awaited<ReturnType<typeof groupReminderDatabase>>,server:Awaited<ReturnType<typeof createServer>>;
const adapters=new Map<string,GroupEscalationApi>(),origin='http://127.0.0.1:64702';
const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),signal=()=>new AbortController().signal;
const fixtures:{close:()=>Promise<void>}[]=[];
beforeAll(async()=>{isolated=await groupReminderDatabase();await isolated.install();expect(await isolated.db.ready()).toBe(true);
 const service=(c:GroupEscalationContext)=>{const adapter=adapters.get(c.principal.tenantId);if(!adapter)throw Error('SYNTHETIC_ESCALATION_UNKNOWN_TENANT');return adapter;};
 server=await createServer({config:{...config(),APP_ORIGIN:origin},db:isolated.appDb,sessionSecret:secret('SESSION_SECRET')!,groupEscalations:{prepare:(c,...a)=>service(c).prepare(c,...a),read:(c,...a)=>service(c).read(c,...a),enqueue:(c,...a)=>service(c).enqueue(c,...a),cancel:(c,...a)=>service(c).cancel(c,...a)}});await server.app.listen({host:'127.0.0.1',port:64702});
},60000);
afterAll(async()=>{await server?.app.close();for(const f of fixtures)await f.close();await isolated?.close();});
async function world(options:{allow?:boolean}={}){
 const w=await groupCaseWorld(isolated.root,isolated.db,isolated.appDb,vault);fixtures.push(w.f);
 if(options.allow!==false)w.document.actions.allowed.push('case.escalate');w.document.escalationUserIds=[w.f.ctx.actorId];
 w.document.workHours={timezone:'UTC',windows:[{daysOfWeek:[1,2,3,4,5,6,7],start:'00:00',end:'12:00'},{daysOfWeek:[1,2,3,4,5,6,7],start:'12:00',end:'00:00'}]};
 await w.approve();await w.save();const roster=new GroupCaseRoster(w.f.dws,'robot-1');fixtures.push(roster);
 const host=new GroupEscalations(isolated.db,vault,roster,'robot-1'),adapter=createGroupEscalationAdapter(host),context:GroupEscalationContext={principal:w.principal,groupId:w.f.conversationId,signal:signal()};
 adapters.set(w.principal.tenantId,adapter);
 const created=await w.cases.create(w.principal,w.f.conversationId,{contractVersion:1,details:{title:'SYNTHETIC escalation case',resourceRef:'release:'+randomUUID(),priority:'HIGH',dueAt:new Date(Date.now()-3600000).toISOString()},source:{kind:'CARD',shareWithGroup:true}},randomUUID());
 const opened=await w.cases.update(w.principal,w.f.conversationId,created.case.id,{contractVersion:1,expectedVersion:created.case.version,command:{operation:'OPEN'}},randomUUID());
 const intent={caseId:opened.case.id,expectedCaseVersion:opened.case.version,expectedContractVersion:1,reason:'SYNTHETIC reviewed single-case escalation request'};
 const prepare=async()=>{const result=await adapter.prepare(context,intent,randomUUID());expect(result,JSON.stringify(result)).toMatchObject({kind:'PREPARED'});if(result.kind!=='PREPARED')throw Error('SYNTHETIC_ESCALATION_NOT_PREPARED');return result;};
 return {...w,host,adapter,context,intent,prepare,roster};
}
it('actual reviewed H5 principal prepares one source-bound group case, explicitly queues once across adapter instances, and changes neither owner nor completion',async()=>{
 const w=await world(),prepared=await w.prepare(),ref={proposalId:prepared.preview.proposalId,previewHash:prepared.previewHash};
 expect(prepared.preview.targets).toEqual([{id:w.f.ctx.actorId,name:'synthetic group'}]);expect(prepared.preview.verification).toBe('UNVERIFIED');
 const request=randomUUID(),first=await w.adapter.enqueue(w.context,ref,request);expect(first,JSON.stringify(first)).toMatchObject({kind:'QUEUED'});
 const second=await createGroupEscalationAdapter(w.host).enqueue(w.context,ref,request);expect(second,JSON.stringify(second)).toMatchObject({kind:'QUEUED',receipt:{replayed:true}});
 expect((await isolated.root.query('SELECT state,reserved_at,claim_id FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows).toEqual([{state:'QUEUED',reserved_at:expect.any(Date),claim_id:null}]);
 const row=(await isolated.root.query('SELECT state,owner_id FROM group_cases WHERE id=$1',[w.intent.caseId])).rows[0];expect(row).toEqual({state:'OPEN',owner_id:null});expect((await isolated.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[w.principal.tenantId])).rows[0].n).toBe('0');
},30000);
it('real local HTTP uses the actual cookie/CSRF principal and registered source for preview, confirmation, reread and cancellation',async()=>{
 const w=await world(),path='/api/v1/groups/'+encodeURIComponent(w.f.conversationId)+'/case-escalations';
 const request=(route:string,body?:unknown,csrf=true)=>fetch(origin+path+route,{method:body===undefined?'GET':'POST',headers:{cookie:'oa_session='+w.session.cookie,origin,...(csrf?{'x-csrf-token':w.session.csrf}:{}),'content-type':'application/json','idempotency-key':randomUUID()},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 expect((await request('/preview',w.intent,false)).status).toBe(403);
 const forged=await request('/preview',{...w.intent,targets:[w.principal.actorId]});expect(forged.status).toBe(400);
 const prepared=await request('/preview',w.intent);expect(prepared.status).toBe(200);expect(prepared.headers.get('cache-control')).toContain('no-store');const p=(await prepared.json()).data;expect(p.kind,JSON.stringify(p)).toBe('PREPARED');
 const route='/'+p.preview.proposalId,confirm=await request(route+'/confirm',{previewHash:p.previewHash});expect(confirm.status).toBe(200);expect((await confirm.json()).data.kind).toBe('QUEUED');
 expect((await (await request(route)).json()).data).toMatchObject({kind:'QUEUED',receipt:{replayed:true}});
 expect((await (await request(route+'/cancel',{previewHash:p.previewHash})).json()).data.kind).toBe('CANCELLED_LOCAL');
 expect((await isolated.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[w.principal.tenantId])).rows[0].n).toBe('0');
},30000);
it('existing case read/update authority and targets never substitute for the independent escalation action',async()=>{
 const w=await world({allow:false});expect((await w.adapter.prepare(w.context,w.intent,randomUUID())).kind).toBe('DENIED');expect((await isolated.root.query('SELECT count(*) n FROM group_case_escalations WHERE tenant_id=$1',[w.principal.tenantId])).rows[0].n).toBe('0');
},30000);
it.each(['case','session','scope','target'] as const)('actual %s revocation after a preview prevents confirmation with zero delivery',async kind=>{
 const w=await world(),p=await w.prepare(),ref={proposalId:p.preview.proposalId,previewHash:p.previewHash};
 if(kind==='case')await w.cases.update(w.principal,w.f.conversationId,w.intent.caseId,{contractVersion:1,expectedVersion:w.intent.expectedCaseVersion,command:{operation:'CANCEL'}},randomUUID());
 if(kind==='session')await isolated.root.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[w.principal.sessionId]);
 if(kind==='scope')await isolated.root.query('UPDATE dws_group_scopes SET revoked_at=clock_timestamp() WHERE id=$1',[w.f.scopeId]);
 if(kind==='target')await w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.otherOpen]),info:groupInfoReply(1,1,'r2')});
 expect((await w.adapter.enqueue(w.context,ref,randomUUID())).kind).not.toBe('QUEUED');expect((await isolated.root.query('SELECT state,reserved_at FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0]).toEqual({state:'PREPARED',reserved_at:null});expect((await isolated.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[w.principal.tenantId])).rows[0].n).toBe('0');
},30000);
it('an actual local cancellation remains possible after contract pause and cannot reopen or be queued by a new adapter',async()=>{
 const w=await world(),p=await w.prepare(),ref={proposalId:p.preview.proposalId,previewHash:p.previewHash};
 expect((await w.adapter.enqueue(w.context,ref,randomUUID())).kind).toBe('QUEUED');
 await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,expectedVersion:1,state:'PAUSED'},randomUUID());
 expect((await w.adapter.cancel(w.context,ref,randomUUID())).kind).toBe('CANCELLED_LOCAL');
 expect((await createGroupEscalationAdapter(w.host).enqueue(w.context,ref,randomUUID())).kind).not.toBe('QUEUED');
 expect((await isolated.root.query('SELECT state,reserved_at IS NOT NULL reserved FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0]).toEqual({state:'CANCELLED',reserved:true});
},30000);
it('a lost actual confirmation COMMIT acknowledgment remains UNKNOWN but a fresh read finds the single durable queue record without a second reservation',async()=>{
 const w=await world(),p=await w.prepare(),ref={proposalId:p.preview.proposalId,previewHash:p.previewHash},query=pg.Client.prototype.query,confirm=new WeakSet<pg.Client>();let lost=0;
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation((function(this:pg.Client,...args:unknown[]){if(typeof args[0]==='string'&&args[0].startsWith('SELECT public.oa_group_escalation_confirm('))confirm.add(this);const result=Reflect.apply(query,this,args);if(args[0]==='COMMIT'&&confirm.delete(this))return Promise.resolve(result).then(()=>{lost++;throw Error('SYNTHETIC_ESCALATION_COMMIT_ACK_LOST');});return result;}) as typeof pg.Client.prototype.query);
 try{expect((await w.adapter.enqueue(w.context,ref,randomUUID())).kind).toBe('UNKNOWN');expect(lost).toBe(1);}finally{spy.mockRestore();}
 expect((await w.adapter.read(w.context,ref.proposalId)).kind).toBe('QUEUED');expect((await isolated.root.query('SELECT count(*) n FROM group_case_escalations WHERE tenant_id=$1 AND reserved_at IS NOT NULL',[w.principal.tenantId])).rows[0].n).toBe('1');expect((await isolated.root.query('SELECT count(*) n FROM deliveries WHERE tenant_id=$1',[w.principal.tenantId])).rows[0].n).toBe('0');
},30000);

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function queued(){const w=await world(),p=await w.prepare(),ref={proposalId:p.preview.proposalId,previewHash:p.previewHash};expect((await w.adapter.enqueue(w.context,ref,randomUUID())).kind).toBe('QUEUED');return {w,p,ref,target:{tenantId:w.f.ctx.tenantId,actorId:w.f.ctx.actorId,groupId:w.f.conversationId,proposalId:ref.proposalId,previewHash:ref.previewHash,contractHash:p.preview.contract.hash}};}
it.each(['APPLIED_UNVERIFIED','UNKNOWN'] as const)('actual SQL runner and real sender retain %s without changing responsibility, retrying or default notifier pickup',async outcome=>{
 const {w,p,ref,target}=await queued();let oauth=0,physical=0,defaultPending:string[]|undefined,deliveryId:string|undefined;const sent:{url:string;redirect:unknown;body:Record<string,unknown>}[]=[];
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-escalation-secret',robotCode:'robot-1',fetch:async(input,init)=>{
  if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){
   oauth++;deliveryId=(await isolated.root.query('SELECT delivery_id FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0].delivery_id;defaultPending=await new DeliveryGateway(isolated.db,vault,sender,w.f.binding).pending(w.f.ctx);return json({accessToken:'synthetic-token',expireIn:7200});
  }
  physical++;sent.push({url:String(input),redirect:init?.redirect,body:JSON.parse(init!.body as string)});if(outcome==='UNKNOWN')throw Error('SYNTHETIC_RESPONSE_LOST');return json({processQueryKey:'synthetic-escalation-receipt'});
 }}),runner=new GroupEscalationRunner(w.host,sender,w.f.binding);
 try{
  expect(await runner.runOne(target,signal())).toEqual({state:outcome});expect(oauth).toBe(1);expect(physical).toBe(1);expect(deliveryId).toEqual(expect.any(String));expect(defaultPending).not.toContain(deliveryId);expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({url:'https://api.dingtalk.com/v1.0/robot/groupMessages/send',redirect:'error',body:{robotCode:'robot-1',openConversationId:w.f.conversationId,msgKey:'sampleText'}});expect(sent[0]!.body.userIds).toBeUndefined();const text=JSON.parse(sent[0]!.body.msgParam as string).content as string;expect(text).toContain(p.preview.case.title);expect(text).toContain(p.preview.notice);
  expect(await runner.runOne(target,signal())).toEqual({state:'NOT_CLAIMED'});expect(physical).toBe(1);
  expect((await isolated.root.query('SELECT e.state,d.state delivery_state,d.verification_state FROM group_case_escalations e JOIN deliveries d ON d.tenant_id=e.tenant_id AND d.id=e.delivery_id WHERE e.id=$1',[ref.proposalId])).rows[0]).toEqual({state:outcome,delivery_state:outcome,verification_state:'UNVERIFIED'});
  expect((await w.adapter.read(w.context,ref.proposalId))).toMatchObject({kind:'DELIVERY_STATUS',delivery:{state:outcome,verification:'UNVERIFIED',physicalDeliveryVerified:false,method:outcome==='APPLIED_UNVERIFIED'?'PROVIDER_ACCEPTANCE_ONLY':'NO_PROVIDER_RECEIPT'}});
  expect((await isolated.root.query('SELECT state,owner_id FROM group_cases WHERE id=$1',[w.intent.caseId])).rows[0]).toEqual({state:'OPEN',owner_id:null});expect(w.f.requests).toEqual([]);
 }finally{await runner.close();}
},30000);
it.each(['cancel','contract','session','scope','roster','abort'] as const)('cold-token %s veto reaches the real sender final barrier with zero physical group request and no retry',async mode=>{
 const {w,ref,target}=await queued(),controller=new AbortController();let oauth=0,physical=0,cancellation:unknown;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-escalation-secret',robotCode:'robot-1',fetch:async input=>{
  if(String(input)==='https://api.dingtalk.com/v1.0/oauth2/accessToken'){
   oauth++;
   if(mode==='cancel')cancellation=await w.adapter.cancel(w.context,ref,randomUUID());
   if(mode==='contract')await w.service.transition(w.principal,w.document.id,{delegationId:w.profile.document.id,expectedVersion:1,state:'PAUSED'},randomUUID());
   if(mode==='session')await isolated.root.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[w.principal.sessionId]);
   if(mode==='scope')await isolated.root.query('UPDATE dws_group_scopes SET revoked_at=clock_timestamp() WHERE id=$1',[w.f.scopeId]);
   if(mode==='roster')await w.f.configure({reply:groupMembersReply(w.f.conversationId,[w.f.ownerOpen,w.f.otherOpen,'synthetic-external']),info:groupInfoReply(3)});
   if(mode==='abort')controller.abort();
   return json({accessToken:'synthetic-token',expireIn:7200});
  }
  physical++;throw Error('UNEXPECTED_ESCALATION_PHYSICAL_MESSAGE');
 }}),runner=new GroupEscalationRunner(w.host,sender,w.f.binding);
 try{
  expect(await runner.runOne(target,controller.signal)).toEqual({state:mode==='cancel'?'UNKNOWN':'SUPPRESSED'});expect(oauth).toBe(1);expect(physical).toBe(0);if(mode==='cancel')expect(cancellation).toMatchObject({kind:'RECONCILE_REQUIRED'});
  expect((await isolated.root.query('SELECT d.state FROM group_case_escalations e JOIN deliveries d ON d.tenant_id=e.tenant_id AND d.id=e.delivery_id WHERE e.id=$1',[ref.proposalId])).rows[0].state).toBe('SUPPRESSED');
  expect(await runner.runOne(target,signal())).toEqual({state:'NOT_CLAIMED'});expect(physical).toBe(0);
 }finally{await runner.close();}
},30000);
it('a real contract lock cannot hold an aborted runner indefinitely or commit a later claim after release',async()=>{
 const {w,ref,target}=await queued(),gate=await isolated.root.connect(),controller=new AbortController();let physical=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-escalation-secret',robotCode:'robot-1',fetch:async()=>{physical++;throw Error('UNEXPECTED_MESSAGE');}}),runner=new GroupEscalationRunner(w.host,sender,w.f.binding);let pending:ReturnType<typeof runner.runOne>|undefined;
 try{
  await gate.query('BEGIN');await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':group-contract:'||$2,0))",[target.tenantId,target.groupId]);pending=runner.runOne(target,controller.signal);
  const deadline=performance.now()+3000;let observed=false;while(performance.now()<deadline){const row=(await isolated.root.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT public.oa_group_escalation_claim(%') present")).rows[0];if(row.present){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(observed).toBe(true);controller.abort();
  const result=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('RUNNER_LOCK_CANCELLATION_UNBOUNDED')),3500))]);expect(result).toEqual({state:'UNKNOWN'});expect(physical).toBe(0);
  await gate.query('COMMIT');expect((await isolated.root.query('SELECT state,claim_id FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0]).toEqual({state:'QUEUED',claim_id:null});
 }finally{controller.abort();await gate.query('ROLLBACK');gate.release();await pending?.catch(()=>{});await runner.close();}
},30000);
it('lost actual claim COMMIT acknowledgment leaves a single durable claim UNKNOWN to its caller and a new runner never reclaims it',async()=>{
 const {w,ref,target}=await queued(),query=pg.Client.prototype.query,claiming=new WeakSet<pg.Client>();let physical=0,lost=0;
 const sender=new DingTalkSender({clientId:'synthetic',clientSecret:'synthetic-escalation-secret',robotCode:'robot-1',fetch:async()=>{physical++;throw Error('UNEXPECTED_MESSAGE');}}),runner=new GroupEscalationRunner(w.host,sender,w.f.binding);
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation((function(this:pg.Client,...args:unknown[]){if(typeof args[0]==='string'&&args[0].startsWith('SELECT public.oa_group_escalation_claim('))claiming.add(this);const result=Reflect.apply(query,this,args);if(args[0]==='COMMIT'&&claiming.delete(this))return Promise.resolve(result).then(()=>{lost++;throw Error('SYNTHETIC_CLAIM_ACK_LOST');});return result;}) as typeof pg.Client.prototype.query);
 try{expect(await runner.runOne(target,signal())).toEqual({state:'UNKNOWN'});expect(lost).toBe(1);}finally{spy.mockRestore();}
 try{expect((await isolated.root.query('SELECT state,claim_id FROM group_case_escalations WHERE id=$1',[ref.proposalId])).rows[0]).toEqual({state:'CLAIMED',claim_id:expect.any(String)});expect(await runner.runOne(target,signal())).toEqual({state:'NOT_CLAIMED'});expect(physical).toBe(0);}finally{await runner.close();}
},30000);
