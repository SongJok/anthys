import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {TOPIC_CARD,type DWClient,type DWClientDownStream} from 'dingtalk-stream';
import type pg from 'pg';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {Principal} from '../../identity/src/sessions.js';
import {hash} from '../../storage/src/crypto.js';
import {canonical} from '../../gateway/src/index.js';
import {cancelTask} from '../../tasks/src/store.js';
export const cardCancellationHash=(taskId:string,audience:unknown,authEpoch:unknown)=>hash(canonical({taskId,audience,authEpoch:String(authEpoch),action:'CANCEL'}));
export class CardActions {
 constructor(private db:Database){}
 private async valid(c:pg.PoolClient,token:string,outTrackId?:string,lock=false){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const q=await c.query(`SELECT n.*,t.audience,t.auth_epoch task_epoch,card.out_track_id,u.auth_epoch current_epoch,u.status user_status,org.status tenant_status FROM card_action_tokens n JOIN tasks t ON t.tenant_id=n.tenant_id AND t.id=n.task_id JOIN card_instances card ON card.tenant_id=n.tenant_id AND card.id=n.card_id JOIN users u ON u.tenant_id=n.tenant_id AND u.id=n.owner_id JOIN tenants org ON org.tenant_id=n.tenant_id WHERE n.token_hash=$1 AND n.consumed_at IS NULL AND n.expires_at>now() ${lock?'FOR UPDATE OF n':''}`,[hash(token)]);
  const row=q.rows[0];if(!row||row.user_status!=='ACTIVE'||row.tenant_status!=='ACTIVE'||String(row.auth_epoch)!==String(row.current_epoch)||String(row.task_epoch)!==String(row.current_epoch)||row.args_hash!==cardCancellationHash(row.task_id as string,row.audience,row.current_epoch)||(outTrackId&&row.out_track_id!==outTrackId))return null;return row;
 }
 async preview(ctx:DbContext,token:string,outTrackId?:string){return this.db.scope(ctx,async c=>{const row=await this.valid(c,token,outTrackId);return row?{taskId:row.task_id as string,action:'CANCEL' as const,expiresAt:(row.expires_at as Date).toISOString()}:null;});}
 async execute(principal:Principal,token:string){return this.db.scope(principal,async c=>{
  const row=await this.valid(c,token,undefined,true);if(!row)return null;
  const session=await c.query('SELECT id FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() AND auth_epoch=$2 FOR SHARE',[principal.sessionId,principal.authEpoch]);if(!session.rowCount||String(row.auth_epoch)!==String(principal.authEpoch))return null;
  const result=await cancelTask(c,row.task_id as string);if(!result)return null;
  await c.query('UPDATE card_action_tokens SET consumed_at=now(),consumed_session_id=$2,version=version+1 WHERE id=$1',[row.id,principal.sessionId]);return result;
 });}
}
const callback=z.object({corpId:z.string(),outTrackId:z.uuid(),userId:z.string().min(1),userIdType:z.literal(1),type:z.literal('actionCallback'),content:z.string().max(16384)});
const content=z.object({cardPrivateData:z.object({params:z.object({action:z.literal('cancel'),token:z.string()}),actionIds:z.array(z.string()).optional()})});
export class CardCallbacks {
 constructor(private db:Database,private binding:{tenantId:string;corpId:string;clientId:string;appOrigin:string}){}
 async acceptTrustedCallback(message:DWClientDownStream):Promise<Record<string,unknown>>{
  if(message.type!=='CALLBACK'||message.headers.topic!==TOPIC_CARD||message.headers.appId!==this.binding.clientId)throw Error('UNTRUSTED_CARD_CALLBACK');
  const body=callback.parse(JSON.parse(message.data));if(body.corpId!==this.binding.corpId)throw Error('CARD_ENTERPRISE_MISMATCH');const params=content.parse(JSON.parse(body.content)).cardPrivateData.params;
  const user=await this.db.scope({tenantId:this.binding.tenantId,actorId:'00000000-0000-4000-8000-000000000000'},c=>c.query("SELECT id FROM users WHERE external_user_id=$1 AND status='ACTIVE'",[body.userId]));
  if(!user.rowCount)return {userPrivateData:{cardParamMap:{actionStatus:'DENIED'}}};
  const ctx={tenantId:this.binding.tenantId,actorId:user.rows[0].id as string};const action=await new CardActions(this.db).preview(ctx,params.token,body.outTrackId);
  if(!action)return {userPrivateData:{cardParamMap:{actionStatus:'DENIED'}}};
  await this.db.scope(ctx,async c=>{const key=`${this.binding.clientId}:${message.headers.messageId}`,digest=hash(canonical({corpId:body.corpId,userId:body.userId,outTrackId:body.outTrackId,params}));await c.query("INSERT INTO card_callback_receipts(tenant_id,id,owner_id,event_key,request_hash,card_id,response) SELECT $1,$2,$3,$4,$5,id,$6 FROM card_instances WHERE out_track_id=$7 ON CONFLICT(tenant_id,event_key) DO NOTHING",[ctx.tenantId,randomUUID(),ctx.actorId,key,digest,JSON.stringify({status:'H5_CONFIRMATION_REQUIRED'}),body.outTrackId]);const saved=await c.query('SELECT request_hash FROM card_callback_receipts WHERE event_key=$1',[key]);if(saved.rows[0]?.request_hash!==digest)throw Error('CARD_CALLBACK_REPLAY_MISMATCH');});
  const url=new URL('/card-action',this.binding.appOrigin);url.searchParams.set('token',params.token);
  // Stream never authorizes a mutation; confirmation uses an authenticated session and CSRF in H5.
  return {userPrivateData:{cardParamMap:{actionStatus:'H5_CONFIRMATION_REQUIRED',actionUrl:url.toString()}}};
 }
}
export function attachCardCallbacks(client:Pick<DWClient,'registerCallbackListener'|'socketCallBackResponse'>,callbacks:CardCallbacks,onError:(code:string)=>void,maxPending=20){
 let pending=0;client.registerCallbackListener(TOPIC_CARD,message=>{if(pending>=maxPending){onError('CARD_CALLBACK_BACKPRESSURE');return;}pending++;void callbacks.acceptTrustedCallback(message).then(response=>client.socketCallBackResponse(message.headers.messageId,response)).catch(()=>onError('CARD_CALLBACK_NOT_ACKNOWLEDGED')).finally(()=>{pending--;});});
}
