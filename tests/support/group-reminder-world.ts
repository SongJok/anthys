import type {GroupContract} from '../../packages/groups/src/contract-model.js';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {Database} from '../../packages/storage/src/database.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {groupReminderAuthorizationFingerprint} from '../../packages/config/src/group-reminder-authorization.js';
import {GroupCaseRoster} from '../../packages/groups/src/case-roster.js';
import {GroupReminders} from '../../packages/groups/src/reminders.js';
import {groupCaseWorld} from './group-cases.js';
/** Explicit reviewed synthetic installation, never a real authorization source. */
export async function groupReminderWorld(root:pg.Pool,db:Database,appDb:Database,vault:Vault,options:{workHours?:GroupContract['workHours'];escalation?:boolean}={}){
 const w=await groupCaseWorld(root,db,appDb,vault);w.document.actions.allowed.push('case.remind');if(options.escalation){w.document.actions.allowed.push('case.escalate');w.document.escalationUserIds=[w.f.ctx.actorId];}if(options.workHours)w.document.workHours=options.workHours;await w.approve();await w.save();
 const i=(await root.query('SELECT id,auth_epoch,authorization_version FROM dws_identities WHERE tenant_id=$1 AND owner_id=$2',[w.f.ctx.tenantId,w.f.ctx.actorId])).rows[0],contract=(await root.query('SELECT document_hash FROM group_contracts WHERE tenant_id=$1 AND id=$2',[w.f.ctx.tenantId,w.document.id])).rows[0];
 const grant=groupReminderAuthorizationFingerprint({schemaVersion:1,approved:true,purpose:'SCHEDULED_CONTRACT',id:randomUUID(),tenantId:w.f.ctx.tenantId,groupId:w.f.conversationId,contractId:w.document.id,contractVersion:1,contractHash:contract.document_hash,delegationId:w.profile.document.id,serviceOwnerId:w.f.ctx.actorId,serviceIdentityId:i.id,scopeId:w.f.scopeId,ownerAuthEpoch:Number(i.auth_epoch),serviceAuthorizationVersion:Number(i.authorization_version),scopeVersion:1,validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),limits:{remindersPerCasePerDay:2,summariesPerGroupPerHour:6},reviewReference:'SYNTHETIC_SCHEDULED_CONTRACT_REVIEW',sourceReviewHash:hash('synthetic operator approval only'),allowMentionAll:false,allowDirectMessages:false,allowEscalation:false});
 await root.query('SELECT public.oa_group_reminder_authorize($1,$2,$3)',[grant.serialized,grant.hash,grant.document.reviewReference]);const reminders=new GroupReminders(db,vault,new GroupCaseRoster(w.f.dws,'robot-1')),close=w.f.close;w.f.close=async()=>{await reminders.close();await close();};return {...w,grant,reminders};
}
