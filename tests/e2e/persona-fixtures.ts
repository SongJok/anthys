import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type pg from 'pg';
export async function browserPersonas(root:pg.Pool,tenantId:string){
 const records:Record<string,{actorId:string;groupId:string;groupGrant:string}>={};
 for(const project of ['desktop','mobile','privacy-desktop','privacy-mobile','scope-desktop','scope-mobile']){
  const external='synthetic-persona-browser-'+project+'-'+randomUUID(),union='synthetic-persona-browser-'+project+'-union';
  // Each server run owns fresh synthetic revisions. Prior records remain intact.
  await root.query("UPDATE users SET union_id=NULL,status='DEPARTED',auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND union_id=$2",[tenantId,union]);
  const actorId=randomUUID();await root.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status,union_id) VALUES($1,$2,$3,$3,'ACTIVE',$4)",[tenantId,actorId,external,union]);
  const groupId='synthetic-persona-browser-group-'+project+'-'+randomUUID(),role=(await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'GROUP_ADMIN') ON CONFLICT(tenant_id,name) DO UPDATE SET name=excluded.name RETURNING id",[tenantId,randomUUID()])).rows[0].id as string,groupGrant=randomUUID();await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'GROUP',$5)",[tenantId,groupGrant,role,actorId,groupId]);records[project]={actorId,groupId,groupGrant};
 }
 await writeFile('.data/test-environment/browser-persona-fixtures.json',JSON.stringify(records),{mode:0o600});
}
