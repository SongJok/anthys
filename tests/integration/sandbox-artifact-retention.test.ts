import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {Database} from '../../packages/storage/src/database.js';
import {EncryptedFileStore,type FileStore} from '../../packages/storage/src/files.js';
import {PgSandboxArtifactConnector} from '../../packages/sandbox/src/artifacts.js';
import {SandboxArtifactRetentionSweeper} from '../../packages/sandbox/src/retention.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),db=new Database(secret('RUNTIME_DATABASE_URL')!,10);
let directory:string,files:EncryptedFileStore,expired:PgSandboxArtifactConnector,live:PgSandboxArtifactConnector;
beforeAll(async()=>{
 directory=await realpath(await mkdtemp(join(tmpdir(),'anthys-sandbox-retention-')));
 files=new EncryptedFileStore(directory,new Vault(new Map([['1',randomBytes(32)]]),'1'));
 expired=new PgSandboxArtifactConnector(db,files,{ttlMs:7*86_400_000,now:()=>Date.now()-8*86_400_000});
 live=new PgSandboxArtifactConnector(db,files);
});
afterAll(async()=>{await db.close();await root.end();await rm(directory,{recursive:true,force:true});});

async function world(){
 const tenantId=randomUUID(),actorId=randomUUID();
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status,timezone) VALUES($1,$1,$2,'synthetic sandbox retention','ACTIVE','UTC')",[tenantId,'synthetic-sandbox-retention-'+tenantId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic sandbox retention owner','ACTIVE')",[tenantId,actorId,'synthetic-sandbox-retention-'+actorId]);
 return {tenantId,actorId};
}
const keyOf=async(tenantId:string,id:string)=>((await root.query('SELECT storage_key FROM sandbox_artifacts WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0] as {storage_key:string}).storage_key;
const rowOf=async(tenantId:string,id:string)=>(await root.query('SELECT state,retention_claimed_at FROM sandbox_artifacts WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0] as {state:string;retention_claimed_at:Date|null}|undefined;

it('removes expired bytes and metadata across owner scopes while leaving live artifacts untouched',async()=>{
 const first=await world(),second=await world();
 const one=await expired.put(first,{kind:'CODE',mime:'text/javascript',bytes:Buffer.from('expired-one')}),two=await expired.put(second,{kind:'INPUT',name:'expired.txt',mime:'text/plain',bytes:Buffer.from('expired-two')});
 const kept=await live.put(first,{kind:'INPUT',name:'live.txt',mime:'text/plain',bytes:Buffer.from('live')});
 const keys=await Promise.all([keyOf(first.tenantId,one.id),keyOf(second.tenantId,two.id),keyOf(first.tenantId,kept.id)]);
 await expect(files.get(keys[0]!)).resolves.toEqual(Buffer.from('expired-one'));
 const summary=await new SandboxArtifactRetentionSweeper(db,files).sweep(500);
 expect(summary.claimed).toBeGreaterThanOrEqual(2);expect(summary.failed).toBe(0);expect(summary.removed).toBeGreaterThanOrEqual(2);
 await expect(rowOf(first.tenantId,one.id)).resolves.toBeUndefined();
 await expect(rowOf(second.tenantId,two.id)).resolves.toBeUndefined();
 await expect(files.get(keys[0]!)).rejects.toMatchObject({code:'ENOENT'});
 await expect(files.get(keys[1]!)).rejects.toMatchObject({code:'ENOENT'});
 await expect(rowOf(first.tenantId,kept.id)).resolves.toMatchObject({state:'READY',retention_claimed_at:null});
 await expect(files.get(keys[2]!)).resolves.toEqual(Buffer.from('live'));
});

class FlakyStore implements FileStore {
 failKey:string|null=null;
 constructor(private readonly inner:FileStore){}
 put(key:string,bytes:Buffer){return this.inner.put(key,bytes);}
 get(key:string){return this.inner.get(key);}
 remove(key:string){if(this.failKey===key){this.failKey=null;throw Object.assign(Error('SYNTHETIC_REMOVE_DENIED'),{code:'EACCES'});}return this.inner.remove(key);}
}

it('retains a claimed row when byte removal fails and retries only after the window',async()=>{
 const w=await world(),flaky=new FlakyStore(files);
 const ref=await new PgSandboxArtifactConnector(db,flaky,{ttlMs:7*86_400_000,now:()=>Date.now()-8*86_400_000}).put(w,{kind:'INPUT',name:'retry.txt',mime:'text/plain',bytes:Buffer.from('retry-me')});
 const key=await keyOf(w.tenantId,ref.id);flaky.failKey=key;
 const sweeper=new SandboxArtifactRetentionSweeper(db,flaky,{retryAfterMs:60_000});
 const first=await sweeper.sweep(500);
 expect(first.failed).toBeGreaterThanOrEqual(1);
 const claimed=await rowOf(w.tenantId,ref.id);
 expect(claimed).toMatchObject({state:'READY'});expect(claimed?.retention_claimed_at).not.toBeNull();
 await sweeper.sweep(500);
 expect(await rowOf(w.tenantId,ref.id)).toMatchObject({retention_claimed_at:claimed?.retention_claimed_at});
 await root.query("UPDATE sandbox_artifacts SET retention_claimed_at=clock_timestamp()-interval '2 minutes' WHERE tenant_id=$1 AND id=$2",[w.tenantId,ref.id]);
 const retried=await sweeper.sweep(500);
 expect(retried.removed).toBeGreaterThanOrEqual(1);
 await expect(rowOf(w.tenantId,ref.id)).resolves.toBeUndefined();
 await expect(files.get(key)).rejects.toMatchObject({code:'ENOENT'});
});

it('cannot delete an unclaimed artifact through the retention function and rejects an unbounded sweep',async()=>{
 const w=await world(),kept=await live.put(w,{kind:'INPUT',name:'unclaimed.txt',mime:'text/plain',bytes:Buffer.from('unclaimed')}),key=await keyOf(w.tenantId,kept.id);
 const finished=(await db.pool.query<{done:boolean}>('SELECT public.oa_sandbox_artifact_finish_retention($1,$2,$3) done',[w.tenantId,kept.id,key])).rows[0]!;
 expect(finished.done).toBe(false);
 await expect(rowOf(w.tenantId,kept.id)).resolves.toMatchObject({state:'READY'});
 await expect(files.get(key)).resolves.toEqual(Buffer.from('unclaimed'));
 await expect(new SandboxArtifactRetentionSweeper(db,files).sweep(0)).rejects.toThrow('SANDBOX_ARTIFACT_RETENTION_LIMIT_INVALID');
});
