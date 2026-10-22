import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {DataTemplateError,type DataTemplateAdministration} from '../../../packages/company/src/data-template-administration.js';
export function dataTemplateRoutes(app:FastifyInstance,administration?:DataTemplateAdministration){
 const service=()=>{if(!administration)throw new DataTemplateError('DATA_TEMPLATES_UNCONFIGURED',503);return administration;};
 app.get('/api/v1/data/templates',async(req,reply)=>{reply.header('cache-control','private, no-store');z.object({}).strict().parse(req.query);return {data:await service().list(req.principal!)};});
 app.post('/api/v1/data/templates/publish',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await service().publish(req.principal!,req.body,z.uuid().parse(req.headers['idempotency-key']))};});
 app.post('/api/v1/data/templates/rollback',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await service().rollback(req.principal!,req.body,z.uuid().parse(req.headers['idempotency-key']))};});
}
