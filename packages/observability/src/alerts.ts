import {readFile} from 'node:fs/promises';
import {z} from 'zod';

const alertCode=z.enum(['PERSISTENT_UNKNOWN_WRITES','BACKUP_UNRECOVERABLE','DELIVERY_FAILURES','QUEUE_BACKLOG']);
const alertSeverity=z.enum(['P0','P1']);
const alertSurface=z.enum(['tool_actions','deliveries','outbox','backup']);
export type AlertCode=z.infer<typeof alertCode>;
export type AlertSeverity=z.infer<typeof alertSeverity>;
export type AlertSurface=z.infer<typeof alertSurface>;

export const alertFindingSchema=z.object({
 code:alertCode,severity:alertSeverity,key:z.string().min(1).max(256),
 tenantId:z.uuid().nullable(),subject:z.string().min(1).max(256),surface:alertSurface,
 count:z.number().int().nonnegative(),oldestAt:z.iso.datetime().nullable(),
 reason:z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),locations:z.array(z.string().min(1).max(128)).max(100),
 thresholdMs:z.number().int().positive().nullable(),
 breakdown:z.record(z.string(),z.number().int().nonnegative()).optional()
}).strict();
export type AlertFinding=z.infer<typeof alertFindingSchema>;

export const operationalAlertSchema=alertFindingSchema.extend({
 owner:z.string().min(1).max(64),escalationMinutes:z.number().int().positive(),
 runbook:z.string().regex(/^RUNBOOK-[A-Z0-9-]{3,64}$/),closeCondition:z.string().min(1).max(256),
 firstObservedAt:z.iso.datetime(),lastObservedAt:z.iso.datetime()
}).strict();
export type OperationalAlert=z.infer<typeof operationalAlertSchema>;

export interface AlertQueryClient {query(sql:string,params:unknown[]):Promise<{rows:Record<string,unknown>[]}>;}
export interface BackupExpectation {backupSetId:string;receiptPath:string;}
export interface AlertCollectionOptions {
 now?:Date;unknownWriteAgeMs?:number;queueBacklogAgeMs?:number;backupMaxAgeMs?:number;maxLocations?:number;
 tenantId?:string;backup?:BackupExpectation|null;
}
export interface AlertReconciliation {active:OperationalAlert[];opened:OperationalAlert[];ongoing:OperationalAlert[];resolved:OperationalAlert[];}

const policy={
 PERSISTENT_UNKNOWN_WRITES:{severity:'P0',owner:'security-operations',escalationMinutes:15,runbook:'RUNBOOK-SEC-UNKNOWN-WRITES',closeCondition:'No tool_actions row remains UNKNOWN older than the configured threshold'},
 BACKUP_UNRECOVERABLE:{severity:'P0',owner:'data-platform',escalationMinutes:15,runbook:'RUNBOOK-DATA-BACKUP-SET',closeCondition:'A fresh valid backup-set receipt is present for the monitored set'},
 DELIVERY_FAILURES:{severity:'P1',owner:'connector-operations',escalationMinutes:30,runbook:'RUNBOOK-CONNECTOR-DELIVERY',closeCondition:'No delivery remains FAILED or UNKNOWN'},
 QUEUE_BACKLOG:{severity:'P1',owner:'runtime-operations',escalationMinutes:30,runbook:'RUNBOOK-RUNTIME-QUEUE',closeCondition:'No unpublished outbox row is older than the configured threshold'}
} as const satisfies Record<AlertCode,{severity:AlertSeverity;owner:string;escalationMinutes:number;runbook:string;closeCondition:string}>;

const defaults={unknownWriteAgeMs:5*60*1000,queueBacklogAgeMs:60*1000,backupMaxAgeMs:60*60*1000,maxLocations:20};
const iso=(value:unknown)=>new Date(value as string|Date).toISOString();
const strings=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
const count=(value:unknown)=>Number(value);
function positive(value:number|undefined,fallback:number,name:string){const resolved=value??fallback;if(!Number.isSafeInteger(resolved)||resolved<=0)throw Error(`ALERT_THRESHOLD_REJECTED:${name}`);return resolved;}
function finding(code:AlertCode,input:Omit<AlertFinding,'code'|'severity'|'key'>):AlertFinding {
 const p=policy[code];
 return alertFindingSchema.parse({code,severity:p.severity,key:`${code}:${input.subject}`,...input});
}
function groupRows(rows:Record<string,unknown>[],make:(row:Record<string,unknown>)=>AlertFinding):AlertFinding[]{return rows.map(make);}

