import {createHash} from 'node:crypto';
import type {DbContext} from '../../storage/src/database.js';
import type {PrivatePreferences} from './service.js';
import type {Personas} from '../../personas/src/service.js';
import type {PermissionCacheMaintenance} from '../../gateway/src/permission-maintenance.js';
export class MaintenanceGuardError extends Error{constructor(readonly reason:'SCHEMA_INCOMPATIBLE'|'TRIAL_MAINTENANCE_DISABLED'|'MAINTENANCE_ALREADY_STARTED'){super(reason);}}
type Operation='SCHEMA_READY'|'TRIAL_GUARD'|'PREFERENCE_MAINTENANCE'|'PERSONA_ERASURE_REPAIR'|'PERMISSION_CACHE_MAINTENANCE'|'ARTIFACT_FILE_CLEANUP';
type Dependencies={ready:()=>Promise<boolean>;trialGuard:()=>Promise<void>;memory:Pick<PrivatePreferences,'maintain'>;personas:Pick<Personas,'repairPrivateErasure'>;diagnostics:Pick<PermissionCacheMaintenance,'maintain'>;artifacts?:{maintain:(scope:DbContext)=>Promise<{removed:number;more:boolean}>};emit:(event:Record<string,unknown>,error:boolean)=>void};
const sqlStates=new Set(['23514','42501','42883','42P01','42703','57014','55P03','40001','40P01','08000','08001','08003','08006','53300','57P01']);
const trialReasons=new Set(['TRIAL_STARTUP_BLOCKED','TRIAL_PROFILE_BINDING_MISMATCH','TRIAL_BUDGET_POLICY_MISMATCH']);
export function maintenanceFailureCode(error:unknown){if(error instanceof MaintenanceGuardError)return error.reason;if(error instanceof Error&&trialReasons.has(error.message))return error.message;const code=(error as {code?:unknown}|null)?.code;return typeof code==='string'&&sqlStates.has(code)?code:'INTERNAL_ERROR';}
export class MaintenanceSupervisor{
 state:'STARTING'|'READY'|'FAILED'|'STOPPED'='STARTING';
 private started=false;private stopping=false;private pending:Promise<boolean>|null=null;private cycleNumber=0;
 private lastFailureCode:string|null=null;get failureCode(){return this.lastFailureCode;}
 constructor(private readonly scopes:readonly DbContext[],private readonly deps:Dependencies){}
 private stateEvent(state:typeof this.state,counts:Record<string,number>={}){this.state=state;this.deps.emit({kind:'PRIVATE_MEMORY_MAINTENANCE_STATE',state,cycle:this.cycleNumber,...counts},state==='FAILED');}
 private failure(operation:Operation,error:unknown,index:number|null=null){this.lastFailureCode=maintenanceFailureCode(error);this.deps.emit({kind:'PRIVATE_MEMORY_MAINTENANCE_FAILED',operation,scopeIndex:index,scopeRef:index===null?null:createHash('sha256').update(this.scopes[index]!.tenantId+':'+this.scopes[index]!.actorId).digest('hex').slice(0,16),causeCode:this.lastFailureCode},true);}
 start(){if(this.started)throw new MaintenanceGuardError('MAINTENANCE_ALREADY_STARTED');this.started=true;this.stateEvent('STARTING');this.pending=this.initialize().finally(()=>{this.pending=null;});return this.pending;}
 private async initialize(){let operation:Operation='SCHEMA_READY';try{if(!await this.deps.ready())throw new MaintenanceGuardError('SCHEMA_INCOMPATIBLE');if(this.stopping)return false;operation='TRIAL_GUARD';await this.deps.trialGuard();if(this.stopping)return false;}catch(error){this.failure(operation,error);this.stateEvent('FAILED');return false;}return this.cycle();}
 tick(){if(this.pending)return this.pending;if(!this.started||this.stopping||this.state==='FAILED'||this.state==='STOPPED')return Promise.resolve(false);this.pending=this.cycle().finally(()=>{this.pending=null;});return this.pending;}
 private async cycle(){this.cycleNumber++;let completedScopes=0,failedScopes=0;
  if(this.cycleNumber>1){try{if(!await this.deps.ready())throw new MaintenanceGuardError('SCHEMA_INCOMPATIBLE');}catch(error){this.failure('SCHEMA_READY',error);this.stateEvent('FAILED');return false;}if(this.stopping)return false;}
  for(const [index,scope]of this.scopes.entries()){
   if(this.stopping)break;let failed=false;const recordFailure=(operation:Operation,error:unknown)=>{if(!failed){failed=true;failedScopes++;}this.failure(operation,error,index);if(this.state!=='FAILED')this.stateEvent('FAILED',{completedScopes,failedScopes});};
   try{const result=await this.deps.memory.maintain(scope);if(result.expired||result.repaired)this.deps.emit({kind:'PRIVATE_MEMORY_MAINTENANCE',scopeIndex:index,expired:result.expired,repaired:result.repaired,more:result.more},false);}catch(error){recordFailure('PREFERENCE_MAINTENANCE',error);}
   if(this.stopping)break;
   try{const result=await this.deps.personas.repairPrivateErasure(scope);if(result.status==='REPAIRED')this.deps.emit({kind:'PERSONA_PRIVACY_REPAIR',scopeIndex:index,repaired:true},false);}catch(error){recordFailure('PERSONA_ERASURE_REPAIR',error);}
   if(this.stopping)break;
   try{const result=await this.deps.diagnostics.maintain(scope);if(result.expired||result.counters)this.deps.emit({kind:'PERMISSION_CACHE_MAINTENANCE',scopeIndex:index,expired:result.expired,counters:result.counters,more:result.more},false);}catch(error){recordFailure('PERMISSION_CACHE_MAINTENANCE',error);}
   if(this.stopping)break;
   if(this.deps.artifacts)try{const result=await this.deps.artifacts.maintain(scope);if(result.removed)this.deps.emit({kind:'ARTIFACT_FILE_CLEANUP',scopeIndex:index,removed:result.removed,more:result.more},false);}catch(error){recordFailure('ARTIFACT_FILE_CLEANUP',error);}
   if(!failed)completedScopes++;
  }
  if(failedScopes){this.stateEvent('FAILED',{completedScopes,failedScopes});return false;}
  if(this.stopping)return false;if(this.state!=='READY')this.stateEvent('READY',{completedScopes,failedScopes});return true;
 }
 async stop(){this.stopping=true;await this.pending;if(this.state!=='FAILED'&&this.state!=='STOPPED')this.stateEvent('STOPPED');}
}
