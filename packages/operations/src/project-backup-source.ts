import {createHash} from 'node:crypto';
import {readOperationsPrivateFile} from './private-file.js';
import {planProjectBackup} from './project-backup-profile.js';

class BackupSourceError extends Error{constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new BackupSourceError(code);};

/** Private operator-driver boundary, never a model tool. References are
 * attestations; the caller must obtain human permission for the real action.
 * This reads a pinned connection file only, and opens no database connection. */
export async function readProjectBackupSource(raw:unknown,review:{expectedProfileHash:string;reviewReference:string},signal:AbortSignal){
 const plan=planProjectBackup(raw),p=plan.profile;
 const checkpoint=()=>{if(signal.aborted)fail('BACKUP_SOURCE_CANCELLED');const now=Date.now();if(now<Date.parse(p.validFrom)||now>=Date.parse(p.validUntil))fail('BACKUP_SOURCE_WINDOW_CLOSED');};
 if(review.expectedProfileHash!==plan.profileHash||review.reviewReference!==p.reviewReference)fail('BACKUP_SOURCE_REVIEW_MISMATCH');
 checkpoint();let bytes:Buffer|undefined;
 try{
  bytes=await readOperationsPrivateFile(p.source.connectionFile,8192);checkpoint();
  if(createHash('sha256').update(bytes).digest('hex')!==p.source.connectionFileSha256)fail('BACKUP_SOURCE_CONNECTION_CHANGED');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();
  if(!/^postgresql:\/\/oa_migrator:[^/?#@\s]+@127\.0\.0\.1:53330\/open_aider$/.test(text))fail('BACKUP_SOURCE_TARGET_REJECTED');
  const url=new URL(text),password=decodeURIComponent(url.password);
  if(url.protocol!=='postgresql:'||url.hostname!==p.source.host||Number(url.port)!==p.source.port||url.pathname!=='/'+p.source.database||url.username!==p.source.role||url.search||url.hash||!password||/[\u0000-\u001f\u007f]/.test(password))fail('BACKUP_SOURCE_TARGET_REJECTED');
  checkpoint();
  // Explicit fields prevent PGHOST/PGOPTIONS/PGSSLMODE inheritance from
  // redirecting this local operator connection. Never serialize this return.
  return {host:p.source.host,port:p.source.port,database:p.source.database,user:p.source.role,password,ssl:false as const,sslnegotiation:'postgres' as const,client_encoding:'UTF8' as const,replication:'false' as const,binary:false as const,options:'-c row_security=off' as const,connectionTimeoutMillis:3000,query_timeout:p.maxDurationMs,application_name:'open_aider_bounded_backup'};
 }catch(error){throw error instanceof BackupSourceError?error:new BackupSourceError('BACKUP_SOURCE_PRIVATE_INPUT_REJECTED');}
 finally{bytes?.fill(0);}
}
