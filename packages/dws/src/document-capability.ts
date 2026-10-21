import {reviewedCapability} from '../../gateway/src/reviewed-capabilities.js';
import {dwsDocumentResultContract,documentSourceSchema} from './result-contracts.js';
import type pg from 'pg';
import {z} from 'zod';
import {Gateway,canonical} from '../../gateway/src/index.js';
import {blocked,type ToolResult} from '../../contracts/src/index.js';
import type {DbContext} from '../../storage/src/database.js';
import type {Lease} from '../../runtime/src/store.js';
import {hash} from '../../storage/src/crypto.js';
import {DwsError} from './contracts.js';
import type {DwsIdentities} from './identity.js';
import {documentReaderBindingHash} from './read-client.js';
import {documentReadSchema,documentPayloadProfile,documentContractHash,type DocumentRead,type DocumentPayloadProfile} from './document-contract.js';

export const dwsDocumentBindingHash=(service:DwsIdentities)=>documentReaderBindingHash(service.runner);
export const dwsDocumentResource=(node:string)=>'dws:doc:'+node;
type Scope={id:string;version:number;profile:DocumentPayloadProfile;classification:'CONFIDENTIAL'|'RESTRICTED'};
const receiptSchema=documentSourceSchema;
const levels=['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'];
async function allowed(c:pg.PoolClient,service:DwsIdentities,ctx:DbContext,lease:Lease,args:DocumentRead):Promise<Scope|null>{
 // A GROUP grant is not evidence that every visible member can read the body.
 // Shared body output requires the later per-member audience proof machinery.
 if(lease.audience['kind']!=='PRIVATE_USER'||lease.audience['targetId']!==ctx.actorId)return null;
 const row=(await c.query('SELECT * FROM dws_document_scopes WHERE owner_id=$1 AND node_id=$2 AND binary_hash=$3 AND schema_hash=$4 AND contract_hash=$5 AND model_egress_allowed AND revoked_at IS NULL AND expires_at>clock_timestamp()',[ctx.actorId,args.nodeId,service.runner!.config.binaryHash,service.runner!.config.documentSchemaHash,documentContractHash])).rows[0];if(!row||!Number.isSafeInteger(Number(row.version)))return null;
 const profile=documentPayloadProfile.safeParse(row.payload_profile);if(!profile.success)return null;
 const rank=levels.indexOf(row.classification as string),grants=(await c.query("SELECT classification_ceiling FROM resource_grants WHERE actor_id=$1 AND capability_id='dws.doc.read' AND resource_id=$2 AND audience_kind='PRIVATE_USER' AND audience_id=$1::uuid::text AND revoked_at IS NULL AND expires_at>clock_timestamp()",[ctx.actorId,dwsDocumentResource(args.nodeId)])).rows;if(rank<2||levels.indexOf(lease.audience['classificationCeiling'] as string)<rank||!grants.some(g=>levels.indexOf(g.classification_ceiling as string)>=rank))return null;
 const identity=await service.identity(c,ctx);if(service.usable(identity)&&(Number(identity['authorization_version'])!==args.authorizationVersion||identity['model_egress_allowed']!==true))return null;
 return {id:row.id as string,version:Number(row.version),profile:profile.data,classification:row.classification as Scope['classification']};
}
function receiptMetadata(scope:Scope,current:Awaited<ReturnType<DwsIdentities['readDocument']>>){const d=current.document;return {identityId:current.identityId,authorizationVersion:current.authorizationVersion,scopeId:scope.id,scopeVersion:scope.version,profileHash:hash(canonical(scope.profile)),nodeId:d.nodeId,revision:d.revision,projectionHash:d.projectionHash,classification:scope.classification};}
function proofAad(ctx:DbContext,metadata:ReturnType<typeof receiptMetadata>){return `${ctx.tenantId}:${ctx.actorId}:dws.doc.source:${hash(canonical(metadata))}`;}
function receipt(service:DwsIdentities,ctx:DbContext,scope:Scope,read:Awaited<ReturnType<DwsIdentities['readDocument']>>){const metadata=receiptMetadata(scope,read);return {...metadata,observedSourceProof:service.vault.seal(read.document.observedTextHash,proofAad(ctx,metadata))};}
async function current(c:pg.PoolClient,service:DwsIdentities,ctx:DbContext,lease:Lease,args:DocumentRead,cached:ToolResult):Promise<boolean>{
 const scope=await allowed(c,service,ctx,lease,args),old=receiptSchema.safeParse((cached.data as {source?:unknown}|undefined)?.source);if(!scope||!old.success)return false;
 if(old.data.scopeId!==scope.id||old.data.scopeVersion!==scope.version||old.data.nodeId!==args.nodeId||old.data.authorizationVersion!==args.authorizationVersion||old.data.profileHash!==hash(canonical(scope.profile))||old.data.classification!==scope.classification)return false;
 try{const now=await service.readDocument(ctx,args,scope.profile,AbortSignal.timeout(service.runner!.config.timeoutMs+2000),{lease,scopeId:scope.id,scopeVersion:scope.version,client:c}),after=await allowed(c,service,ctx,lease,args),identity=await service.identity(c,ctx);return !!after&&service.usable(identity)&&Number(identity['authorization_version'])===args.authorizationVersion&&canonical({...after,profile:after.profile})===canonical({...scope,profile:scope.profile})&&(()=>{const {observedSourceProof,...metadata}=old.data;return canonical(metadata)===canonical(receiptMetadata(scope,now))&&service.vault.open(observedSourceProof,proofAad(ctx,metadata))===now.document.observedTextHash;})();}catch{return false;}
}
export function registerDwsDocumentCapability(gateway:Gateway,service:DwsIdentities){
 if(!service.runner?.config.documentSchemaHash||!service.runner.readDocument)return;
 gateway.register({...dwsDocumentResultContract,...reviewedCapability('dws.doc.read',`dws:${service.runner.config.binaryHash}:doc.+fetch:${service.runner.config.documentSchemaHash}`),id:'dws.doc.read',version:'1.0.0',provider:'DWS',connectorId:'DWS',risk:'READ',state:'READY',retryableRead:true,protectResult:true,bindingHash:dwsDocumentBindingHash(service),schema:documentReadSchema,jsonSchema:z.toJSONSchema(documentReadSchema),resource:a=>dwsDocumentResource((a as DocumentRead).nodeId),description:'Read or query one reviewed document by its exact stable node ID, under your own profile. New requestNonce for each fresh read. URLs, titles, writes and group body sharing are unavailable. Unicode ranges are over the observed upstream text; local selections do not reduce upstream transfer. Result coverage never means the entire corpus.',
  classifyResult:r=>receiptSchema.safeParse((r.data as {source?:unknown}|undefined)?.source).data?.classification??'RESTRICTED',
  allowResource:async(a,{principal,lease},c,cached)=>{const args=a as DocumentRead;if(!await allowed(c,service,principal,lease,args))return false;return (cached as ToolResult|undefined)?.data===undefined||await current(c,service,principal,lease,args,cached as ToolResult);},
  retainFact:async(a,{principal,lease},c,result)=>{if(!await current(c,service,principal,lease,a as DocumentRead,result))throw new DwsError('DWS_DOCUMENT_SOURCE_CHANGED');},
  execute:async(a,{principal,lease,signal})=>{const args=a as DocumentRead;try{
   const scope=await gateway.store.guarded(principal,lease,async c=>{const scope=await allowed(c,service,principal,lease,args),identity=await service.identity(c,principal);if(scope&&service.usable(identity))await c.query('INSERT INTO run_dws_dependencies(tenant_id,owner_id,run_id,session_no,identity_id,authorization_version) VALUES($1,$2,$3,(SELECT provider_session_no FROM runs WHERE id=$3),$4,$5) ON CONFLICT(tenant_id,run_id,session_no,identity_id) DO UPDATE SET authorization_version=excluded.authorization_version',[principal.tenantId,principal.actorId,lease.runId,identity['id'],args.authorizationVersion]);return scope;});if(!scope)return blocked('DENIED','DWS_DOCUMENT_SCOPE_UNAVAILABLE');
   const read=await gateway.store.guarded(principal,lease,c=>service.readDocument(principal,args,scope.profile,signal,{lease,scopeId:scope.id,scopeVersion:scope.version,client:c})),d=read.document,result:ToolResult={status:d.status as ToolResult['status'],completeness:d.completeness as ToolResult['completeness'],data:{source:receipt(service,principal,scope,read),document:d.projection},evidenceIds:[`dws.doc:${scope.id}:${d.projectionHash.slice(0,16)}`],verification:{state:'VERIFIED',method:'PINNED_CLI_CURRENT_OWNER_BODY_READ_REVIEWED_PAYLOAD_MAPPING'}};
   if(!await gateway.store.guarded(principal,lease,c=>current(c,service,principal,lease,args,result)))return blocked('RETRYABLE_ERROR','DWS_DOCUMENT_SOURCE_CHANGED');return result;
  }catch(error){const code=error instanceof DwsError?error.code:'DWS_DOCUMENT_UNAVAILABLE';return blocked(['DWS_USER_CONSENT_REQUIRED','DWS_AUTH_IDENTITY_MISMATCH','DWS_PROFILE_MISMATCH','DWS_DEPLOYMENT_UNCONFIGURED'].includes(code)?'NEEDS_AUTH':['DWS_PROCESS_TIMEOUT','DWS_IDENTITY_BUSY','DWS_STORAGE_UNAVAILABLE','DWS_UPSTREAM_RETRYABLE'].includes(code)?'RETRYABLE_ERROR':'PERMANENT_ERROR',code);}}
 });
}
