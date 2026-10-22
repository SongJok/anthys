import {randomUUID} from 'node:crypto';
import type {Database,DbContext} from '../../storage/src/database.js';
import type {ToolResult} from '../../contracts/src/index.js';
import {parseExactCount} from './data-numeric.js';
export type DataExecutionAudit={
 templateKey:string;templateVersion:string;paramsHash:string;queryId:string|null;status:ToolResult['status'];
 watermark:string|null;observedAt:string|null;completeness:ToolResult['completeness'];rowCount:string;evidenceRef:string;
};
export async function recordDataExecution(db:Database,ctx:DbContext,audit:DataExecutionAudit):Promise<void>{
 parseExactCount(audit.rowCount);
 await db.scope(ctx,client=>client.query('INSERT INTO data_executions(tenant_id,id,owner_id,template_key,template_version,params_hash,query_id,status,watermark,observed_at,completeness,row_count,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12::bigint,$13)',[
  ctx.tenantId,randomUUID(),ctx.actorId,audit.templateKey,audit.templateVersion,audit.paramsHash,audit.queryId,audit.status,audit.watermark,audit.observedAt,audit.completeness,audit.rowCount,audit.evidenceRef,
 ]));
}
