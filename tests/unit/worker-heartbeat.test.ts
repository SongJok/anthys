import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkerHeartbeat,isWorkerHeartbeatFresh,writeWorkerHeartbeat,workerHeartbeatMaxAgeMs,workerHeartbeatMinIntervalMs} from '../../packages/runtime/src/worker-heartbeat.js';

it('a written heartbeat reads back as fresh and turns stale exactly at the maximum age',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{
  const path=join(dir,'heartbeat');
  await writeWorkerHeartbeat(path,1_000);
  expect(await readFile(path,'utf8')).toBe('1000');
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,1_000+workerHeartbeatMaxAgeMs)).toBe(true);
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,1_000+workerHeartbeatMaxAgeMs+1)).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('a missing heartbeat is never fresh',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{expect(isWorkerHeartbeatFresh(join(dir,'absent'),workerHeartbeatMaxAgeMs,Date.now())).toBe(false);}finally{await rm(dir,{recursive:true,force:true});}
});
it('the recorded timestamp decides freshness even when the file was just rewritten',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{
  const path=join(dir,'heartbeat');
  await writeWorkerHeartbeat(path,1_000);
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,Date.now())).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('an unreadable heartbeat payload is never fresh',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{
  const path=join(dir,'heartbeat');
  await writeFile(path,'not-a-timestamp');
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,Date.now())).toBe(false);
  await writeFile(path,'');
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,Date.now())).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('the throttled writer records one write per interval and resumes afterwards',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{
  const path=join(dir,'heartbeat'),heartbeat=createWorkerHeartbeat(path,workerHeartbeatMinIntervalMs);
  expect(await heartbeat.write(10_000)).toBe(true);
  expect(await heartbeat.write(10_000+workerHeartbeatMinIntervalMs-1)).toBe(false);
  expect(await readFile(path,'utf8')).toBe('10000');
  expect(await heartbeat.write(10_000+workerHeartbeatMinIntervalMs)).toBe(true);
  expect(await readFile(path,'utf8')).toBe(String(10_000+workerHeartbeatMinIntervalMs));
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('a heartbeat write to an unusable path surfaces the failure instead of reporting liveness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'anthys-heartbeat-'));
 try{
  const path=join(dir,'nested','heartbeat');
  await expect(writeWorkerHeartbeat(path)).rejects.toThrow();
  expect(isWorkerHeartbeatFresh(path,workerHeartbeatMaxAgeMs,Date.now())).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
