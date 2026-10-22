import {randomUUID} from 'node:crypto';
import {OfficeExtensionBroker,type FormalApproval,type OfficeCapabilityId,type OfficeCertification,type OfficeConnector,type OfficeRequest} from '../../packages/office/src/extensions.js';

const tenantId=randomUUID(),actorId=randomUUID(),now=Date.parse('2026-10-21T00:00:00.000Z'),schemaHash='a'.repeat(64),version='1.0.0';
const dangerous:OfficeCapabilityId[]=['office.approval.decide','office.attendance.punch','office.member.bulk_remove','office.document.public_share'];
const request=(capabilityId:OfficeCapabilityId,params:OfficeRequest['params']={}):OfficeRequest=>({capabilityId,version,schemaHash,params});
const certification=(capabilityId:OfficeCapabilityId,overrides:Partial<OfficeCertification>={}):OfficeCertification=>({capabilityId,version,schemaHash,connectorId:'synthetic-dws',certifiedBy:'security-review',certifiedAt:'2026-10-20T00:00:00.000Z',expiresAt:'2026-11-20T00:00:00.000Z',...overrides});
function connector(){const seen:string[]=[];const value:OfficeConnector={connectorId:'synthetic-dws',execute:async req=>{seen.push(req.capabilityId);return {receiptId:randomUUID(),verification:'ACCEPTED_BY_UPSTREAM'};}};return {seen,value};}

it('T115 default-denies auto approval decisions, clock-in, bulk member removal and public sharing before any connector call',async()=>{
 const c=connector(),broker=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:dangerous.map(id=>certification(id)),now:()=>now});
 for(const id of dangerous){const preview=broker.preview(request(id),{tenantId,actorId});if(preview.status!=='PREVIEW')throw Error(preview.code);
  expect(await broker.execute(request(id),{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token})).toMatchObject({status:'NEEDS_APPROVAL',code:'OFFICE_DANGEROUS_REQUIRES_FORMAL_APPROVAL',dispatched:false,effect:'NONE'});}
 expect(c.seen).toEqual([]);
});

it('runs a dangerous extension once only with a matching formal approval and a fresh preview',async()=>{
 const c=connector();let verifications=0;
 const broker=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:[certification('office.approval.decide')],now:()=>now,approvals:{verify:async(a,binding)=>{verifications++;return a.approvedBy==='CFO'&&a.paramsHash===binding.paramsHash;}}});
 const base=request('office.approval.decide',{instanceId:'IS-1',decision:'APPROVE'}),preview=broker.preview(base,{tenantId,actorId});if(preview.status!=='PREVIEW')throw Error(preview.code);
 const approval:FormalApproval={approvalId:randomUUID(),tenantId,actorId,capabilityId:'office.approval.decide',version,paramsHash:preview.previewHash,approvedBy:'CFO',expiresAt:'2026-10-21T01:00:00.000Z'};
 const ok=await broker.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:approval});
 expect(ok.status).toBe('OK');expect(verifications).toBe(1);expect(c.seen).toEqual(['office.approval.decide']);
 expect(await broker.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:approval})).toMatchObject({status:'NEEDS_APPROVAL',dispatched:false});
 expect(c.seen).toHaveLength(1);
});

it('rejects mismatched, expired or unverifiable formal approvals without dispatching',async()=>{
 const c=connector();let verifications=0;
 const broker=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:[certification('office.attendance.punch')],now:()=>now,approvals:{verify:async()=>{verifications++;return false;}}});
 const base=request('office.attendance.punch',{location:'HQ'}),preview=broker.preview(base,{tenantId,actorId});if(preview.status!=='PREVIEW')throw Error(preview.code);
 const approval:FormalApproval={approvalId:randomUUID(),tenantId,actorId,capabilityId:'office.attendance.punch',version,paramsHash:preview.previewHash,approvedBy:'HR',expiresAt:'2026-10-21T01:00:00.000Z'};
 const mismatched={...approval,paramsHash:'b'.repeat(64)},expired={...approval,expiresAt:'2026-10-20T23:00:00.000Z'};
 expect(await broker.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:mismatched})).toMatchObject({status:'NEEDS_APPROVAL',dispatched:false});
 expect(await broker.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:expired})).toMatchObject({status:'NEEDS_APPROVAL',dispatched:false});
 expect(await broker.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:approval})).toMatchObject({status:'DENIED',code:'OFFICE_FORMAL_APPROVAL_INVALID',dispatched:false});
 expect(verifications).toBe(1);expect(c.seen).toEqual([]);
 const noVerifier=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:[certification('office.attendance.punch')],now:()=>now});
 expect(await noVerifier.execute(base,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token,formalApproval:approval})).toMatchObject({status:'NEEDS_APPROVAL',dispatched:false});
 expect(c.seen).toEqual([]);
});

it('blocks uncertified extensions and unknown capabilities instead of faking a result',async()=>{
 const c=connector(),broker=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:[certification('office.report.read')],now:()=>now});
 expect(broker.preview(request('office.group.dissolve'),{tenantId,actorId})).toMatchObject({status:'BLOCKED_EXTERNAL',code:'OFFICE_CONNECTOR_UNCERTIFIED'});
 expect(await broker.execute(request('office.group.dissolve'),{tenantId,actorId,signal:new AbortController().signal})).toMatchObject({status:'BLOCKED_EXTERNAL',dispatched:false,effect:'NONE'});
 expect(await broker.execute({...request('office.report.read'),capabilityId:'office.shell.execute'} as unknown as OfficeRequest,{tenantId,actorId,signal:new AbortController().signal})).toMatchObject({status:'DENIED',code:'OFFICE_CAPABILITY_UNKNOWN',dispatched:false});
 expect(c.seen).toEqual([]);
 expect(broker.capabilities().find(x=>x.id==='office.group.dissolve')).toMatchObject({state:'BLOCKED_EXTERNAL',dangerous:true});
});

it('requires a single-use preview for writes while reads dispatch only through a certified connector',async()=>{
 const c=connector(),broker=new OfficeExtensionBroker({connectors:{'synthetic-dws':c.value},certifications:[certification('office.report.submit'),certification('office.report.read')],now:()=>now});
 const write=request('office.report.submit',{week:'2026-W42'});
 expect(await broker.execute(write,{tenantId,actorId,signal:new AbortController().signal})).toMatchObject({status:'NEEDS_APPROVAL',code:'OFFICE_WRITE_PREVIEW_REQUIRED',dispatched:false});
 const preview=broker.preview(write,{tenantId,actorId});if(preview.status!=='PREVIEW')throw Error(preview.code);
 expect(await broker.execute(write,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token})).toMatchObject({status:'OK',dispatched:true});
 expect(await broker.execute(write,{tenantId,actorId,signal:new AbortController().signal,previewToken:preview.token})).toMatchObject({status:'NEEDS_APPROVAL',dispatched:false});
 expect(await broker.execute(request('office.report.read'),{tenantId,actorId,signal:new AbortController().signal})).toMatchObject({status:'OK',dispatched:true});
 expect(c.seen).toEqual(['office.report.submit','office.report.read']);
});
