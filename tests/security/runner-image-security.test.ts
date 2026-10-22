import {readFileSync} from 'node:fs';
import {chmod, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeSocketParent} from '../../packages/dws/src/signed-service.js';
import {readSandboxBrokerAuthKey} from '../../packages/sandbox/src/service-auth.js';
import {configureCompanyCode} from '../../packages/company/src/configuration.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import type {Gateway} from '../../packages/gateway/src/index.js';

const read=(path:string)=>readFileSync(path,'utf8');
const repoFile=(path:string)=>read(join(process.cwd(),path));
const dockerfile=repoFile('deploy/images/dws-runner.Dockerfile');
const appDockerfile=repoFile('deploy/images/app.Dockerfile');
const executorSource=repoFile('packages/sandbox/src/executor.ts');
const fromLine=[...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match=>match[1]!);
const baseImagePattern=/^[^@\s]+@sha256:[a-f0-9]{64}$/;
const businessServices=['api','worker','ingress','notifier','scheduler','maintenance','dws-runner'] as const;
function composeServices(text:string):Record<string,string>{
 const lines=text.split(/\r?\n/),start=lines.findIndex(line=>line==='services:');
 if(start<0)throw Error('COMPOSE_SERVICES_BLOCK_MISSING');
 const services:Record<string,string>={};
 let current:string|undefined;
 for(const line of lines.slice(start+1)){
  if(/^\S/.test(line))break;
  const match=/^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
  if(match){current=match[1]!;services[current]='';continue;}
  if(current!==undefined)services[current]+=line+'\n';
 }
 return services;
}
const evidence=JSON.parse(repoFile('reports/dws-runner-security-20261022/result.json')) as {
 status:string;live:boolean;scope:string;
 catalogStatus:Record<string,string>;
 image:{reference:string;id:string;architecture:string;os:string};
 checks:Record<string,boolean>;
 source:{baseImagesPinned:boolean;buildContextExcludesEnvSecrets:boolean};
 cliProbe:{result:{binaryHash:string;uid:number;gid:number;businessCalls:number;authorizationCalls:number;live:boolean}};
 signedProbe:{result:{socketMode:string;socketParentMode:string;configFileMode:string;keyFileMode:string;tcpListeners:number;dockerSocket:boolean;secretPaths:boolean;appCodeOwner:string;appFilePermissions:string;argvSecretFree:boolean;logsSecretFree:boolean;cryptoEnvelope:string;capabilitySets:Record<string,string>;noNewPrivs:number;enterpriseCredentials:boolean;businessCliExecuted:boolean;live:boolean;network:string;readonlyRoot:boolean;privateTmpfs:boolean}};
};

