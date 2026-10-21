import {groupMentionRosterPolicySchema,snapshotGroupMentionPolicies} from './group-mention-roster-protocol.js';
import {nativeCaseRosterPolicySchema,snapshotNativeCaseRosterPolicies} from './native-case-roster-protocol.js';
import {scheduledGroupPolicySchema,snapshotScheduledGroupPolicies} from './scheduled-group-protocol.js';
import {caseRosterPolicySchema,snapshotCaseRosterPolicies} from './case-roster-protocol.js';
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import type {Database} from '../../storage/src/database.js';
import type {Vault} from '../../storage/src/crypto.js';
import {DwsIdentities} from './identity.js';
import {DwsError} from './contracts.js';
import {SignedDwsReadClient} from './signed-client.js';
import {SignedDocumentReader} from './signed-document-reader.js';
import {SignedGroupAudienceReader} from './signed-group-reader.js';
import {SignedGroupReadClient,SignedDocumentReadClient} from './read-client.js';
import {groupScopeSchema,snapshotGroupScopes,documentScopeSchema,snapshotDocumentScopes,documentPolicySchema,snapshotDocumentPolicies,rpcKey} from './signed-protocol.js';
import {safeSocketParent} from './signed-service.js';
import {assertReviewedDocumentReadBinding} from './document-binding.js';
import {assertReviewedGroupReadBinding} from './group-binding.js';
const configSchema=z.object({schemaVersion:z.literal(1),binaryFile:z.string().refine(isAbsolute),root:z.string().refine(isAbsolute),timeoutMs:z.number().int().min(100).max(10000),maxOutputBytes:z.number().int().min(1024).max(262144),reviewed:z.literal(true),egressPolicyRef:z.string().trim().min(1)}).strict();
const sha=z.string().regex(/^[a-f0-9]{64}$/),absolute=z.string().refine(isAbsolute);
const signedBase=z.object({schemaVersion:z.literal(1),executionMode:z.enum(['SYNTHETIC_TEST','PRODUCTION_OFFLINE']),reviewed:z.literal(true),reviewReference:z.string().trim().min(1).max(2048),socketPath:absolute,callerKeyId:z.string(),callerPrivateKeyFile:absolute,runnerKeyId:z.string(),runnerPublicKeyFile:absolute,bindingHash:sha,policyHash:sha,timeoutMs:z.number().int().min(100).max(10000),maxOutputBytes:z.number().int().min(1024).max(262144),binaryHash:sha,schemaHash:sha}).strict();
const signedConfiguration=z.discriminatedUnion('mode',[
 signedBase.extend({mode:z.literal('SIGNED_GROUP_READ_V1'),groupMembersSchemaHash:sha,groupInfoSchemaHash:sha,groupScopes:z.array(groupScopeSchema).min(1).max(32).optional(),caseRosterPolicies:z.array(caseRosterPolicySchema).min(1).max(32).optional(),groupMentionPolicies:z.array(groupMentionRosterPolicySchema).min(1).max(32).optional(),nativeCaseRosterPolicies:z.array(nativeCaseRosterPolicySchema).min(1).max(32).optional(),scheduledGroupPolicies:z.array(scheduledGroupPolicySchema).min(1).max(32).optional()}).superRefine((c,ctx)=>{if(!c.groupScopes?.length&&!c.caseRosterPolicies?.length&&!c.scheduledGroupPolicies?.length&&!c.nativeCaseRosterPolicies?.length&&!c.groupMentionPolicies?.length)ctx.addIssue({code:'custom',message:'GROUP_SCOPE_OR_CASE_ROSTER_POLICY_REQUIRED'});}),
 signedBase.extend({mode:z.literal('SIGNED_DOCUMENT_READ_V1'),documentSchemaHash:sha,documentScopes:z.array(documentScopeSchema).min(1).max(32).optional(),documentPolicies:z.array(documentPolicySchema).min(1).max(32).optional()}).superRefine((c,ctx)=>{if(Boolean(c.documentScopes?.length)===Boolean(c.documentPolicies?.length)||c.executionMode==='PRODUCTION_OFFLINE'&&!c.documentPolicies?.length)ctx.addIssue({code:'custom',message:'DOCUMENT_POLICY_REQUIRED_EXCLUSIVE'});})
]);
async function privateFile(path:string){if(!isAbsolute(path)||await realpath(path)!==path)throw new DwsError('DWS_RPC_CONFIG_UNSAFE');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>262144)throw new DwsError('DWS_RPC_CONFIG_UNSAFE');return await file.readFile('utf8');}finally{await file.close();}}
async function signedReader(path:string){
 const c=signedConfiguration.parse(JSON.parse(await privateFile(path))),test=c.executionMode==='SYNTHETIC_TEST';
 if(test&&(process.env['APP_ENV']!=='test'||process.env['OA_TEST_ISOLATED']!=='true'))throw new DwsError('DWS_SYNTHETIC_FORBIDDEN');
 if(!test){if(process.platform!=='linux'||process.getuid?.()!==10001)throw new DwsError('DWS_PLATFORM_UNCERTIFIED');const platform='linux-'+(process.arch==='arm64'?'arm64':process.arch==='x64'?'amd64':'unsupported');if(c.mode==='SIGNED_GROUP_READ_V1')await assertReviewedGroupReadBinding(c,platform);else await assertReviewedDocumentReadBinding(c,platform);}
 await safeSocketParent(c.socketPath);const client=new SignedDwsReadClient({socketPath:c.socketPath,callerKeyId:c.callerKeyId,callerPrivateKey:rpcKey(await privateFile(c.callerPrivateKeyFile),'private'),runnerKeyId:c.runnerKeyId,runnerPublicKey:rpcKey(await privateFile(c.runnerPublicKeyFile),'public'),bindingHash:c.bindingHash,policyHash:c.policyHash,timeoutMs:c.timeoutMs});
 if(c.mode==='SIGNED_DOCUMENT_READ_V1')return new SignedDocumentReadClient({mode:test?'SYNTHETIC_TEST':'PRODUCTION',binaryHash:c.binaryHash,schemaHash:c.schemaHash,documentSchemaHash:c.documentSchemaHash,timeoutMs:c.timeoutMs,maxOutputBytes:c.maxOutputBytes,signedBindingHash:c.bindingHash,signedPolicyHash:c.policyHash},new SignedDocumentReader(client),snapshotDocumentScopes(c.documentScopes),snapshotDocumentPolicies(c.documentPolicies));
 return new SignedGroupReadClient({mode:test?'SYNTHETIC_TEST':'PRODUCTION',binaryHash:c.binaryHash,schemaHash:c.schemaHash,groupMembersSchemaHash:c.groupMembersSchemaHash,groupInfoSchemaHash:c.groupInfoSchemaHash,timeoutMs:c.timeoutMs,maxOutputBytes:c.maxOutputBytes,signedBindingHash:c.bindingHash,signedPolicyHash:c.policyHash},new SignedGroupAudienceReader(client),snapshotGroupScopes(c.groupScopes),snapshotCaseRosterPolicies(c.caseRosterPolicies),snapshotScheduledGroupPolicies(c.scheduledGroupPolicies),snapshotNativeCaseRosterPolicies(c.nativeCaseRosterPolicies),snapshotGroupMentionPolicies(c.groupMentionPolicies));
}
// The in-process implementation is for isolated tests. Production must first
// use a separately authenticated runner with enforced network and secret scope.
export async function configureDws(db:Database,vault:Vault,env:NodeJS.ProcessEnv=process.env){
 if(env['DWS_ENABLED']!=='true'||!env['DWS_RUNNER_CONFIG_FILE'])return new DwsIdentities(db,vault);
 const path=env['DWS_RUNNER_CONFIG_FILE'],raw=JSON.parse(await privateFile(path));
 if(raw?.mode==='SIGNED_GROUP_READ_V1'||raw?.mode==='SIGNED_DOCUMENT_READ_V1')return new DwsIdentities(db,vault,await signedReader(path));
 configSchema.parse(raw);
 throw new DwsError('DWS_RUNNER_SERVICE_REQUIRED');
}
