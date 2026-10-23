import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {secret} from '../../packages/config/src/index.js';
import {collectAlertFindings,reconcileAlerts} from '../../packages/observability/src/alerts.js';

const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!});
afterAll(async()=>{await root.end();});

function backupReceipt(backupSetId:string,createdAt:string){
 return {schemaVersion:1,kind:'POSTGRES_FILESTORE_BACKUP_SET',backupSetId,createdAt,sourceStable:{status:'MATCH'}};
}

async function fixture(){
 const tenantId=randomUUID(),actorId=randomUUID(),taskId=randomUUID(),runId=randomUUID(),marker='SYNTHETIC-SENSITIVE-'+randomUUID();
 const failedDelivery=randomUUID(),unknownDelivery=randomUUID(),sentDelivery=randomUUID(),unknownAction=randomUUID(),recentAction=randomUUID(),backlogOutbox=randomUUID(),recentOutbox=randomUUID(),publishedOutbox=randomUUID();
 const backupSetId=randomUUID(),directory=await mkdtemp(join(tmpdir(),'anthys-t126-')),receiptPath=join(directory,backupSetId+'.backup-set.json');
 await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic T126','ACTIVE')",[tenantId,'synthetic-t126-corp-'+tenantId.slice(0,8)]);
 await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$3,'synthetic T126 owner','ACTIVE')",[tenantId,actorId,'synthetic-t126-'+actorId]);
 await root.query("INSERT INTO tasks(tenant_id,id,requester_id,goal,status,audience,auth_epoch,expires_at) VALUES($1,$2,$3,'synthetic T126 alerting','OPEN',$4,1,clock_timestamp()+interval '1 hour')",[tenantId,taskId,actorId,JSON.stringify({kind:'PRIVATE_USER',targetId:actorId,classificationCeiling:'RESTRICTED'})]);
 await root.query("INSERT INTO runs(tenant_id,id,task_id,owner_id,status,budget) VALUES($1,$2,$3,$4,'QUEUED',$5)",[tenantId,runId,taskId,actorId,JSON.stringify({maxTurns:1})]);
 for(const [id,state,messageId] of [[failedDelivery,'FAILED',null],[unknownDelivery,'UNKNOWN','synthetic-request-'+unknownDelivery],[sentDelivery,'SENT','synthetic-request-'+sentDelivery]] as const)
  await root.query("INSERT INTO deliveries(tenant_id,id,owner_id,task_id,target,args_hash,state,message_id,content_ref,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[tenantId,id,actorId,taskId,JSON.stringify({kind:'PRIVATE_USER',targetId:actorId,preview:marker}),'synthetic-'+randomUUID(),state,messageId,JSON.stringify({ciphertext:marker}),state==='SENT'?null:marker]);
 await root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,result,tool_version,created_at) VALUES($1,$2,$3,$4,$5,'synthetic','UNKNOWN','MCP',$6,'1.0.0',clock_timestamp()-interval '10 minutes')",[tenantId,unknownAction,actorId,runId,'synthetic-unknown-'+unknownAction,JSON.stringify({body:marker})]);
 await root.query("INSERT INTO tool_actions(tenant_id,id,owner_id,run_id,logical_action_key,args_hash,state,provider_id,result,tool_version) VALUES($1,$2,$3,$4,$5,'synthetic','UNKNOWN','MCP',$6,'1.0.0')",[tenantId,recentAction,actorId,runId,'synthetic-recent-'+recentAction,JSON.stringify({body:marker})]);
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,created_at) VALUES($1,$2,$3,'RUN',$4,$5,$6,clock_timestamp()-interval '10 minutes')",[tenantId,backlogOutbox,actorId,runId,JSON.stringify({body:marker}),'synthetic-backlog-'+backlogOutbox]);
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key) VALUES($1,$2,$3,'RUN',$4,$5,$6)",[tenantId,recentOutbox,actorId,runId,JSON.stringify({body:marker}),'synthetic-recent-'+recentOutbox]);
 await root.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at,created_at) VALUES($1,$2,$3,'RUN',$4,$5,$6,clock_timestamp(),clock_timestamp()-interval '10 minutes')",[tenantId,publishedOutbox,actorId,runId,JSON.stringify({body:marker}),'synthetic-published-'+publishedOutbox]);
 return {tenantId,actorId,taskId,runId,marker,failedDelivery,unknownDelivery,sentDelivery,unknownAction,recentAction,backlogOutbox,recentOutbox,publishedOutbox,backupSetId,directory,receiptPath,now:new Date()};
}

