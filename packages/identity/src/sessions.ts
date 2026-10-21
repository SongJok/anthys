import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database,DbContext} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
export interface Principal extends DbContext {roles:string[];authEpoch:number;sessionId:string}
export class Sessions {
 constructor(private db:Database,private signingKey:string) {if(signingKey.length<32) throw Error('SESSION_KEY_LENGTH');}
 private sign(text:string):string {return createHmac('sha256',this.signingKey).update(text).digest('base64url');}
 async create(trustedSubject:DbContext):Promise<{cookie:string;csrf:string}> {
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),id=randomUUID();
  await this.db.scope(trustedSubject,async c=>{
   const q=await c.query("SELECT u.auth_epoch FROM users u JOIN tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='ACTIVE' AND t.status='ACTIVE'",[trustedSubject.tenantId,trustedSubject.actorId]);if(!q.rowCount) throw Error('IDENTITY_INACTIVE');
   await c.query("INSERT INTO sessions(tenant_id,id,owner_id,token_hash,csrf_hash,auth_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '8 hours')",[trustedSubject.tenantId,id,trustedSubject.actorId,hash(token),hash(csrf),q.rows[0].auth_epoch]);
  });
  const payload=Buffer.from(JSON.stringify({tenantId:trustedSubject.tenantId,actorId:trustedSubject.actorId,token})).toString('base64url');return {cookie:`${payload}.${this.sign(payload)}`,csrf};
 }
 async authenticate(cookie:string|undefined,csrf?:string):Promise<Principal|null> {
  if(!cookie||cookie.length>2048) return null;
  const [payload,sig,...rest]=cookie.split('.');if(!payload||!sig||rest.length) return null;
  const expected=Buffer.from(this.sign(payload));const provided=Buffer.from(sig);if(provided.length!==expected.length||!timingSafeEqual(provided,expected)) return null;
  let data:{tenantId:string;actorId:string;token:string};
  try {data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as typeof data;if(!/^[0-9a-f-]{36}$/.test(data.tenantId)||!/^[0-9a-f-]{36}$/.test(data.actorId)||typeof data.token!=='string') return null;} catch {return null;}
  return this.db.scope(data,async c=>{
   const q=await c.query("SELECT s.id,s.csrf_hash,s.auth_epoch FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.owner_id JOIN tenants t ON t.tenant_id=s.tenant_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE' AND t.status='ACTIVE' AND u.auth_epoch=s.auth_epoch",[hash(data.token)]);
   if(!q.rowCount) return null;const row=q.rows[0];
   if(csrf!==undefined && hash(csrf)!==row.csrf_hash) return null;
   const roles=await c.query('SELECT r.name FROM roles r JOIN role_bindings b ON b.tenant_id=r.tenant_id AND b.role_id=r.id WHERE b.subject_id=$1 AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>now())',[data.actorId]);
   return {tenantId:data.tenantId,actorId:data.actorId,sessionId:row.id as string,authEpoch:Number(row.auth_epoch),roles:roles.rows.map(r=>r.name as string)};
  });
 }
 async rotateCsrf(principal:Principal):Promise<string>{const csrf=randomBytes(32).toString('base64url');await this.db.scope(principal,async c=>{const q=await c.query('UPDATE sessions SET csrf_hash=$2 WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id',[principal.sessionId,hash(csrf)]);if(!q.rowCount)throw Error('SESSION_EXPIRED');});return csrf;}
 async revoke(principal:Principal):Promise<void> {await this.db.scope(principal,async c=>{await c.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[principal.sessionId]);});}
}
