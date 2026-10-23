import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {loadEnvFile,secret} from '../packages/config/src/index.js';
import {collectAlertFindings,operationalAlertSchema,reconcileAlerts,type OperationalAlert,type AlertCollectionOptions} from '../packages/observability/src/alerts.js';

const stateSchema=z.object({schemaVersion:z.literal(1),observedAt:z.iso.datetime(),active:z.array(operationalAlertSchema)}).strict();

function option(name:string):string|undefined{
 const index=process.argv.indexOf(name);if(index<0)return undefined;
 const value=process.argv[index+1];if(!value||value.startsWith('--'))throw Error(`ALERT_ARGUMENT_REQUIRED:${name}`);
 return value;
}
function integerOption(name:string):number|undefined{
 const raw=option(name);if(raw===undefined)return undefined;
 if(!/^[1-9][0-9]{0,8}$/.test(raw))throw Error(`ALERT_ARGUMENT_REJECTED:${name}`);
 return Number(raw);
}
async function loadState(path:string):Promise<OperationalAlert[]>{
 let raw:string;
 try{raw=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 return stateSchema.parse(JSON.parse(raw)).active;
}

loadEnvFile();
const backupSetId=option('--backup-set'),receiptPath=option('--backup-receipt');
if(!!backupSetId!==!!receiptPath)throw Error('ALERT_BACKUP_ARGUMENTS_INCOMPLETE');
const unknownAge=integerOption('--max-unknown-age-ms'),queueAge=integerOption('--max-queue-age-ms'),backupAge=integerOption('--max-backup-age-ms');
const thresholds={unknownWriteAgeMs:unknownAge??300000,queueBacklogAgeMs:queueAge??60000,backupMaxAgeMs:backupAge??3600000};
const options:AlertCollectionOptions={
 ...(unknownAge!==undefined?{unknownWriteAgeMs:unknownAge}:{}),...(queueAge!==undefined?{queueBacklogAgeMs:queueAge}:{}),
 ...(backupAge!==undefined?{backupMaxAgeMs:backupAge}:{}),backup:backupSetId&&receiptPath?{backupSetId,receiptPath}:null
};
const statePath=option('--state-file')??'.data/alerts/state.json',reportPath=option('--report')??'reports/alerts-latest.json';
const url=secret('MIGRATION_DATABASE_URL')??secret('DATABASE_URL');
if(!url)throw Error('ALERT_DATABASE_URL_REQUIRED');
const pool=new pg.Pool({connectionString:url,max:2});
try{
 const authority=(await pool.query('SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0] as {role:string;rolsuper:boolean;rolbypassrls:boolean}|undefined;
 if(!authority?.rolsuper&&!authority?.rolbypassrls)throw Error('ALERT_DATABASE_ROLE_INSUFFICIENT');
 const observedAt=new Date(),previous=await loadState(statePath);
 const findings=await collectAlertFindings(pool,{...options,now:observedAt});
 const result=reconcileAlerts(previous,findings,observedAt);
 const p0=result.active.filter(alert=>alert.severity==='P0').length,p1=result.active.length-p0;
 const report={schemaVersion:1,observedAt:observedAt.toISOString(),databaseRole:authority.role,thresholds,backup:backupSetId?{backupSetId}:null,summary:{status:p0?'P0_ACTIVE':p1?'P1_ACTIVE':'CLEAR',p0,p1,opened:result.opened.length,ongoing:result.ongoing.length,resolved:result.resolved.length},active:result.active,opened:result.opened,ongoing:result.ongoing,resolved:result.resolved};
 await mkdir(dirname(statePath),{recursive:true});
 await writeFile(statePath,JSON.stringify({schemaVersion:1,observedAt:observedAt.toISOString(),active:result.active},null,2)+'\n',{mode:0o600});
 await mkdir(dirname(reportPath),{recursive:true});
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
 process.exitCode=p0?1:0;
}finally{await pool.end();}
