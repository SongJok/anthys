import assert from 'node:assert/strict';
import {after,mock,test} from 'node:test';
import {readdir} from 'node:fs/promises';
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
import type {DocumentRead} from '../../packages/dws/src/document-contract.js';
import type {DwsDocumentDelegation,DwsDocumentScope} from '../../packages/dws/src/signed-protocol.js';

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
const {documentReadCliFixture,signedDocumentReadFixture,syntheticDocumentText,syntheticDocumentSecret}=await import('../support/signed-document-read-fixture.js');
const {hash}=await import('../../packages/storage/src/crypto.js');
assert.deepEqual(denied,[],'imports must perform no IO');
after(()=>{assert.deepEqual(denied,[]);assert.equal(sockets.size,0);assert.equal(binaries.size,0);});
async function fixture(){const f=await documentReadCliFixture();binaries.set(f.cli.binary,f.cli.workspace);return {...f,close:async()=>{try{await f.close();}finally{binaries.delete(f.cli.binary);}}};}
async function rejectsCode(promise:Promise<unknown>,code:string){await assert.rejects(promise,(e:unknown)=>e instanceof Error&&'code' in e&&e.code===code);}
async function assertCli(f:Awaited<ReturnType<typeof fixture>>){
 const reads=(await f.cli.events()).filter(x=>x.phase==='DOC_READ');assert.equal(reads.length,1);
 assert.deepEqual(reads[0]!.args,['doc','+fetch','--node',f.nodeId,'--detail','simple','--scope','full','--profile',f.subject.corpId+':'+f.subject.userId,'--format','json','--timeout','3']);
 assert.equal(reads[0]!.tokenMatches,true);assert.equal(reads[0]!.rootMode,0o700);assert.equal(reads[0]!.fileMode,0o600);assert.equal(f.calls.length,1);
 assert.deepEqual(await readdir(f.cli.workspace),[]);
}
test('document offline guard rejects PG/TCP/HTTP/DNS/TLS/foreign sockets and arbitrary processes',()=>{
 for(const call of [()=>net.connect(53331,'127.0.0.1'),()=>http.get('http://localhost:53331'),()=>dns.lookup('example.invalid',()=>{}),()=>tls.connect(443),()=>fetch('https://example.invalid'),()=>dgram.createSocket('udp4'),()=>net.connect('/var/run/docker.sock'),()=>Reflect.apply(pg.Client.prototype.connect,null,[]),()=>childProcess.spawn('not-executed')])assert.throws(call,/OFFLINE_IO_DENIED/);
 assert.equal(denied.length,9);denied.length=0;
});
test('actual runner/CLI FULL returns one reviewed document projection with redacted body and legitimate synthetic credential rotation',async()=>{
 const f=await fixture();try{
  const result=await f.read(),o=result.value,expected=syntheticDocumentText.replace(syntheticDocumentSecret,'█'.repeat(Array.from(syntheticDocumentSecret).length));
  assert.equal(o.status,'OK');assert.equal(o.completeness,'COMPLETE');assert.equal(o.nodeId,f.nodeId);assert.equal(o.revision,'synthetic-r1');assert.equal(o.observedTextHash,hash(syntheticDocumentText));
  assert.equal(o.projection.population,'ONE_DOCUMENT_VERSION');assert.equal(o.projection.documentComplete,true);assert.equal(o.projection.untrustedContent,true);assert.equal(o.projection.rangeUnit,'UNICODE_CODE_POINTS');
  assert.deepEqual(o.projection.fragments,[{start:0,end:Array.from(syntheticDocumentText).length,text:expected,contentHash:hash(expected),redacted:true}]);
  assert.ok(!JSON.stringify(o).includes(syntheticDocumentSecret));assert.ok(!JSON.stringify(o).includes('SYNTHETIC_DWS_CREDENTIAL'));
  assert.equal(JSON.parse(Buffer.from(result.state.files['keychain/dws-cli/auth-token.enc']!,'base64').toString()).revision,1);await assertCli(f);
 }finally{await f.close();}
});
for(const selector of [{kind:'RANGE',start:1,end:3},{kind:'KEYWORD',query:'结论',context:0,limit:1}] satisfies DocumentRead['selector'][])test(`actual CLI ${selector.kind} is an explicitly partial local Unicode projection over the fetched document`,async()=>{
 const f=await fixture();try{const o=(await f.read(selector)).value;assert.equal(o.status,'PARTIAL');assert.equal(o.completeness,'TRUNCATED');assert.equal(o.projection.documentComplete,false);assert.equal(o.projection.population,'ONE_DOCUMENT_VERSION');assert.equal(o.projection.stopReason,'LOCAL_SELECTION_LIMIT');
 if(selector.kind==='RANGE')assert.deepEqual(o.projection.fragments,[{start:1,end:3,text:'😀乙',contentHash:hash('😀乙'),redacted:false}]);
 else{assert.equal(o.projection.totalMatches,2);assert.equal(o.projection.fragments.length,1);assert.equal(o.projection.fragments[0]!.text,'结论');assert.deepEqual(o.projection.selector,{kind:'KEYWORD',queryHash:hash('结论'),context:0,limit:1});}
 await assertCli(f);
 }finally{await f.close();}
});
test('actual empty document is EMPTY/COMPLETE, while unpublished upstream coverage remains PARTIAL/UNKNOWN',async()=>{
 const f=await fixture();try{await f.configure({text:''});const empty=(await f.read()).value;assert.equal(empty.status,'EMPTY');assert.equal(empty.completeness,'COMPLETE');assert.deepEqual(empty.projection.fragments,[{start:0,end:0,text:'',contentHash:hash(''),redacted:false}]);
 await f.configure({text:'存在正文但覆盖字段没有认证'});const unknown=(await f.read(undefined,{...f.profile,completePointer:null,hasMorePointer:null,cursorPointer:null})).value;assert.equal(unknown.status,'PARTIAL');assert.equal(unknown.completeness,'UNKNOWN');assert.equal(unknown.projection.upstreamCompleteness,'UNKNOWN');assert.equal(unknown.projection.documentComplete,false);assert.equal(unknown.projection.stopReason,'UPSTREAM_COMPLETENESS_UNPUBLISHED');
 assert.equal((await f.cli.events()).filter(x=>x.phase==='DOC_READ').length,2);assert.deepEqual(await readdir(f.cli.workspace),[]);
 }finally{await f.close();}
});
test('actual unconsumed upstream continuation is PARTIAL/TRUNCATED and never fabricates fetch pagination',async()=>{
 const f=await fixture();try{await f.configure({complete:false,hasMore:true,nextCursor:'synthetic-unconsumed-cursor'});const o=(await f.read()).value;assert.equal(o.status,'PARTIAL');assert.equal(o.completeness,'TRUNCATED');assert.equal(o.projection.upstreamCompleteness,'TRUNCATED');assert.equal(o.projection.stopReason,'UPSTREAM_CONTINUATION_UNCONSUMED');assert.equal(o.projection.documentComplete,false);await assertCli(f);}finally{await f.close();}
});
test('actual CLI keyword matching cannot reveal a masked secret, and byte clipping never implies complete coverage',async()=>{
 const f=await fixture();try{const empty=(await f.read({kind:'KEYWORD',query:syntheticDocumentSecret,context:0,limit:1})).value;assert.equal(empty.status,'EMPTY');assert.equal(empty.projection.totalMatches,0);assert.deepEqual(empty.projection.fragments,[]);
 await f.configure({text:'汉'.repeat(9000)+' password='+syntheticDocumentSecret});const bounded=(await f.read({kind:'FULL',maxCharacters:12000})).value;assert.equal(bounded.status,'PARTIAL');assert.equal(bounded.completeness,'TRUNCATED');assert.equal(bounded.projection.documentComplete,false);assert.ok(Buffer.byteLength(bounded.projection.fragments[0]!.text)<=16000);assert.ok(!JSON.stringify(bounded).includes(syntheticDocumentSecret));assert.deepEqual(await readdir(f.cli.workspace),[]);
 }finally{await f.close();}
});
for(const mode of ['schema','profile','denied','outer-partial','payload-error','wrong-node','wrong-type','empty-revision'] as const)test(`actual document runner/CLI ${mode} cannot return a body projection`,async()=>{
 const f=await fixture();try{
  await f.configure({...mode==='denied'?{allowedUsers:[]}:mode==='outer-partial'?{outerPartial:true}:mode==='payload-error'?{payloadError:true}:mode==='wrong-node'?{responseNodeId:'foreign_node'}:mode==='wrong-type'?{resourceType:'dlink'}:mode==='empty-revision'?{revision:''}:{}},mode==='schema'?'schema':mode==='profile'?'profiles':'normal');
  const expected={schema:'DWS_SCHEMA_CHANGED',profile:'DWS_PROFILE_MISMATCH',denied:'DWS_BUSINESS_DENIED','outer-partial':'DWS_DOCUMENT_ENVELOPE_UNVERIFIED','payload-error':'DWS_DOCUMENT_PAYLOAD_FAILED','wrong-node':'DWS_DOCUMENT_TARGET_MISMATCH','wrong-type':'DWS_DOCUMENT_TARGET_MISMATCH','empty-revision':'DWS_DOCUMENT_PAYLOAD_UNVERIFIED'}[mode];
  await rejectsCode(f.read(),expected);assert.equal((await f.cli.events()).filter(x=>x.phase==='DOC_READ').length,mode==='schema'||mode==='profile'?0:1);assert.deepEqual(await readdir(f.cli.workspace),[]);
 }finally{await f.close();}
});

