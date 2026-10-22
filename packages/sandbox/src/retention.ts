import type {Database} from '../../storage/src/database.js';
import type {FileStore} from '../../storage/src/files.js';

export type SandboxArtifactRetentionSummary=Readonly<{claimed:number;removed:number;failed:number}>;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';

/**
 * Removes expired sandbox artifact bytes and then their metadata. Claiming is
 * fenced by `expires_at` and a retry window inside SQL; a failed removal keeps
 * the row claimed so it is retried instead of leaking bytes without a key.
 */
export class SandboxArtifactRetentionSweeper {
 constructor(private readonly db:Database,private readonly files:FileStore,private readonly options:{retryAfterMs?:number}={}){}
 async sweep(limit=100):Promise<SandboxArtifactRetentionSummary>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('SANDBOX_ARTIFACT_RETENTION_LIMIT_INVALID');
  const retryAfterMs=this.options.retryAfterMs??300_000;
  const rows=(await this.db.pool.query<{out_tenant:string;out_id:string;out_key:string}>('SELECT * FROM public.oa_sandbox_artifact_claim_expired($1,$2)',[limit,retryAfterMs])).rows;
  let removed=0,failed=0;
  for(const row of rows){
   try{await this.files.remove(row.out_key);}catch(error){if(!missing(error)){failed++;continue;}}
   try{
    const done=(await this.db.pool.query<{done:boolean}>('SELECT public.oa_sandbox_artifact_finish_retention($1,$2,$3) done',[row.out_tenant,row.out_id,row.out_key])).rows[0]?.done===true;
    if(done)removed++;else failed++;
   }catch{failed++;}
  }
  return Object.freeze({claimed:rows.length,removed,failed});
 }
}
