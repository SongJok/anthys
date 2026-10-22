import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Offline image-security evidence for the DWS runner. This does not execute a
// business CLI, connect to an enterprise service, or mark T072/T123 as PASS.
const image=process.argv[2];if(process.argv.length!==3||!image||!/^[-a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)||image.startsWith('-'))throw Error('USAGE: verify-dws-image IMAGE');
const docker=(args,timeout=60000)=>execFileSync('docker',args,{encoding:'utf8',timeout,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
const digest=value=>createHash('sha256').update(value).digest('hex');
const dockerfile=readFileSync('deploy/images/dws-runner.Dockerfile','utf8'),baseImages=[...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match=>match[1]);
if(baseImages.length!==2||baseImages.some(value=>!/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(value)))throw Error('DWS_IMAGE_BASE_NOT_PINNED');
if(!/^USER 10001:10001$/m.test(dockerfile))throw Error('DWS_IMAGE_USER_NOT_PINNED');
if(!/COPY --from=dws_release --chmod=0555 dws \/usr\/local\/bin\/dws/.test(dockerfile)||!/COPY --from=dws_release --chmod=0444 LICENSE NOTICE prepared\.json/.test(dockerfile))throw Error('DWS_IMAGE_RELEASE_COPY_INVALID');
const ignore=readFileSync('.dockerignore','utf8').split(/\r?\n/).filter(Boolean);
for(const entry of ['.git','node_modules','dist','.env','.env.*','.secrets','reports'])if(!ignore.includes(entry))throw Error('DWS_IMAGE_BUILD_CONTEXT_SECRET_RISK');
const metadata=JSON.parse(docker(['image','inspect',image]))[0];
if(metadata.Os!=='linux'||!['arm64','amd64'].includes(metadata.Architecture))throw Error('DWS_IMAGE_PLATFORM_INVALID');
if(metadata.Config.User!=='10001:10001')throw Error('DWS_IMAGE_RUNTIME_USER_INVALID');
if(JSON.stringify(metadata.Config.Entrypoint)!==JSON.stringify(['node','scripts/start-dws-runner.mjs']))throw Error('DWS_IMAGE_ENTRYPOINT_INVALID');
if(metadata.Config.Cmd!==null&&metadata.Config.Cmd!==undefined)throw Error('DWS_IMAGE_DEFAULT_COMMAND_INVALID');
if(Object.keys(metadata.Config.ExposedPorts??{}).length||Object.keys(metadata.Config.Volumes??{}).length)throw Error('DWS_IMAGE_PORT_OR_VOLUME_DECLARED');
const allowedEnv=new Set(['PATH','NODE_VERSION','YARN_VERSION','LANG']),secretEnv=/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DINGTALK|GLM|DWS_|MCP_)/i;
for(const entry of metadata.Config.Env??[]){const name=entry.slice(0,entry.indexOf('='));if(!allowedEnv.has(name)||secretEnv.test(entry))throw Error('DWS_IMAGE_ENV_SECRET_RISK');}
if(/^sha256:[a-f0-9]{64}$/.test(image)&&metadata.Id!==image)throw Error('DWS_IMAGE_DIGEST_MISMATCH');
const securityArgs=['--pull=never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','512m','--cpus','1','--tmpfs','/run/dws:rw,noexec,nosuid,nodev,size=32m,mode=700,uid=10001,gid=10001'];
function runProbe(script,label){
 const args=['create',...securityArgs,'--entrypoint','node',image,script];let id;
 try{
  id=docker(args).trim();if(!/^[a-f0-9]{64}$/.test(id))throw Error(`${label}_CONTAINER_ID_INVALID`);
  const state=JSON.parse(docker(['inspect',id]))[0],tmpfs=state.HostConfig.Tmpfs?.['/run/dws']??'';
  if(state.Image!==metadata.Id||state.Config.User!=='10001:10001'||state.HostConfig.NetworkMode!=='none'||!state.HostConfig.ReadonlyRootfs||state.HostConfig.Privileged||state.HostConfig.Binds?.length||state.HostConfig.CapAdd?.length||!state.HostConfig.CapDrop?.includes('ALL')||!state.HostConfig.SecurityOpt?.includes('no-new-privileges:true')||state.HostConfig.PidsLimit!==64||state.HostConfig.Memory!==536870912||state.HostConfig.NanoCpus!==1000000000||(state.Mounts??[]).some(mount=>mount.Type!=='tmpfs'||mount.Destination!=='/run/dws')||!['',null,undefined].includes(state.Config.ExposedPorts)&&Object.keys(state.Config.ExposedPorts).length)throw Error(`${label}_ISOLATION_INVALID`);
  if(!['rw',''].includes(tmpfs.split(',')[0])||!['noexec','nosuid','nodev','size=32m','mode=700','uid=10001','gid=10001'].every(option=>tmpfs.split(',').includes(option)))throw Error(`${label}_TMPFS_INVALID`);
  const output=docker(['start','--attach',id],90000),result=JSON.parse(output),finished=JSON.parse(docker(['inspect',id]))[0];
  if(finished.State.Running||finished.State.ExitCode!==0)throw Error(`${label}_PROBE_FAILED`);
  const containerId=id;docker(['rm','--force',id]);id=undefined;
  return {result,container:{id:containerId,createCommand:['docker',...args],startCommand:['docker','start','--attach',containerId],networkMode:'none',readOnlyRootfs:true,user:state.Config.User,tmpfs,tmpfsOptions:tmpfs.split(','),exitCode:finished.State.ExitCode,removedAfterProbe:true}};
 }finally{if(id&&/^[a-f0-9]{64}$/.test(id))docker(['rm','--force',id]);}
}
const cli=runProbe('scripts/probe-dws-offline.mjs','DWS_CLI'),signed=runProbe('scripts/probe-dws-signed-offline.mjs','DWS_SIGNED');
if(cli.result.kind!=='OFFLINE_CLI'||cli.result.status!=='PASS'||cli.result.live!==false||cli.result.uid!==10001||cli.result.gid!==10001||cli.result.businessCalls!==0||cli.result.authorizationCalls!==0||cli.result.applicationStarted!==false||cli.result.deployed!==false)throw Error('DWS_CLI_PROBE_INVALID');
if(!Array.isArray(cli.result.commands)||cli.result.commands.some(command=>command.executable!=='/usr/local/bin/dws'||command.exitCode!==0||['auth','contact','chat','todo','calendar','mail'].includes(command.args?.[0])))throw Error('DWS_CLI_PROBE_COMMAND_INVALID');
if(signed.result.status!=='PASS'||signed.result.scope!=='LINUX_OFFLINE_SIGNED_PROTOCOL_AND_IMAGE_SECURITY'||signed.result.live!==false||signed.result.uid!==10001||signed.result.network!=='none'||signed.result.readonlyRoot!==true||signed.result.privateTmpfs!==true||signed.result.challengeSignatureVerified!==true||signed.result.invalidCredentialStateRejectedBeforeCli!==true||signed.result.replayRejected!==true||signed.result.enterpriseCredentials!==false||signed.result.businessCliExecuted!==false)throw Error('DWS_SIGNED_PROBE_INVALID');
if(signed.result.socketMode!=='0600'||signed.result.socketParentMode!=='0700'||signed.result.configFileMode!=='0600'||signed.result.keyFileMode!=='0600'||signed.result.tcpListeners!==0||signed.result.dockerSocket!==false||signed.result.secretPaths!==false||signed.result.appCodeOwner!=='root'||signed.result.appFilePermissions!=='NO_GROUP_WORLD_WRITE_NO_SETUID'||signed.result.argvSecretFree!==true||signed.result.logsSecretFree!==true||signed.result.cryptoEnvelope!=='AES_256_GCM_AAD')throw Error('DWS_SIGNED_PROBE_SECURITY_INVALID');
for(const capability of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])if(!/^0+$/.test(signed.result.capabilitySets?.[capability]??''))throw Error('DWS_SIGNED_PROBE_CAPABILITY_INVALID');
if(signed.result.noNewPrivs!==1||signed.result.binarySha256!==cli.result.binaryHash)throw Error('DWS_SIGNED_PROBE_BINARY_OR_PRIVILEGE_INVALID');
const lock=JSON.parse(readFileSync('config/dws/lock.json','utf8'));
if(lock.platforms?.[signed.result.platform]?.binarySha256!==signed.result.binarySha256)throw Error('DWS_PROBE_LOCK_MISMATCH');
const sourceCommit=(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}})();
console.log(JSON.stringify({status:'PASS',scope:'DWS_RUNNER_IMAGE_SECURITY_EVIDENCE_ONLY',catalogStatus:{T072:'NOT_RUN',T123:'NOT_RUN'},live:false,source:{commit:sourceCommit,dockerfileSha256:digest(dockerfile),baseImagesPinned:true,buildContextExcludesEnvSecrets:true},image:{reference:image,id:metadata.Id,architecture:metadata.Architecture,os:metadata.Os,repoDigests:metadata.RepoDigests??[]},checks:{pinnedCli:true,rootOwnedReadOnlyCode:true,noGroupWorldWriteOrSetuid:true,nonRootUid10001:true,zeroCapabilities:true,noNewPrivileges:true,noDockerSocket:true,noEnterpriseSecretPaths:true,noTcpListener:true,unixSocket0600:true,socketParent0700:true,configAndKeyFiles0600:true,noSecretArgvOrLogs:true,aes256GcmAadEnvelope:true,boundedTmpfs:true,readOnlyRootfs:true},cliProbe:cli,signedProbe:signed},null,2));
