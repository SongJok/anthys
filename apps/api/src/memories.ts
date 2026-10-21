import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {PrivatePreferences,MemoryError} from '../../../packages/memory/src/service.js';
import {memoryRequestKey,memoryIfMatch} from '../../../packages/memory/src/schema.js';
export function memoryRoutes(app:FastifyInstance,service:PrivatePreferences|undefined){
 const ready=()=>{if(!service)throw new MemoryError('MEMORY_UNCONFIGURED',503);return service;},session=(req:FastifyRequest)=>({sessionId:req.principal!.sessionId,authEpoch:req.principal!.authEpoch}),id=(req:FastifyRequest)=>z.uuid().parse((req.params as {id:unknown}).id).toLowerCase(),key=(req:FastifyRequest)=>memoryRequestKey.parse(req.headers['idempotency-key']);
 app.get('/api/v1/me/memories',async(req,reply)=>{reply.header('cache-control','private, no-store');const active=ready(),result=await active.search(req.principal!,req.query,session(req));return {data:{...result,retention:{defaultDays:active.policy.defaultDays,maximumDays:active.policy.maximumDays,backupRetentionDays:active.policy.backupRetentionDays,backupReviewReference:active.policy.backupReviewReference}}};});
 app.post('/api/v1/me/memories',async(req,reply)=>{reply.header('cache-control','private, no-store');const receipt=await ready().save(req.principal!,req.body,key(req),session(req));if(receipt.etag)reply.header('etag',receipt.etag);return {data:receipt};});
 app.patch('/api/v1/me/memories/:id',async(req,reply)=>{reply.header('cache-control','private, no-store');const receipt=await ready().save(req.principal!,req.body,key(req),session(req),{id:id(req),etag:memoryIfMatch.parse(req.headers['if-match'])});if(receipt.etag)reply.header('etag',receipt.etag);return {data:receipt};});
 app.delete('/api/v1/me/memories/:id',async(req,reply)=>{reply.header('cache-control','private, no-store');z.object({}).strict().parse(req.body??{});return {data:await ready().forget(req.principal!,id(req),key(req),session(req))};});
}