it('T126 alerts fire and stay locatable for connector failure, persistent UNKNOWN, stale backup and queue backlog, carry no sensitive content, and close independently on recovery',async()=>{
 const f=await fixture();
 try{
  const options={now:f.now,unknownWriteAgeMs:5*60*1000,queueBacklogAgeMs:5*60*1000,backupMaxAgeMs:60*60*1000,maxLocations:10,tenantId:f.tenantId,backup:{backupSetId:f.backupSetId,receiptPath:f.receiptPath}};

  const missingBackup=(await collectAlertFindings(root,options)).find(item=>item.code==='BACKUP_UNRECOVERABLE');
  expect(missingBackup).toMatchObject({severity:'P0',tenantId:null,subject:f.backupSetId,surface:'backup',count:1,reason:'BACKUP_RECEIPT_MISSING',locations:[f.backupSetId],thresholdMs:60*60*1000});

  await writeFile(f.receiptPath,JSON.stringify({schemaVersion:1,kind:'NOT_A_BACKUP_SET',backupSetId:f.backupSetId,createdAt:f.now.toISOString(),body:f.marker}));
  const invalid=await collectAlertFindings(root,options),invalidBackup=invalid.find(item=>item.code==='BACKUP_UNRECOVERABLE');
  expect(invalidBackup?.reason).toBe('BACKUP_RECEIPT_INVALID');
  expect(JSON.stringify(invalid)).not.toContain(f.marker);

  await writeFile(f.receiptPath,JSON.stringify(backupReceipt(f.backupSetId,new Date(f.now.getTime()-2*60*60*1000).toISOString())));
  const findings=await collectAlertFindings(root,options),byCode=(code:string)=>findings.find(item=>item.code===code)!;
  expect(findings.map(item=>item.code).sort()).toEqual(['BACKUP_UNRECOVERABLE','DELIVERY_FAILURES','PERSISTENT_UNKNOWN_WRITES','QUEUE_BACKLOG']);

  const unknown=byCode('PERSISTENT_UNKNOWN_WRITES');
  expect(unknown).toMatchObject({severity:'P0',tenantId:f.tenantId,subject:f.tenantId,surface:'tool_actions',count:1,reason:'UNKNOWN_WRITES_OLDER_THAN_THRESHOLD',locations:[f.unknownAction],thresholdMs:5*60*1000});
  expect(Date.parse(unknown.oldestAt!)).toBeLessThanOrEqual(f.now.getTime()-5*60*1000);

  const deliveries=byCode('DELIVERY_FAILURES');
  expect(deliveries).toMatchObject({severity:'P1',tenantId:f.tenantId,subject:f.tenantId,surface:'deliveries',count:2,reason:'DELIVERY_FAILED_OR_UNKNOWN',thresholdMs:null,breakdown:{FAILED:1,UNKNOWN:1}});
  expect(new Set(deliveries.locations)).toEqual(new Set([f.failedDelivery,f.unknownDelivery]));
  expect(deliveries.locations).not.toContain(f.sentDelivery);

  const backlog=byCode('QUEUE_BACKLOG');
  expect(backlog).toMatchObject({severity:'P1',tenantId:f.tenantId,subject:f.tenantId,surface:'outbox',count:1,reason:'UNPUBLISHED_OUTBOX_OLDER_THAN_THRESHOLD',locations:[f.backlogOutbox],thresholdMs:5*60*1000});
  expect(backlog.locations).not.toContain(f.recentOutbox);expect(backlog.locations).not.toContain(f.publishedOutbox);

  const backup=byCode('BACKUP_UNRECOVERABLE');
  expect(backup).toMatchObject({severity:'P0',tenantId:null,subject:f.backupSetId,surface:'backup',count:1,reason:'BACKUP_RECEIPT_STALE',locations:[f.backupSetId],thresholdMs:60*60*1000});
  expect(JSON.stringify(findings)).not.toContain(f.marker);

  const observed=new Date(f.now.getTime()+1000),opened=reconcileAlerts([],findings,observed);
  expect(opened.active).toHaveLength(4);expect(opened.opened).toHaveLength(4);expect(opened.ongoing).toHaveLength(0);expect(opened.resolved).toHaveLength(0);
  for(const alert of opened.active){
   expect(alert.firstObservedAt).toBe(observed.toISOString());expect(alert.lastObservedAt).toBe(observed.toISOString());
   expect(alert.owner.length).toBeGreaterThan(0);expect(alert.escalationMinutes).toBeGreaterThan(0);
   expect(alert.runbook).toMatch(/^RUNBOOK-/);expect(alert.closeCondition.length).toBeGreaterThan(0);
  }
  expect(new Set(opened.active.map(alert=>alert.runbook)).size).toBe(4);

  const ongoing=reconcileAlerts(opened.active,await collectAlertFindings(root,options),new Date(f.now.getTime()+2000));
  expect(ongoing.opened).toHaveLength(0);expect(ongoing.ongoing).toHaveLength(4);expect(ongoing.resolved).toHaveLength(0);
  expect(ongoing.active.map(alert=>[alert.key,alert.firstObservedAt])).toEqual(opened.active.map(alert=>[alert.key,alert.firstObservedAt]));

  await root.query("UPDATE deliveries SET state='SENT',last_error=NULL,content_ref='synthetic' WHERE tenant_id=$1 AND id=ANY($2::uuid[])",[f.tenantId,[f.failedDelivery,f.unknownDelivery]]);
  const afterDelivery=await collectAlertFindings(root,options),partial=reconcileAlerts(opened.active,afterDelivery,new Date(f.now.getTime()+3000));
  expect(afterDelivery.map(item=>item.code).sort()).toEqual(['BACKUP_UNRECOVERABLE','PERSISTENT_UNKNOWN_WRITES','QUEUE_BACKLOG']);
  expect(partial.resolved.map(alert=>alert.code)).toEqual(['DELIVERY_FAILURES']);
  expect(partial.ongoing).toHaveLength(3);expect(partial.active).toHaveLength(3);

  await root.query("UPDATE tool_actions SET state='VERIFIED',result='{}' WHERE tenant_id=$1 AND id=$2",[f.tenantId,f.unknownAction]);
  await root.query('UPDATE outbox SET published_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.backlogOutbox]);
  await writeFile(f.receiptPath,JSON.stringify(backupReceipt(f.backupSetId,f.now.toISOString())));
  const cleared=await collectAlertFindings(root,options);
  expect(cleared).toEqual([]);
  const closed=reconcileAlerts(partial.active,cleared,new Date(f.now.getTime()+4000));
  expect(closed.active).toEqual([]);expect(closed.opened).toEqual([]);expect(closed.resolved).toHaveLength(3);
  expect(new Set(closed.resolved.map(alert=>alert.code))).toEqual(new Set(['PERSISTENT_UNKNOWN_WRITES','QUEUE_BACKLOG','BACKUP_UNRECOVERABLE']));
  expect(JSON.stringify({opened,ongoing,partial,closed})).not.toContain(f.marker);
 }
 finally{await rm(f.directory,{recursive:true,force:true});}
},30000);
