import pg from 'pg';
import {Kysely,PostgresDialect} from 'kysely';
import {TrialStopped} from './trial.js';
import {matchesRequiredSchema} from './schema.js';
export interface DbContext {tenantId:string;actorId:string; auditAccess?:boolean}
export class Database {
 readonly pool:pg.Pool;
 readonly kysely:Kysely<Record<string,never>>;
 trialProfileHash:string|null=null;
 formalProfileHash:string|null=null;
 private idleFailures=0;get idleConnectionFailures(){return this.idleFailures;}
 private transactionFailures=0;get transactionConnectionFailures(){return this.transactionFailures;}
 constructor(private readonly connectionUrl:string,max=10,queryTimeoutMs?:number) {this.pool=new pg.Pool({connectionString:connectionUrl,max,connectionTimeoutMillis:3000,...(queryTimeoutMs?{query_timeout:queryTimeoutMs,statement_timeout:queryTimeoutMs}:{})});this.pool.on('error',()=>{this.idleFailures++;console.error(JSON.stringify({kind:'DATABASE_IDLE_CONNECTION_FAILED',count:this.idleFailures}));});this.kysely=new Kysely({dialect:new PostgresDialect({pool:this.pool})});}
 forkForAuthority(max=4,queryTimeoutMs?:number){const db=new Database(this.connectionUrl,max,queryTimeoutMs);db.trialProfileHash=this.trialProfileHash;db.formalProfileHash=this.formalProfileHash;return db;}
 async scope<T>(context:DbContext,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await this.pool.connect();
  let discard=false,connectionFailureObserved=false;
  // pg removes its idle error listener while a client is borrowed. Own that
  // interval explicitly; query rejection still propagates and a failed client
  // cannot commit or return to the reusable pool.
  const connectionFailed=()=>{if(connectionFailureObserved)return;connectionFailureObserved=true;discard=true;this.transactionFailures++;console.error(JSON.stringify({kind:'DATABASE_TRANSACTION_CONNECTION_FAILED',count:this.transactionFailures}));};
  client.on('error',connectionFailed);
  try {
   await client.query('BEGIN');
   await this.configure(client,context);
   const result=await fn(client);if(discard)throw new Error('DATABASE_CONNECTION_FAILED');await client.query('COMMIT');return result;
  } catch(e) {
   try{await client.query('ROLLBACK');}catch(rollbackError){discard=true;throw rollbackError;}
   // A rejected dispatch rolls its own transaction back. Commit the durable
   // veto separately before returning the error, never undoing the close too.
   if(e instanceof TrialStopped&&!['TRIAL_RUN_MISMATCH','TRIAL_SUBJECT_MISMATCH','TRIAL_RECORD_MISSING'].includes(e.reason)){
    try{await client.query('BEGIN');await this.configure(client,context);await client.query('SELECT public.oa_trial_check(NULL,false,$1)',[e.reason]);await client.query('COMMIT');}
    catch(closeError){try{await client.query('ROLLBACK');}catch(rollbackError){discard=true;throw rollbackError;}throw closeError;}
   }
   throw e;
  } finally {try{client.release(discard);}finally{client.removeListener('error',connectionFailed);}}
 }
 private async configure(client:pg.PoolClient,context:DbContext){await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true),set_config('app.audit_access',$3,true),set_config('app.trial_profile_hash',$4,true),set_config('app.formal_profile_hash',$5,true),set_config('app.managed_grant_protocol','OA_MANAGED_GRANT_V1',true)",[context.tenantId,context.actorId,String(context.auditAccess===true),this.trialProfileHash??'',this.formalProfileHash??'']);}
 async ready():Promise<boolean> {
  // A matching ledger cannot certify readiness when an application identity can
  // rewrite it, including through column grants or a non-inherited SET ROLE.
  // Keep the contract and effective privilege observation in one SQL snapshot.
  const q=await this.pool.query<{name:string;hash:string;authority_safe:boolean}>('SELECT name,hash,(SELECT public.oa_schema_ledger_read_only()) AS authority_safe FROM public.schema_migrations ORDER BY name');
  return matchesRequiredSchema(q.rows)&&q.rows.every(row=>row.authority_safe===true);
 }
 async close():Promise<void> {await this.kysely.destroy();if(!this.pool.ended) await this.pool.end();}
}
