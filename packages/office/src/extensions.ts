import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';

const sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const officeCapabilityIds=[
 'office.approval.submit','office.approval.status','office.approval.decide',
 'office.report.submit','office.report.read',
 'office.meeting.create','office.meeting.busy','office.meeting.minutes.create',
 'office.attendance.punch','office.member.bulk_remove','office.group.dissolve',
 'office.document.public_share','office.hr.permission_change','office.production.write',
 'office.todo.create','office.todo.read','office.calendar.create','office.calendar.busy',
] as const;
export type OfficeCapabilityId=typeof officeCapabilityIds[number];
const capabilityIdSchema=z.enum(officeCapabilityIds),versionSchema=z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
type Risk='READ'|'WRITE'|'DANGEROUS';
const catalog:Record<OfficeCapabilityId,{risk:Risk;description:string}>={
 'office.approval.submit':{risk:'WRITE',description:'Submit one approval instance after an explicit preview'},
 'office.approval.status':{risk:'READ',description:'Read approval status for instances this user may see'},
 'office.approval.decide':{risk:'DANGEROUS',description:'Approve or reject an approval on the user’s behalf'},
 'office.report.submit':{risk:'WRITE',description:'Submit a work report after an explicit preview'},
 'office.report.read':{risk:'READ',description:'Read work reports visible to this user'},
 'office.meeting.create':{risk:'WRITE',description:'Create a meeting after a busy/free check and preview'},
 'office.meeting.busy':{risk:'READ',description:'Query corporate busy/free availability'},
 'office.meeting.minutes.create':{risk:'WRITE',description:'Create meeting minutes after an explicit preview'},
 'office.attendance.punch':{risk:'DANGEROUS',description:'Record attendance on the user’s behalf'},
 'office.member.bulk_remove':{risk:'DANGEROUS',description:'Remove multiple members from a group'},
 'office.group.dissolve':{risk:'DANGEROUS',description:'Dissolve a group'},
 'office.document.public_share':{risk:'DANGEROUS',description:'Share a document publicly'},
 'office.hr.permission_change':{risk:'DANGEROUS',description:'Change personnel or administrative permissions'},
 'office.production.write':{risk:'DANGEROUS',description:'Write to a production system'},
 'office.todo.create':{risk:'WRITE',description:'Create a personal or assigned todo after preview'},
 'office.todo.read':{risk:'READ',description:'Read todos this user may see'},
 'office.calendar.create':{risk:'WRITE',description:'Create a calendar event after preview'},
 'office.calendar.busy':{risk:'READ',description:'Query calendar availability'},
};
export function officeCapabilityCatalog(){return officeCapabilityIds.map(id=>Object.freeze({id,...catalog[id],dangerous:catalog[id].risk==='DANGEROUS'}));}
export const officeRequestSchema=z.strictObject({capabilityId:capabilityIdSchema,version:versionSchema,schemaHash:sha,params:z.record(z.string(),z.json())}).strict();
export type OfficeRequest=z.infer<typeof officeRequestSchema>;
const certificationSchema=z.strictObject({capabilityId:capabilityIdSchema,version:versionSchema,schemaHash:sha,connectorId:z.string().min(1).max(128),certifiedBy:z.string().min(1).max(256),certifiedAt:instant,expiresAt:instant}).strict();
export type OfficeCertification=z.infer<typeof certificationSchema>;
export const formalApprovalSchema=z.strictObject({approvalId:z.uuid(),tenantId:z.uuid(),actorId:z.uuid(),capabilityId:capabilityIdSchema,version:versionSchema,paramsHash:sha,approvedBy:z.string().min(1).max(256),expiresAt:instant}).strict();
export type FormalApproval=z.infer<typeof formalApprovalSchema>;
export interface FormalApprovalVerifier{verify(approval:FormalApproval,binding:OfficeBinding,signal:AbortSignal):Promise<boolean>;}
export interface OfficeBinding{tenantId:string;actorId:string;capabilityId:OfficeCapabilityId;version:string;schemaHash:string;paramsHash:string;}
export interface OfficeConnector{readonly connectorId:string;execute(request:OfficeRequest,binding:OfficeBinding,signal:AbortSignal):Promise<{receiptId:string;verification:'VERIFIED'|'ACCEPTED_BY_UPSTREAM';detail?:unknown}>;}
export type OfficeResult=
 |{status:'OK';dispatched:true;receipt:{receiptId:string;verification:'VERIFIED'|'ACCEPTED_BY_UPSTREAM';detail?:unknown}}
 |{status:'NEEDS_APPROVAL';code:'OFFICE_WRITE_PREVIEW_REQUIRED'|'OFFICE_DANGEROUS_REQUIRES_FORMAL_APPROVAL';dispatched:false;effect:'NONE';previewHash?:string}
 |{status:'BLOCKED_EXTERNAL';code:'OFFICE_CONNECTOR_UNCERTIFIED';dispatched:false;effect:'NONE'}
 |{status:'DENIED';code:'OFFICE_CAPABILITY_UNKNOWN'|'OFFICE_REQUEST_INVALID'|'OFFICE_PREVIEW_INVALID'|'OFFICE_FORMAL_APPROVAL_INVALID';dispatched:false;effect:'NONE'}
 |{status:'UNKNOWN';code:'OFFICE_CONNECTOR_OUTCOME_UNKNOWN';dispatched:true;effect:'UNKNOWN'};
