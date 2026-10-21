import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {GroupReminders} from '../../../packages/groups/src/reminders.js';
import {GroupReminderError} from '../../../packages/groups/src/reminder-model.js';
function cancellation(req:FastifyRequest,reply:FastifyReply){const c=new AbortController();req.raw.once('aborted',()=>c.abort());reply.raw.once('close',()=>{if(!reply.raw.writableEnded)c.abort();});if(req.raw.aborted)c.abort();return c.signal;}
export function groupReminderRoutes(app:FastifyInstance,service?:Pick<GroupReminders,'list'|'preview'|'create'|'mutate'>){
 const enabled=()=>{if(!service)throw new GroupReminderError('GROUP_REMINDER_UNAVAILABLE',503);return service;},group=(v:string)=>z.string().min(1).max(512).parse(v);
 app.get<{Params:{id:string}}>('/api/v1/groups/:id/reminder-schedules',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().list(req.principal!,group(req.params.id),req.query,cancellation(req,reply))};});
 app.post<{Params:{id:string}}>('/api/v1/groups/:id/reminder-schedules/preview',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().preview(req.principal!,group(req.params.id),req.body,cancellation(req,reply))};});
 app.post<{Params:{id:string}}>('/api/v1/groups/:id/reminder-schedules',async(req,reply)=>{reply.header('cache-control','private, no-store');return reply.code(201).send({data:await enabled().create(req.principal!,group(req.params.id),req.body,z.uuid().parse(req.headers['idempotency-key']),cancellation(req,reply))});});
 app.patch<{Params:{id:string;scheduleId:string}}>('/api/v1/groups/:id/reminder-schedules/:scheduleId',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().mutate(req.principal!,group(req.params.id),z.uuid().parse(req.params.scheduleId),'EDIT',req.body,z.uuid().parse(req.headers['idempotency-key']),cancellation(req,reply))};});
 for(const [path,operation]of [['pause','PAUSE'],['resume','RESUME'],['cancel','CANCEL']] as const)app.post<{Params:{id:string;scheduleId:string}}>('/api/v1/groups/:id/reminder-schedules/:scheduleId/'+path,async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().mutate(req.principal!,group(req.params.id),z.uuid().parse(req.params.scheduleId),operation,req.body,z.uuid().parse(req.headers['idempotency-key']),cancellation(req,reply))};});
}
