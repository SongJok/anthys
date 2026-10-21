import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
const subjectSchema=z.object({corpId:z.string().min(1),userId:z.string().min(1),unionId:z.string().optional(),openDingTalkId:z.string().optional()}).strict();
export class Directory {
 constructor(private db:Database,private tenants:ReadonlyMap<string,string>) {}
 // Only call with the result of a verified provider exchange, never a request body.
 async resolveVerifiedSubject(subject:z.infer<typeof subjectSchema>):Promise<DbContext|null> {
  const s=subjectSchema.parse(subject),tenantId=this.tenants.get(s.corpId);if(!tenantId) return null;
  return this.db.scope({tenantId,actorId:'00000000-0000-4000-8000-000000000000'},async c=>{
   const q=await c.query("SELECT u.id,u.union_id,u.open_dingtalk_id FROM users u JOIN tenants t ON t.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.external_user_id=$2 AND u.status='ACTIVE' AND t.status='ACTIVE' AND t.corp_id=$3",[tenantId,s.userId,s.corpId]);
   if(!q.rowCount) return null;const row=q.rows[0];
   if(s.unionId&&row.union_id&&row.union_id!==s.unionId||s.openDingTalkId&&row.open_dingtalk_id&&row.open_dingtalk_id!==s.openDingTalkId) throw Error('IDENTITY_ALIAS_MISMATCH');
   return {tenantId,actorId:row.id as string};
  });
 }
 async search(ctx:DbContext,displayName:string):Promise<{status:'EMPTY'|'UNIQUE'|'AMBIGUOUS';candidates:{id:string;displayName:string;externalUserId:string}[]}> {
  const candidates=await this.db.scope(ctx,async c=>{const q=await c.query("SELECT id,display_name,external_user_id FROM users WHERE display_name=$1 AND status='ACTIVE' ORDER BY id LIMIT 21",[displayName]);return q.rows.map(r=>({id:r.id as string,displayName:r.display_name as string,externalUserId:r.external_user_id as string}));});
  return {status:candidates.length===0?'EMPTY':candidates.length===1?'UNIQUE':'AMBIGUOUS',candidates};
 }
}
