import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {chmod,lstat,readdir,writeFile} from 'node:fs/promises';
import {createServer,request as httpRequest} from 'node:http';
import {signedDwsFixture} from '../support/signed-dws-fixture.js';
import {SignedDwsReadClient,postDwsSocket} from '../../packages/dws/src/signed-client.js';
import {responseSchema,openEnvelope,signEnvelope,rpcHash,rpcKey,requestSchema,challengeSchema} from '../../packages/dws/src/signed-protocol.js';
import {dwsCredentialCanary} from '../support/dws-cli.js';
import {SignedDwsReadService} from '../../packages/dws/src/signed-service.js';

async function readRaw(f:Awaited<ReturnType<typeof signedDwsFixture>>,body:unknown){return openEnvelope(await postDwsSocket(f.socketPath,'/v1/read',body,AbortSignal.timeout(10000)),'synthetic-runner',f.runner.publicKey,responseSchema);}
it('separate runner process verifies exact identity, returns projected self data and rotated state, and cleans private workspaces',async()=>{
 const f=await signedDwsFixture();try{await f.start();const before=f.cli.state(f.delegation.subject),verified=await f.client.verify({...f.delegation,capabilityBindingId:'dws.identity.verify.v1'},before,AbortSignal.timeout(10000)),result=await f.client.readSelf(f.delegation,verified.state,AbortSignal.timeout(10000));expect(verified.value).toEqual({verified:true});expect(result.value).toEqual({userId:'synthetic-user',name:'Fixture synthetic-user',dept:'测试部门',org:'测试企业'});expect(result.state).not.toEqual(before);expect(JSON.stringify(result.value)).not.toContain(dwsCredentialCanary);expect(JSON.stringify(result.value)).not.toContain('PRIVATE_PHONE');const events=await f.cli.events();expect(events.some(e=>e.phase==='VERIFY')).toBe(true);expect(events.filter(e=>e.phase==='READ')).toHaveLength(1);expect(events.every(e=>e.rootMode===0o700&&e.fileMode===0o600&&e.tokenMatches)).toBe(true);expect(await readdir(f.cli.workspace)).toEqual([]);expect((await lstat(f.socketPath)).mode&0o777).toBe(0o600);}finally{await f.close();}
});
it.each(['signature','key','unknown-field','argv','write','state-tamper'])('rejects %s without CLI execution',async kind=>{
 const f=await signedDwsFixture();try{await f.start();const {envelope,request}=await f.signedRequest();let body:unknown=envelope;
  if(kind==='signature')body={...envelope,signature:'A'.repeat(86)};
  if(kind==='key')body=signEnvelope(request,'synthetic-caller',generateKeyPairSync('ed25519').privateKey);
  if(kind==='unknown-field')body=signEnvelope({...request,endpoint:'https://undeclared.example.invalid'},'synthetic-caller',f.caller.privateKey);
  if(kind==='argv')body=signEnvelope({...request,argv:['api','--yes']},'synthetic-caller',f.caller.privateKey);
  if(kind==='write')body=signEnvelope({...request,operation:'SEND_MESSAGE'},'synthetic-caller',f.caller.privateKey);
  if(kind==='state-tamper')body={...envelope,payload:{...request,state:f.cli.state({...f.delegation.subject,userId:'foreign-user'})}};
  await expect(readRaw(f,body)).rejects.toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});expect(await f.cli.events()).toEqual([]);expect(await readdir(f.cli.workspace)).toEqual([]);
 }finally{await f.close();}
});
it.each(['tenant','corp','audience','capability','binding','policy','expired','future','overlong','state-path','identity'])('rejects signed %s mismatch before CLI execution',async kind=>{
 const f=await signedDwsFixture();try{await f.start();const {request}=await f.signedRequest();let code='DWS_RPC_SCOPE_MISMATCH';
  if(kind==='tenant')request.delegation.tenantId=randomUUID();if(kind==='corp')request.delegation.subject.corpId='foreign-corp';if(kind==='audience')request.delegation.audience.id=randomUUID();if(kind==='capability')request.delegation.capabilityBindingId='dws.identity.verify.v1';
  if(kind==='binding'){request.bindingHash='0'.repeat(64);code='DWS_RPC_BINDING_CHANGED';}if(kind==='policy'){request.policyHash='0'.repeat(64);code='DWS_RPC_BINDING_CHANGED';}
  if(kind==='expired'){request.issuedAt=Date.now()-2000;request.expiresAt=Date.now()-1;code='DWS_RPC_EXPIRED';}if(kind==='future'){request.issuedAt=Date.now()+10000;request.expiresAt=request.issuedAt+100;code='DWS_RPC_EXPIRED';}if(kind==='overlong'){request.expiresAt=request.issuedAt+10001;code='DWS_RPC_EXPIRED';}
  if(kind==='state-path'){request.state.files['../../escape']=Buffer.from('synthetic').toString('base64');code='DWS_RPC_STATE_INVALID';}if(kind==='identity'){request.state=f.cli.state({...f.delegation.subject,userId:'foreign-user'});code='DWS_RPC_STATE_INVALID';}
  const reply=await readRaw(f,signEnvelope(request,'synthetic-caller',f.caller.privateKey));expect(reply.result).toEqual({ok:false,code});expect(JSON.stringify(reply)).not.toContain(dwsCredentialCanary);expect(await f.cli.events()).toEqual([]);
 }finally{await f.close();}
});
it('concurrent duplicate requests execute once and the client does not retry a rejected execution',async()=>{
 const f=await signedDwsFixture();try{await f.start();const {envelope}=await f.signedRequest(),replies=await Promise.all([readRaw(f,envelope),readRaw(f,envelope)]);expect(replies.filter(r=>r.result.ok)).toHaveLength(1);expect(replies.filter(r=>!r.result.ok).map(r=>r.result)).toEqual([{ok:false,code:'DWS_RPC_REPLAY'}]);expect((await f.cli.events()).filter(e=>e.phase==='READ')).toHaveLength(1);await f.cli.mode('businessError');await expect(f.client.readSelf(f.delegation,f.cli.state(f.delegation.subject),AbortSignal.timeout(10000))).rejects.toMatchObject({code:'DWS_BUSINESS_DENIED'});expect((await f.cli.events()).filter(e=>e.phase==='READ')).toHaveLength(2);}finally{await f.close();}
});
it('restart changes the signed instance and rejects a captured old request without execution',async()=>{
 const f=await signedDwsFixture();try{const first=await f.start(),{envelope}=await f.signedRequest();await f.stop('SIGKILL');const second=await f.start();expect(second.instanceId).not.toBe(first.instanceId);expect((await readRaw(f,envelope)).result).toEqual({ok:false,code:'DWS_RPC_BINDING_CHANGED'});expect(await f.cli.events()).toEqual([]);expect((await f.client.readSelf(f.delegation,f.cli.state(f.delegation.subject),AbortSignal.timeout(10000))).value.userId).toBe('synthetic-user');}finally{await f.close();}
});
it('full replay storage fails closed without evicting a live nonce',async()=>{
 const f=await signedDwsFixture({maxReplayEntries:1});try{await f.start();const a=await f.signedRequest(),b=await f.signedRequest();expect((await readRaw(f,a.envelope)).result.ok).toBe(true);expect((await readRaw(f,b.envelope)).result).toEqual({ok:false,code:'DWS_RPC_BUSY'});expect((await readRaw(f,a.envelope)).result).toEqual({ok:false,code:'DWS_RPC_REPLAY'});expect((await f.cli.events()).filter(e=>e.phase==='READ')).toHaveLength(1);}finally{await f.close();}
});
it('a canceled in-flight request terminates its CLI descendant and cleans the workspace',async()=>{
 const f=await signedDwsFixture();try{await f.start();await f.cli.mode('hang');const controller=new AbortController(),result=f.client.readSelf(f.delegation,f.cli.state(f.delegation.subject),controller.signal).catch(e=>e);await vi.waitFor(async()=>expect((await f.cli.events()).some(e=>e.phase==='CHILD')).toBe(true),{timeout:5000});const event=(await f.cli.events()).find(e=>e.phase==='CHILD')!;controller.abort();expect(await result).toMatchObject({code:'DWS_PROCESS_TIMEOUT'});await vi.waitFor(async()=>expect(await readdir(f.cli.workspace)).toEqual([]),{timeout:5000});expect(()=>process.kill(event.child!,0)).toThrow();expect((await f.cli.events()).filter(e=>e.phase==='READ')).toHaveLength(1);}finally{await f.close();}
});
it('shutdown cancels an active CLI and waits for private workspace cleanup',async()=>{
 const f=await signedDwsFixture();try{await f.start();await f.cli.mode('hang');const pending=f.client.readSelf(f.delegation,f.cli.state(f.delegation.subject),AbortSignal.timeout(10000)).catch(e=>e);await vi.waitFor(async()=>expect((await f.cli.events()).some(e=>e.phase==='CHILD')).toBe(true),{timeout:5000});await f.stop();expect(await pending).toMatchObject({code:'DWS_RPC_TRANSPORT_FAILED'});expect(await readdir(f.cli.workspace)).toEqual([]);}finally{await f.close();}
});
it.each(['foreign-runner','bad-nonce','bad-binding','bad-response','bad-result','foreign-state','late'])('client rejects %s and never falls back to local execution',async kind=>{
 const f=await signedDwsFixture();let server:ReturnType<typeof createServer>|undefined;try{
  const key=kind==='foreign-runner'?generateKeyPairSync('ed25519').privateKey:f.runner.privateKey,instanceId=randomUUID();let readCount=0;
  server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const raw=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {nonce:string};let payload:unknown;
   if(req.url==='/v1/challenge'){payload={type:'CHALLENGE',protocol:'OA_DWS_READ_V1',nonce:kind==='bad-nonce'?randomUUID():raw.nonce,instanceId,bindingHash:kind==='bad-binding'?'0'.repeat(64):f.clientConfig.bindingHash,policyHash:f.clientConfig.policyHash,issuedAt:Date.now(),expiresAt:Date.now()+3000};}
   else{readCount++;const r=openEnvelope(raw,'synthetic-caller',f.caller.publicKey,requestSchema);if(kind==='late')await new Promise(resolve=>setTimeout(resolve,250));payload={type:'READ_RESPONSE',protocol:'OA_DWS_READ_V1',instanceId,requestId:kind==='bad-response'?randomUUID():r.requestId,requestHash:rpcHash(r),result:{ok:true,value:{userId:kind==='bad-result'?'foreign-user':'synthetic-user'},state:kind==='foreign-state'?f.cli.state({...r.delegation.subject,userId:'foreign-user'}):r.state}};}
   if(!res.destroyed){res.writeHead(200,{'content-type':'application/json','connection':'close'});res.end(JSON.stringify(signEnvelope(payload,'synthetic-runner',key)));}
  });await new Promise<void>(resolve=>server!.listen(f.socketPath,resolve));await chmod(f.socketPath,0o600);
  const client=kind==='late'?new SignedDwsReadClient({...f.clientConfig,timeoutMs:100}):f.client;
  await expect(client.readSelf(f.delegation,f.cli.state(f.delegation.subject),AbortSignal.timeout(5000))).rejects.toThrow();expect(readCount).toBe(['foreign-runner','bad-nonce','bad-binding'].includes(kind)?0:1);expect(await f.cli.events()).toEqual([]);
 }finally{server?.closeAllConnections();if(server)await new Promise<void>(r=>server!.close(()=>r()));await f.close();}
});
it.each(['inherited-secret','mutable-private-key','symlink-config','production-mode'])('entrypoint refuses %s before opening a socket or starting CLI',async kind=>{
 const f=await signedDwsFixture();try{
  if(kind==='mutable-private-key')await chmod(f.runnerFile,0o644);
  if(kind==='symlink-config'){const {symlink}=await import('node:fs/promises');await symlink(f.configFile,f.configFile+'.link');await writeFile(f.configFile,JSON.stringify({...f.config,runnerPrivateKeyFile:f.configFile+'.link'}),{mode:0o600});}
  if(kind==='production-mode')await writeFile(f.configFile,JSON.stringify({...f.config,mode:'PRODUCTION_OFFLINE'}),{mode:0o600});
  await expect(f.start(kind==='inherited-secret'?{GLM_API_KEY:'SYNTHETIC_FORBIDDEN_PARENT_SECRET'}:{})).rejects.toThrow();expect(await f.cli.events()).toEqual([]);expect(await lstat(f.socketPath).catch(()=>null)).toBeNull();expect(f.stderr()).not.toContain('SYNTHETIC_FORBIDDEN_PARENT_SECRET');
 }finally{await f.close();}
});
it('only Ed25519 keys and domain-bound signatures are accepted',()=>{const pair=generateKeyPairSync('ed25519'),payload={type:'READ_RESPONSE'},signed=signEnvelope(payload,'test',pair.privateKey);expect(()=>openEnvelope(signed,'other',pair.publicKey,responseSchema)).toThrow('DWS_RPC_SIGNATURE_INVALID');expect(()=>openEnvelope(signed,'test',pair.publicKey,challengeSchema)).toThrow('DWS_RPC_SIGNATURE_INVALID');const rsa=generateKeyPairSync('rsa',{modulusLength:2048});expect(()=>rpcKey(String(rsa.publicKey.export({type:'spki',format:'pem'})),'public')).toThrow('DWS_RPC_KEY_INVALID');expect(()=>rpcKey('synthetic-not-a-key','private')).toThrow('DWS_RPC_KEY_INVALID');expect(rpcKey(String(pair.publicKey.export({type:'spki',format:'pem'})),'public').asymmetricKeyType).toBe('ed25519');});
it('wall-clock freeze and rollback cannot revive a consumed nonce or purge it early',async()=>{
 const f=await signedDwsFixture(),service=new SignedDwsReadService(f.cli.runner,{tenantId:f.delegation.tenantId,corpId:f.delegation.subject.corpId,policyHash:f.clientConfig.policyHash,callerKeyId:'synthetic-caller',callerPublicKey:f.caller.publicKey,runnerKeyId:'synthetic-runner',runnerPrivateKey:f.runner.privateKey,maxRequestMs:100,maxConcurrent:1,maxReplayEntries:1});
 const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now);try{await service.listen(f.socketPath);const request={...(await f.signedRequest()).request,expiresAt:now+100,state:{schemaVersion:1 as const,files:{}}},signed=signEnvelope(request,'synthetic-caller',f.caller.privateKey);expect((await readRaw(f,signed)).result).toEqual({ok:false,code:'DWS_RPC_STATE_INVALID'});
  await new Promise(resolve=>setTimeout(resolve,150));clock.mockReturnValue(now+10);expect((await readRaw(f,signed)).result).toEqual({ok:false,code:'DWS_RPC_REPLAY'});const next={...request,requestId:randomUUID(),issuedAt:now+10,expiresAt:now+100};expect((await readRaw(f,signEnvelope(next,'synthetic-caller',f.caller.privateKey))).result).toEqual({ok:false,code:'DWS_RPC_BUSY'});
  clock.mockReturnValue(now+101);const fresh={...request,requestId:randomUUID(),issuedAt:now+101,expiresAt:now+201};expect((await readRaw(f,signEnvelope(fresh,'synthetic-caller',f.caller.privateKey))).result).toEqual({ok:false,code:'DWS_RPC_STATE_INVALID'});
  clock.mockReturnValue(now+10);expect((await readRaw(f,signed)).result).toEqual({ok:false,code:'DWS_RPC_EXPIRED'});expect(await f.cli.events()).toEqual([]);
 }finally{clock.mockRestore();await service.close();await f.close();}
});
it('test guard still rejects personal sockets, undeclared TCP and a nonprivate synthetic socket',async()=>{
 expect(()=>httpRequest({socketPath:'/var/run/docker.sock',path:'/v1/read'})).toThrow('TEST_NETWORK_UNDECLARED_DESTINATION');expect(()=>httpRequest('https://undeclared.example.invalid')).toThrow('TEST_NETWORK_UNDECLARED_DESTINATION');
 const f=await signedDwsFixture();try{await f.start();await chmod(f.socketPath,0o666);expect(()=>httpRequest({socketPath:f.socketPath,path:'/v1/read'})).toThrow('TEST_NETWORK_UNDECLARED_DESTINATION');await expect(postDwsSocket(f.socketPath,'/v1/challenge',{protocol:'OA_DWS_READ_V1',nonce:randomUUID()},AbortSignal.timeout(1000))).rejects.toMatchObject({code:'DWS_RPC_SOCKET_UNSAFE'});expect(await f.cli.events()).toEqual([]);}finally{await f.close();}
});