async function backupFinding(backup:BackupExpectation,now:Date,maxAgeMs:number):Promise<AlertFinding|null>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backup.backupSetId))throw Error('BACKUP_SET_ID_REJECTED');
 const base={tenantId:null,subject:backup.backupSetId,surface:'backup' as const,count:1,oldestAt:null,locations:[backup.backupSetId],thresholdMs:maxAgeMs};
 let raw:string;
 try{raw=await readFile(backup.receiptPath,'utf8');}
 catch(error){
  const reason=(error as NodeJS.ErrnoException).code==='ENOENT'?'BACKUP_RECEIPT_MISSING':'BACKUP_RECEIPT_UNREADABLE';
  return finding('BACKUP_UNRECOVERABLE',{...base,reason});
 }
 let receipt:Record<string,unknown>;
 try{const parsed=JSON.parse(raw) as unknown;if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('NOT_OBJECT');receipt=parsed as Record<string,unknown>;}
 catch{return finding('BACKUP_UNRECOVERABLE',{...base,reason:'BACKUP_RECEIPT_INVALID'});}
 const stable=receipt['sourceStable'];
 if(receipt['schemaVersion']!==1||receipt['kind']!=='POSTGRES_FILESTORE_BACKUP_SET'||receipt['backupSetId']!==backup.backupSetId
  ||!stable||typeof stable!=='object'||(stable as Record<string,unknown>)['status']!=='MATCH')return finding('BACKUP_UNRECOVERABLE',{...base,reason:'BACKUP_RECEIPT_INVALID'});
 const createdAt=typeof receipt['createdAt']==='string'?Date.parse(receipt['createdAt']):NaN;
 if(!Number.isFinite(createdAt)||createdAt>now.getTime()+5*60*1000)return finding('BACKUP_UNRECOVERABLE',{...base,reason:'BACKUP_RECEIPT_INVALID'});
 if(now.getTime()-createdAt>maxAgeMs)return finding('BACKUP_UNRECOVERABLE',{...base,reason:'BACKUP_RECEIPT_STALE'});
 return null;
}

/** Aggregates operational state into fixed, content-free alerts.
 * Only identifiers, counts and configured thresholds leave the database. */
