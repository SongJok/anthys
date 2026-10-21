import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import type {Principal} from '../../identity/src/sessions.js';
import type {RuntimeStore} from '../../runtime/src/store.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from './index.js';
import {actionAuthority,killed} from './controls.js';
import {type CertifiedReadBacks,type ReadBackRegistration,type ReadBackRequest} from './reconciliation.js';

type Action=Record<string,unknown> & {id:string;owner_id:string;run_id:string;task_id:string;capability_id:string;tool_version:string;binding_hash:string;resource_id:string;args_hash:string;logical_action_key:string;scope_descriptor:Record<string,unknown>};
export class ControlError extends Error {constructor(readonly code:string,readonly status=409){super(code);}}
function requireControl(ok:unknown,code='CONTROL_SCOPE_INVALID'):asserts ok {if(!ok)throw new ControlError(code);}
export class ControlPlane {
 constructor(readonly store:RuntimeStore,private signingKey:string,private readBacks?:CertifiedReadBacks){if(signingKey.length<32)throw Error('CONTROL_KEY_LENGTH');}
 private sign(value:string){return createHmac('sha256',this.signingKey).update('approval:'+value).digest('base64url');}
 private async session(c:pg.PoolClient,p:Principal){requireControl((await c.query('SELECT public.oa_control_session($1,$2) ok',[p.actorId,p.sessionId])).rows[0].ok,'CONTROL_SESSION_INVALID');}
 private async view(c:pg.PoolClient,p:Principal,id:string):Promise<Action>{await this.session(c,p);const row=(await c.query('SELECT public.oa_control_action_view($1,$2,$3) value',[id,p.sessionId,p.actorId])).rows[0].value;requireControl(row,'CONTROL_NOT_FOUND');return row as Action;}
 private async valid(c:pg.PoolClient,a:Action){
  requireControl((await c.query('SELECT public.oa_lifecycle_run_allowed($1) allowed',[a.run_id])).rows[0].allowed,'FORMAL_RUN_NOT_ADMITTED');
  const d=a.scope_descriptor;
  requireControl(a.hash_version===2&&d&&typeof d['descriptorHash']==='string'&&/^[a-f0-9]{64}$/.test(d['descriptorHash'])&&hash(canonical(d))===a.args_hash,'ACTION_SCOPE_UNVERIFIED');
  requireControl(a.user_status==='ACTIVE'&&a.tenant_status==='ACTIVE'&&Number(a.task_auth_epoch)===Number(a.current_auth_epoch)&&['OPEN','ACTIVE'].includes(a.task_status as string)&&!a.cancel_requested_at&&new Date(a.expires_text as string).getTime()>Date.now(),'TASK_NO_LONGER_EXECUTABLE');
  requireControl(d.capability===a.capability_id&&d.semanticVersion===a.tool_version&&d.risk===a.risk&&d.connector===a.connector_id&&d.bindingHash===a.binding_hash&&d.resource===a.resource_id&&canonical(d.actor)===canonical({tenantId:a.tenant_id,actorId:a.owner_id})&&d.authEpoch===Number(a.current_auth_epoch)&&d.policyVersion===a.policy_version&&d.expiresAt===a.expires_text&&canonical(d.audience)===canonical(a.audience),'ACTION_SCOPE_CHANGED');
  requireControl(hash(canonical(a.approval_preview))===d.previewHash,'ACTION_PREVIEW_CHANGED');
  const args=this.store.openActionInput({tenantId:a.tenant_id as string,actorId:a.owner_id},a.logical_action_key,a.input_ref);requireControl(hash(canonical(args))===d.argsHash,'ACTION_INPUT_CHANGED');
  if(a.provider_id!=='CORE')requireControl((await c.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk=$4 AND state='READY'",[a.capability_id,a.tool_version,a.binding_hash,a.risk])).rowCount,'ACTION_BINDING_CHANGED');
 }
 private async audit(c:pg.PoolClient,p:Principal,owner:string,kind:string,resource:string,data:Record<string,unknown>){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${p.tenantId}:${owner}:control`]);
  const prior=(await c.query('SELECT hash FROM control_events WHERE owner_id=$1 ORDER BY seq DESC LIMIT 1',[owner])).rows[0]?.hash as string|undefined,id=randomUUID();
  const digest=hash(canonical({tenantId:p.tenantId,owner,id,actor:p.actorId,kind,resource,data,previous:prior??null}));
  await c.query('INSERT INTO control_events(tenant_id,owner_id,id,actor_id,kind,resource_id,safe_data,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[p.tenantId,owner,id,p.actorId,kind,resource,JSON.stringify(data),prior??null,digest]);
 }
 async taskActions(p:Principal,taskId:string){return this.store.db.scope(p,async c=>{
  await this.session(c,p);requireControl((await c.query('SELECT id FROM tasks WHERE id=$1',[taskId])).rowCount,'CONTROL_NOT_FOUND');
  return (await c.query("SELECT a.id,a.capability_id,a.risk,a.state,a.approval_preview,(SELECT jsonb_build_object('id',p.id,'state',CASE WHEN p.state IN ('PENDING','APPROVED') AND p.expires_at<=now() THEN 'EXPIRED' WHEN p.state IN ('PENDING','APPROVED') AND (p.requester_auth_epoch<>$2 OR (public.oa_control_action_authority(p.approver_id,'ACTION_APPROVER',a.id)->>'id') IS DISTINCT FROM p.authority_id::text OR (public.oa_control_action_authority(p.approver_id,'ACTION_APPROVER',a.id)->>'version')::bigint IS DISTINCT FROM p.authority_version OR (public.oa_control_action_authority(p.approver_id,'ACTION_APPROVER',a.id)->>'authEpoch')::bigint IS DISTINCT FROM p.approver_auth_epoch) THEN 'INVALIDATED' ELSE p.state END,'expiresAt',p.expires_at) FROM approvals p WHERE p.action_id=a.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) approval FROM tool_actions a JOIN runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id WHERE r.task_id=$1 ORDER BY a.created_at,a.id",[taskId,p.authEpoch])).rows;
 });}
 async eligible(p:Principal,actionId:string){return this.store.db.scope(p,async c=>{
  const a=await this.view(c,p,actionId);requireControl(a.owner_id===p.actorId,'APPROVAL_REQUEST_DENIED');await this.valid(c,a);
  return (await c.query("SELECT u.id,u.display_name FROM users u WHERE u.id<>$1 AND public.oa_control_action_authority(u.id,'ACTION_APPROVER',$2) IS NOT NULL ORDER BY u.display_name,u.id LIMIT 50",[p.actorId,a.id])).rows;
 });}
 async inbox(p:Principal){return this.store.db.scope(p,async c=>{
  await this.session(c,p);return (await c.query("SELECT p.id,p.action_id,p.state,p.expires_at,a.value->>'capability_id' capability_id,a.value->>'risk' risk FROM approvals p CROSS JOIN LATERAL(SELECT public.oa_control_action_view(p.action_id,$1,$2) value) a WHERE p.approver_id=$2 AND p.workflow_version=1 AND p.state='PENDING' AND p.expires_at>now() AND a.value IS NOT NULL ORDER BY p.created_at,p.id LIMIT 50",[p.sessionId,p.actorId])).rows;
 });}
 async overview(p:Principal,cursor?:string){return this.store.db.scope(p,async c=>{
  await this.session(c,p);if(!p.roles.includes('SECURITY_OPERATOR'))throw new ControlError('CONTROL_CONSOLE_DENIED',403);
  const scopes=(await c.query("SELECT b.scope_kind,b.scope_id,b.expires_at FROM role_bindings b JOIN roles r ON r.tenant_id=b.tenant_id AND r.id=b.role_id WHERE b.subject_id=$1 AND r.name='SECURITY_OPERATOR' AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now()) ORDER BY b.scope_kind,b.scope_id",[p.actorId])).rows;
  if(!scopes.length)throw new ControlError('CONTROL_CONSOLE_DENIED',403);
  const switches=(await c.query("SELECT id,scope_kind,scope_id,mode,enabled,version,expires_at,issuer_id=$1 mine FROM kill_switches WHERE public.oa_control_kill_authority($1,scope_kind,scope_id) IS NOT NULL ORDER BY created_at,id",[p.actorId])).rows;
  const unknown=(await c.query('SELECT * FROM public.oa_control_unknown_inbox($1,$2,$3)',[p.actorId,p.sessionId,cursor??null])).rows;
  return {tenantId:p.tenantId,actorId:p.actorId,scopes,switches,unknown:{items:unknown.slice(0,50),nextCursor:unknown.length>50?unknown[49]!.id as string:null}};
 });}
 async setKill(p:Principal,input:{scopeKind:'TENANT'|'CONNECTOR'|'GROUP'|'USER'|'TASK';scopeId:string;mode:'ALL'|'WRITES';enabled:boolean;reason:string;expiresAt?:string|undefined}){return this.store.db.scope(p,async c=>{
  await this.session(c,p);requireControl(input.scopeKind!=='TENANT'||input.scopeId===p.tenantId,'KILL_SCOPE_DENIED');
  if(!(await c.query('SELECT public.oa_control_kill_authority($1,$2,$3) value',[p.actorId,input.scopeKind,input.scopeId])).rows[0].value)throw new ControlError('KILL_AUTHORITY_REQUIRED',403);
  if(input.expiresAt)requireControl(new Date(input.expiresAt).getTime()>Date.now()&&new Date(input.expiresAt).getTime()<=Date.now()+24*60*60*1000,'KILL_EXPIRY_INVALID');
  const id=randomUUID(),row=(await c.query("INSERT INTO kill_switches(tenant_id,id,issuer_id,scope_kind,scope_id,mode,enabled,reason_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,issuer_id,scope_kind,scope_id) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,reason_hash=excluded.reason_hash,expires_at=excluded.expires_at,version=kill_switches.version+1,updated_at=now() RETURNING id,scope_kind,scope_id,mode,enabled,version,expires_at",[p.tenantId,id,p.actorId,input.scopeKind,input.scopeId,input.mode,input.enabled,hash(input.reason),input.expiresAt??null])).rows[0];
  await this.audit(c,p,p.actorId,'kill.changed',row.id as string,{scopeKind:input.scopeKind,scopeId:input.scopeId,mode:input.mode,enabled:input.enabled,reasonHash:hash(input.reason)});return row;
 });}
 async beginReconciliation(p:Principal,actionId:string){
  const visible=await this.store.db.scope(p,c=>this.view(c,p,actionId));
  return this.store.db.scope({tenantId:p.tenantId,actorId:visible.owner_id},async c=>{
   await this.session(c,p);const a=await this.view(c,p,actionId);requireControl(a.owner_id!==p.actorId&&a.state==='UNKNOWN','RECONCILIATION_NOT_ALLOWED');
   const role=await actionAuthority(c,p.actorId,'SECURITY_OPERATOR',a.id);requireControl(role,'RECONCILIATION_AUTHORITY_REQUIRED');
   const id=randomUUID(),expires=Date.now()+5*60*1000,payload=Buffer.from(JSON.stringify({purpose:'reconcile',id,session:p.sessionId,argsHash:a.args_hash,expires,random:randomBytes(32).toString('base64url')})).toString('base64url'),nonce=payload+'.'+this.sign(payload);
   await c.query("INSERT INTO reconciliation_cases(tenant_id,id,owner_id,action_id,reviewer_id,args_hash,state,claim,evidence_ref,session_id,authority_id,authority_version,reviewer_auth_epoch,nonce_hash,nonce_expires_at) VALUES($1,$2,$3,$4,$5,$6,'REQUESTED','INCONCLUSIVE',$7,$8,$9,$10,$11,$12,$13)",[p.tenantId,id,a.owner_id,a.id,p.actorId,a.args_hash,JSON.stringify(this.store.sealActionInput({tenantId:p.tenantId,actorId:a.owner_id},`reconcile:${id}`,{})),p.sessionId,role.id,role.version,role.authEpoch,hash(nonce),new Date(expires).toISOString()]);
   await this.audit(c,p,a.owner_id,'reconciliation.requested',a.id,{caseId:id,argsHash:a.args_hash});return {id,nonce,argsHash:a.args_hash,expiresAt:new Date(expires).toISOString(),action:{id:a.id,capability:a.capability_id,state:a.state},verification:'NO_AUTOMATIC_READ_BACK',retryAllowed:false};
  });
 }
 private async readBackAccess<T>(p:Principal,a:Action,entry:ReadBackRegistration,fn:(c:pg.PoolClient)=>Promise<T>){
  const r=entry.review,reader=r.reader,owner={tenantId:p.tenantId,actorId:a.owner_id};
  const audience=a.audience as Record<string,unknown>,operation=a.scope_descriptor['operationAudience'] as Record<string,unknown>|null;
  requireControl(audience['kind']==='PRIVATE_USER'&&audience['targetId']===a.owner_id&&operation?.['kind']==='PRIVATE_USER'&&operation['targetId']===a.owner_id,'READ_BACK_PRIVATE_SCOPE_REQUIRED');
  // Recheck both independently scoped authorities before and after I/O. The
  // configuration tables intentionally grant this role SELECT only; this
  // path cannot acquire row-write privileges to lock or edit those policies.
  // The reviewer uses their own read grant;
  // SECURITY_OPERATOR does not lend them the owner's provider credentials.
  return this.store.db.scope(p,async reviewer=>{
   await this.session(reviewer,p);
   requireControl((await reviewer.query("SELECT id FROM capability_bindings WHERE logical_id=$1 AND semantic_version=$2 AND schema_hash=$3 AND risk='READ' AND state='READY'",[reader.id,reader.version,r.readerBindingHash])).rowCount,'READ_BACK_BINDING_UNAVAILABLE');
   requireControl((await reviewer.query("SELECT id FROM resource_grants WHERE actor_id=$1 AND capability_id=$2 AND resource_id=$3 AND audience_kind='PRIVATE_USER' AND audience_id=$1::uuid::text AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))",[p.actorId,reader.id,a.resource_id,reader.version,r.readerBindingHash,hash(canonical(reader.inputSchema)),hash(canonical(reader))])).rowCount,'READ_BACK_REVIEWER_RESOURCE_DENIED');
   requireControl(!await killed(reviewer,p,{taskId:a.task_id,audience:a.audience as Record<string,unknown>},r.connectorId,false),'READ_BACK_STOPPED');
   return this.store.db.scope(owner,async c=>{
    await this.valid(c,a);requireControl((await c.query('SELECT public.oa_run_content_erased($1) erased',[a.run_id])).rows[0].erased===false,'READ_BACK_CONTENT_ERASED');
    requireControl(a.provider_id==='CORE'&&a.resource_id===a.task_id||(await c.query("SELECT id FROM resource_grants WHERE actor_id=$1 AND capability_id=$2 AND resource_id=$3 AND audience_kind='PRIVATE_USER' AND audience_id=$1::uuid::text AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (managed_capability_version IS NULL OR public.oa_resource_grant_usable(id,$4,$5,$6,$7))",[a.owner_id,a.capability_id,a.resource_id,a.tool_version,a.binding_hash,entry.inputSchemaHash,r.descriptorHash])).rowCount,'READ_BACK_OWNER_RESOURCE_DENIED');
    requireControl(!await killed(c,owner,{taskId:a.task_id,audience:a.audience as Record<string,unknown>},r.connectorId,false),'READ_BACK_STOPPED');
    return fn(c);
   });
  });
 }
 async verifyReconciliation(p:Principal,id:string,input:{nonce:string;argsHash:string}){
  const parts=input.nonce.split('.'),sig=Buffer.from(parts[1]??''),expected=Buffer.from(this.sign(parts[0]??''));requireControl(parts.length===2&&sig.length===expected.length&&timingSafeEqual(sig,expected),'RECONCILIATION_NONCE_INVALID');
  let token:{purpose:string;id:string;session:string;argsHash:string;expires:number};try{token=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8')) as typeof token;}catch{throw new ControlError('RECONCILIATION_NONCE_INVALID');}
  requireControl(token.purpose==='reconcile'&&token.id===id&&token.session===p.sessionId&&token.argsHash===input.argsHash&&token.expires>Date.now(),'RECONCILIATION_NONCE_INVALID');
  const original=await this.store.db.scope(p,async c=>{await this.session(c,p);const q=await c.query('SELECT action_id FROM reconciliation_cases WHERE id=$1 AND reviewer_id=$2',[id,p.actorId]);requireControl(q.rowCount,'CONTROL_NOT_FOUND');return this.view(c,p,q.rows[0].action_id as string);});
  const entry=this.readBacks?.resolve(original);requireControl(entry,'CERTIFIED_READ_BACK_UNAVAILABLE');
  const current=async(c:pg.PoolClient,state:'REQUESTED'|'VERIFYING')=>{
   await this.session(c,p);await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[original.run_id]);await c.query('SELECT id FROM tool_actions WHERE id=$1 FOR UPDATE',[original.id]);const a=await this.view(c,p,original.id),row=(await c.query('SELECT * FROM reconciliation_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
   requireControl(row&&row.state===state&&row.reviewer_id===p.actorId&&row.session_id===p.sessionId&&row.nonce_hash===(state==='REQUESTED'?hash(input.nonce):'CONSUMED_NONCE')&&new Date(row.nonce_expires_at as string).getTime()>Date.now()&&row.args_hash===input.argsHash&&a.args_hash===input.argsHash&&a.state==='UNKNOWN'&&a.run_status==='WAITING_USER'&&a.owner_id!==p.actorId&&Number(a.version)===Number(original.version),'RECONCILIATION_STALE_OR_REPLAYED');
   const role=await actionAuthority(c,p.actorId,'SECURITY_OPERATOR',a.id);requireControl(role&&role.id===row.authority_id&&role.version===Number(row.authority_version)&&role.authEpoch===Number(row.reviewer_auth_epoch),'RECONCILIATION_AUTHORITY_CHANGED');
   requireControl(this.readBacks?.resolve(a)===entry,'READ_BACK_CONTRACT_CHANGED');await this.valid(c,a);return a;
  };
  const request:ReadBackRequest={version:1,tenantId:p.tenantId,ownerId:original.owner_id,actionId:original.id,actionKey:original.logical_action_key,argsHash:original.args_hash,resourceId:original.resource_id,capabilityId:original.capability_id,capabilityVersion:original.tool_version,bindingHash:original.binding_hash,descriptorHash:entry.review.descriptorHash,readerBindingHash:entry.review.readerBindingHash};
  await this.readBackAccess(p,original,entry,async c=>{const a=await current(c,'REQUESTED');await c.query("UPDATE reconciliation_cases SET state='VERIFYING',nonce_hash='CONSUMED_NONCE',verification_method='CERTIFIED_READ_BACK_V1',updated_at=now(),version=version+1 WHERE id=$1",[id]);await this.audit(c,p,a.owner_id,'reconciliation.verifying',a.id,{caseId:id,argsHash:a.args_hash,reviewHash:entry.reviewHash});});
  let proof:Awaited<ReturnType<CertifiedReadBacks['observe']>>=null;
  try{
   // Revalidate after the committed claim, immediately before physical I/O.
   await this.readBackAccess(p,original,entry,c=>current(c,'VERIFYING'));
   proof=await this.readBacks!.observe(entry,request,{tenantId:p.tenantId,actorId:p.actorId});
   return await this.readBackAccess(p,original,entry,async c=>{
    const a=await current(c,'VERIFYING'),claim=proof?.outcome??'INCONCLUSIVE',state=proof?claim==='APPLIED'?'VERIFIED_APPLIED':'VERIFIED_NOT_APPLIED':'INCONCLUSIVE';
    await c.query("UPDATE reconciliation_cases SET state=$2,claim=$3,evidence_ref=$4,decided_at=now(),updated_at=now(),version=version+1 WHERE id=$1",[id,state,claim,JSON.stringify(this.store.sealActionInput({tenantId:p.tenantId,actorId:a.owner_id},`reconcile:${id}`,{proof,reviewHash:entry.reviewHash}))]);
    await this.audit(c,p,a.owner_id,proof?'reconciliation.verified':'reconciliation.inconclusive',a.id,{caseId:id,argsHash:a.args_hash,state,reviewHash:entry.reviewHash});
    // Journal evidence does not recreate a missing ToolResult, re-open a run,
    // renew a deadline, or replace fresh approval and an explicit owner retry.
    return {id,state,actionState:'UNKNOWN',verification:proof?'CERTIFIED_JOURNAL':'INCONCLUSIVE',retryAllowed:false};
   });
  }catch{
   // This is completion of our consumed claim only. Revoked authority cannot
   // certify evidence, and cannot cause another read or a write retry.
   return this.store.db.scope({tenantId:p.tenantId,actorId:original.owner_id},async c=>{
    const q=await c.query("UPDATE reconciliation_cases SET state='INCONCLUSIVE',claim='INCONCLUSIVE',evidence_ref=$3,decided_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND reviewer_id=$2 AND state='VERIFYING' AND nonce_hash='CONSUMED_NONCE' RETURNING id",[id,p.actorId,JSON.stringify(this.store.sealActionInput({tenantId:p.tenantId,actorId:original.owner_id},`reconcile:${id}`,{reason:'READ_BACK_SCOPE_CHANGED_OR_UNAVAILABLE',reviewHash:entry.reviewHash}))]);
    if(q.rowCount)await this.audit(c,p,original.owner_id,'reconciliation.inconclusive',original.id,{caseId:id,reviewHash:entry.reviewHash});
    return {id,state:'INCONCLUSIVE',verification:'INCONCLUSIVE',retryAllowed:false};
   });
  }
 }
 async attestReconciliation(p:Principal,id:string,input:{nonce:string;argsHash:string;claim:'APPLIED'|'NOT_APPLIED'|'INCONCLUSIVE';evidence:string}){
  const parts=input.nonce.split('.'),sig=Buffer.from(parts[1]??''),expected=Buffer.from(this.sign(parts[0]??''));requireControl(parts.length===2&&sig.length===expected.length&&timingSafeEqual(sig,expected),'RECONCILIATION_NONCE_INVALID');
  let token:{purpose:string;id:string;session:string;argsHash:string;expires:number};try{token=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8')) as typeof token;}catch{throw new ControlError('RECONCILIATION_NONCE_INVALID');}
  requireControl(token.purpose==='reconcile'&&token.id===id&&token.session===p.sessionId&&token.argsHash===input.argsHash&&token.expires>Date.now(),'RECONCILIATION_NONCE_INVALID');
  const scope=await this.store.db.scope(p,async c=>{await this.session(c,p);const q=await c.query('SELECT action_id FROM reconciliation_cases WHERE id=$1 AND reviewer_id=$2',[id,p.actorId]);requireControl(q.rowCount,'CONTROL_NOT_FOUND');return this.view(c,p,q.rows[0].action_id as string);});
  return this.store.db.scope({tenantId:p.tenantId,actorId:scope.owner_id},async c=>{
   await this.session(c,p);await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[scope.run_id]);await c.query('SELECT id FROM tool_actions WHERE id=$1 FOR UPDATE',[scope.id]);const a=await this.view(c,p,scope.id),row=(await c.query('SELECT * FROM reconciliation_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
   requireControl(row&&row.state==='REQUESTED'&&row.reviewer_id===p.actorId&&row.session_id===p.sessionId&&row.nonce_hash===hash(input.nonce)&&new Date(row.nonce_expires_at as string).getTime()>Date.now()&&row.args_hash===input.argsHash&&a.args_hash===input.argsHash&&a.state==='UNKNOWN','RECONCILIATION_STALE_OR_REPLAYED');
   const role=await actionAuthority(c,p.actorId,'SECURITY_OPERATOR',a.id);requireControl(role&&role.id===row.authority_id&&role.version===Number(row.authority_version)&&role.authEpoch===Number(row.reviewer_auth_epoch),'RECONCILIATION_AUTHORITY_CHANGED');
   const state=input.claim==='APPLIED'?'MANUAL_APPLIED_UNVERIFIED':'INCONCLUSIVE',actionState=input.claim==='APPLIED'?'APPLIED_UNVERIFIED':'UNKNOWN';
   await c.query("UPDATE reconciliation_cases SET state=$2,claim=$3,evidence_ref=$4,nonce_hash='CONSUMED_NONCE',decided_at=now(),verification_method='HUMAN_ATTESTATION_ONLY',updated_at=now(),version=version+1 WHERE id=$1",[id,state,input.claim,JSON.stringify(this.store.sealActionInput({tenantId:p.tenantId,actorId:a.owner_id},`reconcile:${id}`,{evidence:input.evidence}))]);
   await c.query('UPDATE tool_actions SET state=$2,updated_at=now(),version=version+1 WHERE id=$1',[a.id,actionState]);
   await c.query("UPDATE runs SET status=$2,last_error=$3,fence=fence+1,lease_owner=NULL,lease_until=NULL WHERE id=$1",[a.run_id,input.claim==='APPLIED'?'PARTIAL':'WAITING_USER',input.claim==='APPLIED'?'ACTION_APPLIED_UNVERIFIED':'RECONCILIATION_REQUIRED']);
   await this.audit(c,p,a.owner_id,'reconciliation.attested',a.id,{caseId:id,argsHash:a.args_hash,claim:input.claim,evidenceHash:hash(input.evidence),verification:'HUMAN_ATTESTATION_ONLY'});return {id,state,actionState,verification:'UNVERIFIED',retryAllowed:false};
  });
 }
 async request(p:Principal,actionId:string,approverId:string){return this.store.db.scope(p,async c=>{
  const a=await this.view(c,p,actionId);requireControl(a.owner_id===p.actorId&&p.actorId!==approverId,'APPROVAL_REQUEST_DENIED');
  await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[a.run_id]);await c.query('SELECT id FROM tool_actions WHERE id=$1 FOR UPDATE',[a.id]);
  const current=await this.view(c,p,a.id);await this.valid(c,current);
  const stale=await c.query("UPDATE approvals old SET state=CASE WHEN old.expires_at<=now() THEN 'EXPIRED' ELSE 'INVALIDATED' END,version=version+1,updated_at=now() WHERE old.action_id=$1 AND old.state IN ('PENDING','APPROVED') AND (old.expires_at<=now() OR old.requester_auth_epoch<>$2 OR (public.oa_control_action_authority(old.approver_id,'ACTION_APPROVER',old.action_id)->>'id') IS DISTINCT FROM old.authority_id::text OR (public.oa_control_action_authority(old.approver_id,'ACTION_APPROVER',old.action_id)->>'version')::bigint IS DISTINCT FROM old.authority_version OR (public.oa_control_action_authority(old.approver_id,'ACTION_APPROVER',old.action_id)->>'authEpoch')::bigint IS DISTINCT FROM old.approver_auth_epoch) RETURNING id,state",[a.id,p.authEpoch]);
  for(const prior of stale.rows)await this.audit(c,p,p.actorId,'approval.invalidated',a.id,{approvalId:prior.id,state:prior.state,argsHash:a.args_hash});
  if(current.state==='APPROVED'&&!(await c.query("SELECT id FROM approvals WHERE action_id=$1 AND state='APPROVED'",[a.id])).rowCount){await c.query("UPDATE tool_actions SET state='APPROVAL_REQUIRED',version=version+1 WHERE id=$1 AND state='APPROVED'",[a.id]);current.state='APPROVAL_REQUIRED';}
  requireControl(current.state==='APPROVAL_REQUIRED','ACTION_NOT_AWAITING_APPROVAL');
  const role=await actionAuthority(c,approverId,'ACTION_APPROVER',a.id);requireControl(role,'APPROVER_NOT_QUALIFIED');
  await c.query("UPDATE approvals SET state='EXPIRED',version=version+1 WHERE action_id=$1 AND state IN ('PENDING','APPROVED') AND expires_at<=now()",[a.id]);
  requireControl(!(await c.query("SELECT id FROM approvals WHERE action_id=$1 AND state IN ('PENDING','APPROVED')",[a.id])).rowCount,'APPROVAL_ALREADY_PENDING');
  const id=randomUUID(),expires=new Date(Math.min(Date.now()+20*60*1000,new Date(a.expires_text as string).getTime(),role.expiresAt?new Date(role.expiresAt).getTime():Infinity)).toISOString();
  await c.query("INSERT INTO approvals(tenant_id,id,owner_id,action_id,approver_id,args_hash,state,expires_at,nonce_hash,approver_auth_epoch,workflow_version,authority_id,authority_version,requester_auth_epoch) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,'UNISSUED',$8,1,$9,$10,$11)",[p.tenantId,id,p.actorId,a.id,approverId,a.args_hash,expires,role.authEpoch,role.id,role.version,p.authEpoch]);
  await this.audit(c,p,p.actorId,'approval.requested',a.id,{approvalId:id,argsHash:a.args_hash,approverId});return {id,state:'PENDING',expiresAt:expires};
 });}
 async preview(p:Principal,id:string){return this.store.db.scope(p,async c=>{
  await this.session(c,p);const row=(await c.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0];requireControl(row,'CONTROL_NOT_FOUND');const a=await this.view(c,p,row.action_id as string);await this.valid(c,a);
  const result={id,state:row.state,argsHash:row.args_hash,version:Number(row.version),expiresAt:row.expires_at,action:{id:a.id,capability:a.capability_id,risk:a.risk,resource:a.resource_id,audience:a.scope_descriptor.operationAudience,preview:a.approval_preview}};
  if(row.owner_id===p.actorId||row.state!=='PENDING'||new Date(row.expires_at as string).getTime()<=Date.now())return result;
  requireControl(row.approver_id===p.actorId&&row.state==='PENDING'&&new Date(row.expires_at as string).getTime()>Date.now(),'APPROVAL_NOT_DECIDABLE');
  const role=await actionAuthority(c,p.actorId,'ACTION_APPROVER',a.id);requireControl(role&&role.id===row.authority_id&&role.version===Number(row.authority_version)&&role.authEpoch===Number(row.approver_auth_epoch),'APPROVER_AUTHORITY_CHANGED');
  const expires=Math.min(Date.now()+5*60*1000,new Date(row.expires_at as string).getTime()),payload=Buffer.from(JSON.stringify({id,session:p.sessionId,argsHash:row.args_hash,version:Number(row.version),expires,random:randomBytes(32).toString('base64url')})).toString('base64url'),nonce=payload+'.'+this.sign(payload);
  await c.query('UPDATE approvals SET nonce_hash=$2,nonce_session_id=$3,nonce_expires_at=$4 WHERE id=$1',[id,hash(nonce),p.sessionId,new Date(expires).toISOString()]);return {...result,nonce};
 });}
 async decide(p:Principal,id:string,input:{nonce:string;argsHash:string;version:number;decision:'APPROVE'|'REJECT'}){
  const parts=input.nonce.split('.'),sig=Buffer.from(parts[1]??''),expected=Buffer.from(this.sign(parts[0]??''));requireControl(parts.length===2&&sig.length===expected.length&&timingSafeEqual(sig,expected),'DECISION_NONCE_INVALID');
  let payload:{id:string;session:string;argsHash:string;version:number;expires:number};try{payload=JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8')) as typeof payload;}catch{throw new ControlError('DECISION_NONCE_INVALID');}
  requireControl(payload.id===id&&payload.session===p.sessionId&&payload.argsHash===input.argsHash&&payload.version===input.version&&payload.expires>Date.now(),'DECISION_NONCE_INVALID');
  // Resolve visibility as the authenticated reviewer first. The owner scope below
  // is internal and repeats the caller/session/authority checks before mutation.
  const action=await this.store.db.scope(p,async c=>{await this.session(c,p);const q=await c.query('SELECT action_id FROM approvals WHERE id=$1 AND approver_id=$2',[id,p.actorId]);requireControl(q.rowCount,'CONTROL_NOT_FOUND');return this.view(c,p,q.rows[0].action_id as string);});
  return this.store.db.scope({tenantId:p.tenantId,actorId:action.owner_id},async c=>{
   await this.session(c,p);await c.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[action.run_id]);await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[action.task_id]);await c.query('SELECT id FROM tool_actions WHERE id=$1 FOR UPDATE',[action.id]);
   const a=await this.view(c,p,action.id);await this.valid(c,a);const row=(await c.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0];
   requireControl(row&&row.workflow_version===1&&row.approver_id===p.actorId&&row.owner_id!==p.actorId&&row.state==='PENDING'&&Number(row.version)===input.version&&row.args_hash===input.argsHash&&row.args_hash===a.args_hash&&row.nonce_hash===hash(input.nonce)&&row.nonce_session_id===p.sessionId&&new Date(row.nonce_expires_at as string).getTime()>Date.now()&&new Date(row.expires_at as string).getTime()>Date.now(),'DECISION_STALE_OR_REPLAYED');
   const role=await actionAuthority(c,p.actorId,'ACTION_APPROVER',a.id);requireControl(role&&role.id===row.authority_id&&role.version===Number(row.authority_version)&&role.authEpoch===Number(row.approver_auth_epoch)&&Number(row.requester_auth_epoch)===Number(a.current_auth_epoch),'APPROVER_AUTHORITY_CHANGED');
   requireControl(a.state==='APPROVAL_REQUIRED','ACTION_NOT_AWAITING_APPROVAL');
   const state=input.decision==='APPROVE'?'APPROVED':'REJECTED';await c.query('UPDATE approvals SET state=$2,decided_session_id=$3,nonce_hash=$4,version=version+1,updated_at=now() WHERE id=$1',[id,state,p.sessionId,'CONSUMED_NONCE']);
   await c.query('UPDATE tool_actions SET state=$2,version=version+1,updated_at=now() WHERE id=$1',[a.id,state==='APPROVED'?'APPROVED':'CANCELLED']);
   if(state==='APPROVED'){
    const run=(await c.query("UPDATE runs SET status='QUEUED',resume_action_id=$2,resume_kind='APPROVED_ACTION',reset_context=true,fence=fence+1,lease_until=NULL,lease_owner=NULL,retry_generation=retry_generation+1,version=version+1 WHERE id=$1 RETURNING retry_generation",[a.run_id,a.id])).rows[0];
    await c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'RUN',$4,$5,$6)",[p.tenantId,randomUUID(),a.owner_id,a.run_id,JSON.stringify({tenantId:p.tenantId,actorId:a.owner_id,runId:a.run_id,generation:Number(run.retry_generation)}),`approval:${id}:run`]);
   }else await c.query("UPDATE runs SET status='WAITING_USER',last_error='APPROVAL_REJECTED',fence=fence+1,lease_until=NULL,lease_owner=NULL WHERE id=$1",[a.run_id]);
   await this.audit(c,p,a.owner_id,'approval.decided',a.id,{approvalId:id,argsHash:a.args_hash,state,sessionHash:hash(p.sessionId)});return {id,state,executionState:state==='APPROVED'?'APPROVED_NOT_EXECUTED':'CANCELLED'};
  });
 }
}
