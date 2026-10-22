import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {ConditionWatchStore} from '../../../packages/watches/src/store.js';
import type {CompanyMcpWatchObserver,WatchSourceMetric} from '../../../packages/company/src/watch-observer.js';
export type WatchApi=Pick<ConditionWatchStore,'create'|'list'|'get'|'pause'|'resume'|'cancel'>;
export type WatchSourceBindingApi=Pick<CompanyMcpWatchObserver,'bind'>;
const sourceBody=z.object({scopeId:z.uuid(),metric:z.enum(['attempts','successes','successRate']),windowSeconds:z.number().int().min(60).max(2678400)}).strict();
const idOf=z.uuid();
function unavailable(reply:FastifyReply){
 return reply.code(503).send({error:{code:'WATCH_UNAVAILABLE',message:'条件监控尚未配置',correlationId:reply.request.id}});
}
function sourceFailure(error:unknown,reply:FastifyReply){
 const code=error instanceof Error?error.message:'WATCH_SOURCE_INVALID';
 if(code==='WATCH_SOURCE_ALREADY_BOUND')return reply.code(409).send({error:{code,correlationId:reply.request.id}});
 if(code.startsWith('WATCH_SOURCE_'))return reply.code(400).send({error:{code,correlationId:reply.request.id}});
 throw error;
}
export function watchRoutes(app:FastifyInstance,service?:WatchApi,sources?:WatchSourceBindingApi){
 app.get('/api/v1/watches',async(req,reply)=>{
  reply.header('cache-control','private, no-store');if(!service)return unavailable(reply);
  const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
  return {data:await service.list(req.principal!,query.limit)};
 });
 app.post('/api/v1/watches',async(req,reply)=>{
  reply.header('cache-control','private, no-store');if(!service)return unavailable(reply);
  return reply.code(201).send({data:await service.create(req.principal!,req.body)});
 });
 app.get<{Params:{id:string}}>('/api/v1/watches/:id',async(req,reply)=>{
  reply.header('cache-control','private, no-store');if(!service)return unavailable(reply);
  const watch=await service.get(req.principal!,idOf.parse(req.params.id));
  return watch?{data:watch}:reply.code(404).send({error:{code:'WATCH_NOT_FOUND',correlationId:req.id}});
 });
 for(const operation of ['pause','resume','cancel'] as const)app.post<{Params:{id:string}}>(`/api/v1/watches/:id/${operation}`,async(req,reply)=>{
  reply.header('cache-control','private, no-store');if(!service)return unavailable(reply);
  z.object({}).strict().parse(req.body??{});
  const result=await service[operation](req.principal!,idOf.parse(req.params.id));
  return result.found?{data:result}:reply.code(404).send({error:{code:'WATCH_NOT_FOUND',correlationId:req.id}});
 });
 app.post<{Params:{id:string}}>('/api/v1/watches/:id/source',async(req,reply)=>{
  reply.header('cache-control','private, no-store');if(!sources)return unavailable(reply);
  const body=sourceBody.parse(req.body);
  try{await sources.bind(req.principal!,{watchId:idOf.parse(req.params.id),scopeId:body.scopeId,metric:body.metric as WatchSourceMetric,windowSeconds:body.windowSeconds});}
  catch(error){return sourceFailure(error,reply);}
  return {data:{bound:true}};
 });
}
