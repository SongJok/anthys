import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {Personas,PersonaError} from '../../../packages/personas/src/service.js';
import {scopeSchema,personaTemplates,requestKey,type PersonaScope} from '../../../packages/personas/src/schema.js';
export function personaRoutes(app:FastifyInstance,service:Personas|undefined){
 const ready=()=>{if(!service)throw new PersonaError('PERSONAS_UNCONFIGURED',503);return service;},session=(req:FastifyRequest)=>({sessionId:req.principal!.sessionId,authEpoch:req.principal!.authEpoch});
 const route=(path:string,target:(req:FastifyRequest)=>PersonaScope)=>{
  app.get(path,async(req,reply)=>{reply.header('cache-control','private, no-store');const view=await ready().get(req.principal!,scopeSchema.parse(target(req)),session(req));reply.header('etag',view.selected.etag);return {data:view};});
  app.patch(path,async(req,reply)=>{reply.header('cache-control','private, no-store');const key=requestKey.parse(req.headers['idempotency-key']),saved=await ready().patch(req.principal!,scopeSchema.parse(target(req)),req.body,req.headers['if-match'],key,session(req));reply.header('etag',saved.etag);return {data:saved};});
  app.get(path+'/history',async(req,reply)=>{reply.header('cache-control','private, no-store');const query=z.object({cursor:z.uuid().optional()}).strict().parse(req.query);return {data:await ready().history(req.principal!,scopeSchema.parse(target(req)),session(req),query.cursor)};});
 };
 route('/api/v1/me/persona',req=>({kind:'USER',id:req.principal!.actorId}));
 route('/api/v1/personas/global',req=>({kind:'GLOBAL',id:req.principal!.tenantId}));
 route('/api/v1/groups/:groupId/persona',req=>({kind:'GROUP',id:z.string().parse((req.params as {groupId:unknown}).groupId)}));
 app.delete('/api/v1/me/persona',async(req,reply)=>{reply.header('cache-control','private, no-store');z.object({}).strict().parse(req.body??{});return {data:await ready().erasePrivate(req.principal!,requestKey.parse(req.headers['idempotency-key']),session(req))};});
 app.get('/api/v1/persona-scopes',async(req,reply)=>{reply.header('cache-control','private, no-store');const query=z.object({cursor:z.string().min(1).max(512).optional()}).strict().parse(req.query);return {data:await ready().scopes(req.principal!,session(req),query.cursor)};});
 app.get('/api/v1/persona-templates',async(_req,reply)=>{reply.header('cache-control','private, no-store');return {data:{version:1,templates:personaTemplates}};});
}
