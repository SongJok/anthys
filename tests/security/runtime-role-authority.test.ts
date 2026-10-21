import '../support/isolation.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {secret} from '../../packages/config/src/index.js';
const root=new pg.Pool({connectionString:secret('MIGRATION_DATABASE_URL')!}),runtime=new pg.Pool({connectionString:secret('RUNTIME_DATABASE_URL')!}),tenant=randomUUID(),actor=randomUUID(),member=randomUUID(),security=randomUUID(),binding=randomUUID();
beforeAll(async()=>{await root.query("INSERT INTO tenants(tenant_id,id,corp_id,name,status) VALUES($1,$1,$2,'synthetic role authority','ACTIVE')",[tenant,'synthetic-'+tenant]);await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,'synthetic-owner','synthetic owner','ACTIVE')",[tenant,actor]);await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'GROUP_MEMBER'),($1,$3,'SECURITY_OPERATOR')",[tenant,member,security]);await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'GROUP','synthetic-group')",[tenant,binding,member,actor]);});
afterAll(async()=>{await root.end();await runtime.end();});
async function transaction(work:(c:pg.PoolClient)=>Promise<void>){const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)",[tenant,actor]);await work(c);}finally{await c.query('ROLLBACK');c.release();}}
it.each(['define-role','self-assign','replace-binding','delete-binding'])('runtime cannot %s through direct database writes',async kind=>transaction(async c=>{
 const operation=kind==='define-role'?c.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'UNREVIEWED_ADMIN')",[tenant,randomUUID()]):kind==='self-assign'?c.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'TENANT',$1::uuid::text)",[tenant,randomUUID(),security,actor]):kind==='replace-binding'?c.query('UPDATE role_bindings SET role_id=$1 WHERE id=$2',[security,binding]):c.query('DELETE FROM role_bindings WHERE id=$1',[binding]);await expect(operation).rejects.toMatchObject({code:'42501'});
}));
it('runtime retains only current-context role reads',async()=>transaction(async c=>{expect((await c.query('SELECT id FROM role_bindings WHERE subject_id=$1',[actor])).rows).toEqual([{id:binding}]);}));
