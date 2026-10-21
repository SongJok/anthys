import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import type {Lease} from '../../runtime/src/store.js';
export type Authority={id:string;version:number;authEpoch:number;expiresAt:string|null};
export async function actionAuthority(c:pg.PoolClient,subject:string,role:string,actionId:string):Promise<Authority|null>{const q=await c.query('SELECT public.oa_control_action_authority($1,$2,$3) value',[subject,role,actionId]);const a=q.rows[0].value as {id:string;version:number|string;authEpoch:number|string;expiresAt:string|null}|null;return a?{...a,version:Number(a.version),authEpoch:Number(a.authEpoch)}:null;}
export async function killed(c:pg.PoolClient,ctx:DbContext,lease:Pick<Lease,'taskId'|'audience'>,connector:string,write:boolean,operationAudience?:Record<string,unknown>):Promise<boolean>{
 const groups=[lease.audience,operationAudience].filter(a=>a?.['kind']==='GROUP').map(a=>a!['targetId']);const q=await c.query("SELECT id FROM kill_switches WHERE enabled AND (expires_at IS NULL OR expires_at>now()) AND (mode='ALL' OR $1) AND (scope_kind='TENANT' AND scope_id=$2 OR scope_kind='USER' AND scope_id=$3 OR scope_kind='TASK' AND scope_id=$4 OR scope_kind='CONNECTOR' AND scope_id=$5 OR scope_kind='GROUP' AND scope_id=ANY($6::text[])) LIMIT 1",[write,ctx.tenantId,ctx.actorId,lease.taskId,connector,groups]);return !!q.rowCount;
}
