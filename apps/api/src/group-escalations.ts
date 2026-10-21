import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {GroupEscalationAdapter} from '../../../packages/groups/src/escalation-adapter.js';
import {groupEscalationIntentSchema} from '../../../packages/groups/src/escalation-contracts.js';
import {GroupCaseError} from '../../../packages/groups/src/case-model.js';
function cancellation(req:FastifyRequest,reply:FastifyReply){const c=new AbortController();req.raw.once('aborted',()=>c.abort());reply.raw.once('close',()=>{if(!reply.raw.writableEnded)c.abort();});if(req.raw.aborted)c.abort();return AbortSignal.any([c.signal,AbortSignal.timeout(12000)]);}
export type GroupEscalationApi=Pick<GroupEscalationAdapter,'prepare'|'read'|'enqueue'|'cancel'>;
export function groupEscalationRoutes(app:FastifyInstance,service?:GroupEscalationApi){
 const enabled=()=>{if(!service)throw new GroupCaseError('GROUP_ESCALATION_UNAVAILABLE',503);return service;},group=z.string().min(1).max(512),ref=z.object({previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 app.post<{Params:{id:string}}>('/api/v1/groups/:id/case-escalations/preview',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().prepare({principal:req.principal!,groupId:group.parse(req.params.id),signal:cancellation(req,reply)},groupEscalationIntentSchema.parse(req.body),z.uuid().parse(req.headers['idempotency-key']))};});
 app.get<{Params:{id:string;proposalId:string}}>('/api/v1/groups/:id/case-escalations/:proposalId',async(req,reply)=>{reply.header('cache-control','private, no-store');z.object({}).strict().parse(req.query);return {data:await enabled().read({principal:req.principal!,groupId:group.parse(req.params.id),signal:cancellation(req,reply)},z.uuid().parse(req.params.proposalId))};});
 for(const [path,operation]of [['confirm','enqueue'],['cancel','cancel']] as const)app.post<{Params:{id:string;proposalId:string}}>('/api/v1/groups/:id/case-escalations/:proposalId/'+path,async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled()[operation]({principal:req.principal!,groupId:group.parse(req.params.id),signal:cancellation(req,reply)},{proposalId:z.uuid().parse(req.params.proposalId),previewHash:ref.parse(req.body).previewHash},z.uuid().parse(req.headers['idempotency-key']))};});
}
