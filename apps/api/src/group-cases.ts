import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {GroupCases} from '../../../packages/groups/src/cases.js';
import {GroupCaseError} from '../../../packages/groups/src/case-model.js';
function cancellation(req:FastifyRequest,reply:FastifyReply){const controller=new AbortController();req.raw.once('aborted',()=>controller.abort());reply.raw.once('close',()=>{if(!reply.raw.writableEnded)controller.abort();});if(req.raw.aborted)controller.abort();return controller.signal;}
export function groupCaseRoutes(app:FastifyInstance,service?:Pick<GroupCases,'list'|'create'|'update'>){
 const enabled=()=>{if(!service)throw new GroupCaseError('GROUP_CASE_UNAVAILABLE',503);return service;};
 const group=(value:string)=>z.string().min(1).max(512).parse(value);
 app.get<{Params:{id:string}}>('/api/v1/groups/:id/cases',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().list(req.principal!,group(req.params.id),req.query,cancellation(req,reply))};});
 app.post<{Params:{id:string}}>('/api/v1/groups/:id/cases',async(req,reply)=>{reply.header('cache-control','private, no-store');return reply.code(201).send({data:await enabled().create(req.principal!,group(req.params.id),req.body,z.uuid().parse(req.headers['idempotency-key']),cancellation(req,reply))});});
 app.patch<{Params:{id:string;caseId:string}}>('/api/v1/groups/:id/cases/:caseId',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().update(req.principal!,group(req.params.id),req.params.caseId,req.body,z.uuid().parse(req.headers['idempotency-key']),cancellation(req,reply))};});
}
