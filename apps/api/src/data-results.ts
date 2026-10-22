import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {DataResultsError,type CertifiedDataResultReader} from '../../../packages/company/src/data-results.js';
export function dataResultRoutes(app:FastifyInstance,reader?:CertifiedDataResultReader){
 const service=()=>{if(!reader)throw new DataResultsError('DATA_RESULTS_UNCONFIGURED',503);return reader;};
 app.get('/api/v1/data/results',async(req,reply)=>{reply.header('cache-control','private, no-store');const query=z.object({taskId:z.uuid().optional()}).strict().parse(req.query);return {data:await service().list(req.principal!,query.taskId)};});
 app.get('/api/v1/data/catalog',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await service().catalog(req.principal!)};});
}
