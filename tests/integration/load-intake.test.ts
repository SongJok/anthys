import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {cpus,platform,arch} from 'node:os';
import pg from 'pg';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
import {RunQueue} from '../../packages/tasks/src/queue.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {Schedules} from '../../packages/schedules/src/service.js';
import {ReminderScheduler} from '../../packages/schedules/src/runner.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
const db=new Database(secret('RUNTIME_DATABASE_URL')!,16),appDb=new Database(secret('DATABASE_URL')!,4),queueDb=new Database(secret('RUNTIME_DATABASE_URL')!,4);
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),queue=new RunQueue(secret('QUEUE_DATABASE_URL')!,'synthetic-load-'+randomUUID());
afterAll(async()=>{await queue.stop().catch(()=>undefined);await db.close();await appDb.close();await queueDb.close();await root.end();});

function percentile(values:number[],p:number){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!;}
function round(value:number){return Math.round(value*100)/100;}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function world(){
 const ctx={tenantId:randomUUID(),actorId:randomUUID()},externalUserId='synthetic-load-'+ctx.actorId,corpId='synthetic-corp-'+ctx.tenantId.slice(0,8),robotCode='synthetic-load-robot',conversationId='synthetic-load-conversation-'+ctx.tenantId;
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic T121','ACTIVE')",[ctx.tenantId,corpId]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic T121 owner','ACTIVE')",[ctx.tenantId,ctx.actorId,externalUserId]);
 const binding={tenantId:ctx.tenantId,corpId,robotCode},sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(ctx),principal=(await sessions.authenticate(session.cookie))!;
 return {ctx,externalUserId,corpId,robotCode,conversationId,binding,sessions,session,principal,ingress:new DingTalkIngress(db,vault,binding)};
}
function event(w:Awaited<ReturnType<typeof world>>,messageId:string,index:number):DWClientDownStream{
 return {specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:randomUUID(),time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:messageId,chatbotCorpId:w.corpId,senderCorpId:w.corpId,senderStaffId:w.externalUserId,senderId:w.externalUserId,conversationId:w.conversationId,conversationType:'1',robotCode:w.robotCode,msgtype:'text',text:{content:'合成负载消息 '+index},createAt:Date.now(),chatbotUserId:'bot'})};
}
interface AckClient{registerCallbackListener(topic:string,listener:(message:DWClientDownStream)=>void):void;socketCallBackResponse(messageId:string,response:Record<string,unknown>):void;}
function ackHarness(ingress:DingTalkIngress){
 const dispatched=new Map<string,{at:number;msgId:string}>(),acknowledged=new Map<string,number>(),logicalAcked=new Set<string>(),backpressure:string[]=[],failures:string[]=[];let listener:((message:DWClientDownStream)=>void)|undefined;
 const client:AckClient={registerCallbackListener(_topic,fn){listener=fn;},socketCallBackResponse(id){const attempt=dispatched.get(id);if(attempt){acknowledged.set(id,performance.now()-attempt.at);logicalAcked.add(attempt.msgId);}}};
 attachDurableRobotCallback(client as Parameters<typeof attachDurableRobotCallback>[0],ingress,code=>{if(code==='BACKPRESSURE_NOT_ACKNOWLEDGED')backpressure.push(code);else failures.push(code);},20);
 const send=(message:DWClientDownStream)=>{const id=message.headers.messageId,msgId=(JSON.parse(message.data) as {msgId:string}).msgId;dispatched.set(id,{at:performance.now(),msgId});listener!(message);return id;};
 return {send,dispatched,acknowledged,logicalAcked,backpressure,failures};
}
// A refused delivery is not a lost event: the stream platform redelivers the
// same msgId under a fresh protocol messageId, so retry by logical message.
async function redeliver(harness:ReturnType<typeof ackHarness>,originals:Map<string,DWClientDownStream>,unique:Set<string>,deadlineMs=60000){
 const started=performance.now();let rounds=0,redelivered=0;
 while(performance.now()-started<deadlineMs){
  const missing=[...unique].filter(id=>!harness.logicalAcked.has(id));if(!missing.length)return {rounds,missing:[] as string[],redelivered};
  rounds++;
  for(let offset=0;offset<missing.length;offset+=10){
   for(const msgId of missing.slice(offset,offset+10)){const original=originals.get(msgId)!;harness.send({...original,headers:{...original.headers,messageId:randomUUID()}});redelivered++;}
   await sleep(50);
  }
  for(let wait=0;wait<10&&[...unique].some(id=>!harness.logicalAcked.has(id));wait++)await sleep(50);
 }
 return {rounds,missing:[...unique].filter(id=>!harness.logicalAcked.has(id)),redelivered};
}

