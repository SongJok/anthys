import {scheduledGroupPolicySchema,snapshotScheduledGroupPolicies} from '../../../packages/dws/src/scheduled-group-protocol.js';
import {caseRosterPolicySchema,snapshotCaseRosterPolicies} from '../../../packages/dws/src/case-roster-protocol.js';
import {readFile,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {DwsRunner} from '../../../packages/dws/src/runner.js';
import {DwsError} from '../../../packages/dws/src/contracts.js';
import {rpcKey,groupScopeSchema,snapshotGroupScopes,documentScopeSchema,snapshotDocumentScopes,documentPolicySchema,snapshotDocumentPolicies} from '../../../packages/dws/src/signed-protocol.js';
import {SignedDwsReadService} from '../../../packages/dws/src/signed-service.js';
import {observeOfflineNetwork} from '../../../packages/dws/src/offline-network.js';
import {assertReviewedDocumentReadBinding} from '../../../packages/dws/src/document-binding.js';
import {assertReviewedGroupReadBinding} from '../../../packages/dws/src/group-binding.js';

const absolute=z.string().refine(isAbsolute),sha=z.string().regex(/^[a-f0-9]{64}$/);
const configuration=z.object({schemaVersion:z.literal(1),mode:z.enum(['SYNTHETIC_TEST','PRODUCTION_OFFLINE']),socketPath:absolute,tenantId:z.uuid(),corpId:z.string(),policyHash:sha,callerKeyId:z.string(),callerPublicKeyFile:absolute,runnerKeyId:z.string(),runnerPrivateKeyFile:absolute,maxRequestMs:z.number().int().min(100).max(10000),maxConcurrent:z.number().int().min(1).max(8),maxReplayEntries:z.number().int().min(1).max(100000),binaryFile:absolute,binaryHash:sha,schemaHash:sha,root:absolute,maxOutputBytes:z.number().int().min(1024).max(262144),groupMembersSchemaHash:sha.optional(),groupInfoSchemaHash:sha.optional(),groupScopes:z.array(groupScopeSchema).min(1).max(32).optional(),caseRosterPolicies:z.array(caseRosterPolicySchema).min(1).max(32).optional(),scheduledGroupPolicies:z.array(scheduledGroupPolicySchema).min(1).max(32).optional(),documentSchemaHash:sha.optional(),documentScopes:z.array(documentScopeSchema).min(1).max(32).optional(),documentPolicies:z.array(documentPolicySchema).min(1).max(32).optional()}).strict().superRefine((c,ctx)=>{if((c.groupMembersSchemaHash||c.groupInfoSchemaHash||c.groupScopes||c.caseRosterPolicies||c.scheduledGroupPolicies)&&(!c.groupMembersSchemaHash||!c.groupInfoSchemaHash||!c.groupScopes?.length&&!c.caseRosterPolicies?.length&&!c.scheduledGroupPolicies?.length))ctx.addIssue({code:'custom',message:'GROUP_BINDING_REQUIRES_COMPLETE_SCOPE_AND_SCHEMAS'});if((c.documentSchemaHash||c.documentScopes||c.documentPolicies)&&(!c.documentSchemaHash||Boolean(c.documentScopes?.length)===Boolean(c.documentPolicies?.length)||c.mode==='PRODUCTION_OFFLINE'&&!c.documentPolicies?.length))ctx.addIssue({code:'custom',message:'DOCUMENT_BINDING_REQUIRES_COMPLETE_SCOPE_AND_SCHEMA'});});
async function privateFile(path:string){if(!isAbsolute(path)||await realpath(path)!==path)throw new DwsError('DWS_RPC_CONFIG_UNSAFE');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>262144)throw new DwsError('DWS_RPC_CONFIG_UNSAFE');return await file.readFile('utf8');}finally{await file.close();}}
async function start(){const path=process.argv[2];if(!path||process.argv.length!==3||!isAbsolute(path))throw new DwsError('DWS_RPC_CONFIG_REQUIRED');const c=configuration.parse(JSON.parse(await privateFile(path)));
 const test=c.mode==='SYNTHETIC_TEST';if(test&&(process.env['OA_TEST_ISOLATED']!=='true'||process.env['APP_ENV']!=='test'))throw new DwsError('DWS_SYNTHETIC_FORBIDDEN');
 // macOS injects this locale hint into spawned processes even with an exact
 // env map. It is accepted only by the synthetic entrypoint, never Linux prod.
 const allowed=new Set(['PATH','LANG',...(test?['APP_ENV','OA_TEST_ISOLATED','__CF_USER_TEXT_ENCODING']:[])]);if(Object.keys(process.env).some(k=>!allowed.has(k)))throw new DwsError('DWS_RPC_ENV_UNSAFE');
 if(!test){
  // This first standalone service can be exercised offline only. A reviewed
  // reference alone never enables unrestricted outbound access in production.
  if(process.platform!=='linux'||process.getuid?.()!==10001)throw new DwsError('DWS_RPC_OFFLINE_NETWORK_REQUIRED');await observeOfflineNetwork();
  const lock=JSON.parse(await readFile('config/dws/lock.json','utf8')) as {platforms:Record<string,{binarySha256:string}>;commands:Record<string,{schemaHash:string}>};const platform='linux-'+(process.arch==='arm64'?'arm64':process.arch==='x64'?'amd64':'unsupported');
  if(c.binaryFile!=='/usr/local/bin/dws'||c.binaryHash!==lock.platforms[platform]?.binarySha256||c.schemaHash!==lock.commands['contact.me']?.schemaHash)throw new DwsError('DWS_RPC_BINDING_CHANGED');
  if(c.documentScopes||c.documentPolicies)await assertReviewedDocumentReadBinding({binaryHash:c.binaryHash,schemaHash:c.schemaHash,documentSchemaHash:c.documentSchemaHash!},platform);
  if(c.groupScopes||c.caseRosterPolicies||c.scheduledGroupPolicies)await assertReviewedGroupReadBinding({binaryHash:c.binaryHash,schemaHash:c.schemaHash,groupMembersSchemaHash:c.groupMembersSchemaHash!,groupInfoSchemaHash:c.groupInfoSchemaHash!},platform);
 }
 const runner=new DwsRunner({mode:test?'SYNTHETIC_TEST':'PRODUCTION',binaryFile:c.binaryFile,binaryHash:c.binaryHash,schemaHash:c.schemaHash,root:c.root,timeoutMs:c.maxRequestMs,maxOutputBytes:c.maxOutputBytes,...(c.documentSchemaHash?{documentSchemaHash:c.documentSchemaHash}:{}),...(c.groupMembersSchemaHash?{groupMembersSchemaHash:c.groupMembersSchemaHash,groupInfoSchemaHash:c.groupInfoSchemaHash!}:{})}),service=new SignedDwsReadService(runner,{tenantId:c.tenantId,corpId:c.corpId,policyHash:c.policyHash,callerKeyId:c.callerKeyId,callerPublicKey:rpcKey(await privateFile(c.callerPublicKeyFile),'public'),runnerKeyId:c.runnerKeyId,runnerPrivateKey:rpcKey(await privateFile(c.runnerPrivateKeyFile),'private'),maxRequestMs:c.maxRequestMs,maxConcurrent:c.maxConcurrent,maxReplayEntries:c.maxReplayEntries,...(c.documentScopes?{documentScopes:snapshotDocumentScopes(c.documentScopes)}:{}),...(c.documentPolicies?{documentPolicies:snapshotDocumentPolicies(c.documentPolicies)}:{}),...(c.groupScopes?{groupScopes:snapshotGroupScopes(c.groupScopes)}:{}),...(c.caseRosterPolicies?{caseRosterPolicies:snapshotCaseRosterPolicies(c.caseRosterPolicies)}:{}),...(c.scheduledGroupPolicies?{scheduledGroupPolicies:snapshotScheduledGroupPolicies(c.scheduledGroupPolicies)}:{})});
 await service.listen(c.socketPath);const stop=()=>{void service.close().finally(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);process.send?.({type:'ready',instanceId:service.instanceId,bindingHash:service.bindingHash});
}
start().catch(error=>{process.stderr.write(JSON.stringify({error:error instanceof DwsError?error.code:'DWS_RPC_START_FAILED'})+'\n');process.exitCode=1;});