export async function collectAlertFindings(client:AlertQueryClient,options:AlertCollectionOptions={}):Promise<AlertFinding[]>{
 const now=options.now??new Date(),unknownAge=positive(options.unknownWriteAgeMs,defaults.unknownWriteAgeMs,'unknownWriteAgeMs'),
  queueAge=positive(options.queueBacklogAgeMs,defaults.queueBacklogAgeMs,'queueBacklogAgeMs'),
  backupAge=positive(options.backupMaxAgeMs,defaults.backupMaxAgeMs,'backupMaxAgeMs'),
  limit=positive(options.maxLocations,defaults.maxLocations,'maxLocations');
 if(limit>100)throw Error('ALERT_THRESHOLD_REJECTED:maxLocations');
 const scoped=options.tenantId??null;if(scoped!==null&&!z.uuid().safeParse(scoped).success)throw Error('ALERT_TENANT_REJECTED');
 const unknownCutoff=new Date(now.getTime()-unknownAge).toISOString(),queueCutoff=new Date(now.getTime()-queueAge).toISOString(),findings:AlertFinding[]=[];

 const unknown=await client.query(`SELECT t.tenant_id::text tenant_id,t.n,t.oldest_at,l.locations
  FROM (SELECT tenant_id,count(*)::int n,min(created_at) oldest_at FROM tool_actions WHERE state='UNKNOWN' AND created_at<=$1 AND ($3::uuid IS NULL OR tenant_id=$3::uuid) GROUP BY tenant_id) t
  CROSS JOIN LATERAL (SELECT array_agg(id::text ORDER BY created_at,id) locations FROM (SELECT id,created_at FROM tool_actions a WHERE a.tenant_id=t.tenant_id AND a.state='UNKNOWN' AND a.created_at<=$1 ORDER BY a.created_at,a.id LIMIT $2) x) l
  ORDER BY t.tenant_id`,[unknownCutoff,limit,scoped]);
 findings.push(...groupRows(unknown.rows,row=>finding('PERSISTENT_UNKNOWN_WRITES',{tenantId:row['tenant_id'] as string,subject:row['tenant_id'] as string,surface:'tool_actions',count:count(row['n']),oldestAt:iso(row['oldest_at']),reason:'UNKNOWN_WRITES_OLDER_THAN_THRESHOLD',locations:strings(row['locations']),thresholdMs:unknownAge})));

 const deliveries=await client.query(`SELECT tenant_id::text tenant_id,state,count(*)::int n,min(created_at) oldest_at,
  (SELECT array_agg(id::text ORDER BY created_at,id) FROM (SELECT id,created_at FROM deliveries d WHERE d.tenant_id=deliveries.tenant_id AND d.state IN ('FAILED','UNKNOWN') ORDER BY d.created_at,d.id LIMIT $1) x) locations
  FROM deliveries WHERE state IN ('FAILED','UNKNOWN') AND ($2::uuid IS NULL OR tenant_id=$2::uuid) GROUP BY tenant_id,state ORDER BY tenant_id,state`,[limit,scoped]);
 const deliveryGroups=new Map<string,{count:number;oldestAt:string;locations:string[];breakdown:Record<string,number>}>();
 for(const row of deliveries.rows){
  const tenant=row['tenant_id'] as string,group=deliveryGroups.get(tenant)??{count:0,oldestAt:iso(row['oldest_at']),locations:[],breakdown:{}};
  group.count+=count(row['n']);if(Date.parse(iso(row['oldest_at']))<Date.parse(group.oldestAt))group.oldestAt=iso(row['oldest_at']);
  group.breakdown[row['state'] as string]=count(row['n']);
  for(const id of strings(row['locations']))if(group.locations.length<limit&&!group.locations.includes(id))group.locations.push(id);
  deliveryGroups.set(tenant,group);
 }
 for(const [tenant,group] of deliveryGroups)findings.push(finding('DELIVERY_FAILURES',{tenantId:tenant,subject:tenant,surface:'deliveries',count:group.count,oldestAt:group.oldestAt,reason:'DELIVERY_FAILED_OR_UNKNOWN',locations:group.locations,thresholdMs:null,breakdown:group.breakdown}));

 const backlog=await client.query(`SELECT t.tenant_id::text tenant_id,t.n,t.oldest_at,l.locations
  FROM (SELECT tenant_id,count(*)::int n,min(created_at) oldest_at FROM outbox WHERE published_at IS NULL AND created_at<=$1 AND ($3::uuid IS NULL OR tenant_id=$3::uuid) GROUP BY tenant_id) t
  CROSS JOIN LATERAL (SELECT array_agg(id::text ORDER BY created_at,id) locations FROM (SELECT id,created_at FROM outbox o WHERE o.tenant_id=t.tenant_id AND o.published_at IS NULL AND o.created_at<=$1 ORDER BY o.created_at,o.id LIMIT $2) x) l
  ORDER BY t.tenant_id`,[queueCutoff,limit,scoped]);
 findings.push(...groupRows(backlog.rows,row=>finding('QUEUE_BACKLOG',{tenantId:row['tenant_id'] as string,subject:row['tenant_id'] as string,surface:'outbox',count:count(row['n']),oldestAt:iso(row['oldest_at']),reason:'UNPUBLISHED_OUTBOX_OLDER_THAN_THRESHOLD',locations:strings(row['locations']),thresholdMs:queueAge})));

 if(options.backup){const item=await backupFinding(options.backup,now,backupAge);if(item)findings.push(item);}
 const rank={P0:0,P1:1};
 return findings.sort((a,b)=>rank[a.severity]-rank[b.severity]||a.code.localeCompare(b.code)||(a.subject).localeCompare(b.subject));
}

/** Stable keys let one alert stay open across count changes and close only
 * when its own signal clears; recovery of another signal does not close it. */
export function reconcileAlerts(previous:readonly OperationalAlert[],findings:readonly AlertFinding[],observedAt:Date):AlertReconciliation{
 const stamp=observedAt.toISOString(),prior=new Map(previous.map(alert=>[alert.key,alert]));
 const active=findings.map(item=>{const p=policy[item.code],before=prior.get(item.key);return operationalAlertSchema.parse({...item,owner:p.owner,escalationMinutes:p.escalationMinutes,runbook:p.runbook,closeCondition:p.closeCondition,firstObservedAt:before?.firstObservedAt??stamp,lastObservedAt:stamp});});
 const current=new Set(active.map(alert=>alert.key));
 return {active,opened:active.filter(alert=>!prior.has(alert.key)),ongoing:active.filter(alert=>prior.has(alert.key)),resolved:previous.filter(alert=>!current.has(alert.key))};
}
