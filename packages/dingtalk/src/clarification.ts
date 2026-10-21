import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {DbContext} from '../../storage/src/database.js';
import type {RuntimeStore} from '../../runtime/src/store.js';
import {clarificationRefusal} from './clarification-receipt.js';
import type {Vault} from '../../storage/src/crypto.js';
import type {Audience} from '../../tasks/src/store.js';
export function clarificationCommand(text:string):{code:string;text:string}|{taskId:string;code:string;text:string}|{invalid:true}|null{
 if(/^继续任务(?:\s|[:：])/u.test(text.trim())){
  const match=/^继续任务\s+([^\s:：]+)\s+([a-f0-9]{8})\s*[:：]\s*([\s\S]+)$/iu.exec(text.trim()),id=z.uuid().safeParse(match?.[1]);
  return match&&id.success&&match[3]!.trim().length>0&&match[3]!.length<=10000?{taskId:id.data.toLowerCase(),code:match[2]!.toLowerCase(),text:match[3]!}:{invalid:true};
 }
 if(!/^补充(?:\s|[:：])/u.test(text.trim()))return null;
 const match=/^补充\s+([a-f0-9]{8})\s*[:：]\s*([\s\S]+)$/iu.exec(text.trim());return match&&match[2]!.trim().length>0&&match[2]!.length<=10000?{code:match[1]!.toLowerCase(),text:match[2]!}:{invalid:true};
}
export async function acceptClarification(c:pg.PoolClient,ctx:DbContext,store:RuntimeStore,input:{command:NonNullable<ReturnType<typeof clarificationCommand>>;eventId:string;conversationId:string;isPrivate:boolean;audience:Audience;bound?:{taskId:string;runId:string}},vault:Vault):Promise<string|null>{
 let outcome='NOT_FOUND',taskId:string|null=null,reviewId:string|null=null,rowsChoiceId:string|null=null;
 if(!input.isPrivate&&(!store.groupAudiences||'taskId' in input.command))outcome='GROUP_DENIED';else if('invalid' in input.command)outcome='INVALID';else{
  const targetTaskId='taskId' in input.command?input.command.taskId:null;
  const rows=(await c.query("SELECT r.task_id,coalesce(n.id,q.id) id,CASE WHEN q.id IS NOT NULL THEN 'SOURCE' ELSE 'NARRATIVE' END kind FROM runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id LEFT JOIN run_narrative_reviews n ON n.tenant_id=r.tenant_id AND n.id=r.clarification_review_id AND n.verdict='CLARIFICATION' AND n.answered_at IS NULL AND n.expires_at>clock_timestamp() LEFT JOIN run_source_choices q ON q.tenant_id=r.tenant_id AND q.id=r.source_choice_id AND q.answered_at IS NULL AND q.expires_at>clock_timestamp() WHERE public.oa_lifecycle_run_allowed(r.id) AND t.conversation_id=$1 AND t.requester_id=$2 AND r.status='WAITING_USER' AND r.last_error IN ('CLARIFICATION_REQUESTED','SOURCE_CHOICE_REQUIRED') AND substring(replace(coalesce(n.id,q.id)::text,'-',''),1,8)=$3 AND ($4::uuid IS NULL OR t.id=$4) AND t.cancel_requested_at IS NULL AND t.status='ACTIVE' AND t.expires_at>clock_timestamp() ORDER BY r.created_at,r.id LIMIT 2",[input.conversationId,ctx.actorId,input.command.code,targetTaskId])).rows;
  if(rows.length>1)outcome='AMBIGUOUS';else if(rows.length===1){const candidate=rows[0]!;let resumed;try{resumed=await store.replyInTransaction(c,ctx,candidate.task_id as string,candidate.id as string,input.command.text,'dingtalk:'+input.eventId,{eventId:input.eventId,conversationId:input.conversationId});}catch(error){if(error instanceof Error&&['SOURCE_CHOICE_INVALID_SELECTION','SOURCE_CHOICE_REPLY_IN_PROGRESS','GROUP_REPLY_IN_PROGRESS'].includes(error.message)){outcome='INVALID';}else throw error;}if(resumed){outcome='status' in resumed?(input.isPrivate?'PENDING_SOURCE_CHECK':'PENDING_GROUP_CHECK'):'RESUMED';if(candidate.kind==='SOURCE')rowsChoiceId=candidate.id as string;taskId=resumed.taskId;reviewId=candidate.kind==='NARRATIVE'?candidate.id as string:null;}else if(outcome!=='INVALID')outcome='CLOSED';}
 }
 if(!['RESUMED','PENDING_SOURCE_CHECK','PENDING_GROUP_CHECK'].includes(outcome))taskId=await clarificationRefusal(c,ctx,vault,{eventId:input.eventId,conversationId:input.conversationId,audience:input.audience,outcome,...(input.bound?{bound:input.bound}:{})});
 // A refusal is a deterministic control response with zero model budget and
 // no RUN queue entry; it explicitly says that continuation did not occur.
 await c.query('INSERT INTO dingtalk_clarification_replies(tenant_id,id,owner_id,event_id,task_id,review_id,outcome,source_choice_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,randomUUID(),ctx.actorId,input.eventId,taskId,reviewId,outcome,outcome==='PENDING_SOURCE_CHECK'?rowsChoiceId:null]);await c.query("UPDATE event_inbox SET state='PROCESSED' WHERE id=$1",[input.eventId]);return taskId;
}
