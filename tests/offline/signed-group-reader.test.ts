import assert from 'node:assert/strict';
import {after,mock,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {lstat,readdir} from 'node:fs/promises';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import type {DwsGroupDelegation,DwsGroupScope} from '../../packages/dws/src/signed-protocol.js';

assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
assert.equal(process.env['APP_ENV'],'test');assert.equal(process.env['OA_TEST_ISOLATED'],'true');
const sockets=new Set<string>(),binaries=new Map<string,string>(),denied:string[]=[];
function deny(surface:string):never{denied.push(surface);throw Error('OFFLINE_IO_DENIED');}
function socketAllowed(path:unknown,exists:boolean){
 if(typeof path!=='string'||!sockets.has(path))return false;
 try{const dir=lstatSync(dirname(path));if(!dir.isDirectory()||dir.isSymbolicLink()||realpathSync(dirname(path))!==dirname(path)||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())return false;
 return !exists||(lstatSync(path).isSocket()&&(lstatSync(path).mode&0o077)===0);}catch{return false;}
}
function pathOf(args:unknown[]):unknown{let first=args[0];if(Array.isArray(first))first=first[0];return typeof first==='string'?first:first&&typeof first==='object'?Reflect.get(first,'path'):undefined;}
const connect=net.Socket.prototype.connect;
mock.method(net.Socket.prototype,'connect',function(this:net.Socket,...args:unknown[]){if(!socketAllowed(pathOf(args),true))deny('net.connect');return Reflect.apply(connect,this,args);});
const listen=net.Server.prototype.listen;
mock.method(net.Server.prototype,'listen',function(this:net.Server,...args:unknown[]){if(!socketAllowed(pathOf(args),false))deny('net.listen');return Reflect.apply(listen,this,args);});
for(const module of [http,https])for(const key of ['request','get'] as const){const original=module[key];mock.method(module,key,(...args:unknown[])=>{const options=args[0];if(module!==http||!options||typeof options!=='object'||!socketAllowed(Reflect.get(options,'socketPath'),true)||!['/v1/challenge','/v1/read'].includes(String(Reflect.get(options,'path'))))deny('http');return Reflect.apply(original,module,args);});}
mock.method(tls,'connect',()=>deny('tls'));mock.method(globalThis,'fetch',()=>deny('fetch'));mock.method(dgram,'createSocket',()=>deny('dgram'));
for(const key of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse'] as const){mock.method(dns,key,()=>deny('dns'));mock.method(dns.promises,key,()=>deny('dns.promises'));}
const spawn=childProcess.spawn;
mock.method(childProcess,'spawn',(...args:unknown[])=>{
 const [binary,argv,rawOptions]=args,options=rawOptions as {cwd?:string;shell?:boolean;env?:NodeJS.ProcessEnv}|undefined;
 if(binary!==process.execPath||!Array.isArray(argv)||argv.length!==5||argv[0]!==resolve('packages/dws/src/process-supervisor.mjs')||typeof argv[1]!=='string'||typeof argv[2]!=='string'||!binaries.has(argv[2])||dirname(argv[1])!==binaries.get(argv[2])||options?.cwd!==argv[1]||options.shell!==false||options.env?.['HOME']!==argv[1])deny('spawn');
 return Reflect.apply(spawn,childProcess,args);
});
for(const key of ['spawnSync','exec','execSync','execFile','execFileSync','fork'] as const)mock.method(childProcess,key,()=>deny('child_process'));
syncBuiltinESMExports();
const {default:pg}=await import('pg');
for(const key of ['connect','query'] as const){mock.method(pg.Client.prototype,key,()=>deny('PG'));mock.method(pg.Pool.prototype,key,()=>deny('PG'));}
const {signedGroupReadFixture}=await import('../support/signed-group-read-fixture.js');
const {groupMembersReply,groupInfoReply}=await import('../support/group-members.js');
assert.deepEqual(denied,[],'imports must perform no IO');
after(()=>{assert.deepEqual(denied,[]);assert.equal(sockets.size,0);assert.equal(binaries.size,0);});
async function fixture(options:Parameters<typeof signedGroupReadFixture>[0]={}){
 const f=await signedGroupReadFixture({...options,onSocket:(path,active)=>{if(active)sockets.add(path);else sockets.delete(path);}});binaries.set(f.cli.binary,f.cli.workspace);
 return {...f,close:async()=>{try{await f.close();}finally{binaries.delete(f.cli.binary);}}};
}
async function rejectsCode(promise:Promise<unknown>,code:string){await assert.rejects(promise,(e:unknown)=>e instanceof Error&&'code' in e&&e.code===code);}

test('offline guard denies PG/TCP/DNS/TLS/fetch/foreign socket and arbitrary processes',()=>{
 for(const call of [()=>net.connect(53331,'127.0.0.1'),()=>http.get('http://localhost:53331'),()=>dns.lookup('example.invalid',()=>{}),()=>tls.connect(443),()=>fetch('https://example.invalid'),()=>dgram.createSocket('udp4'),()=>net.connect('/var/run/docker.sock'),()=>Reflect.apply(pg.Client.prototype.connect,null,[]),()=>childProcess.spawn('not-executed')])assert.throws(call,/OFFLINE_IO_DENIED/);
 assert.equal(denied.length,9);denied.length=0;
});
test('actual adapter -> signed client/service -> constrained runner/CLI produces only strict metadata and rotated synthetic state',async()=>{
 const f=await fixture();try{
  const result=await f.read();assert.equal(result.grantsAuthority,false);assert.equal(result.value.internalMembersVerified,false);assert.equal(result.value.platformCountsVerified,true);
  assert.deepEqual(result.value.users.map(x=>x.openDingtalkId),['open-a','open-b']);assert.equal(result.value.independentSource.userCount,2);assert.equal(f.groupCalls.length,1);assert.deepEqual(f.legacyCalls,[]);
  const [subject,,args,profile]=f.groupCalls[0]!;assert.deepEqual(subject,f.delegation.subject);assert.deepEqual(profile,f.scope.profile);assert.equal(args.conversationId,f.scope.conversationId);assert.equal(args.authorizationVersion,f.delegation.authorizationVersion);assert.match(args.requestNonce,/^[a-f0-9-]{36}$/);
  const events=await f.cli.events(),reads=events.filter(x=>['GROUP_INFO','GROUP_READ'].includes(x.phase));assert.deepEqual(reads.map(x=>x.phase),['GROUP_INFO','GROUP_READ','GROUP_INFO']);
  for(const event of reads){assert.equal(event.user,f.delegation.subject.userId);assert.equal(event.group,f.scope.conversationId);assert.equal(event.rootMode,0o700);assert.equal(event.fileMode,0o600);assert.equal(event.tokenMatches,true);}
  assert.deepEqual(events.filter(x=>x.args[0]==='schema').map(x=>x.args[2]),['chat +chat-members-list','chat +conversation-info']);
  assert.equal((await lstat(f.socketPath)).mode&0o777,0o600);assert.equal((await lstat(f.root)).mode&0o777,0o700);assert.deepEqual(await readdir(f.cli.workspace),[]);
  assert.equal(JSON.parse(Buffer.from(result.state.files['keychain/dws-cli/auth-token.enc']!,'base64').toString()).revision,1);
  assert.ok(!JSON.stringify(result.value).includes('private'));assert.ok(!JSON.stringify(result.value).includes('SYNTHETIC_DWS_CREDENTIAL'));
 }finally{await f.close();}
});
for(const field of ['tenantId','ownerId','identityId','taskId','runId','authEpoch','authorizationVersion','subject','audience'] as const){
 test(`adapter rejects complete delegation ${field} mismatch before invoking client`,async()=>{
  const f=await fixture();try{
   const candidate=structuredClone(f.delegation);if(field==='authEpoch'||field==='authorizationVersion')candidate[field]++;
   else if(field==='subject')candidate.subject.userId='foreign-user';else if(field==='audience')candidate.audience.id=randomUUID();else candidate[field]=randomUUID();
   if(field==='ownerId')candidate.audience.id=candidate.ownerId;
   const spy=mock.method(f.client,'readGroupAudience');await rejectsCode(f.reader.read(candidate,f.cli.state(candidate.subject),f.scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(spy.mock.callCount(),0);assert.equal(f.groupCalls.length,0);assert.deepEqual(await f.cli.events(),[]);
  }finally{await f.close();}
 });
}
test('adapter rejects unknown scope fields and GROUP publishing delegation before IPC',async()=>{
 const f=await fixture();try{
  const spy=mock.method(f.client,'readGroupAudience');await rejectsCode(f.reader.read(f.delegation,f.cli.state(f.delegation.subject),{...f.scope,endpoint:'https://example.invalid'} as DwsGroupScope,AbortSignal.timeout(4000)),'DWS_RPC_GROUP_SCOPE_INVALID');
  await rejectsCode(f.reader.read({...f.delegation,audience:{kind:'GROUP',id:f.delegation.ownerId}} as unknown as DwsGroupDelegation,f.cli.state(f.delegation.subject),f.scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(spy.mock.callCount(),0);assert.deepEqual(await f.cli.events(),[]);
 }finally{await f.close();}
});
test('service defaults to no approved scopes, with no runner or fallback',async()=>{
 const f=await fixture({enabled:false});try{await rejectsCode(f.read(),'DWS_RPC_SCOPE_MISMATCH');assert.equal(f.groupCalls.length,0);assert.deepEqual(f.legacyCalls,[]);assert.deepEqual(await f.cli.events(),[]);}finally{await f.close();}
});
for(const fault of ['scopeVersion','conversationId','membersSchemaHash','profile'] as const)test(`actual service refuses unapproved ${fault} even when local delegation matches`,async()=>{
 const f=await fixture();try{const scope=structuredClone(f.scope);if(fault==='scopeVersion')scope.scopeVersion++;else if(fault==='profile')scope.profile.reviewRef='UNAPPROVED';else scope[fault]=fault==='conversationId'?'cidWrong==':'9'.repeat(64);
 await rejectsCode(f.reader.read(f.delegation,f.cli.state(f.delegation.subject),scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(f.groupCalls.length,0);assert.deepEqual(await f.cli.events(),[]);}finally{await f.close();}
});
test('protocol nonce replay executes once; fresh signed reads reobserve metadata without business idempotency claims',async()=>{
 const f=await fixture();try{const request=await f.request(),envelope=f.sign(request);await rejectsCode(f.rawRead({...envelope,signature:'A'.repeat(86)}),'DWS_RPC_TRANSPORT_FAILED');assert.equal(f.groupCalls.length,0);
 const replies=await Promise.all([f.rawRead(envelope),f.rawRead(envelope)]);assert.equal(replies.filter(x=>x.result.ok).length,1);assert.deepEqual(replies.find(x=>!x.result.ok)!.result,{ok:false,code:'DWS_RPC_REPLAY'});assert.equal(f.groupCalls.length,1);assert.equal((await f.cli.events()).filter(x=>x.phase==='GROUP_READ').length,1);
 const fresh=await Promise.all([f.read(),f.read()]);assert.equal(fresh.length,2);assert.ok(fresh.every(x=>x.grantsAuthority===false));assert.equal(f.groupCalls.length,3);assert.equal((await f.cli.events()).filter(x=>x.phase==='GROUP_READ').length,3);assert.deepEqual(f.legacyCalls,[]);
 }finally{await f.close();}
});
for(const mode of ['schema','partial','wrong-identity','count-mismatch','business-partial','member-change','external-denial'] as const)test(`actual runner/CLI ${mode} cannot yield signed metadata or fallback`,async()=>{
 const f=await fixture();try{
  const reply=groupMembersReply();if(mode==='partial')reply.data.buckets.users.partial=true;
  await f.cli.mode(mode==='schema'?'schema':mode==='wrong-identity'?'profiles':'normal',{groups:{[f.scope.conversationId]:{allowedUsers:mode==='external-denial'?[]:[f.delegation.subject.userId],reply:mode==='business-partial'?{ok:false,outcome:'partial_failure'}:reply,info:groupInfoReply(mode==='count-mismatch'?3:2),infoAfter:mode==='member-change'?groupInfoReply(2,1,'r2'):groupInfoReply(mode==='count-mismatch'?3:2)}}});
  await rejectsCode(f.read(),{schema:'DWS_SCHEMA_CHANGED',partial:'DWS_RPC_EXECUTION_FAILED','wrong-identity':'DWS_PROFILE_MISMATCH','count-mismatch':'DWS_RPC_EXECUTION_FAILED','business-partial':'DWS_RESULT_PARTIAL','member-change':'DWS_RPC_EXECUTION_FAILED','external-denial':'DWS_BUSINESS_DENIED'}[mode]);assert.equal(f.groupCalls.length,1);assert.deepEqual(f.legacyCalls,[]);assert.deepEqual(await readdir(f.cli.workspace),[]);
 }finally{await f.close();}
});
test('adapter snapshots approved profile across the real asynchronous signed read',async()=>{
 const f=await fixture();try{const approved=f.scope.profile.reviewRef;f.afterRead(async()=>{f.scope.profile.reviewRef='UNAPPROVED_POST_CALL_MUTATION';});const result=await f.read();assert.equal(result.value.independentSource.reviewRef,approved);assert.equal(result.grantsAuthority,false);}finally{await f.close();}
});
for(const fault of ['count','review','authority'] as const)test(`adapter rejects post-client ${fault} corruption after actual signed validation`,async()=>{
 const f=await fixture();try{const actual=f.client.readGroupAudience.bind(f.client);mock.method(f.client,'readGroupAudience',async(...args:Parameters<typeof actual>)=>{const result=await actual(...args);
  if(fault==='count')result.value.independentSource.userCount=3;
  if(fault==='review')result.value.independentSource.reviewRef='UNAPPROVED_REVIEW';
  if(fault==='authority')Object.assign(result,{grantsAuthority:true});
  return result;});
 await rejectsCode(f.read(),'DWS_RPC_GROUP_RESULT_INVALID');assert.equal(f.groupCalls.length,1);assert.deepEqual(f.legacyCalls,[]);
 }finally{await f.close();}
});
test('actual service expiry before returning a completed CLI read cannot release metadata',async()=>{
 const f=await fixture();let clock:ReturnType<typeof mock.method>|undefined;
 try{f.afterRead(async()=>{clock=mock.method(Date,'now',()=>f.scope.expiresAt+1);});await rejectsCode(f.read(),'DWS_RPC_EXPIRED');assert.equal(f.groupCalls.length,1);assert.deepEqual(f.legacyCalls,[]);}
 finally{clock?.mock.restore();await f.close();}
});
test('scope expiry at dispatch and caller cancellation never produce metadata',async()=>{
 const expired=await fixture({expiresAt:Date.now()-1});try{await rejectsCode(expired.read(),'DWS_RPC_EXPIRED');assert.equal(expired.groupCalls.length,0);}finally{await expired.close();}
 const f=await fixture();try{const controller=new AbortController();controller.abort(Error('SYNTHETIC_ABORT'));await assert.rejects(f.read(controller.signal),/SYNTHETIC_ABORT/);assert.equal(f.groupCalls.length,0);}finally{await f.close();}
});
