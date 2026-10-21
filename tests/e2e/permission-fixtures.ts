import {syntheticResultContract} from '../support/capability-result-contract.js';
import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type pg from 'pg';
import {z} from 'zod';
import {Gateway,canonical} from '../../packages/gateway/src/index.js';
import {installPermissionManifest} from '../../packages/gateway/src/permissions.js';
import {hash} from '../../packages/storage/src/crypto.js';

// Actual metadata and RLS on the isolated test cluster; no provider credential
// or remote authority is fabricated. A diagnostic must never call execute.
export async function browserPermissions(root:pg.Pool,gateway:Gateway,tenantId:string){
 const records:Record<string,{actorId:string;grantId:string;roleBinding:string;capabilityId:string}>={};
 for(const project of ['desktop','mobile']){
  const actorId=randomUUID(),capabilityId='synthetic.permission.browser.'+project,grantId=randomUUID(),roleBinding=randomUUID(),resourceId='synthetic-private-resource-'+project;
  const bindingHash=hash('synthetic-permission-browser-v1:'+project),jsonSchema={type:'object',properties:{},additionalProperties:false};
  await root.query("UPDATE users SET union_id=NULL,status='DEPARTED',auth_epoch=auth_epoch+1 WHERE tenant_id=$1 AND union_id=$2",[tenantId,'synthetic-permission-'+project+'-union']);
  await root.query("INSERT INTO users(tenant_id,id,external_user_id,union_id,display_name,status) VALUES($1,$2,$3,$4,'synthetic permission owner','ACTIVE')",[tenantId,actorId,'synthetic-permission-'+actorId,'synthetic-permission-'+project+'-union']);
  await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'GROUP_MEMBER') ON CONFLICT(tenant_id,name) DO NOTHING",[tenantId,randomUUID()]);
  await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='GROUP_MEMBER'),$3,'GROUP','synthetic-permission-group')",[tenantId,roleBinding,actorId]);
  await root.query("INSERT INTO capability_bindings(tenant_id,id,logical_id,semantic_version,provider_binding,schema_hash,risk,state) VALUES($1,$2,$3,'1.0.0',$4,$5,'READ','READY') ON CONFLICT(tenant_id,logical_id,semantic_version) DO UPDATE SET schema_hash=excluded.schema_hash,state='READY'",[tenantId,randomUUID(),capabilityId,JSON.stringify({credential:'SYNTHETIC_PERMISSION_BROWSER_CREDENTIAL'}),bindingHash]);
  await root.query("INSERT INTO resource_grants(tenant_id,id,actor_id,capability_id,resource_id,audience_kind,audience_id,classification_ceiling,expires_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_USER',$3::uuid::text,'INTERNAL',clock_timestamp()+interval '1 hour')",[tenantId,grantId,actorId,capabilityId,resourceId]);
  const c=await root.connect();try{await c.query('BEGIN');await installPermissionManifest(c,tenantId,{schemaVersion:'1.0',capabilityId,capabilityVersion:'1.0.0',manifestVersion:1,bindingHash,inputSchemaHash:hash(canonical(jsonSchema)),description:'合成资源使用条件',provider:'MCP',risk:'READ',authMode:'SERVICE',applicationRef:'synthetic-browser',requiredScopes:['Synthetic.Read'],resourcePreconditions:['exact_owner_resource'],officialDocRefs:['S12'],reviewReference:'SYNTHETIC_ONLY_NOT_LIVE'});await c.query('COMMIT');}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  gateway.register({...syntheticResultContract,id:capabilityId,version:'1.0.0',description:'Synthetic permission metadata',provider:'MCP',risk:'READ',state:'READY',bindingHash,jsonSchema,schema:z.object({}).strict(),resource:()=>resourceId,execute:async()=>{throw Error('PERMISSION_DIAGNOSTIC_MUST_NOT_EXECUTE');}});
  records[project]={actorId,grantId,roleBinding,capabilityId};
 }
 await writeFile('.data/test-environment/browser-permission-fixtures.json',JSON.stringify(records),{mode:0o600});
}
