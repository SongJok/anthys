import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import type {TaskResultArtifacts} from '../../../packages/artifacts/src/service.js';
import {ArtifactAccessError,artifactCreateInput} from '../../../packages/artifacts/src/contracts.js';
/** Same authenticated session and CSRF hooks as the task API. */
export function artifactRoutes(app:FastifyInstance,service?:TaskResultArtifacts){
 const invoke=async(req:FastifyRequest,reply:FastifyReply,operation:(s:TaskResultArtifacts,signal:AbortSignal)=>Promise<unknown>)=>{
  reply.header('cache-control','private, no-store');if(!service)return reply.code(503).send({error:{code:'ARTIFACTS_UNCONFIGURED',correlationId:req.id}});
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!reply.raw.writableFinished)abort();};req.raw.once('aborted',abort);reply.raw.once('close',closed);
  try{return await operation(service,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));}
  catch(error){if(error instanceof ArtifactAccessError)return reply.code(error.status).send({error:{code:error.code,correlationId:req.id}});throw error;}
  finally{req.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);}
 };
 app.get<{Params:{id:string}}>('/api/v1/tasks/:id/artifacts',async(req,reply)=>{
  const id=z.uuid().parse(req.params.id).toLowerCase();return invoke(req,reply,async(s,signal)=>({data:await s.list(req.principal!,id,signal)}));
 });
 app.post<{Params:{id:string}}>('/api/v1/tasks/:id/artifacts',async(req,reply)=>{
  const id=z.uuid().parse(req.params.id).toLowerCase(),body=artifactCreateInput.parse(req.body),key=z.string().min(8).max(128).parse(req.headers['idempotency-key']);
  return invoke(req,reply,async(s,signal)=>{const data=await s.create(req.principal!,id,body,key,signal);reply.code(data.replayed?200:201);return {data};});
 });
 app.post<{Params:{id:string}}>('/api/v1/artifacts/:id/download-ticket',async(req,reply)=>{
  const id=z.uuid().parse(req.params.id).toLowerCase();z.object({}).strict().parse(req.body);
  return invoke(req,reply,async(s,signal)=>({data:await s.ticket(req.principal!,id,signal)}));
 });
 app.get<{Params:{id:string}}>('/api/v1/artifacts/:id/download',async(req,reply)=>{
  const id=z.uuid().parse(req.params.id).toLowerCase(),token=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.headers['x-artifact-download-ticket']);
  return invoke(req,reply,async(s,signal)=>{
   const file=await s.download(req.principal!,id,token,signal);reply.header('content-disposition',`attachment; filename="${file.metadata.fileName}"`);reply.header('content-security-policy',"default-src 'none'; sandbox");reply.header('x-content-type-options','nosniff');return reply.type(file.metadata.mime).send(file.bytes);
  });
 });
}