const canonical=(value:unknown):string=>{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('NON_JSON_VALUE');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 throw new TypeError('NON_JSON_VALUE');
};
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const bindingOf=(request:OfficeRequest):OfficeBinding=>({tenantId:'',actorId:'',capabilityId:request.capabilityId,version:request.version,schemaHash:request.schemaHash,paramsHash:digest({capabilityId:request.capabilityId,version:request.version,schemaHash:request.schemaHash,params:request.params})});
export class OfficeExtensionBroker{
 private readonly previews=new Map<string,{tenantId:string;actorId:string;paramsHash:string;expiresAt:number}>();
 private readonly certifications:OfficeCertification[];
 constructor(private readonly options:{connectors:Readonly<Record<string,OfficeConnector>>;certifications:readonly OfficeCertification[];approvals?:FormalApprovalVerifier;now?:()=>number;previewTtlMs?:number}){
  this.certifications=options.certifications.map(c=>certificationSchema.parse(c));
  for(const c of this.certifications){if(!options.connectors[c.connectorId])throw new Error('OFFICE_CONNECTOR_UNREGISTERED');if(Date.parse(c.expiresAt)<=Date.parse(c.certifiedAt))throw new Error('OFFICE_CERTIFICATION_WINDOW_INVALID');}
 }
 capabilities(){
  const now=(this.options.now??Date.now)();
  return officeCapabilityCatalog().map(capability=>{
   const matches=this.certifications.filter(c=>c.capabilityId===capability.id&&Date.parse(c.expiresAt)>now);
   return Object.freeze({...capability,state:matches.length?'READY':'BLOCKED_EXTERNAL',connectors:Object.freeze(matches.map(c=>c.connectorId)),requiresConfirmation:capability.risk!=='READ'});
  });
 }
 preview(request:OfficeRequest,ctx:{tenantId:string;actorId:string}){
  if(!capabilityIdSchema.safeParse((request as {capabilityId?:unknown}).capabilityId).success)return {status:'DENIED' as const,code:'OFFICE_CAPABILITY_UNKNOWN' as const};
  const parsed=officeRequestSchema.safeParse(request);if(!parsed.success)return {status:'DENIED' as const,code:'OFFICE_REQUEST_INVALID' as const};
  const binding={...bindingOf(parsed.data),tenantId:ctx.tenantId,actorId:ctx.actorId},now=(this.options.now??Date.now)();
  if(!this.certified(parsed.data,binding,now))return {status:'BLOCKED_EXTERNAL' as const,code:'OFFICE_CONNECTOR_UNCERTIFIED' as const};
  const token=randomUUID(),expiresAt=now+(this.options.previewTtlMs??120000);
  this.previews.set(token,{tenantId:ctx.tenantId,actorId:ctx.actorId,paramsHash:binding.paramsHash,expiresAt});
  if(this.previews.size>1024)this.previews.delete(this.previews.keys().next().value!);
  return {status:'PREVIEW' as const,token,previewHash:binding.paramsHash,expiresAt:new Date(expiresAt).toISOString(),capabilityId:parsed.data.capabilityId,risk:catalog[parsed.data.capabilityId].risk};
 }
 async execute(request:OfficeRequest,ctx:{tenantId:string;actorId:string;signal:AbortSignal;previewToken?:string;formalApproval?:FormalApproval}):Promise<OfficeResult>{
  if(!capabilityIdSchema.safeParse((request as {capabilityId?:unknown}).capabilityId).success)return {status:'DENIED',code:'OFFICE_CAPABILITY_UNKNOWN',dispatched:false,effect:'NONE'};
  const parsed=officeRequestSchema.safeParse(request);
  if(!parsed.success||!(ctx.signal instanceof AbortSignal)||!z.uuid().safeParse(ctx.tenantId).success||!z.uuid().safeParse(ctx.actorId).success)return {status:'DENIED',code:'OFFICE_REQUEST_INVALID',dispatched:false,effect:'NONE'};
  const now=(this.options.now??Date.now)(),binding={...bindingOf(parsed.data),tenantId:ctx.tenantId,actorId:ctx.actorId},risk=catalog[parsed.data.capabilityId].risk;
  const certified=this.certified(parsed.data,binding,now);
  if(!certified)return {status:'BLOCKED_EXTERNAL',code:'OFFICE_CONNECTOR_UNCERTIFIED',dispatched:false,effect:'NONE'};
  if(risk!=='READ'){
   const token=ctx.previewToken?this.previews.get(ctx.previewToken):undefined;
   const valid=token&&token.tenantId===ctx.tenantId&&token.actorId===ctx.actorId&&token.paramsHash===binding.paramsHash&&token.expiresAt>now;
   if(!valid)return {status:'NEEDS_APPROVAL',code:'OFFICE_WRITE_PREVIEW_REQUIRED',dispatched:false,effect:'NONE',previewHash:binding.paramsHash};
  }
  if(risk==='DANGEROUS'){
   const approval=formalApprovalSchema.safeParse(ctx.formalApproval);
   if(!this.options.approvals||!approval.success||approval.data.tenantId!==ctx.tenantId||approval.data.actorId!==ctx.actorId||approval.data.capabilityId!==parsed.data.capabilityId||approval.data.version!==parsed.data.version||approval.data.paramsHash!==binding.paramsHash||Date.parse(approval.data.expiresAt)<=now)return {status:'NEEDS_APPROVAL',code:'OFFICE_DANGEROUS_REQUIRES_FORMAL_APPROVAL',dispatched:false,effect:'NONE',previewHash:binding.paramsHash};
   let approved=false;try{approved=await this.options.approvals.verify(approval.data,binding,ctx.signal);}catch{return {status:'DENIED',code:'OFFICE_FORMAL_APPROVAL_INVALID',dispatched:false,effect:'NONE'};}
   if(!approved)return {status:'DENIED',code:'OFFICE_FORMAL_APPROVAL_INVALID',dispatched:false,effect:'NONE'};
  }
  if(risk!=='READ')this.previews.delete(ctx.previewToken!);
  try{
   const receipt=await this.options.connectors[certified.connectorId]!.execute(parsed.data,binding,ctx.signal);
   return {status:'OK',dispatched:true,receipt};
  }catch{
   return {status:'UNKNOWN',code:'OFFICE_CONNECTOR_OUTCOME_UNKNOWN',dispatched:true,effect:'UNKNOWN'};
  }
 }
 private certified(request:OfficeRequest,binding:OfficeBinding,now:number){
  return this.certifications.find(c=>c.capabilityId===request.capabilityId&&c.version===request.version&&c.schemaHash===request.schemaHash&&Date.parse(c.certifiedAt)<=now&&Date.parse(c.expiresAt)>now&&this.options.connectors[c.connectorId]!==undefined)??null;
 }
}
