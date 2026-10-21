import {execFileSync} from 'node:child_process';

// Creates a disposable probe container only; no project files/profiles or host environment are mounted.
const image=process.argv[2];if(process.argv.length!==3||!image||!/^[-a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)||image.startsWith('-'))throw Error('USAGE: verify-dws-image IMAGE');
const docker=(args,timeout=30000)=>execFileSync('docker',args,{encoding:'utf8',timeout,maxBuffer:524288,stdio:['ignore','pipe','pipe']});
const createArgs=['create','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','512m','--cpus','1','--tmpfs','/run/dws:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001','--entrypoint','node',image,'/app/scripts/probe-dws-offline.mjs'];
let container;
try{
 container=docker(createArgs).trim();if(!/^[a-f0-9]{64}$/.test(container))throw Error('DWS_OFFLINE_CONTAINER_ID_INVALID');
 const state=JSON.parse(docker(['inspect',container]))[0];
 if(state.HostConfig.NetworkMode!=='none'||!state.HostConfig.ReadonlyRootfs||state.Config.User!=='10001:10001'||state.HostConfig.Binds?.length||state.Mounts?.some(mount=>mount.Type!=='tmpfs'))throw Error('DWS_OFFLINE_CONTAINER_ISOLATION_INVALID');
 const output=docker(['start','--attach',container],45000),result=JSON.parse(output);
 const finished=JSON.parse(docker(['inspect',container]))[0];if(finished.State.Running||finished.State.ExitCode!==0||result.kind!=='OFFLINE_CLI'||result.status!=='PASS'||result.live!==false)throw Error('DWS_OFFLINE_CONTAINER_PROBE_FAILED');
 const containerId=container;docker(['rm','--force',container]);container=undefined;
 console.log(JSON.stringify({...result,image:{reference:image,id:state.Image},container:{id:containerId,createCommand:['docker',...createArgs],startCommand:['docker','start','--attach',containerId],networkMode:state.HostConfig.NetworkMode,readOnlyRootfs:state.HostConfig.ReadonlyRootfs,user:state.Config.User,tmpfs:state.HostConfig.Tmpfs,exitCode:finished.State.ExitCode,removedAfterProbe:true}},null,2));
}finally{if(container&&/^[a-f0-9]{64}$/.test(container))docker(['rm','--force',container]);}
