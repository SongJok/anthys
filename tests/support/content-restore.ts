import './isolation.js';
import type pg from 'pg';
const tables=['personas','persona_revisions','persona_change_requests','persona_scope_proposals','tasks','runs','run_persona_snapshots','provider_journals','context_checkpoints','run_steps','tool_actions','run_finalizations','run_narrative_reviews','run_user_messages','run_source_choices','source_choice_replies','outbox','deliveries','event_inbox'] as const;
export type ContentFragment={table:typeof tables[number];rows:Record<string,unknown>[]}[];
export async function captureSyntheticContent(root:pg.Pool,table:typeof tables[number],tenantId:string,ids?:string[]){
 if(!tables.includes(table))throw Error('RESTORE_TABLE_REJECTED');
 // PostgreSQL JSON preserves timestamp microseconds. pg Date objects would
 // truncate them and falsely invalidate an otherwise restored live lease.
 return {table,rows:(await root.query(`SELECT to_jsonb(content) row FROM ${table} content WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2))`,[tenantId,ids??null])).rows.map(r=>r.row as Record<string,unknown>)};
}
export async function restoreSyntheticContent(root:pg.Pool,fragment:ContentFragment){
 const c=await root.connect();try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");for(const part of fragment){if(!tables.includes(part.table))throw Error('RESTORE_TABLE_REJECTED');for(const row of part.rows){if(!(await c.query("SELECT 1 FROM tenants WHERE tenant_id=$1 AND corp_id LIKE 'synthetic-personas-%'",[row['tenant_id']])).rowCount)throw Error('RESTORE_SYNTHETIC_TENANT_REQUIRED');const columns=Object.keys(row);if(columns.some(k=>!/^[a-z_]+$/.test(k)))throw Error('RESTORE_COLUMN_REJECTED');await c.query(`INSERT INTO ${part.table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT(tenant_id,id) DO UPDATE SET ${columns.filter(k=>!['tenant_id','id'].includes(k)).map(k=>k+'=excluded.'+k).join(',')}`,Object.values(row));}}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
