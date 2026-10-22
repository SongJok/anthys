import type {AnalysisJobPayload,AnalysisJobSubject} from '../../analysis/src/job-contract.js';
import type {Database} from '../../storage/src/database.js';
import {SandboxBrokerError,type SandboxAuthorizer} from './broker.js';

const activeTasks=new Set(['OPEN','ACTIVE']);
const activeRuns=new Set(['QUEUED','RUNNING','WAITING_USER','WAITING_AUTH','WAITING_APPROVAL','RETRY_SCHEDULED','VERIFYING']);
export type SandboxAuthorizationReason=
 |'AUTHORIZED'|'TENANT_INACTIVE'|'IDENTITY_INACTIVE'|'IDENTITY_EPOCH_STALE'
 |'TASK_NOT_FOUND'|'TASK_NOT_ACTIVE'|'TASK_CANCELLED'|'TASK_EXPIRED'|'TASK_EPOCH_STALE'
 |'RUN_NOT_FOUND'|'RUN_BINDING_MISMATCH'|'RUN_NOT_ACTIVE';

/**
 * Rechecks the live ACL for one already-signed job inside the owner's RLS
 * scope. A stale epoch, suspended tenant/user, ended task or non-active run
 * denies execution even when the envelope itself is valid and unexpired.
 */
export class PgSandboxAuthorizer implements SandboxAuthorizer {
 constructor(private readonly db:Database){}
 async authorize(payload:AnalysisJobPayload,signal:AbortSignal):Promise<{authorized:boolean;reason?:string}>{
  const subject=payload.subject;
  if(signal.aborted)throw new SandboxBrokerError('SANDBOX_BROKER_CANCELLED');
  let decision:SandboxAuthorizationReason;
  try{decision=await this.db.scope({tenantId:subject.tenantId,actorId:subject.actorId},client=>evaluate(client,subject));}
  catch(error){if(error instanceof SandboxBrokerError)throw error;throw new SandboxBrokerError('SANDBOX_BROKER_UNAVAILABLE');}
  if(signal.aborted)throw new SandboxBrokerError('SANDBOX_BROKER_CANCELLED');
  return decision==='AUTHORIZED'?{authorized:true}:{authorized:false,reason:decision};
 }
}

async function evaluate(client:{query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>},subject:AnalysisJobSubject):Promise<SandboxAuthorizationReason>{
 const tenant=(await client.query('SELECT status FROM tenants WHERE tenant_id=$1',[subject.tenantId])).rows[0] as {status:string}|undefined;
 if(tenant?.status!=='ACTIVE')return 'TENANT_INACTIVE';
 const identity=(await client.query('SELECT status,auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[subject.tenantId,subject.actorId])).rows[0] as {status:string;auth_epoch:string}|undefined;
 if(!identity||identity.status!=='ACTIVE')return 'IDENTITY_INACTIVE';
 if(Number(identity.auth_epoch)!==subject.authEpoch)return 'IDENTITY_EPOCH_STALE';
 const task=(await client.query("SELECT status,auth_epoch,cancel_requested_at IS NOT NULL cancelled,(expires_at>clock_timestamp()) unexpired FROM tasks WHERE tenant_id=$1 AND id=$2 AND requester_id=$3",[subject.tenantId,subject.taskId,subject.actorId])).rows[0] as {status:string;auth_epoch:string;cancelled:boolean;unexpired:boolean}|undefined;
 if(!task)return 'TASK_NOT_FOUND';
 if(!activeTasks.has(task.status))return 'TASK_NOT_ACTIVE';
 if(task.cancelled)return 'TASK_CANCELLED';
 if(Number(task.auth_epoch)!==subject.authEpoch)return 'TASK_EPOCH_STALE';
 if(!task.unexpired)return 'TASK_EXPIRED';
 const run=(await client.query('SELECT task_id,status FROM runs WHERE tenant_id=$1 AND id=$2 AND owner_id=$3',[subject.tenantId,subject.runId,subject.actorId])).rows[0] as {task_id:string;status:string}|undefined;
 if(!run)return 'RUN_NOT_FOUND';
 if(run.task_id!==subject.taskId)return 'RUN_BINDING_MISMATCH';
 if(!activeRuns.has(run.status))return 'RUN_NOT_ACTIVE';
 return 'AUTHORIZED';
}
