import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {GroupContracts,GroupContractError} from '../../../packages/groups/src/contracts.js';
export function groupContractRoutes(app:FastifyInstance,service?:GroupContracts){
 const enabled=()=>{if(!service)throw new GroupContractError('GROUP_CONTRACT_UNAVAILABLE',503);return service;};
 app.get('/api/v1/group-contracts',async(req,reply)=>{reply.header('cache-control','private, no-store');const q=z.object({delegationId:z.uuid()}).strict().parse(req.query);return {data:await enabled().get(req.principal!,q.delegationId)};});
 app.post('/api/v1/group-contracts',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().put(req.principal!,req.body,z.uuid().parse(req.headers['idempotency-key']))};});
 app.post<{Params:{id:string}}>('/api/v1/group-contracts/:id/state',async(req,reply)=>{reply.header('cache-control','private, no-store');return {data:await enabled().transition(req.principal!,req.params.id,req.body,z.uuid().parse(req.headers['idempotency-key']))};});
}