it('T072 the Linux runner image is digest pinned, non-root and read-only, its secret material is 0700/0600 and encrypted, and no secret reaches argv or logs',async()=>{
 expect(fromLine).toHaveLength(2);
 for(const base of fromLine)expect(base).toMatch(baseImagePattern);
 expect(dockerfile).toMatch(/^USER 10001:10001$/m);
 expect(dockerfile).toContain('COPY --from=dws_release --chmod=0555 dws /usr/local/bin/dws');
 expect(dockerfile).toContain('COPY --from=dws_release --chmod=0444 LICENSE NOTICE prepared.json /usr/local/share/dws/');
 expect(dockerfile).toContain('-perm /022 -exec chmod go-w {} +');
 expect(dockerfile).toContain('-perm /6000 -exec chmod u-s,g-s {} +');
 expect(dockerfile).not.toMatch(/^EXPOSE\s/m);
 expect(dockerfile).not.toMatch(/^VOLUME\s/m);
 const ignore=repoFile('.dockerignore').split(/\r?\n/).filter(Boolean);
 for(const entry of ['.env','.env.*','.secrets'])expect(ignore).toContain(entry);

 const dir=await realpath(await mkdtemp(join(tmpdir(),'anthys-t072-')));
 try{
  await chmod(dir,0o755);
  await expect(safeSocketParent(join(dir,'dws.sock'))).rejects.toThrow('DWS_RPC_SOCKET_UNSAFE');
  await chmod(dir,0o700);
  await expect(safeSocketParent(join(dir,'dws.sock'))).resolves.toBeUndefined();

  const keyPath=join(dir,'broker.key');
  await writeFile(keyPath,'k'.repeat(48));
  await chmod(keyPath,0o660);
  await expect(readSandboxBrokerAuthKey(keyPath)).rejects.toThrow('SANDBOX_BROKER_AUTH_KEY_UNSAFE');
  await chmod(keyPath,0o600);
  await expect(readSandboxBrokerAuthKey(keyPath)).resolves.toHaveLength(48);

  const tokenPath=join(dir,'company.token');
  await writeFile(tokenPath,'t'.repeat(32));
  await chmod(tokenPath,0o644);
  const configPath=join(dir,'company.json');
  await writeFile(configPath,JSON.stringify({schemaVersion:1,connectorId:'synthetic-company',transport:'STREAMABLE_HTTP',server:{name:'synthetic',version:'1.0.0'},endpoint:'https://company.anthys.example/mcp',allowedOrigin:'https://company.anthys.example',contractHash:companyContractHash,reviewed:true,readOnlyReviewRef:'synthetic-read-only-review',actorResourceReviewRef:'synthetic-actor-review',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2}));
  await expect(configureCompanyCode({} as Gateway,{COMPANY_MCP_CONFIG_FILE:configPath})).rejects.toThrow('COMPANY_TOKEN_FILE_PERMISSIONS');
 }finally{await rm(dir,{recursive:true,force:true});}

 expect(evidence.status).toBe('PASS');
 expect(evidence.live).toBe(false);
 expect(evidence.source.baseImagesPinned).toBe(true);
 expect(evidence.source.buildContextExcludesEnvSecrets).toBe(true);
 expect(evidence.cliProbe.result.businessCalls).toBe(0);
 expect(evidence.cliProbe.result.authorizationCalls).toBe(0);
 expect(evidence.cliProbe.result.live).toBe(false);
 expect(evidence.signedProbe.result.socketMode).toBe('0600');
 expect(evidence.signedProbe.result.socketParentMode).toBe('0700');
 expect(evidence.signedProbe.result.configFileMode).toBe('0600');
 expect(evidence.signedProbe.result.keyFileMode).toBe('0600');
 expect(evidence.signedProbe.result.argvSecretFree).toBe(true);
 expect(evidence.signedProbe.result.logsSecretFree).toBe(true);
 expect(evidence.signedProbe.result.cryptoEnvelope).toBe('AES_256_GCM_AAD');
 expect(evidence.signedProbe.result.enterpriseCredentials).toBe(false);
 expect(evidence.signedProbe.result.businessCliExecuted).toBe(false);
 expect(evidence.signedProbe.result.live).toBe(false);
});

it('T123 every image runs as a pinned non-root user with no capabilities, and the Docker socket reaches only the isolated sandbox broker',async()=>{
 expect(appDockerfile).toMatch(/^USER 10001:10001$/m);
 expect(appDockerfile).not.toContain('/var/run/docker.sock');
 expect(appDockerfile).not.toMatch(/^COPY .*\.env/m);
 for(const base of [...appDockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match=>match[1]!))expect(base).toMatch(baseImagePattern);
 expect(dockerfile).not.toContain('/var/run/docker.sock');
 expect(executorSource).toContain("'--user','10001:10001'");
 expect(executorSource).toContain("'--cap-drop','ALL'");
 expect(executorSource).toContain("'--security-opt','no-new-privileges=true'");
 expect(executorSource).toContain("'--network','none'");
 expect(executorSource).toContain("'--read-only'");
 for(const file of ['deploy/compose/compose.prod.yml','deploy/compose/compose.dev.yml']){
  const services=composeServices(repoFile(file));
  const holders=Object.entries(services).filter(([,body])=>body.includes('/var/run/docker.sock')).map(([name])=>name);
  expect(holders).toEqual(['sandbox-broker']);
  for(const service of businessServices)expect(services[service]??'').not.toContain('/var/run/docker.sock');
 }
 expect(evidence.checks.nonRootUid10001).toBe(true);
 expect(evidence.checks.zeroCapabilities).toBe(true);
 expect(evidence.checks.noNewPrivileges).toBe(true);
 expect(evidence.checks.noDockerSocket).toBe(true);
 expect(evidence.checks.readOnlyRootfs).toBe(true);
 expect(evidence.checks.pinnedCli).toBe(true);
 expect(evidence.checks.boundedTmpfs).toBe(true);
 expect(evidence.signedProbe.result.dockerSocket).toBe(false);
 expect(evidence.signedProbe.result.tcpListeners).toBe(0);
 expect(evidence.signedProbe.result.noNewPrivs).toBe(1);
 for(const set of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])expect(evidence.signedProbe.result.capabilitySets[set]).toMatch(/^0+$/);
 expect(evidence.image.architecture).toBe('arm64');
 expect(evidence.image.os).toBe('linux');
 expect(evidence.catalogStatus['T072']).toBe('NOT_RUN');
 expect(evidence.catalogStatus['T123']).toBe('NOT_RUN');
});
