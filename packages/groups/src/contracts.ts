import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import type {Database} from '../../storage/src/database.js';
import {Vault,hash,type Sealed} from '../../storage/src/crypto.js';
import type {Principal} from '../../identity/src/sessions.js';
import {canonical} from '../../gateway/src/index.js';
import {evaluateGroupContract,type GroupContract} from './contract-model.js';
const version=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
export const groupContractInput=z.object({delegationId:z.uuid(),expectedVersion:version,document:z.record(z.string(),z.unknown())}).strict();
export const groupContractTransition=z.object({delegationId:z.uuid(),expectedVersion:version,state:z.enum(['ACTIVE','PAUSED','REVOKED'])}).strict();
const authoritySchema=z.object({id:z.uuid(),groupId:z.string(),administratorId:z.uuid(),serviceIdentityId:z.uuid(),reviewReference:z.string(),validUntil:z.string(),currency:z.enum(['CNY','USD']),maxAmountMinor:z.number().int().nonnegative().safe(),authority:z.literal('REVIEWED_DELEGATION'),platformPermissionsVerified:z.literal(false)}).strict();
const receiptSchema=z.object({id:z.uuid(),revisionId:z.uuid(),version:z.number().int().positive().safe(),state:z.enum(['ACTIVE','PAUSED','REVOKED']),replayed:z.boolean(),currentVersion:z.number().int().positive().safe(),currentState:z.enum(['ACTIVE','PAUSED','REVOKED','EXPIRED']),platformPermissionsVerified:z.literal(false)}).strict();
export class GroupContractError extends Error{constructor(readonly code:string,readonly status=403,options?:ErrorOptions){super(code,options);}}
const known:Record<string,number>={GROUP_CONTRACT_SESSION_INVALID:401,GROUP_CONTRACT_AUTHORITY_REQUIRED:403,GROUP_CONTRACT_LIFECYCLE_BLOCKED:403,GROUP_CONTRACT_NOT_FOUND:404,GROUP_CONTRACT_DOCUMENT_INVALID:400,GROUP_CONTRACT_BINDING_MISMATCH:400,GROUP_CONTRACT_WINDOW_OR_BUDGET_INVALID:400,GROUP_CONTRACT_REQUEST_CONFLICT:409,GROUP_CONTRACT_VERSION_CONFLICT:409,GROUP_CONTRACT_FRESH_DELEGATION_REQUIRED:409};
function failure(error:unknown):never{
 if(error instanceof GroupContractError)throw error;
 const detail=z.object({message:z.string(),code:z.string().optional()}).safeParse(error);
 if(detail.success&&Object.hasOwn(known,detail.data.message))throw new GroupContractError(detail.data.message,known[detail.data.message]);
 if(detail.success&&['40P01','55P03'].includes(detail.data.code??''))throw new GroupContractError('GROUP_CONTRACT_BUSY',409);
 throw new GroupContractError('GROUP_CONTRACT_UNAVAILABLE',503,{cause:error});
}
export class GroupContracts{
 constructor(readonly db:Database,private vault:Vault){}
 private async session(c:pg.PoolClient,p:Principal){
  const row=await c.query("SELECT s.id FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN tenants t ON t.tenant_id=u.tenant_id WHERE s.id=$1 AND s.owner_id=$2 AND s.auth_epoch=$3 AND s.auth_epoch=u.auth_epoch AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='ACTIVE' AND t.status='ACTIVE'",[p.sessionId,p.actorId,p.authEpoch]);
  if(!row.rowCount)throw new GroupContractError('GROUP_CONTRACT_SESSION_INVALID',401);
 }
 private async authority(c:pg.PoolClient,p:Principal,id:string){await this.session(c,p);return authoritySchema.parse((await c.query('SELECT public.oa_group_contract_authority($1) value',[id])).rows[0].value);}
 private aad(tenant:string,id:string,revision:string){return `${tenant}:group-contract:${id}:${revision}`;}
 private async load(c:pg.PoolClient,p:Principal,groupId:string){
  const row=(await c.query('SELECT c.id,c.version,c.current_revision_id,r.document_ref,r.document_hash FROM group_contracts c JOIN group_contract_revisions r ON r.tenant_id=c.tenant_id AND r.id=c.current_revision_id AND r.contract_id=c.id WHERE c.group_id=$1',[groupId])).rows[0];
  if(!row)return null;
  const text=this.vault.open(row.document_ref as Sealed,this.aad(p.tenantId,row.id as string,row.current_revision_id as string));if(hash(text)!==row.document_hash)throw new GroupContractError('GROUP_CONTRACT_UNAVAILABLE',503);
  return {document:JSON.parse(text) as GroupContract,version:Number(row.version),revisionId:row.current_revision_id as string};
 }
 async get(p:Principal,delegationId:string){try{return await this.db.scope(p,async c=>{const authority=await this.authority(c,p,z.uuid().parse(delegationId)),current=await this.load(c,p,authority.groupId);return {authority,contract:current,platformPermissionsVerified:false as const};});}catch(error){failure(error);}}
 async put(p:Principal,input:unknown,requestId:string){const body=groupContractInput.parse(input);return this.persist(p,body.document,body.delegationId,body.expectedVersion,z.uuid().parse(requestId),{operation:'PUT',...body});}
 async transition(p:Principal,id:string,input:unknown,requestId:string){
  const contractId=z.uuid().parse(id),body=groupContractTransition.parse(input),key=z.uuid().parse(requestId);
  const loaded=await this.get(p,body.delegationId);if(!loaded.contract||loaded.contract.document.id!==contractId)throw new GroupContractError('GROUP_CONTRACT_NOT_FOUND',404);
  return this.persist(p,{...loaded.contract.document,state:body.state,version:body.expectedVersion+1},body.delegationId,body.expectedVersion,key,{operation:'STATE',id:contractId,...body});
 }
 private async persist(p:Principal,input:Record<string,unknown>|GroupContract,delegationId:string,expected:number,requestId:string,intent:unknown){
  try{return await this.db.scope(p,async c=>{
   const authority=await this.authority(c,p,delegationId),now=(await c.query('SELECT clock_timestamp() observed')).rows[0].observed as Date;
   const document:Record<string,unknown>={...input,stateUpdatedAt:now.toISOString()};const context={tenantId:p.tenantId,groupId:authority.groupId,contractId:document['id'],serviceIdentityId:authority.serviceIdentityId,currentVersion:expected+1,now:now.getTime()};
   const issues=evaluateGroupContract(document,context).gaps.filter(g=>!['INACTIVE_CONTRACT','EXPIRED','NOT_YET_VALID'].includes(g.code));
   if(issues.length||!z.uuid().safeParse(document['id']).success||!['ACTIVE','PAUSED','REVOKED'].includes(String(document['state'])))throw new GroupContractError('GROUP_CONTRACT_DOCUMENT_INVALID',400);
   const doc=document as unknown as GroupContract;
   if(doc.administratorAuthorization.actorId!==p.actorId||doc.administratorAuthorization.evidenceRef!==authority.reviewReference||doc.sources.mode&&doc.sources.mode!=='MENTION_ONLY'||doc.sources.enhanced)throw new GroupContractError('GROUP_CONTRACT_BINDING_MISMATCH',400);
   if(doc.budget.currency!==authority.currency||doc.budget.maxAmountMinor>authority.maxAmountMinor||Date.parse(doc.expiresAt)>Date.parse(authority.validUntil))throw new GroupContractError('GROUP_CONTRACT_WINDOW_OR_BUDGET_INVALID',400);
   const text=canonical(doc),digest=hash(text),revisionId=randomUUID(),sealed=this.vault.seal(text,this.aad(p.tenantId,doc.id,revisionId));
   const result=receiptSchema.parse((await c.query('SELECT public.oa_group_contract_put($1,$2,$3,$4,$5,$6,$7,$8,$9) value',[p.sessionId,delegationId,expected,requestId,hash(canonical(intent)),revisionId,text,JSON.stringify(sealed),digest])).rows[0].value);
   return result;
  });}catch(error){failure(error);}
 }
}
