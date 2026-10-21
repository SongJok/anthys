import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {CompanyAgentRequests} from '../../../packages/company/src/agent-requests.js';
/** Authenticated local metadata only. Polling never opens an MCP connection. */
export function companyAgentRoutes(app:FastifyInstance,requests?:Pick<CompanyAgentRequests,'list'>){
 app.get<{Params:{id:string}}>('/api/v1/tasks/:id/enterprise-requests',async(req,reply)=>{
  reply.header('cache-control','private, no-store');const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);
  if(!requests)return reply.code(503).send({error:{code:'ENTERPRISE_REQUESTS_UNCONFIGURED',correlationId:req.id}});
  const data=await requests.list(req.principal!,id);if(!data)return reply.code(404).send({error:{code:'NOT_FOUND',correlationId:req.id}});return {data};
 });
}
