import {randomUUID} from 'node:crypto';
import {readBindingHash} from '../../packages/dws/src/signed-service.js';
import {documentScopeForPolicy,documentTargetForScope,rpcHash,snapshotDocumentPolicies,type DwsDocumentPolicy} from '../../packages/dws/src/signed-protocol.js';
import {assertReviewedDocumentReadBinding} from '../../packages/dws/src/document-binding.js';
import {assertReviewedGroupReadBinding} from '../../packages/dws/src/group-binding.js';
import {readFile} from 'node:fs/promises';
import {DwsRunner} from '../../packages/dws/src/runner.js';
import {validateState,meEnvelopeSchema,projectMe} from '../../packages/dws/src/contracts.js';
import {dwsFixture} from '../support/dws-cli.js';
import {readdir} from 'node:fs/promises';
it('credential bundles reject traversal, endpoint overrides, foreign identities, invalid encoding and oversized files before writing or executing',async()=>{
 const fixture=await dwsFixture(),subject={corpId:'synthetic-corp',userId:'synthetic-user'};try{const valid=fixture.state(subject);expect(validateState(valid,subject)).toEqual(valid);for(const path of ['../../outside','config/mcp_url','config/terminal_url','keychain/dws-cli/auth-token_foreign.enc'])expect(()=>validateState({...valid,files:{...valid.files,[path]:Buffer.from('synthetic').toString('base64')}},subject)).toThrow('DWS_STATE_PATH_DENIED');expect(()=>validateState(fixture.state({...subject,userId:'foreign'}),subject)).toThrow('DWS_PROFILE_MISMATCH');expect(()=>validateState({...valid,files:{...valid.files,'keychain/dws-cli/dek':'%%%'}},subject)).toThrow('DWS_STATE_INVALID');expect(()=>validateState({...valid,files:{...valid.files,'keychain/dws-cli/dek':Buffer.alloc(65537).toString('base64')}},subject)).toThrow('DWS_STATE_TOO_LARGE');expect(await fixture.events()).toHaveLength(0);expect(await readdir(fixture.workspace)).toEqual([]);}finally{await fixture.close();}
});
it('a changed executable is rejected before the first process and test-only runners cannot be enabled in production',async()=>{
 const fixture=await dwsFixture(),subject={corpId:'synthetic-corp',userId:'synthetic-user'};try{const invalid=new DwsRunner({...fixture.runner.config,binaryHash:'0'.repeat(64)});await expect(invalid.readSelf(subject,fixture.state(subject),new AbortController().signal)).rejects.toMatchObject({code:'DWS_BINARY_CHANGED'});expect(await fixture.events()).toHaveLength(0);vi.stubEnv('APP_ENV','production');expect(()=>new DwsRunner(fixture.runner.config)).toThrow('DWS_SYNTHETIC_FORBIDDEN');}finally{vi.unstubAllEnvs();await fixture.close();}
});
it('only a terminal published self-profile result can be projected, and private phone/email fields are excluded',()=>{
 const data={userId:'synthetic-user',name:'Fixture',dept:'Team',org:'Company',mobile:'private-phone',email:'private-email'};expect(meEnvelopeSchema.safeParse({ok:true,outcome:'success',identity:'user',data}).success).toBe(true);expect(projectMe(data)).toEqual({userId:'synthetic-user',name:'Fixture',dept:'Team',org:'Company'});for(const patch of [{outcome:'pending'},{outcome:'partial_failure',ok:false},{ok:false},{identity:'app'},{dry_run:true},{data:{...data,token:'synthetic-secret'}}])expect(meEnvelopeSchema.safeParse({ok:true,outcome:'success',data,...patch}).success).toBe(false);
});

it('production group binding predicate accepts only archived real CLI metadata and exact pinned binaries',async()=>{
 const lock=JSON.parse(await readFile('config/dws/lock.json','utf8')),base={binaryHash:lock.platforms['linux-arm64'].binarySha256,schemaHash:lock.commands['contact.me'].schemaHash,groupMembersSchemaHash:lock.commands['chat.members'].schemaHash,groupInfoSchemaHash:lock.commands['chat.info'].schemaHash};
 await expect(assertReviewedGroupReadBinding(base,'linux-arm64')).resolves.toBeUndefined();await expect(assertReviewedGroupReadBinding({...base,binaryHash:lock.platforms['linux-amd64'].binarySha256},'linux-amd64')).resolves.toBeUndefined();
 for(const field of ['binaryHash','schemaHash','groupMembersSchemaHash','groupInfoSchemaHash'] as const)await expect(assertReviewedGroupReadBinding({...base,[field]:'0'.repeat(64)},'linux-arm64')).rejects.toMatchObject({code:'DWS_GROUP_BINDING_UNCERTIFIED'});
 await expect(assertReviewedGroupReadBinding(base,'unsupported')).rejects.toMatchObject({code:'DWS_GROUP_BINDING_UNCERTIFIED'});
});

