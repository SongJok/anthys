import {randomUUID,createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createGroupEscalationAdapter} from '../../packages/groups/src/escalation-adapter.js';
import {groupEscalationNotice,groupEscalationLimits,groupEscalationContextHash,groupEscalationIntentHash,groupEscalationPreviewHash,groupEscalationPreviewSchema,groupEscalationPreparationSchema,groupEscalationReadSchema,groupEscalationEnqueueSchema,groupEscalationCancellationSchema,renderGroupEscalationPreview,type GroupEscalationContext,type GroupEscalationHostPort,type GroupEscalationPreview,type GroupEscalationReceipt,type GroupEscalationReference} from '../../packages/groups/src/escalation-contracts.js';

function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
/** Deliberately synthetic host: no SQL, identity authentication, real quota, persistence or sender. */
function world(){
 let now=Date.parse('2026-10-20T05:00:00Z');const controller=new AbortController(),ctx:GroupEscalationContext={principal:{tenantId:randomUUID(),actorId:randomUUID(),sessionId:randomUUID(),authEpoch:1,roles:['SYNTHETIC_GROUP_ADMIN']},groupId:'synthetic-group',signal:controller.signal};
 const intent={caseId:randomUUID(),expectedCaseVersion:2,expectedContractVersion:3,reason:'SYNTHETIC 阻塞需负责人协调'},requestId=randomUUID();
 const preview:GroupEscalationPreview={proposalId:randomUUID(),contextHash:groupEscalationContextHash(ctx),intent,intentHash:groupEscalationIntentHash(intent),groupId:ctx.groupId,case:{id:intent.caseId,version:2,title:'SYNTHETIC case',resourceRef:'synthetic:resource',state:'BLOCKED',ownerId:randomUUID(),dueAt:new Date(now-1000).toISOString()},contract:{id:randomUUID(),version:3,hash:'a'.repeat(64)},targets:[{id:randomUUID(),name:'SYNTHETIC reviewer'}],coverage:{mode:'MENTION_ONLY',completeChat:false},verification:'UNVERIFIED',asOf:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),notice:groupEscalationNotice};
 const prepared=()=>({kind:'PREPARED' as const,preview:structuredClone(preview),previewHash:groupEscalationPreviewHash(preview)}),ref=():GroupEscalationReference=>({proposalId:preview.proposalId,previewHash:groupEscalationPreviewHash(preview)});
 const receipt=():GroupEscalationReceipt=>({...ref(),contextHash:groupEscalationContextHash(ctx),groupId:ctx.groupId,caseId:intent.caseId,caseVersion:2,contractVersion:3,verification:'UNVERIFIED',asOf:new Date(now).toISOString(),replayed:false});
 const host={prepare:vi.fn<GroupEscalationHostPort['prepare']>(async()=>prepared()),read:vi.fn<GroupEscalationHostPort['read']>(async()=>prepared()),enqueue:vi.fn<GroupEscalationHostPort['enqueue']>(async()=>({kind:'QUEUED',receipt:receipt()})),cancel:vi.fn<GroupEscalationHostPort['cancel']>(async()=>({kind:'CANCELLED_LOCAL',receipt:receipt()}))};
 return {host,ctx,controller,intent,requestId,preview,prepared,ref,receipt,adapter:createGroupEscalationAdapter(host,{now:()=>now}),setNow:(v:number)=>{now=v;},now:()=>now};
}
const unknown={kind:'UNKNOWN',code:'GROUP_ESCALATION_RESULT_UNKNOWN'} as const;
describe('same-group escalation adapter: fake host contract only',()=>{
 it('prepares and reads an immutable UNVERIFIED preview, then queues exactly the confirmed reference without sending or modifying ownership',async()=>{
  const w=world(),before=structuredClone(w.preview),prepared=await w.adapter.prepare(w.ctx,w.intent,w.requestId);expect(prepared.kind).toBe('PREPARED');expect(await w.adapter.read(w.ctx,w.preview.proposalId)).toEqual(prepared);expect(w.host.prepare).toHaveBeenCalledWith(expect.objectContaining({principal:w.ctx.principal,groupId:w.ctx.groupId,signal:w.ctx.signal}),w.intent,w.requestId);
  const result=await w.adapter.enqueue(w.ctx,w.ref(),w.requestId);expect(result).toEqual({kind:'QUEUED',receipt:w.receipt()});expect(w.host.enqueue).toHaveBeenCalledTimes(1);expect(w.host.enqueue).toHaveBeenCalledWith(expect.anything(),w.ref(),w.requestId);expect(w.preview).toEqual(before);expect(result).not.toHaveProperty('sent');expect(result).not.toHaveProperty('resolved');
  if(prepared.kind==='PREPARED'){expect(Object.isFrozen(prepared.preview.targets[0])).toBe(true);expect(prepared.preview.verification).toBe('UNVERIFIED');const display=renderGroupEscalationPreview(prepared.preview);expect(display).toContain('待明确确认，尚未发送');expect(display).toContain('不改变负责人和完成状态');expect(display).toContain('不覆盖全部群聊');}
 });
 it('uses deterministic independent canonical hashes, never claiming those hashes authenticate a session',()=>{
  const input={caseId:'11111111-1111-4111-8111-111111111111',expectedCaseVersion:2,expectedContractVersion:3,reason:'SYNTHETIC'};
  const canonical='{"caseId":"11111111-1111-4111-8111-111111111111","expectedCaseVersion":2,"expectedContractVersion":3,"reason":"SYNTHETIC"}';expect(groupEscalationIntentHash(input)).toBe(createHash('sha256').update(canonical).digest('hex'));expect(groupEscalationIntentHash({reason:input.reason,expectedContractVersion:3,caseId:input.caseId,expectedCaseVersion:2})).toBe(groupEscalationIntentHash(input));
  const w=world();for(const field of ['tenantId','actorId','sessionId'] as const){const c={...w.ctx,principal:{...w.ctx.principal,[field]:randomUUID()}};expect(groupEscalationContextHash(c)).not.toBe(groupEscalationContextHash(w.ctx));}expect(groupEscalationContextHash({...w.ctx,groupId:'other'})).not.toBe(groupEscalationContextHash(w.ctx));
 });
 it('rejects client identity, target, ACL, source, verified and unsafe input fields before host prepare',async()=>{
  for(const extra of ['tenantId','ownerId','sessionId','target','targets','url','storagePath','verified','source','roles']){const w=world();expect((await w.adapter.prepare(w.ctx,{...w.intent,[extra]:'FORGED'},w.requestId)).kind).toBe('DENIED');expect(w.host.prepare).not.toHaveBeenCalled();}
  for(const change of [{caseId:'../escape'},{expectedCaseVersion:0},{expectedCaseVersion:2**53},{expectedContractVersion:Infinity},{reason:''},{reason:' x '},{reason:'x'.repeat(1001)}]){const w=world();expect((await w.adapter.prepare(w.ctx,{...w.intent,...change},w.requestId)).kind).toBe('DENIED');expect(w.host.prepare).not.toHaveBeenCalled();}
 });
 it('does not execute unknown getters, proxies or toJSON during strict input and host response parsing',async()=>{
  const touched=vi.fn(()=>{throw Error('MUST_NOT_RUN');}),proxy=new Proxy({},{get:touched,getPrototypeOf:touched,ownKeys:touched}),getter=Object.defineProperty({},'caseId',{enumerable:true,get:touched});
  for(const raw of [proxy,getter,{toJSON:touched}]){const w=world();expect((await w.adapter.prepare(w.ctx,raw,w.requestId)).kind).toBe('DENIED');expect(w.host.prepare).not.toHaveBeenCalled();}
  const w=world();w.host.prepare.mockResolvedValue(Object.defineProperty({},'kind',{enumerable:true,get:touched}) as never);expect(await w.adapter.prepare(w.ctx,w.intent,w.requestId)).toEqual(unknown);expect(touched).not.toHaveBeenCalled();
 });
 it('rejects missing/fabricated session shape and audit context, but role labels do not confer adapter authority',async()=>{
  for(const principal of [{...world().ctx.principal,sessionId:undefined},{...world().ctx.principal,authEpoch:0},{...world().ctx.principal,auditAccess:true}]){const w=world();expect((await w.adapter.prepare({...w.ctx,principal:principal as never},w.intent,w.requestId)).kind).toBe('DENIED');expect(w.host.prepare).not.toHaveBeenCalled();}
  const w=world();w.ctx.principal.roles=[];w.host.prepare.mockResolvedValue({kind:'DENIED',code:'GROUP_ESCALATION_DENIED'});expect(await w.adapter.prepare(w.ctx,w.intent,w.requestId)).toEqual({kind:'DENIED',code:'GROUP_ESCALATION_DENIED'});expect(w.host.prepare).toHaveBeenCalledTimes(1);
 });
 it.each(['VERIFIED','PARTIAL'])('refuses a forged %s preview and never enqueues it',async verification=>{
  const w=world();w.host.read.mockResolvedValue({...w.prepared(),preview:{...w.preview,verification}} as never);expect(await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).toEqual(unknown);expect(w.host.enqueue).not.toHaveBeenCalled();
 });
 it('rejects bad/expanded host previews, pins and wrong same-group/context/case/contract before enqueue',async()=>{
  for(const change of [{groupId:'other'},{contextHash:'0'.repeat(64)},{intentHash:'0'.repeat(64)},{notice:'already sent'},{targets:[]},{targets:[...world().preview.targets,...world().preview.targets]},{case:{...world().preview.case,id:randomUUID()}},{contract:{...world().preview.contract,version:4}},{coverage:{mode:'AUTHORIZED_HISTORY',completeChat:true}},{authority:true}]){
   const w=world(),p={...w.preview,...change};w.host.read.mockResolvedValue({kind:'PREPARED',preview:p,previewHash:w.ref().previewHash} as never);expect((await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).kind).not.toBe('QUEUED');expect(w.host.enqueue).not.toHaveBeenCalled();
  }
 });
 it('rejects preparation with substituted reason or dishonest hash, unsupported state, future/non-due case and extra targets',async()=>{
  for(const mutate of [(w:ReturnType<typeof world>)=>{w.preview.intent={...w.intent,reason:'DIFFERENT'};w.preview.intentHash=groupEscalationIntentHash(w.preview.intent);},(w:ReturnType<typeof world>)=>{w.preview.case.state='RESOLVED' as never;},(w:ReturnType<typeof world>)=>{w.preview.case.state='ASSIGNED';w.preview.case.dueAt=new Date(w.now()+1000).toISOString();},(w:ReturnType<typeof world>)=>{w.preview.targets=Array.from({length:21},()=>({id:randomUUID(),name:'SYNTHETIC'}));}]){const w=world();mutate(w);expect(await w.adapter.prepare(w.ctx,w.intent,w.requestId)).toEqual(unknown);expect(w.host.enqueue).not.toHaveBeenCalled();}
  const w=world();w.host.prepare.mockResolvedValue({...w.prepared(),previewHash:'0'.repeat(64)});expect(await w.adapter.prepare(w.ctx,w.intent,w.requestId)).toEqual(unknown);
 });
 it('bounds preview time and rechecks the deadline immediately before enqueue',async()=>{
  for(const change of [{asOf:'2026-10-20T05:00:06Z'},{expiresAt:'2026-10-20T05:00:00Z'},{expiresAt:'2026-10-20T05:01:01Z'}]){const w=world();Object.assign(w.preview,change);expect((await w.adapter.prepare(w.ctx,w.intent,w.requestId)).kind).not.toBe('PREPARED');}
  const w=world(),original=w.host.read.getMockImplementation()!;w.host.read.mockImplementation(async(...args)=>{const r=await original(...args);w.setNow(w.now()+60000);return r;});expect((await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).kind).not.toBe('QUEUED');expect(w.host.enqueue).not.toHaveBeenCalled();
 });
 it('coalesces neither permission nor durable idempotency: duplicate confirmation never calls read/enqueue again locally',async()=>{
  const w=world(),held=deferred<Awaited<ReturnType<GroupEscalationHostPort['enqueue']>>>();w.host.enqueue.mockReturnValue(held.promise);const first=w.adapter.enqueue(w.ctx,w.ref(),w.requestId);await vi.waitFor(()=>expect(w.host.enqueue).toHaveBeenCalledTimes(1));expect(await w.adapter.enqueue(w.ctx,w.ref(),randomUUID())).toEqual({kind:'UNKNOWN',code:'GROUP_ESCALATION_RECONCILE_REQUIRED'});expect(w.host.read).toHaveBeenCalledTimes(1);held.resolve({kind:'QUEUED',receipt:w.receipt()});expect((await first).kind).toBe('QUEUED');expect((await w.adapter.enqueue(w.ctx,w.ref(),randomUUID())).kind).toBe('UNKNOWN');expect(w.host.enqueue).toHaveBeenCalledTimes(1);
  const another=createGroupEscalationAdapter(w.host,{now:w.now});expect((await another.enqueue(w.ctx,w.ref(),randomUUID())).kind).toBe('QUEUED');expect(w.host.enqueue).toHaveBeenCalledTimes(2); // Intentional: persistence must be supplied by the real host.
 });
 it('does not enqueue an already QUEUED receipt read from the host',async()=>{const w=world();w.host.read.mockResolvedValue({kind:'QUEUED',receipt:{...w.receipt(),replayed:true}});expect(await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).toMatchObject({kind:'QUEUED',receipt:{replayed:true}});expect(w.host.enqueue).not.toHaveBeenCalled();});
 it('pre-cancel is provably no host work; cancellation during current-read prevents enqueue even if the host ignores it',async()=>{
  const w=world();w.controller.abort();for(const call of [()=>w.adapter.prepare(w.ctx,w.intent,w.requestId),()=>w.adapter.read(w.ctx,w.preview.proposalId),()=>w.adapter.enqueue(w.ctx,w.ref(),w.requestId),()=>w.adapter.cancel(w.ctx,w.ref(),w.requestId)])expect(await call()).toMatchObject({kind:'DENIED',code:'GROUP_ESCALATION_CANCELLED'});for(const method of Object.values(w.host))expect(method).not.toHaveBeenCalled();
  const x=world(),held=deferred<Awaited<ReturnType<GroupEscalationHostPort['read']>>>();x.host.read.mockReturnValue(held.promise);const pending=x.adapter.enqueue(x.ctx,x.ref(),x.requestId);x.controller.abort();expect(await pending).toMatchObject({kind:'DENIED',code:'GROUP_ESCALATION_CANCELLED'});held.resolve(x.prepared());expect(x.host.enqueue).not.toHaveBeenCalled();
 });
 it('dispatched enqueue cancellation/timeout returns UNKNOWN promptly, owns late rejection and never auto cancels or retries',async()=>{
  const w=world(),held=deferred<Awaited<ReturnType<GroupEscalationHostPort['enqueue']>>>();w.host.enqueue.mockReturnValue(held.promise);const first=w.adapter.enqueue(w.ctx,w.ref(),w.requestId);await vi.waitFor(()=>expect(w.host.enqueue).toHaveBeenCalledTimes(1));w.controller.abort(new Error('synthetic deadline'));expect(await first).toEqual(unknown);held.reject(Error('SYNTHETIC_LATE_SECRET'));await Promise.resolve();expect(w.host.cancel).not.toHaveBeenCalled();expect(w.host.enqueue).toHaveBeenCalledTimes(1);
 });
 it('prepare and cancel aborted after their host calls stay UNKNOWN rather than claiming local rollback',async()=>{
  const w=world(),p=deferred<Awaited<ReturnType<GroupEscalationHostPort['prepare']>>>();w.host.prepare.mockReturnValue(p.promise);const a=w.adapter.prepare(w.ctx,w.intent,w.requestId);w.controller.abort();expect(await a).toEqual(unknown);p.resolve(w.prepared());
  const x=world(),q=deferred<Awaited<ReturnType<GroupEscalationHostPort['cancel']>>>();x.host.cancel.mockReturnValue(q.promise);const b=x.adapter.cancel(x.ctx,x.ref(),x.requestId);x.controller.abort();expect(await b).toEqual(unknown);q.reject(Error('LATE_CANCEL'));await Promise.resolve();expect(x.host.enqueue).not.toHaveBeenCalled();
 });
 it('bad or mismatched enqueue receipts cannot be upgraded to successful confirmation and cannot be retried locally',async()=>{
  for(const change of [{proposalId:randomUUID()},{previewHash:'0'.repeat(64)},{contextHash:'0'.repeat(64)},{groupId:'other'},{caseId:randomUUID()},{caseVersion:3},{contractVersion:4},{verification:'VERIFIED'},{url:'https://example.invalid'},{asOf:'2026-10-20T05:00:06Z'}]){const w=world();w.host.enqueue.mockResolvedValue({kind:'QUEUED',receipt:{...w.receipt(),...change}} as never);expect(await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).toEqual(unknown);expect((await w.adapter.enqueue(w.ctx,w.ref(),randomUUID())).kind).toBe('UNKNOWN');expect(w.host.enqueue).toHaveBeenCalledTimes(1);}
 });
 it.each(['prepare','read','enqueue','cancel'] as const)('normalizes %s exception without echoing raw private content or automatic work',async method=>{
  const w=world();w.host[method].mockRejectedValue(Error('SYNTHETIC_SECRET_BODY_TOKEN'));const result=method==='prepare'?await w.adapter.prepare(w.ctx,w.intent,w.requestId):method==='read'?await w.adapter.read(w.ctx,w.preview.proposalId):await w.adapter[method](w.ctx,w.ref(),w.requestId);expect(result).toEqual(unknown);expect(JSON.stringify(result)).not.toContain('SECRET');expect(w.host[method]).toHaveBeenCalledTimes(1);
 });
 it('preserves explicit host DENIED/UNKNOWN and has no fallback authority, write or sender',async()=>{
  const w=world();w.host.prepare.mockResolvedValue({kind:'DENIED',code:'GROUP_ESCALATION_SOURCE_CHANGED'});expect(await w.adapter.prepare(w.ctx,w.intent,w.requestId)).toEqual({kind:'DENIED',code:'GROUP_ESCALATION_SOURCE_CHANGED'});w.host.read.mockResolvedValue(unknown);expect(await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).toEqual(unknown);expect(w.host.enqueue).not.toHaveBeenCalled();
  const x=world();x.host.enqueue.mockResolvedValue({kind:'DENIED',code:'GROUP_ESCALATION_DENIED'});expect(await x.adapter.enqueue(x.ctx,x.ref(),x.requestId)).toEqual({kind:'DENIED',code:'GROUP_ESCALATION_DENIED'});expect(x.host.cancel).not.toHaveBeenCalled();
 });
 it.each(['CANCELLED_LOCAL','RECONCILE_REQUIRED'] as const)('returns only a bound %s cancellation receipt without claiming remote retraction',async kind=>{
  const w=world();w.host.cancel.mockResolvedValue({kind,receipt:w.receipt()});expect(await w.adapter.cancel(w.ctx,w.ref(),w.requestId)).toEqual({kind,receipt:w.receipt()});expect((await w.adapter.cancel(w.ctx,w.ref(),randomUUID())).kind).toBe('UNKNOWN');expect(w.host.cancel).toHaveBeenCalledTimes(1);expect(w.host.enqueue).not.toHaveBeenCalled();
 });
 it('rejects bad cancellation/read receipts, stale responses and unknown output states',async()=>{
  const w=world();w.host.cancel.mockResolvedValue({kind:'CANCELLED_LOCAL',receipt:{...w.receipt(),groupId:'other'}});expect(await w.adapter.cancel(w.ctx,w.ref(),w.requestId)).toEqual(unknown);
  for(const value of [{kind:'SENT',receipt:w.receipt()},{kind:'QUEUED',receipt:{...w.receipt(),proposalId:randomUUID()}},{kind:'QUEUED',receipt:{...w.receipt(),asOf:'2026-10-20T04:58:00Z'}},{kind:'UNKNOWN',code:'SECRET_BODY'},{kind:'DENIED',code:'GROUP_ESCALATION_DENIED',body:'SECRET'}]){const x=world();x.host.read.mockResolvedValue(value as never);expect(await x.adapter.read(x.ctx,x.preview.proposalId)).toEqual(unknown);}
 });
 it('all output schemas reject VERIFIED facts, arbitrary target URLs and extra permission fields',()=>{
  const w=world();expect(groupEscalationPreviewSchema.safeParse({...w.preview,verification:'VERIFIED'}).success).toBe(false);expect(groupEscalationPreparationSchema.safeParse({...w.prepared(),grant:true}).success).toBe(false);expect(groupEscalationEnqueueSchema.safeParse({kind:'QUEUED',receipt:{...w.receipt(),verification:'VERIFIED'}}).success).toBe(false);expect(groupEscalationCancellationSchema.safeParse({kind:'CANCELLED_LOCAL',receipt:{...w.receipt(),remoteCancelled:true}}).success).toBe(false);expect(groupEscalationReadSchema.safeParse({kind:'APPLIED',receipt:w.receipt()}).success).toBe(false);
 });
 it('bounds local confirmation tracking instead of evicting old attempts and silently permitting another enqueue',async()=>{
  const w=world();w.host.read.mockResolvedValue({kind:'DENIED',code:'GROUP_ESCALATION_NOT_FOUND'});for(let i=0;i<groupEscalationLimits.maxLocalAttempts;i++)expect((await w.adapter.enqueue(w.ctx,{...w.ref(),proposalId:randomUUID()},randomUUID())).kind).toBe('DENIED');expect(await w.adapter.enqueue(w.ctx,{...w.ref(),proposalId:randomUUID()},randomUUID())).toMatchObject({kind:'DENIED',code:'GROUP_ESCALATION_LIMIT'});expect(w.host.read).toHaveBeenCalledTimes(groupEscalationLimits.maxLocalAttempts);expect(w.host.enqueue).not.toHaveBeenCalled();
 });
 it('actual AbortSignal.timeout interrupts an uncooperative dispatched host and preserves UNKNOWN',async()=>{
  const w=world(),held=deferred<Awaited<ReturnType<GroupEscalationHostPort['enqueue']>>>();w.host.enqueue.mockReturnValue(held.promise);w.ctx.signal=AbortSignal.timeout(20);const running=w.adapter.enqueue(w.ctx,w.ref(),w.requestId);expect(await running).toEqual(unknown);expect(w.host.enqueue).toHaveBeenCalledTimes(1);held.resolve({kind:'QUEUED',receipt:w.receipt()});expect(w.host.cancel).not.toHaveBeenCalled();
 });
 it('an acknowledged enqueue arriving after preview expiry remains UNKNOWN and can only be reconciled by a fresh host read',async()=>{
  const w=world();w.host.enqueue.mockImplementation(async()=>{w.setNow(w.now()+60000);return {kind:'QUEUED',receipt:w.receipt()};});expect(await w.adapter.enqueue(w.ctx,w.ref(),w.requestId)).toEqual(unknown);expect(w.host.enqueue).toHaveBeenCalledTimes(1);
  w.host.read.mockResolvedValue({kind:'QUEUED',receipt:w.receipt()});expect((await w.adapter.read(w.ctx,w.preview.proposalId)).kind).toBe('QUEUED');expect((await w.adapter.enqueue(w.ctx,w.ref(),randomUUID())).kind).toBe('UNKNOWN');expect(w.host.enqueue).toHaveBeenCalledTimes(1);
 });
 it('the current invocation snapshots its context and intent without accepting a later caller mutation or foreign session preview',async()=>{
  const w=world(),held=deferred<Awaited<ReturnType<GroupEscalationHostPort['prepare']>>>(),original=w.prepared();w.host.prepare.mockReturnValue(held.promise);const first=w.adapter.prepare(w.ctx,w.intent,w.requestId);w.intent.reason='MUTATED';w.ctx.principal.authEpoch++;held.resolve(original);expect((await first).kind).toBe('PREPARED');expect(w.host.prepare.mock.calls[0]![0].principal.authEpoch).toBe(1);expect(w.host.prepare.mock.calls[0]![1].reason).not.toBe('MUTATED');
  w.host.read.mockResolvedValue(original);expect((await w.adapter.enqueue(w.ctx,{proposalId:original.preview.proposalId,previewHash:original.previewHash},randomUUID())).kind).toBe('UNKNOWN');expect(w.host.enqueue).not.toHaveBeenCalled();
  const duplicate=world();duplicate.preview.targets.push({...duplicate.preview.targets[0]!});expect(groupEscalationPreviewSchema.safeParse(duplicate.preview).success).toBe(false);
 });
 it('refuses incomplete host configuration without starting any operation',()=>{expect(()=>createGroupEscalationAdapter({} as never)).toThrow('GROUP_ESCALATION_CONFIGURATION_INVALID');});
});
