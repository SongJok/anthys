import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {trialProfileSchema} from '../../packages/config/src/one-shot-trial.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {trialState} from '../../packages/storage/src/trial.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
const admin=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});afterAll(()=>admin.end());
it.each(['ARMED','BOUND','CLOSED','FORMAL','REVOKED'] as const)('reserved metadata marker is inert before lifecycle admission in %s, including SDK replay',async mode=>{
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},corpId='SYNTHETIC-CAPTURE-'+ctx.tenantId,robotCode='synthetic-capture-boundary',conversationId='synthetic-existing-dm',db=new Database(secret('RUNTIME_DATABASE_URL')!,3);
 try{
  await admin.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'SYNTHETIC CAPTURE','ACTIVE')",[ctx.tenantId,corpId]);await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'owner','SYNTHETIC','ACTIVE')",[ctx.tenantId,ctx.actorId]);
  const profile=trialProfileSchema.parse({schemaVersion:1,...ctx,corpId,externalUserId:'owner',robotCode,conversationId,deadline:new Date(Date.now()+3600000).toISOString(),budgetPolicyHash:hash(JSON.stringify(JSON.parse(readFileSync(process.env['BUDGET_POLICY_FILE']!,'utf8')))),approvalReference:'SYNTHETIC_BOUNDARY_TRIAL'}),profileHash=hash(JSON.stringify(profile));db.trialProfileHash=profileHash;
  const slot=await admin.query("INSERT INTO one_shot_trials(tenant_id,owner_id,profile_hash,budget_policy_hash,corp_id,external_user_id,robot_code,conversation_id,deadline) VALUES($1,$2,$3,$4,$5,'owner',$6,$7,$8) RETURNING ceil(extract(epoch FROM created_at)*1000)::text cutoff_ms",[ctx.tenantId,ctx.actorId,profileHash,profile.budgetPolicyHash,corpId,robotCode,conversationId,profile.deadline]);
  const cutoff=Number(slot.rows[0].cutoff_ms);
  await vi.waitFor(async()=>{const sample=await admin.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text now_ms");expect(Number(sample.rows[0].now_ms)).toBeGreaterThanOrEqual(cutoff);expect(Date.now()).toBeGreaterThanOrEqual(cutoff);},{timeout:250,interval:1});
  const ingress=new DingTalkIngress(db,new Vault(new Map([['1',randomBytes(32)]]),'1'),{tenantId:ctx.tenantId,corpId,robotCode});
  const event=(text:string):DWClientDownStream=>{const id=randomUUID();return {specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:corpId,senderCorpId:corpId,senderStaffId:'owner',robotCode,conversationId,conversationType:'1',msgtype:'text',text:{content:text},createAt:Date.now(),senderId:'owner-id',chatbotUserId:'bot-id'})};};
  if(mode!=='ARMED'){const first=await ingress.acceptTrustedCallback(event('Explain hello.'));expect(first).not.toBeNull();expect(first!.taskId).toBeTruthy();if(mode!=='BOUND')await db.scope(ctx,c=>trialState(c,undefined,false,'SYNTHETIC_CLOSE_FOR_BOUNDARY'));}
  if(mode==='FORMAL'||mode==='REVOKED'){
   const formal=formalProfileFingerprint({schemaVersion:1,authorizationId:randomUUID(),...ctx,sourceTrialProfileHash:profileHash,corpId,externalUserId:'owner',robotCode,conversationId,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+1800000).toISOString(),budgetPolicyHash:profile.budgetPolicyHash,approvalReference:'SYNTHETIC_BOUNDARY_FORMAL',modelAllowed:false,modelApprovalReference:null,entrypoints:['INGRESS'],inputPolicy:{attachments:false,controls:false},capabilities:[]});
   await admin.query('SELECT public.oa_formal_authorize($1,$2,$3)',[formal.serialized,profileHash,formal.profile.approvalReference]);db.trialProfileHash=null;db.formalProfileHash=formal.hash;
   if(mode==='REVOKED')await admin.query('SELECT public.oa_formal_revoke($1,$2,$3,$4)',[formal.profile.authorizationId,formal.hash,'SYNTHETIC_REVOKED','SYNTHETIC_BOUNDARY_REVIEW']);
  }
  const snapshot=async()=>{const result:Record<string,unknown>={};for(const table of ['one_shot_trials','event_inbox','tasks','runs','outbox','deliveries','quota_ledger','budget_buckets','budget_allocations','formal_authorizations','formal_lifecycle_events','formal_admissions'])result[table]=(await admin.query(`SELECT to_jsonb(t) value FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[ctx.tenantId])).rows;return result;},before=await snapshot();
  const queries:string[]=[],scope=db.scope.bind(db),spy=vi.spyOn(db,'scope').mockImplementation((principal,fn)=>scope(principal,c=>fn(new Proxy(c,{get(target,key,receiver){if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string')queries.push(args[0]);return Reflect.apply(target.query,target,args);};return Reflect.get(target,key,receiver);}}))));
  try{
   const marker=event('OA_BIND_DM_V1 '+'a'.repeat(32));expect(await ingress.acceptTrustedCallback(marker)).toBeNull();expect(await Promise.all(Array.from({length:20},()=>ingress.acceptTrustedCallback(marker)))).toEqual(Array(20).fill(null));
   const client=new DWClient({clientId:'synthetic',clientSecret:'synthetic',debug:false}),acks:string[]=[],errors:string[]=[];client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,ingress,code=>errors.push(code));client.onCallback(marker);await vi.waitFor(()=>expect(acks).toEqual([marker.headers.messageId]));expect(errors).toEqual([]);
   expect(queries.some(q=>/oa_(?:trial|lifecycle)_admit/.test(q))).toBe(false);expect(queries.every(q=>q.trimStart().startsWith('SELECT'))).toBe(true);expect(await snapshot()).toEqual(before);
   const foreign=event('OA_BIND_DM_V1 '+'b'.repeat(32));foreign.data=JSON.stringify({...JSON.parse(foreign.data),robotCode:'synthetic-foreign'});await expect(ingress.acceptTrustedCallback(foreign)).rejects.toThrow('IDENTITY_MISMATCH');expect(await snapshot()).toEqual(before);
  }finally{spy.mockRestore();}
 }finally{await db.close();}
});