it('T121 sustained real ingress measures ACK percentiles, durable idempotent intake, outbox drain, scheduler lag and memory without mock model latency',async()=>{
 const w=await world(),harness=ackHarness(w.ingress),memoryBefore=process.memoryUsage();
 await queue.start();
 const sustainedMs=20000,rate=30,perTick=3,tickMs=100,ticks=sustainedMs/tickMs,messageIds=new Set<string>(),originals=new Map<string,DWClientDownStream>();
 let sequence=0;
 const dispatch=(messageId:string)=>{const message=event(w,messageId,sequence++);originals.set(messageId,message);harness.send(message);};
 for(let tick=0;tick<ticks;tick++){
  for(let n=0;n<perTick;n++){
   if(!messageIds.size||Math.random()>=0.3){const id=randomUUID();messageIds.add(id);dispatch(id);}
   else{const id=[...messageIds][Math.floor(Math.random()*messageIds.size)]!;if(Math.random()<0.1)setTimeout(()=>dispatch(id),200);else dispatch(id);}
  }
  await sleep(tickMs);
 }
 for(let n=0;n<100;n++){const id=randomUUID();messageIds.add(id);dispatch(id);}
 await sleep(250);
 const retry=await redeliver(harness,originals,messageIds),ackLatencies=[...harness.acknowledged.values()];
 expect(retry.missing).toEqual([]);
 expect(harness.failures).toEqual([]);
 expect(harness.backpressure.length).toBeGreaterThan(0);

 const rows=async(sql:string,params:unknown[]=[])=>(await root.query(sql,params)).rows;
 const inbox=await rows("SELECT event_key,count(*)::int n FROM event_inbox WHERE tenant_id=$1 AND source='DINGTALK' GROUP BY event_key",[w.ctx.tenantId]);
 const tasks=await rows('SELECT count(*)::int n FROM tasks WHERE tenant_id=$1 AND source_event_id IS NOT NULL',[w.ctx.tenantId]);
 const runs=await rows('SELECT count(*)::int n FROM runs WHERE tenant_id=$1',[w.ctx.tenantId]);
 const runOutbox=await rows("SELECT dedup_key,published_at FROM outbox WHERE tenant_id=$1 AND kind='RUN'",[w.ctx.tenantId]);
 const receipts=await rows("SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND kind='TASK_RECEIPT'",[w.ctx.tenantId]);
 const dispatchedCount=harness.dispatched.size,duplicates=harness.acknowledged.size-messageIds.size;
 expect(inbox).toHaveLength(messageIds.size);
 expect(inbox.every(row=>row.n===1)).toBe(true);
 expect(tasks[0]!.n).toBe(messageIds.size);
 expect(runs[0]!.n).toBe(messageIds.size);
 expect(runOutbox).toHaveLength(messageIds.size);
 expect(new Set(runOutbox.map(row=>row.dedup_key)).size).toBe(messageIds.size);
 expect(receipts[0]!.n).toBe(messageIds.size);
 expect(duplicates).toBeGreaterThan(0);

 let remaining=runOutbox.filter(row=>row.published_at===null).length;
 expect(remaining).toBe(messageIds.size);
 const drainSamples=[remaining],drainStarted=performance.now();let published=0;
 for(let batch=0;batch<100&&remaining>0;batch++){published+=await queue.publish(queueDb,w.ctx);remaining=(await rows("SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND kind='RUN' AND published_at IS NULL",[w.ctx.tenantId]))[0]!.n;drainSamples.push(remaining);}
 const drainMs=performance.now()-drainStarted;
 expect(published).toBe(messageIds.size);
 expect(remaining).toBe(0);
 expect(await queue.publish(queueDb,w.ctx)).toBe(0);
 expect(drainSamples.every((value,index)=>index===0||value<=drainSamples[index-1]!)).toBe(true);
 const jobs=await queue.boss.findJobs<{runId:string}>(queue.queueName);
 expect(new Set(jobs.map(job=>job.data.runId)).size).toBe(messageIds.size);

 let now=Date.now()-10000;const schedules=new Schedules(db,vault,()=>now),scheduler=new ReminderScheduler(schedules),due=new Date(Math.floor((Date.now()+2000)/1000)*1000).toISOString();
 const rule={schemaVersion:1,kind:'ONCE',tz:'Asia/Shanghai',start:{kind:'UTC',at:due},dst:{overlap:'EARLIER',gap:'SKIP'},misfire:{kind:'REMINDER_LATEST',graceSeconds:3600}},scheduleIds:string[]=[];
 for(let n=0;n<12;n++)scheduleIds.push((await schedules.create(w.principal,{kind:'PRIVATE_TEXT_REMINDER',text:'合成调度负载 '+n,rule},randomUUID())).schedule.id);
 await sleep(Math.max(0,Date.parse(due)-Date.now()+250));now=Date.now();
 const schedulerStarted=performance.now(),claimed:string[]=[];
 for(let batch=0;batch<3;batch++)claimed.push(...await scheduler.claimDue(w.ctx));
 const schedulerMs=performance.now()-schedulerStarted,claimedAt=Date.now(),occurrences=await rows('SELECT scheduled_at FROM schedule_occurrences WHERE tenant_id=$1',[w.ctx.tenantId]);
 const lags=occurrences.map(row=>Math.max(0,claimedAt-(row.scheduled_at as Date).getTime()));
 expect(claimed).toHaveLength(12);
 expect(occurrences).toHaveLength(12);
 expect(percentile(lags,0.95)).toBeLessThan(30000);
 expect(await scheduler.claimDue(w.ctx)).toEqual([]);

 const memoryAfter=process.memoryUsage(),ackP95=percentile(ackLatencies,0.95),ackP50=percentile(ackLatencies,0.5),ackP99=percentile(ackLatencies,0.99);
 expect(ackLatencies.length).toBeGreaterThan(0);
 expect(ackP95).toBeLessThan(1000);
 expect(memoryAfter.heapUsed-memoryBefore.heapUsed).toBeLessThan(256*1024*1024);
 const measurements={schemaVersion:1,testId:'T121',layer:'LOAD',status:'PASS',environment:{platform:platform(),arch:arch(),cpus:cpus().length,node:process.version,postgres:'127.0.0.1:64711',runner:'vitest single process through scripts/run-tests.mjs',modelCalls:0,mockLatencyUsedAsModelSla:false},load:{sustainedMs,ratePerSecond:rate,ticks,dispatched:dispatchedCount,uniqueMessages:messageIds.size,acceptedDuplicateDeliveries:duplicates,burst:100,burstDeliveredInOneTick:true,backpressureRefusals:harness.backpressure.length,redeliveryRounds:retry.rounds,redeliveredAttempts:retry.redelivered},ack:{samples:ackLatencies.length,p50Ms:round(ackP50),p95Ms:round(ackP95),p99Ms:round(ackP99),maxMs:round(Math.max(...ackLatencies)),thresholdMs:1000},durability:{inboxEvents:inbox.length,inboxRowsPerEvent:Math.max(...inbox.map(row=>row.n as number)),uniqueTasks:tasks[0]!.n,uniqueRuns:runs[0]!.n,runOutboxRows:runOutbox.length,taskReceiptRows:receipts[0]!.n},queue:{unpublishedBefore:messageIds.size,published,drainMs:round(drainMs),drainSamples,finalDepth:remaining,pgBossJobs:jobs.length,threshold:'drained to zero within the measured window'},scheduler:{schedules:scheduleIds.length,claimed:claimed.length,claimMs:round(schedulerMs),p95LagMs:round(percentile(lags,0.95)),maxLagMs:round(Math.max(...lags)),thresholdMs:30000},memory:{heapUsedBefore:memoryBefore.heapUsed,heapUsedAfter:memoryAfter.heapUsed,heapDelta:memoryAfter.heapUsed-memoryBefore.heapUsed,rssDelta:memoryAfter.rss-memoryBefore.rss,note:'short load window, not a 24-hour soak'},disclosure:'This is a shortened local load run on one process and the isolated PostgreSQL, not the document section 9 8vCPU/16GiB 30-minute baseline or a 24-hour soak. No model or upstream was called, so no model or network SLA is claimed from these numbers.'};
 await mkdir('reports',{recursive:true});await writeFile('reports/t121-load-intake-latest.json',JSON.stringify(measurements,null,2)+'\n');
 console.log('T121_MEASUREMENTS '+JSON.stringify(measurements));
},180000);
