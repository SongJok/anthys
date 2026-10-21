import {randomUUID} from 'node:crypto';
import {caseRosterSignedFixture} from '../support/case-roster-signed.js';
import {groupDelegationSchema,rpcHash} from '../../packages/dws/src/signed-protocol.js';
import {readBindingHash} from '../../packages/dws/src/signed-service.js';
import {groupMembersReply,groupInfoReply} from '../support/group-members.js';
import {dwsCredentialCanary} from '../support/dws-cli.js';
it('actual signed H5 roster leaf executes only the reviewed group read for service A and preserves actual requester B',async()=>{
 const f=await caseRosterSignedFixture();try{const r=await f.read();expect(r.grantsAuthority).toBe(false);expect(r.value.platformCountsVerified).toBe(true);expect(r.value.users).toHaveLength(2);expect(f.delegation.requester.actorId).not.toBe(f.delegation.ownerId);expect(groupDelegationSchema.safeParse(f.delegation).success).toBe(false);expect(JSON.stringify(r.value)).not.toContain(dwsCredentialCanary);const events=await f.cli.events();expect(events.filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);expect(events.some(e=>e.phase==='READ')).toBe(false);expect(events.filter(e=>e.phase==='GROUP_INFO')).toHaveLength(2);expect(events.every(e=>e.user===f.delegation.subject.userId)).toBe(true);expect(f.service.bindingHash).not.toBe(readBindingHash(f.cli.runner));expect(f.service.bindingHash).toBe(readBindingHash(f.cli.runner,undefined,undefined,undefined,[f.policy]));}finally{await f.close();}
});
it.each(['tenant','owner','contract','delegation','action','scope','profile','binary','expired','extra','signature','native'])('signed H5 rejects %s before provider execution',async kind=>{
 const f=await caseRosterSignedFixture();try{const req=await f.request();let expected='DWS_RPC_SCOPE_MISMATCH',body:unknown;
  if(kind==='tenant')req.delegation.tenantId=randomUUID();if(kind==='owner'){req.delegation.ownerId=randomUUID();req.delegation.audience.id=req.delegation.ownerId;}if(kind==='contract')req.delegation.contract.contractId=randomUUID();if(kind==='delegation')req.delegation.contract.delegationId=randomUUID();if(kind==='action')req.delegation.action='case.update';if(kind==='scope')req.group.scopeId=randomUUID();if(kind==='profile')req.group.profileHash='0'.repeat(64);if(kind==='binary')req.group.binaryHash='0'.repeat(64);if(kind==='expired'){req.issuedAt=Date.now()-10000;req.expiresAt=Date.now()-1;expected='DWS_RPC_EXPIRED';}
  body=f.sign(kind==='extra'?{...req,endpoint:'https://undeclared.invalid'}:kind==='native'?{...req,delegation:{...req.delegation,taskId:randomUUID(),runId:randomUUID()}}:req);if(kind==='signature')body={...f.sign(req),signature:'A'.repeat(86)};
  if(['extra','signature','native'].includes(kind))await expect(f.rawRead(body)).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});else expect((await f.rawRead(body)).result).toEqual({ok:false,code:expected});expect(await f.cli.events()).toEqual([]);
 }finally{await f.close();}
});
it('concurrent exact H5 envelope is physically observed once; the other is a replay',async()=>{
 const f=await caseRosterSignedFixture();try{const request=await f.request(),body=f.sign(request),replies=await Promise.all([f.rawRead(body),f.rawRead(body)]);expect(replies.filter(r=>r.result.ok)).toHaveLength(1);expect(replies.filter(r=>!r.result.ok).map(r=>r.result)).toEqual([{ok:false,code:'DWS_RPC_REPLAY'}]);expect((await f.cli.events()).filter(e=>e.phase==='GROUP_READ')).toHaveLength(1);const success=replies.find(r=>r.result.ok)!;expect(success.requestHash).toBe(rpcHash(request));}finally{await f.close();}
});
it('partial roster does not become H5 authority or an empty member list',async()=>{
 const f=await caseRosterSignedFixture();try{await f.cli.mode('normal',{groups:{[f.policy.conversationId]:{allowedUsers:[f.delegation.subject.userId],reply:(()=>{const reply=groupMembersReply();reply.data.hasMore=true;reply.data.complete=false;reply.data.partial=true;reply.data.nextCursor='synthetic-continuation';reply.data.buckets.users.hasMore=true;reply.data.buckets.users.complete=false;return reply;})(),info:groupInfoReply()}}});await expect(f.read()).rejects.toThrow();}finally{await f.close();}
});
it('cancelled H5 observation never retries or returns a member list',async()=>{
 const f=await caseRosterSignedFixture();try{const abort=new AbortController();abort.abort();await expect(f.read(abort.signal)).rejects.toThrow();expect(await f.cli.events()).toEqual([]);}finally{await f.close();}
});
