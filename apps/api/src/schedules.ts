import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {Schedules} from '../../../packages/schedules/src/service.js';
import {ScheduleError} from '../../../packages/schedules/src/model.js';
function signal(req:FastifyRequest,reply:FastifyReply){const c=new AbortController();req.raw.once('aborted',()=>c.abort());reply.raw.once('close',()=>{if(!reply.raw.writableEnded)c.abort();});if(req.raw.aborted)c.abort();return c.signal;}
export function scheduleRoutes(app:FastifyInstance,service?:Schedules){
 const ready=()=>{if(!service)throw new ScheduleError('SCHEDULE_UNAVAILABLE',503);return service;};
 const key=(r:FastifyRequest)=>z.uuid().parse(r.headers['idempotency-key']),etag=(r:FastifyRequest)=>z.string().min(1).max(200).parse(r.headers['if-match']);
 app.get('/api/v1/schedules',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().list(req.principal!,req.query,signal(req,reply))};});
 app.post('/api/v1/schedules/preview',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().preview(req.principal!,req.body,signal(req,reply))};});
 app.post('/api/v1/schedules',async(req,reply)=>{reply.header('cache-control','private, no-store');return reply.code(201).send({data:await ready().create(req.principal!,req.body,key(req),signal(req,reply))});});
 app.get<{Params:{id:string}}>('/api/v1/schedules/:id',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().get(req.principal!,req.params.id,signal(req,reply))};});
 app.patch<{Params:{id:string}}>('/api/v1/schedules/:id',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().mutate(req.principal!,req.params.id,'EDIT',req.body,etag(req),key(req),signal(req,reply))};});
 app.post<{Params:{id:string}}>('/api/v1/schedules/:id/cancel',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().cancel(req.principal!,req.params.id,req.body??{},etag(req),key(req),signal(req,reply))};});
 for(const operation of ['pause','resume'] as const)app.post<{Params:{id:string}}>(`/api/v1/schedules/:id/${operation}`,async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await ready().mutate(req.principal!,req.params.id,operation.toUpperCase() as 'PAUSE'|'RESUME',req.body??{},etag(req),key(req),signal(req,reply))};});
}
