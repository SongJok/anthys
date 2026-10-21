import {z} from 'zod';
import type {Database,DbContext} from '../../storage/src/database.js';
const receipt=z.object({expired:z.number().int().min(0).max(128),counters:z.number().int().min(0).max(1),more:z.boolean(),skipped:z.boolean()}).strict();
export class PermissionCacheMaintenance{
 constructor(private readonly db:Database){}
 async maintain(scope:DbContext,limit=128){
  const bound=z.number().int().min(1).max(128).parse(limit);
  return this.db.scope(scope,async c=>{
   await c.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)");
   const result=receipt.parse((await c.query('SELECT public.oa_permission_cache_maintain($1) value',[bound])).rows[0].value);
   if(result.expired>bound||result.skipped&&(result.expired!==0||result.counters!==0))throw Error('PERMISSION_MAINTENANCE_RECEIPT_INVALID');
   return result;
  });
 }
}
