import './isolation.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type pg from 'pg';
import {config} from '../../packages/config/src/index.js';
import type {Database,DbContext} from '../../packages/storage/src/database.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {ControlPlane} from '../../packages/gateway/src/control-plane.js';
import type {CertifiedReadBacks} from '../../packages/gateway/src/reconciliation.js';
import {createServer} from '../../apps/api/src/server.js';

// Only identity/role provisioning uses the migration account. Approval itself
// traverses the authenticated HTTP API, CSRF checks and one-time decision.
export async function approvalFixture(admin:pg.Pool,appDb:Database,store:RuntimeStore,owner:DbContext,actionId:string,chosenApprover?:string,readBacks?:CertifiedReadBacks){
 const approverId=chosenApprover??randomUUID(),roleId=randomUUID(),authorityId=randomUUID();
 await admin.query("INSERT INTO users(tenant_id,id,external_user_id,display_name,status) VALUES($1,$2,$2::uuid::text,'synthetic qualified reviewer','ACTIVE') ON CONFLICT(tenant_id,id) DO NOTHING",[owner.tenantId,approverId]);
 const action=(await admin.query('SELECT capability_id,resource_id,run_id FROM tool_actions WHERE tenant_id=$1 AND id=$2',[owner.tenantId,actionId])).rows[0];
 await admin.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'ACTION_APPROVER') ON CONFLICT(tenant_id,name) DO NOTHING",[owner.tenantId,roleId]);
 await admin.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,(SELECT id FROM roles WHERE tenant_id=$1 AND name='ACTION_APPROVER'),$3,'RESOURCE',$4) ON CONFLICT DO NOTHING",[owner.tenantId,authorityId,approverId,action.resource_id]);
 const key=randomBytes(32).toString('hex'),cfg=config({APP_ENV:'test'}),{app,sessions}=await createServer({config:cfg,db:appDb,sessionSecret:key,controls:new ControlPlane(store,key,readBacks)}),requester=await sessions.create(owner),reviewer=await sessions.create({tenantId:owner.tenantId,actorId:approverId});
 const headers=(s:typeof requester)=>({cookie:`oa_session=${s.cookie}`,origin:cfg.APP_ORIGIN,'x-csrf-token':s.csrf});
 const request=()=>app.inject({method:'POST',url:`/api/v1/actions/${actionId}/approvals`,headers:headers(requester),payload:{approverId}});
 const preview=(id:string)=>app.inject({method:'GET',url:`/api/v1/approvals/${id}`,headers:headers(reviewer)});
 const decide=(id:string,data:{nonce:string;argsHash:string;version:number},decision:'APPROVE'|'REJECT'='APPROVE')=>app.inject({method:'POST',url:`/api/v1/approvals/${id}/decision`,headers:headers(reviewer),payload:{nonce:data.nonce,argsHash:data.argsHash,version:data.version,decision}});
 return {app,sessions,owner,approverId,authorityId,requester,reviewer,headers,request,preview,decide,action};
}
export async function approveViaApi(admin:pg.Pool,appDb:Database,store:RuntimeStore,owner:DbContext,actionId:string,approverId?:string){
 const f=await approvalFixture(admin,appDb,store,owner,actionId,approverId);
 try{const request=await f.request();expect(request.statusCode,request.body).toBe(200);const id=request.json().data.id as string,preview=await f.preview(id);expect(preview.statusCode,preview.body).toBe(200);const decision=await f.decide(id,preview.json().data);expect(decision.statusCode,decision.body).toBe(200);expect(decision.json().data.executionState).toBe('APPROVED_NOT_EXECUTED');const lease=await store.acquire(owner,f.action.run_id as string,randomUUID());expect(lease).not.toBeNull();return lease!;}finally{await f.app.close();}
}
