import {randomBytes,randomUUID} from 'node:crypto';
import type {Database} from '../../storage/src/database.js';
import {hash} from '../../storage/src/crypto.js';
import {Directory} from './directory.js';
export interface LoginIdentityProvider {exchange(code:string,signal:AbortSignal):Promise<{corpId?:string;unionId:string}>}
export class LoginStates {
 constructor(private db:Database,readonly tenantId:string,readonly corpId:string){}
 private context(){return {tenantId:this.tenantId,actorId:'00000000-0000-4000-8000-000000000000'};}
 async create(browser:string,redirectPath:string):Promise<string>{
  if(!['/','/personal','/tasks'].includes(redirectPath))throw Error('REDIRECT_NOT_ALLOWED');
  if(!/^[A-Za-z0-9_-]{43}$/.test(browser))throw Error('BROWSER_BINDING_INVALID');
  const state=randomBytes(32).toString('base64url');
  await this.db.scope(this.context(),async c=>{await c.query("INSERT INTO login_states(tenant_id,id,state_hash,browser_hash,redirect_path,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",[this.tenantId,randomUUID(),hash(state),hash(browser),redirectPath]);});return state;
 }
 async consume(state:string,browser:string):Promise<string|null>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!/^[A-Za-z0-9_-]{43}$/.test(browser))return null;
  return this.db.scope(this.context(),async c=>{const q=await c.query('UPDATE login_states SET consumed_at=now(),version=version+1 WHERE state_hash=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING redirect_path',[hash(state),hash(browser)]);return q.rows[0]?.redirect_path as string|undefined??null;});
 }
 async resolveUnion(unionId:string):Promise<{tenantId:string;actorId:string}|null>{
  const userId=await this.db.scope(this.context(),async c=>{const q=await c.query("SELECT external_user_id FROM users WHERE union_id=$1 AND status='ACTIVE' LIMIT 2",[unionId]);return q.rowCount===1?q.rows[0].external_user_id as string:null;});if(!userId)return null;return new Directory(this.db,new Map([[this.corpId,this.tenantId]])).resolveVerifiedSubject({corpId:this.corpId,userId,unionId});
 }
}
