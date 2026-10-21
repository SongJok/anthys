import {GroupCases} from '../../packages/groups/src/cases.js';
import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {secret} from '../../packages/config/src/index.js';
import {groupRuntimeFixture} from './group-runtime.js';
import {GroupContracts} from '../../packages/groups/src/contracts.js';
import type {GroupContract} from '../../packages/groups/src/contract-model.js';
import {groupDelegationFingerprint} from '../../packages/config/src/group-contract-delegation.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
export async function groupCaseWorld(root:pg.Pool,db:Database,appDb:Database,vault:Vault,currency:'CNY'|'USD'='CNY',options:{administratorIsOwner?:boolean;tenantId?:string}={}){
 const f=await groupRuntimeFixture(root,db,vault,options.tenantId?{tenantId:options.tenantId}:{}),roleId=randomUUID(),bindingId=randomUUID(),admin={tenantId:f.ctx.tenantId,actorId:options.administratorIsOwner?f.ctx.actorId:f.otherId};
 await root.query("INSERT INTO roles(tenant_id,id,name) VALUES($1,$2,'GROUP_ADMIN')",[admin.tenantId,roleId]);
 await root.query("INSERT INTO role_bindings(tenant_id,id,role_id,subject_id,scope_kind,scope_id) VALUES($1,$2,$3,$4,'GROUP',$5)",[admin.tenantId,bindingId,roleId,admin.actorId,f.conversationId]);
 await root.query('UPDATE group_directory_bindings SET user_auth_epoch=(SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2) WHERE tenant_id=$1 AND user_id=$2',[admin.tenantId,admin.actorId]);
 if(options.administratorIsOwner){await f.dws.enroll(f.ctx,f.fixture.state({corpId:f.corpId,userId:f.ownerExternal}),await f.dws.beginEnrollment(f.ctx),new AbortController().signal);await root.query('UPDATE dws_identities SET model_egress_allowed=true WHERE tenant_id=$1 AND owner_id=$2',[f.ctx.tenantId,f.ctx.actorId]);}
 const a=(await root.query('SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[admin.tenantId,admin.actorId])).rows[0],u=(await root.query('SELECT auth_epoch FROM users WHERE tenant_id=$1 AND id=$2',[admin.tenantId,f.ctx.actorId])).rows[0],i=(await root.query('SELECT id,authorization_version FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[admin.tenantId,f.ctx.actorId])).rows[0];
 const profile=groupDelegationFingerprint({schemaVersion:1,approved:true,id:randomUUID(),tenantId:admin.tenantId,groupId:f.conversationId,administratorId:admin.actorId,serviceOwnerId:f.ctx.actorId,serviceIdentityId:i.id,scopeId:f.scopeId,roleBindingId:bindingId,administratorAuthEpoch:Number(a.auth_epoch),serviceOwnerAuthEpoch:Number(u.auth_epoch),roleVersion:1,serviceAuthorizationVersion:Number(i.authorization_version),scopeVersion:1,validUntil:new Date(Date.now()+1800000).toISOString(),currency,maxAmountMinor:1000,reviewReference:'SYNTHETIC_INDEPENDENT_DELEGATION_REVIEW',sourceReviewHash:hash('SYNTHETIC_OPERATOR_REVIEW_NOT_PLATFORM_OWNER_CLAIM'),administratorDirectoryHash:(await root.query('SELECT public.oa_group_contract_directory_hash($1,$2,$3) value',[admin.tenantId,f.scopeId,admin.actorId])).rows[0].value});
 const sessions=new Sessions(appDb,secret('SESSION_SECRET')!),session=await sessions.create(admin),principal=(await sessions.authenticate(session.cookie))!,service=new GroupContracts(db,vault);
 const document:GroupContract={schemaVersion:1,id:randomUUID(),tenantId:admin.tenantId,groupId:f.conversationId,version:1,serviceIdentityId:i.id,administratorAuthorization:{actorId:admin.actorId,evidenceRef:profile.document.reviewReference},responsibilityScope:['Answer explicit group mentions'],sources:{mode:'MENTION_ONLY',entries:[{kind:'MENTION',resourceRef:'synthetic-current-mentions'},{kind:'CARD',resourceRef:'authenticated-group-case-card'}]},actions:{allowed:['question.answer','case.read','case.create','case.update'],prohibited:[]},workHours:{timezone:'Asia/Shanghai',windows:[{daysOfWeek:[1,2,3,4,5],start:'09:00',end:'18:00'}]},mentionUserIds:[],escalationUserIds:[],allowMentionAll:false,validFrom:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),state:'ACTIVE',stateUpdatedAt:new Date().toISOString(),budget:{currency,maxAmountMinor:1000},revocation:{method:'Authenticated reviewed administrator stop'}};
 const approve=()=>root.query('SELECT public.oa_group_contract_delegate($1,$2,$3) value',[profile.serialized,profile.hash,profile.document.reviewReference]);
 const save=(key=randomUUID())=>service.put(principal,{delegationId:profile.document.id,expectedVersion:0,document},key);
 const roster=new GroupCaseRoster(f.dws,'robot-1'),cases=new GroupCases(db,vault,'robot-1',roster),close=f.close;f.close=async()=>{await cases.close();await close();};
 return {f,cases,admin,principal,service,session,profile,document,approve,save};
}
