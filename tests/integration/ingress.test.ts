import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
import {ids,seed} from '../../scripts/seed.js';
import {loadEnvFile,secret} from '../../packages/config/src/index.js';
loadEnvFile();const db=new Database(secret('RUNTIME_DATABASE_URL')!),ctx={tenantId:ids.tenantA,actorId:ids.alice};
const ingress=new DingTalkIngress(db,new Vault(new Map([['1',randomBytes(32)]]),'1'),{tenantId:ids.tenantA,corpId:'TENANT_A',robotCode:'synthetic-robot'});
const event=(id= randomUUID()):DWClientDownStream=>({specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic-app',connectionId:'synthetic-connection',contentType:'application/json',messageId:id,time:'1791972000000',topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:'TENANT_A',senderCorpId:'TENANT_A',senderStaffId:'alice',conversationId:'synthetic-dm',conversationType:'1',robotCode:'synthetic-robot',msgtype:'text',text:{content:'synthetic test question'},createAt:1791972000000,senderId:'alice-id',chatbotUserId:'bot-id'})});
beforeAll(async()=>{await seed(secret('MIGRATION_DATABASE_URL')!);});afterAll(async()=>{await db.close();});
it('T003 concurrent duplicate events create one inbox, task and outbox',async()=>{
 const e=event(),results=await Promise.all(Array.from({length:20},()=>ingress.acceptTrustedCallback(e)));
 expect(new Set(results.map(r=>r?.taskId)).size).toBe(1);expect(results.filter(r=>!r?.duplicate)).toHaveLength(1);
 const q=await db.scope(ctx,c=>c.query('SELECT count(*)::int n FROM tasks WHERE id=$1',[results[0]!.taskId]));expect(q.rows[0].n).toBe(1);
 const r=await db.scope(ctx,c=>c.query("SELECT count(*)::int n FROM outbox WHERE aggregate_id IN (SELECT id FROM runs WHERE task_id=$1) AND kind='RUN'",[results[0]!.taskId]));expect(r.rows[0].n).toBe(1);
});
it('T004 callback ACK occurs only after successful persistence, no ACK on DB failure',async()=>{
 const client=new DWClient({clientId:'synthetic',clientSecret:'synthetic',debug:false}),acks:string[]=[],errors:string[]=[];
 client.socketCallBackResponse=(id)=>{acks.push(id);};attachDurableRobotCallback(client,ingress,code=>errors.push(code));
 const e=event();client.onCallback(e);expect(acks).toHaveLength(0);await vi.waitFor(()=>expect(acks).toEqual([e.headers.messageId]));
 const persisted=await ingress.acceptTrustedCallback(e);expect((await db.scope(ctx,c=>c.query('SELECT id FROM tasks WHERE id=$1',[persisted!.taskId]))).rowCount).toBe(1);
 const closed=new Database(secret('RUNTIME_DATABASE_URL')!);await closed.close();
 const broken=new DingTalkIngress(closed,new Vault(new Map([['1',randomBytes(32)]]),'1'),{tenantId:ids.tenantA,corpId:'TENANT_A',robotCode:'synthetic-robot'});
 const client2=new DWClient({clientId:'synthetic',clientSecret:'synthetic'});client2.socketCallBackResponse=(id)=>{acks.push(id);};attachDurableRobotCallback(client2,broken,code=>errors.push(code));
 const e2=event();client2.onCallback(e2);await vi.waitFor(()=>expect(errors).toContain('INGRESS_NOT_ACKNOWLEDGED'));expect(acks).not.toContain(e2.headers.messageId);
});
it('T004 terminating the real PG connection after inbox/task/outbox writes rolls back without ACK; redelivery commits once',async()=>{
 const faultDb=new Database(secret('RUNTIME_DATABASE_URL')!,1),terminator=new Database(secret('RUNTIME_DATABASE_URL')!,1),e=event(),key=`synthetic-robot:synthetic-dm:${e.headers.messageId}`;
 const acks:string[]=[],errors:string[]=[],connectionErrors:string[]=[];let terminated=false,staged:Record<string,unknown>|undefined;
 faultDb.pool.on('connect',client=>client.on('error',(error:Error)=>{connectionErrors.push((error as NodeJS.ErrnoException).code??'CONNECTION_CLOSED');}));
 const original=faultDb.scope.bind(faultDb),spy=vi.spyOn(faultDb,'scope').mockImplementation((principal,fn)=>original(principal,c=>fn(new Proxy(c,{get(target,property,receiver){
  if(property==='query')return async(...args:unknown[])=>{
   const result=await Reflect.apply(target.query,target,args);
   // The real last ingress write has completed, but Database.scope has not
   // issued COMMIT. Kill this exact checked-out connection, not a test throw.
   if(!terminated&&typeof args[0]==='string'&&args[0].startsWith("UPDATE event_inbox SET state='ENQUEUED'")){
    const before=await target.query("SELECT pg_backend_pid() pid,(SELECT count(*)::int FROM event_inbox WHERE event_key=$1 AND state='ENQUEUED') events,(SELECT count(*)::int FROM tasks WHERE source_event_id IN (SELECT id FROM event_inbox WHERE event_key=$1)) tasks,(SELECT count(*)::int FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE source_event_id IN (SELECT id FROM event_inbox WHERE event_key=$1))) runs,(SELECT count(*)::int FROM outbox WHERE kind='RUN' AND aggregate_id IN (SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id AND t.tenant_id=r.tenant_id JOIN event_inbox e ON e.id=t.source_event_id AND e.tenant_id=t.tenant_id WHERE e.event_key=$1)) outbox",[key]);
    staged=before.rows[0];terminated=(await terminator.pool.query('SELECT pg_terminate_backend($1) terminated',[staged!.pid])).rows[0].terminated as boolean;
    await new Promise(resolve=>setImmediate(resolve));
   }
   return result;
  };
  return Reflect.get(target,property,receiver);
 }}))));
 try{
  const broken=new DingTalkIngress(faultDb,new Vault(new Map([['1',randomBytes(32)]]),'1'),{tenantId:ids.tenantA,corpId:'TENANT_A',robotCode:'synthetic-robot'}),client=new DWClient({clientId:'synthetic',clientSecret:'synthetic'});
  client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,broken,code=>errors.push(code));client.onCallback(e);
  await vi.waitFor(()=>expect(errors).toEqual(['INGRESS_NOT_ACKNOWLEDGED']));expect(terminated).toBe(true);expect(staged).toMatchObject({events:1,tasks:1,runs:1,outbox:1});expect(acks).toEqual([]);
  // pg can report a closed idle socket without retaining PostgreSQL's 57P01.
  // Prove the exact backend is gone instead of assuming an error-code shape.
  await vi.waitFor(async()=>{expect((await terminator.pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[staged!.pid])).rowCount).toBe(0);expect(connectionErrors.length).toBeGreaterThan(0);});
  expect((await db.scope(ctx,c=>c.query('SELECT id FROM event_inbox WHERE event_key=$1',[key]))).rowCount).toBe(0);
  const replay=await Promise.all(Array.from({length:20},()=>ingress.acceptTrustedCallback(e)));expect(replay.filter(r=>!r!.duplicate)).toHaveLength(1);expect(new Set(replay.map(r=>r!.taskId)).size).toBe(1);
  const taskId=replay[0]!.taskId,actual=(await db.scope(ctx,c=>c.query("SELECT (SELECT count(*)::int FROM event_inbox WHERE event_key=$1) events,(SELECT count(*)::int FROM tasks WHERE id=$2) tasks,(SELECT count(*)::int FROM runs WHERE task_id=$2) runs,(SELECT count(*)::int FROM outbox WHERE kind='RUN' AND aggregate_id IN (SELECT id FROM runs WHERE task_id=$2)) outbox",[key,taskId]))).rows[0];expect(actual).toEqual({events:1,tasks:1,runs:1,outbox:1});
 }finally{spy.mockRestore();await faultDb.close();await terminator.close();}
});
it('T006 ignores own robot messages without creating any task',async()=>{
 const e=event(),data=JSON.parse(e.data) as Record<string,unknown>;data['senderId']='bot-id';e.data=JSON.stringify(data);
 const before=await db.scope(ctx,c=>c.query('SELECT count(*) n FROM tasks'));expect(await ingress.acceptTrustedCallback(e)).toBeNull();expect((await db.scope(ctx,c=>c.query('SELECT count(*) n FROM tasks'))).rows).toEqual(before.rows);
});
it('T010 rejects mismatched corporation/robot binding before persistence',async()=>{
 const e=event(),data=JSON.parse(e.data) as Record<string,unknown>;data['senderCorpId']='TENANT_B';e.data=JSON.stringify(data);await expect(ingress.acceptTrustedCallback(e)).rejects.toThrow('IDENTITY_MISMATCH');
});
it('trusted conversation bridge rejects application-role calls and another actor joining a DM',async()=>{
 const appDb=new Database(secret('DATABASE_URL')!);try{await expect(appDb.scope(ctx,c=>c.query("SELECT public.oa_join_verified_conversation('synthetic-dm','DM')"))).rejects.toMatchObject({code:'42501'});}finally{await appDb.close();}
 await ingress.acceptTrustedCallback(event());const other=event(),data=JSON.parse(other.data) as Record<string,unknown>;data['senderStaffId']='bob';data['senderId']='bob-id';other.data=JSON.stringify(data);await expect(ingress.acceptTrustedCallback(other)).rejects.toThrow('DM_IDENTITY_MISMATCH');
 expect((await db.scope(ctx,c=>c.query('SELECT id FROM event_inbox WHERE event_key=$1',[`synthetic-robot:synthetic-dm:${other.headers.messageId}`]))).rowCount).toBe(0);
 await expect(db.scope(ctx,c=>c.query("SELECT public.oa_join_verified_conversation('synthetic','UNTRUSTED')"))).rejects.toMatchObject({code:'42501'});
});
it('bounded callback backlog refuses ACK so the provider can redeliver',()=>{
 const client=new DWClient({clientId:'synthetic',clientSecret:'synthetic'}),acks:string[]=[],errors:string[]=[];client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,ingress,code=>errors.push(code),0);client.onCallback(event());expect(acks).toEqual([]);expect(errors).toEqual(['BACKPRESSURE_NOT_ACKNOWLEDGED']);
});
it('reserved DM binding marker and its replays stay inert before trial admission or task/outbox writes',async()=>{
 const marker='OA_BIND_DM_V1 '+'a'.repeat(32),e=event(),data=JSON.parse(e.data) as Record<string,unknown>;data['text']={content:marker};e.data=JSON.stringify(data);
 const before=(await db.scope(ctx,c=>c.query('SELECT (SELECT count(*)::int FROM event_inbox) events,(SELECT count(*)::int FROM tasks) tasks,(SELECT count(*)::int FROM runs) runs,(SELECT count(*)::int FROM outbox) outbox'))).rows;
 const queries:string[]=[],original=db.scope.bind(db),spy=vi.spyOn(db,'scope').mockImplementation((principal,fn)=>original(principal,c=>fn(new Proxy(c,{get(target,key,receiver){if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string')queries.push(args[0]);return Reflect.apply(target.query,target,args);};return Reflect.get(target,key,receiver);}}))));
 try{expect(await ingress.acceptTrustedCallback(e)).toBeNull();expect(await Promise.all(Array.from({length:20},()=>ingress.acceptTrustedCallback(e)))).toEqual(Array(20).fill(null));}finally{spy.mockRestore();}
 expect(queries.some(q=>/oa_(?:trial|lifecycle)_admit/.test(q))).toBe(false);expect(queries.every(q=>q.trimStart().startsWith('SELECT'))).toBe(true);
 expect((await db.scope(ctx,c=>c.query('SELECT (SELECT count(*)::int FROM event_inbox) events,(SELECT count(*)::int FROM tasks) tasks,(SELECT count(*)::int FROM runs) runs,(SELECT count(*)::int FROM outbox) outbox'))).rows).toEqual(before);
});
it('reserved marker cannot bypass original corp/robot or active directory identity checks',async()=>{
 for(const patch of [{senderCorpId:'foreign'},{chatbotCorpId:'foreign'},{robotCode:'foreign'},{senderStaffId:'synthetic-unmapped-capture-user'}]){const e=event(),raw=JSON.parse(e.data) as Record<string,unknown>;Object.assign(raw,patch,{text:{content:'OA_BIND_DM_V1 '+'b'.repeat(32)}});e.data=JSON.stringify(raw);await expect(ingress.acceptTrustedCallback(e)).rejects.toThrow('senderStaffId'in patch?'UNMAPPED_IDENTITY':'IDENTITY_MISMATCH');}
});
it('normal business mentioning the reserved text still creates a task; exact inert control receives protocol ACK only',async()=>{
 const normal=event(),raw=JSON.parse(normal.data) as Record<string,unknown>;raw['text']={content:'请解释 OA_BIND_DM_V1 '+'c'.repeat(32)};normal.data=JSON.stringify(raw);expect((await ingress.acceptTrustedCallback(normal))?.taskId).toBeDefined();
 const inert=event(),value=JSON.parse(inert.data) as Record<string,unknown>;value['text']={content:'OA_BIND_DM_V1 '+'c'.repeat(32)};inert.data=JSON.stringify(value);const client=new DWClient({clientId:'synthetic',clientSecret:'synthetic'}),acks:string[]=[],errors:string[]=[];client.socketCallBackResponse=id=>{acks.push(id);};attachDurableRobotCallback(client,ingress,code=>errors.push(code));client.onCallback(inert);await vi.waitFor(()=>expect(acks).toEqual([inert.headers.messageId]));expect(errors).toEqual([]);expect((await db.scope(ctx,c=>c.query('SELECT id FROM event_inbox WHERE event_key=$1',[`synthetic-robot:synthetic-dm:${inert.headers.messageId}`]))).rowCount).toBe(0);
});
