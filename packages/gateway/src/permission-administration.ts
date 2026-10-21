import {z} from 'zod';
import type {Database} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {PermissionError,type RuntimeCapability} from './permissions.js';

const uuid=z.uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const managedResourceDefinition=z.object({
 capabilityId:z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),capabilityVersion:z.string().max(64).regex(/^\d+\.\d+\.\d+$/),
 bindingHash:z.string().regex(/^[a-f0-9]{64}$/),inputSchemaHash:z.string().regex(/^[a-f0-9]{64}$/),
 resourceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,511}$/).refine(v=>!v.includes('://'),'OPAQUE_RESOURCE_REFERENCE_REQUIRED'),
 classificationCeiling:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),expiresAt:z.iso.datetime({offset:true}),reviewReference:reference
}).strict();
export const managedResourceCreate=z.object({targetUserId:uuid,grant:managedResourceDefinition}).strict();
export const managedResourceRenew=z.object({targetUserId:uuid,version,expiresAt:z.iso.datetime({offset:true}),reviewReference:reference}).strict();
export const managedResourceRevoke=z.object({targetUserId:uuid,version,reviewReference:reference}).strict();
export const managedResourceRegrant=z.object({targetUserId:uuid,version,grant:managedResourceDefinition}).strict();
const resultSchema=z.object({id:uuid,targetUserId:uuid,version,state:z.enum(['ACTIVE','REVOKED']),replayed:z.boolean(),reauthenticationRequired:z.boolean(),platformPermissionsVerified:z.literal(false),requestId:uuid,currentVersion:version,currentState:z.enum(['ACTIVE','EXPIRED','REVOKED'])}).strict();
const itemSchema=z.object({id:uuid,targetUserId:uuid,capabilityId:z.string().max(256),capabilityVersion:z.string().max(64).nullable(),bindingHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),manifestId:uuid.nullable(),descriptorHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),resourceId:z.string().max(512),resourceTruncated:z.boolean(),classificationCeiling:z.string().max(64),expiresAt:z.iso.datetime({offset:true}),version,managed:z.boolean(),state:z.enum(['ACTIVE','EXPIRED','REVOKED'])}).strict();
const listSchema=z.object({items:z.array(itemSchema).max(50),nextCursor:uuid.nullable(),scope:z.literal('TENANT_POLICY_METADATA_ONLY'),platformPermissionsVerified:z.literal(false)}).strict();
const administrationStatus=new Map<string,number>([
 ['PERMISSION_SESSION_INVALID',401],['PERMISSION_NOT_FOUND',404],
 ['PERMISSION_ADMIN_DENIED',403],['PERMISSION_ADMIN_LIFECYCLE_BLOCKED',403],['PERMISSION_ADMIN_AUDIENCE_UNCERTIFIED',403],['PERMISSION_CAPABILITY_UNAVAILABLE',403],['PERMISSION_MANIFEST_REVIEW_REQUIRED',403],['PERMISSION_GRANT_REVIEW_REQUIRED',403],
 ['PERMISSION_REQUEST_CONFLICT',409],['PERMISSION_VERSION_CONFLICT',409],['PERMISSION_GRANT_EXISTS',409],
 ['PERMISSION_ADMIN_INPUT_INVALID',400],['PERMISSION_GRANT_EXPIRY_INVALID',400],['PERMISSION_GRANT_TARGET_IMMUTABLE',400]
]);
const driverFailure=z.object({message:z.string(),code:z.string().optional()});
const busyCodes=new Set<string|undefined>(['55P03','40P01']);
function translate(error:unknown):never{
 // Only fixed declared codes cross the API boundary. Neither arbitrary
 // driver messages nor an error object's claimed HTTP status are authority.
 const detail=driverFailure.safeParse(error);
 if(detail.success){
  const status=administrationStatus.get(detail.data.message);
  if(status!==undefined)throw new PermissionError(detail.data.message,status);
  if(busyCodes.has(detail.data.code))throw new PermissionError('PERMISSION_BUSY',409);
 }
 throw new PermissionError('PERMISSION_SERVICE_UNAVAILABLE',503);
}

// Metadata policy only. No caller-supplied identity, role, profile, vendor
// scope or callback value becomes authority, and no provider is invoked here.
export class PermissionAdministration{
 constructor(private readonly db:Database,private readonly resolve:(id:string,version:string)=>RuntimeCapability|null=()=>null){}
 async resources(p:Principal,query:{targetUserId?:string|undefined;cursor?:string|undefined;id?:string|undefined}={}){
  const q=z.object({targetUserId:uuid.optional(),cursor:uuid.optional(),id:uuid.optional()}).strict().parse(query);
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   return listSchema.parse((await c.query('SELECT public.oa_permission_admin_resources($1,$2,$3,$4) value',[p.sessionId,q.targetUserId??null,q.cursor??null,q.id??null])).rows[0].value);
  });}catch(error){translate(error);}
 }
 async create(p:Principal,input:unknown,requestId:string){const body=managedResourceCreate.parse(input);return this.mutate(p,'CREATE',body.targetUserId,null,null,body.grant,requestId,this.resolve(body.grant.capabilityId,body.grant.capabilityVersion));}
 async renew(p:Principal,id:string,input:unknown,requestId:string){
  const body=managedResourceRenew.parse(input),grantId=uuid.parse(id);
  // This authorized read uses a separate completed transaction; do not retain
  // role/session locks while later acquiring ordered policy mutation locks.
  const item=(await this.resources(p,{targetUserId:body.targetUserId,id:grantId})).items[0];
  if(!item)throw new PermissionError('PERMISSION_NOT_FOUND',404);
  const runtime=item.capabilityVersion?this.resolve(item.capabilityId,item.capabilityVersion):null;
  return this.mutate(p,'RENEW',body.targetUserId,grantId,body.version,{expiresAt:body.expiresAt,reviewReference:body.reviewReference},requestId,runtime);
 }
 async revoke(p:Principal,id:string,input:unknown,requestId:string){const body=managedResourceRevoke.parse(input);return this.mutate(p,'REVOKE',body.targetUserId,uuid.parse(id),body.version,{reviewReference:body.reviewReference},requestId,null);}
 async regrant(p:Principal,id:string,input:unknown,requestId:string){const body=managedResourceRegrant.parse(input);return this.mutate(p,'REGRANT',body.targetUserId,uuid.parse(id),body.version,body.grant,requestId,this.resolve(body.grant.capabilityId,body.grant.capabilityVersion));}
 private async mutate(p:Principal,operation:string,target:string,id:string|null,expected:number|null,args:unknown,requestId:string,runtime:RuntimeCapability|null){
  const key=uuid.parse(requestId);
  try{return await this.db.scope(p,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   const value=(await c.query('SELECT public.oa_permission_admin_mutate($1,$2,$3,$4,$5,$6,$7,$8) value',[operation,target,id,expected,JSON.stringify(args),key,p.sessionId,runtime?JSON.stringify(runtime):null])).rows[0].value;
   return resultSchema.parse(value);
  });}catch(error){translate(error);}
 }
}