it('production document binding checks exact archived metadata without claiming a tenant payload certification',async()=>{
 const lock=JSON.parse(await readFile('config/dws/lock.json','utf8')),base={binaryHash:lock.platforms['linux-arm64'].binarySha256,schemaHash:lock.commands['contact.me'].schemaHash,documentSchemaHash:lock.commands['doc.fetch'].schemaHash};
 await expect(assertReviewedDocumentReadBinding(base,'linux-arm64')).resolves.toBeUndefined();await expect(assertReviewedDocumentReadBinding({...base,binaryHash:lock.platforms['linux-amd64'].binarySha256},'linux-amd64')).resolves.toBeUndefined();
 for(const field of ['binaryHash','schemaHash','documentSchemaHash'] as const)await expect(assertReviewedDocumentReadBinding({...base,[field]:'0'.repeat(64)},'linux-arm64')).rejects.toMatchObject({code:'DWS_DOCUMENT_BINDING_UNCERTIFIED'});
 await expect(assertReviewedDocumentReadBinding(base,'unsupported')).rejects.toMatchObject({code:'DWS_DOCUMENT_BINDING_UNCERTIFIED'});
});

it('reviewed document policy binding stays stable across generated run IDs while each signed request target binds its exact run',async()=>{
 const f=await dwsFixture({documents:true}),ownerId=randomUUID();try{
  const principal={tenantId:randomUUID(),ownerId,identityId:randomUUID(),authEpoch:1,authorizationVersion:1,capabilityBindingId:'dws.doc.read.v1' as const,audience:{kind:'PRIVATE_USER' as const,id:ownerId},subject:{corpId:'synthetic-policy',userId:'synthetic-owner'}};
  const policy:DwsDocumentPolicy={scopeId:randomUUID(),scopeVersion:1,principal,nodeId:'synthetic_policy_doc',selector:{kind:'FULL',maxCharacters:6000},profile:{schemaVersion:1,reviewRef:'SYNTHETIC_POLICY_METADATA_ONLY',nodePointer:'/data/nodeId',revisionPointer:'/data/revision',textPointer:'/data/markdown',typePointer:'/data/resourceType',typeValue:'adoc',completePointer:'/data/complete',hasMorePointer:'/data/hasMore',cursorPointer:'/data/nextCursor',completenessUnit:'ONE_DOCUMENT_VERSION'},binaryHash:f.runner.config.binaryHash,documentSchemaHash:f.runner.config.documentSchemaHash!,validFrom:Date.now()-1000,expiresAt:Date.now()+60000};
  const snapshot=snapshotDocumentPolicies([policy]),binding=readBindingHash(f.runner,undefined,undefined,snapshot),first={...principal,taskId:randomUUID(),runId:randomUUID()},second={...principal,taskId:randomUUID(),runId:randomUUID()};
  const one=documentTargetForScope(documentScopeForPolicy(snapshot[0]!,first)),two=documentTargetForScope(documentScopeForPolicy(snapshot[0]!,second));expect(one.scopeHash).not.toBe(two.scopeHash);expect(readBindingHash(f.runner,undefined,undefined,snapshot)).toBe(binding);
  expect(()=>documentScopeForPolicy(snapshot[0]!,{...second,identityId:randomUUID()})).toThrow('DWS_RPC_SCOPE_MISMATCH');
  expect(()=>documentScopeForPolicy(snapshot[0]!,{...second,authorizationVersion:2})).toThrow('DWS_RPC_SCOPE_MISMATCH');
  expect(()=>snapshotDocumentPolicies([policy,policy])).toThrow('DWS_RPC_DOCUMENT_SCOPE_INVALID');
  policy.profile.reviewRef='UNREVIEWED_CHANGE';expect(rpcHash(snapshot[0]!.profile)).not.toBe(rpcHash(policy.profile));expect(()=>{snapshot[0]!.expiresAt=1;}).toThrow(TypeError);expect(await f.events()).toHaveLength(0);
 }finally{await f.close();}
});