// These actual signed-path cases require the sole owner's document protocol
// commit. They are not represented by the earlier runner-only CLI results.
async function signedFixture(options:Parameters<typeof signedDocumentReadFixture>[0]={}){
 const f=await signedDocumentReadFixture({...options,onSocket:(path,active)=>{if(active)sockets.add(path);else sockets.delete(path);}});binaries.set(f.document.cli.binary,f.document.cli.workspace);
 return {...f,close:async()=>{try{await f.close();}finally{binaries.delete(f.document.cli.binary);}}};
}
for(const selector of [{kind:'FULL',maxCharacters:6000},{kind:'RANGE',start:1,end:3},{kind:'KEYWORD',query:'结论',context:0,limit:1}] satisfies DocumentRead['selector'][])test(`actual signed document adapter/client/service/socket/runner/CLI ${selector.kind} preserves bounded projection and no authority`,async()=>{
 const f=await signedFixture({selector});try{
  const result=await f.read();assert.equal(result.grantsAuthority,false);assert.equal(result.value.projection.population,'ONE_DOCUMENT_VERSION');assert.equal(result.value.projection.untrustedContent,true);assert.equal(result.value.status,selector.kind==='FULL'?'OK':'PARTIAL');assert.equal(result.value.completeness,selector.kind==='FULL'?'COMPLETE':'TRUNCATED');
  assert.equal(f.document.calls.length,1);assert.deepEqual(f.document.calls[0]!.subject,f.delegation.subject);assert.deepEqual(f.document.calls[0]!.args.selector,selector);assert.deepEqual(f.document.calls[0]!.profile,f.scope.profile);assert.ok(!JSON.stringify(result.value).includes(syntheticDocumentSecret));assert.equal((await f.document.cli.events()).filter(x=>x.phase==='DOC_READ').length,1);assert.deepEqual(await readdir(f.document.cli.workspace),[]);
 }finally{await f.close();}
});
test('actual signed service denies document reads by default with zero CLI dispatch',async()=>{
 const f=await signedFixture({enabled:false});try{await rejectsCode(f.read(),'DWS_RPC_SCOPE_MISMATCH');assert.equal(f.document.calls.length,0);assert.deepEqual(await f.document.cli.events(),[]);}finally{await f.close();}
});
for(const field of ['tenantId','ownerId','identityId','taskId','runId','authEpoch','authorizationVersion'] as const)test(`document adapter ${field} mismatch reaches no actual client/CLI`,async()=>{
 const f=await signedFixture();try{const candidate=structuredClone(f.delegation);if(field==='authEpoch'||field==='authorizationVersion')candidate[field]++;else candidate[field]='99999999-9999-4999-8999-999999999999';if(field==='ownerId')candidate.audience.id=candidate.ownerId;
 const spy=mock.method(f.client,'readDocument');await rejectsCode(f.reader.read(candidate,f.document.cli.state(candidate.subject),f.scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(spy.mock.callCount(),0);assert.equal(f.document.calls.length,0);assert.deepEqual(await f.document.cli.events(),[]);
 }finally{await f.close();}
});
for(const field of ['nodeId','selector','profile','documentSchemaHash'] as const)test(`actual signed document scope ${field} mismatch is denied before CLI`,async()=>{
 const f=await signedFixture();try{const changed:DwsDocumentScope=structuredClone(f.scope);if(field==='nodeId')changed.nodeId='different_node';else if(field==='selector')changed.selector={kind:'RANGE',start:1,end:3};else if(field==='profile')changed.profile.reviewRef='UNAPPROVED_PROFILE';else changed.documentSchemaHash='9'.repeat(64);
 await rejectsCode(f.reader.read(f.delegation,f.document.cli.state(f.delegation.subject),changed,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(f.document.calls.length,0);assert.deepEqual(await f.document.cli.events(),[]);
 }finally{await f.close();}
});
test('actual fresh signed document requests use distinct request nonces and independently re-read the source',async()=>{
 const f=await signedFixture();try{const first=await f.read(),second=await f.read();assert.equal(first.grantsAuthority,false);assert.equal(second.grantsAuthority,false);assert.equal(f.document.calls.length,2);assert.notEqual(f.document.calls[0]!.args.requestNonce,f.document.calls[1]!.args.requestNonce);assert.equal((await f.document.cli.events()).filter(x=>x.phase==='DOC_READ').length,2);}finally{await f.close();}
});

test('document adapter rejects malformed scope/delegation and group publishing without leaking Zod errors or invoking client',async()=>{
 const f=await signedFixture();try{const spy=mock.method(f.client,'readDocument');const state=f.document.cli.state(f.delegation.subject);
 await rejectsCode(f.reader.read(f.delegation,state,{...f.scope,endpoint:'https://example.invalid'} as DwsDocumentScope,AbortSignal.timeout(4000)),'DWS_RPC_DOCUMENT_SCOPE_INVALID');
 await rejectsCode(f.reader.read({...f.delegation,argv:['doc','+update']} as DwsDocumentDelegation,state,f.scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');
 await rejectsCode(f.reader.read({...f.delegation,audience:{kind:'GROUP',id:f.delegation.ownerId}} as unknown as DwsDocumentDelegation,state,f.scope,AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(spy.mock.callCount(),0);assert.equal(f.document.calls.length,0);assert.deepEqual(await f.document.cli.events(),[]);
 }finally{await f.close();}
});
test('document adapter refuses authority=true fault after a real successful signed client read',async()=>{
 const f=await signedFixture();try{const read=f.client.readDocument.bind(f.client);mock.method(f.client,'readDocument',async(...args:Parameters<typeof read>)=>{const result=await read(...args);Object.assign(result,{grantsAuthority:true});return result;});await rejectsCode(f.read(),'DWS_RPC_DOCUMENT_RESULT_INVALID');assert.equal(f.document.calls.length,1);}finally{await f.close();}
});
test('actual bad signature is rejected and concurrent reuse of the same signed document nonce executes exactly once',async()=>{
 const f=await signedFixture();try{const request=await f.request(),envelope=f.sign(request);await rejectsCode(f.rawRead({...envelope,signature:'A'.repeat(86)}),'DWS_RPC_TRANSPORT_FAILED');assert.equal(f.document.calls.length,0);
 const results=await Promise.all([f.rawRead(envelope),f.rawRead(envelope)]);assert.equal(results.filter(x=>x.result.ok).length,1);assert.deepEqual(results.find(x=>!x.result.ok)!.result,{ok:false,code:'DWS_RPC_REPLAY'});assert.equal(f.document.calls.length,1);assert.equal((await f.document.cli.events()).filter(x=>x.phase==='DOC_READ').length,1);
 }finally{await f.close();}
});
for(const extra of [{argv:['doc','+update']},{endpoint:'https://example.invalid'},{profile:'foreign:user'},{path:'/not-used'},{operation:'WRITE_DOCUMENT'}])test(`actual signed document request rejects caller override ${Object.keys(extra)[0]}`,async()=>{
 const f=await signedFixture();try{const request=await f.request();await rejectsCode(f.rawRead(f.sign({...request,...extra})),'DWS_RPC_TRANSPORT_FAILED');assert.equal(f.document.calls.length,0);assert.deepEqual(await f.document.cli.events(),[]);}finally{await f.close();}
});
for(const fault of ['unknown','fragment-hash','offset','projection-hash','selector','coverage','oversized'] as const)test(`actual service refuses ${fault} projection injected after real CLI projection`,async()=>{
 const f=await signedFixture();try{f.document.afterRead(async o=>{
  if(fault==='unknown')Object.assign(o,{enterpriseData:'SYNTHETIC_REJECTED_EXTRA'});
  if(fault==='fragment-hash')o.projection.fragments[0]!.contentHash='0'.repeat(64);
  if(fault==='offset')o.projection.fragments[0]!.end++;
  if(fault==='projection-hash')o.projectionHash='0'.repeat(64);
  if(fault==='selector')o.projection.selector={kind:'RANGE',start:1,end:3};
  if(fault==='coverage')o.projection.documentComplete=false;
  if(fault==='oversized')Object.assign(o,{padding:'x'.repeat(65537)});
 });await rejectsCode(f.read(),'DWS_RPC_DOCUMENT_RESULT_INVALID');assert.equal(f.document.calls.length,1);assert.deepEqual(await readdir(f.document.cli.workspace),[]);
 }finally{await f.close();}
});
test('actual signed document scope expiry before dispatch and after a completed CLI read cannot release a body',async()=>{
 const expired=await signedFixture({expiresAt:Date.now()-1});try{await rejectsCode(expired.read(),'DWS_RPC_EXPIRED');assert.equal(expired.document.calls.length,0);}finally{await expired.close();}
 const f=await signedFixture();let clock:ReturnType<typeof mock.method>|undefined;
 try{f.document.afterRead(async()=>{clock=mock.method(Date,'now',()=>f.scope.expiresAt+1);});const request=await f.request();assert.deepEqual((await f.rawRead(f.sign(request))).result,{ok:false,code:'DWS_RPC_EXPIRED'});assert.equal(f.document.calls.length,1);}
 finally{clock?.mock.restore();await f.close();}
});
test('document scope and profile snapshots survive external mutation during the actual asynchronous signed read',async()=>{
 const f=await signedFixture();try{const original=structuredClone(f.scope);f.document.afterRead(async()=>{f.scope.profile.reviewRef='UNAPPROVED_MUTATION';f.scope.selector={kind:'RANGE',start:1,end:3};});const result=await f.read();assert.equal(result.grantsAuthority,false);assert.deepEqual(result.value.projection.selector,original.selector);assert.deepEqual(f.document.calls[0]!.profile,original.profile);}finally{await f.close();}
});
test('signed empty/unknown/truncated source coverage remains exact after the actual service and client validators',async()=>{
 for(const mode of ['empty','unknown','truncated'] as const){const f=await signedFixture(mode==='unknown'?{profile:{schemaVersion:1,reviewRef:'SYNTHETIC_UNPUBLISHED_COVERAGE_ONLY',nodePointer:'/data/nodeId',revisionPointer:'/data/revision',textPointer:'/data/markdown',typePointer:'/data/resourceType',typeValue:'adoc',completePointer:null,hasMorePointer:null,cursorPointer:null,completenessUnit:'ONE_DOCUMENT_VERSION'}}:{});
 try{if(mode==='empty')await f.document.configure({text:''});if(mode==='truncated')await f.document.configure({complete:false,hasMore:true,nextCursor:'unconsumed'});const o=(await f.read()).value;assert.equal(o.status,mode==='empty'?'EMPTY':'PARTIAL');assert.equal(o.completeness,mode==='empty'?'COMPLETE':mode==='unknown'?'UNKNOWN':'TRUNCATED');assert.equal(o.projection.documentComplete,mode==='empty');assert.equal(f.document.calls.length,1);}finally{await f.close();}}
});
test('document opt-in preserves legacy reads while leaving group reads disabled',async()=>{
 const f=await signedFixture();try{const {readBindingHash}=await import('../../packages/dws/src/signed-service.js');assert.equal(readBindingHash(f.document.runner),readBindingHash(f.document.runner,undefined,[]));assert.notEqual(f.service.bindingHash,readBindingHash(f.document.runner));
 const self={...f.delegation,capabilityBindingId:'dws.contact.me.v1' as const},state=f.document.cli.state(f.delegation.subject);assert.equal((await f.client.readSelf(self,state,AbortSignal.timeout(4000))).value.userId,f.delegation.subject.userId);assert.deepEqual((await f.client.verify({...self,capabilityBindingId:'dws.identity.verify.v1'},state,AbortSignal.timeout(4000))).value,{verified:true});
 await rejectsCode(f.client.readGroupAudience({...f.delegation,capabilityBindingId:'dws.group.audience.v1'},state,{scopeId:f.scope.scopeId,scopeVersion:1,scopeHash:'1'.repeat(64),profileHash:'2'.repeat(64),conversationId:'cidForbidden==',binaryHash:f.scope.binaryHash,membersSchemaHash:'3'.repeat(64),infoSchemaHash:'4'.repeat(64)},AbortSignal.timeout(4000)),'DWS_RPC_SCOPE_MISMATCH');assert.equal(f.document.calls.length,0);assert.equal((await f.document.cli.events()).filter(x=>x.phase==='DOC_READ').length,0);
 }finally{await f.close();}
});
