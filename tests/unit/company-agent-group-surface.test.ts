import {randomBytes,randomUUID} from 'node:crypto';
import {Gateway,toolName,type Capability} from '../../packages/gateway/src/index.js';
import {certifiedGroupReadSurface,certifiedGroupReadCheckpoint,isCertifiedGroupRead} from '../../packages/gateway/src/group-read-surface.js';
import {registerGroupCompanyAgent,isGroupCompanyAgent} from '../../packages/company/src/agent-group-capability.js';
import {registerCompanyAgent} from '../../packages/company/src/agent-capability.js';
import type {AgentGroupPilotPolicy} from '../../packages/company/src/agent-group-policy.js';
import {agentTextResult,agentTextResultContract,agentTextDataSchema} from '../../packages/company/src/agent-result.js';
import type {AgentRequestRow} from '../../packages/company/src/agent-requests.js';
import {registerGroupCaseRead,isGroupCaseRead} from '../../packages/groups/src/read-capability.js';
import {checkpointSchema,type Checkpoint} from '../../packages/runtime/src/checkpoint.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import type {ProviderMessage} from '../../packages/provider-glm/src/sse.js';
import type {AgentChatResult} from '../../packages/company/src/agent-chat.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {blocked} from '../../packages/contracts/src/index.js';

const policy=():AgentGroupPilotPolicy=>({schemaVersion:1,kind:'ENTERPRISE_AGENT_GROUP_MENTION_PILOT',id:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),connection:{connectorId:'synthetic.group.surface',endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash('SYNTHETIC_ENDPOINT'),credentialHash:hash('SYNTHETIC_CREDENTIAL'),server:{name:'synthetic-group-agent',version:'1'},toolName:'chat',inputSchemaHash:hash('SYNTHETIC_SCHEMA')},validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',approvalReference:'SYNTHETIC_GROUP_APPROVAL',scope:{id:randomUUID(),topics:['DATA'],questionHashes:[hash('SYNTHETIC question')],readOnlyReviewRef:'SYNTHETIC_READ_ONLY',actorResourceReviewRef:'SYNTHETIC_ACTOR_RESOURCE',resourceReviewRef:'SYNTHETIC_RESOURCE',modelEgressAllowed:true,classification:'INTERNAL'},group:{conversationId:'cidSynthetic==',mode:'MENTION_ONLY',scopeId:randomUUID(),scopeVersion:1,contractId:randomUUID(),contractVersion:1,contractHash:hash('SYNTHETIC_CONTRACT'),membershipHash:hash('SYNTHETIC_MEMBERSHIP'),directoryHash:hash('SYNTHETIC_DIRECTORY'),audienceReviewRef:'SYNTHETIC_AUDIENCE',sharingReviewRef:'SYNTHETIC_SHARING'},budget:{id:randomUUID(),approvalReference:'SYNTHETIC_BUDGET',expiresAt:'2026-12-01T00:00:00.000Z',waitBudgetMs:1200000,maxDispatched:1,maxUnresolved:1,enterpriseCost:'UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE'}});
const callsBlocked:ReturnType<typeof vi.fn>[]=[];
afterEach(()=>{for(const io of callsBlocked.splice(0))expect(io).not.toHaveBeenCalled();});
function fresh(){
 const io=vi.fn(()=>{throw Error('PURE_SURFACE_DATABASE_FORBIDDEN');});callsBlocked.push(io);
 const store={groupAudiences:{},groupCases:{},db:{scope:io},guarded:io} as unknown as RuntimeStore;
 const gateway=new Gateway(store),registry=new Map<string,Capability>(),register=gateway.register.bind(gateway);
 vi.spyOn(gateway,'register').mockImplementation(cap=>{register(cap);registry.set(toolName(cap.id,cap.version),cap);});
 const vault=new Vault(new Map([['1',randomBytes(32)]]),'1'),input=policy(),service=registerGroupCompanyAgent(gateway,vault,input);registerGroupCaseRead(gateway);
 const cap=service.capability,name=toolName(cap.id,cap.version),caseName=toolName('group.case.list','1.0.0'),caseCap=registry.get(caseName)!;
 const row={id:randomUUID(),capability_id:cap.id,tool_version:cap.version,binding_hash:cap.bindingHash,risk:'READ',provider_id:'MCP',connector_id:cap.connectorId,args_hash:hash('SYNTHETIC_ARGS'),state:'VERIFIED'};
 const caseRow={...row,id:randomUUID(),capability_id:caseCap.id,tool_version:caseCap.version,binding_hash:caseCap.bindingHash,provider_id:'CORE',connector_id:'CORE'};
 const assistant:ProviderMessage={role:'assistant',content:null,tool_calls:[{id:'synthetic-call',type:'function',function:{name,arguments:JSON.stringify({message:'SYNTHETIC question'})}}]};
 const answer:ProviderMessage={role:'tool',tool_call_id:'synthetic-call',content:JSON.stringify(blocked('DENIED','RESOURCE_DENIED'))};
 const caseAssistant:ProviderMessage={role:'assistant',content:null,tool_calls:[{id:'synthetic-case-call',type:'function',function:{name:caseName,arguments:JSON.stringify({from:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z',limit:10})}}]};
 const caseAnswer:ProviderMessage={...answer,tool_call_id:'synthetic-case-call'};
 const history=[assistant,answer],check=(messages:unknown=history,rows=[row],r:ReadonlyMap<string,Capability>=registry)=>certifiedGroupReadSurface(r,messages as ProviderMessage[],rows);
 const checkpoint=()=>checkpointSchema.parse({version:1,runId:randomUUID(),taskId:randomUUID(),sessionNo:2,originalGoal:'SYNTHETIC question',reason:'JOURNAL_EXPIRED',authEpoch:1,policyVersion:'synthetic-policy',taskState:'RUNNING',actions:[{id:row.id,capabilityId:cap.id,argsHash:row.args_hash,state:row.state,risk:'READ'}],facts:[],omitted:[],unexecutedCalls:[],blocked:null});
 const verify=(c:Checkpoint,rows=[row],r:ReadonlyMap<string,Capability>=registry)=>certifiedGroupReadCheckpoint(r,c,rows);
 return {input,gateway,vault,service,registry,cap,name,row,caseCap,caseName,caseRow,assistant,answer,caseAssistant,caseAnswer,history,check,checkpoint,verify};
}
function dataReceipt(f:ReturnType<typeof fresh>){
 const row={...f.row,id:randomUUID(),connector_id:f.cap.connectorId!,tool_name:'chat',input_schema_hash:f.input.connection.inputSchemaHash,scope_hash:f.service.scopeHash,response_hash:hash('SYNTHETIC_REPLY')} as unknown as AgentRequestRow;
 const reply:Extract<AgentChatResult,{status:'RESPONSE_RECEIVED'}>={status:'RESPONSE_RECEIVED',localRequestId:row.id,text:'SYNTHETIC unverified reply',textBlocks:['SYNTHETIC unverified reply'],source:{protocol:'MCP',toolName:'chat',inputSchemaHash:row.input_schema_hash,receivedAt:'2026-10-19T00:00:00Z',verification:'UNVERIFIED',notice:'SYNTHETIC receipt only'}};
 return agentTextResultContract.resultSchema.parse(agentTextResult(row,reply));
}
it('certifies only real frozen factory objects registered through the actual Gateway',()=>{
 const f=fresh();expect(f.gateway.describeCapability(f.cap.id,f.cap.version)?.bindingHash).toBe(f.cap.bindingHash);expect(f.cap).toBe(f.registry.get(f.name));expect(Object.isFrozen(f.cap)).toBe(true);expect(isGroupCompanyAgent(f.cap)).toBe(true);expect(isGroupCaseRead(f.caseCap)).toBe(true);expect(isCertifiedGroupRead(f.cap)).toBe(true);expect(isCertifiedGroupRead(undefined)).toBe(false);expect(f.check()).toBe(true);expect(f.check([f.caseAssistant,f.caseAnswer],[f.caseRow])).toBe(true);
 const copied={...f.cap};expect(isCertifiedGroupRead(copied)).toBe(false);expect(f.check(f.history,[f.row],new Map([[f.name,copied]]))).toBe(false);expect(f.check(f.history,[f.row],new Map([[f.name,f.caseCap]]))).toBe(false);
 const {group:_group,...fields}=f.input;const privateService=registerCompanyAgent(new Gateway({} as RuntimeStore),f.vault,{...fields,kind:'ENTERPRISE_AGENT_PRIVATE_PILOT'});expect(isCertifiedGroupRead(privateService.capability)).toBe(false);expect(f.check(f.history,[f.row],new Map([[f.name,privateService.capability]]))).toBe(false);
});
it.each(['binding_hash','provider_id','connector_id','risk','tool_version','capability_id'] as const)('rejects an action row whose %s no longer pins the certified source',field=>{const f=fresh();expect(f.check(f.history,[{...f.row,[field]:'SYNTHETIC_WRONG_PIN'}])).toBe(false);});
it.each(['duplicate-call','wrong-reply-id','missing-reply-id','duplicate-reply','non-assistant','non-function','invalid-argument-json','extra-identity-argument','uncertified-tool','invalid-result-json'] as const)('rejects malformed call/result correlation: %s',kind=>{
 const f=fresh(),h=structuredClone(f.history),call=h[0]!.tool_calls![0]!;
 switch(kind){case'duplicate-call':h[0]!.tool_calls!.push({...call});break;case'wrong-reply-id':h[1]!.tool_call_id='other-call';break;case'missing-reply-id':delete h[1]!.tool_call_id;break;case'duplicate-reply':h.push({...h[1]!});break;case'non-assistant':h[0]!.role='user';break;case'non-function':Reflect.set(call,'type','command');break;case'invalid-argument-json':call.function.arguments='{';break;case'extra-identity-argument':call.function.arguments=JSON.stringify({message:'SYNTHETIC question',actorId:randomUUID()});break;case'uncertified-tool':call.function.name='unregistered-tool';break;case'invalid-result-json':h[1]!.content='{';break;}
 expect(f.check(h)).toBe(false);
});
it('accepts a real host-produced text receipt with its unverified contract and rejects mutated data',()=>{
 const f=fresh(),result=dataReceipt(f),message={...f.answer,content:JSON.stringify(result)};expect(f.check([f.assistant,message])).toBe(true);
 for(const change of [{completeness:'COMPLETE'},{verification:{state:'VERIFIED',method:'SYNTHETIC_FORGED_AUTHORITY'}},{data:{...agentTextDataSchema.parse(result.data),unexpectedAuthority:true}},{data:{...agentTextDataSchema.parse(result.data),text:'SYNTHETIC altered without a matching hash'}}])expect(f.check([f.assistant,{...message,content:JSON.stringify({...result,...change})}])).toBe(false);
});
it('requires the exact bounded no-data failure envelope instead of silently accepting success or extra metadata',()=>{
 const f=fresh();for(const status of ['DENIED','PERMANENT_ERROR','RETRYABLE_ERROR','UNKNOWN'] as const)expect(f.check([f.assistant,{...f.answer,content:JSON.stringify(blocked(status,'RESOURCE_DENIED'))}])).toBe(true);
 for(const result of [{...blocked('DENIED','RESOURCE_DENIED'),evidenceIds:['SYNTHETIC_EVIDENCE']},{...blocked('DENIED','RESOURCE_DENIED'),completeness:'COMPLETE'},{...blocked('DENIED','RESOURCE_DENIED'),authorized:true},{...blocked('DENIED','RESOURCE_DENIED'),remediation:{kind:'RESOURCE_DENIED',requiredScopes:['SYNTHETIC_SCOPE']}},blocked('OK','RESOURCE_DENIED'),blocked('NEEDS_AUTH','RESOURCE_DENIED'),blocked('DENIED','SYNTHETIC_UNKNOWN_REASON')])expect(f.check([f.assistant,{...f.answer,content:JSON.stringify(result)}])).toBe(false);
});
it('allows an admitted but unexecuted call without manufacturing an action or authorization',()=>{const f=fresh();expect(f.check([f.assistant],[])).toBe(true);expect(f.check([],[])).toBe(true);});
it('never combines two separately certified source families in history or persisted rows',()=>{
 const f=fresh();expect(f.check([...f.history,f.caseAssistant,f.caseAnswer],[f.row,f.caseRow])).toBe(false);expect(f.check(f.history,[f.row,f.caseRow])).toBe(false);expect(f.check([f.caseAssistant,f.caseAnswer],[f.row,f.caseRow])).toBe(false);expect(f.check([f.assistant,f.caseAssistant],[])).toBe(false);
});
it('accepts an exact checkpoint action only when its row identity, argument digest, state and source agree',()=>{
 const f=fresh(),c=f.checkpoint();expect(f.verify(c)).toBe(true);
 for(const change of [{id:randomUUID()},{capabilityId:'group.case.list'},{argsHash:hash('SYNTHETIC_OTHER')},{state:'UNKNOWN'},{risk:'PERSONAL_WRITE'}])expect(f.verify({...c,actions:[{...c.actions[0]!,...change}]})).toBe(false);
 expect(f.verify(c,[])).toBe(false);expect(f.verify(c,[{...f.row,provider_id:'CORE'}])).toBe(false);expect(f.verify(c,[f.row],new Map([[f.name,{...f.cap}]]))).toBe(false);
});
it('requires each checkpoint fact to reference the certified source and an actual pinned row',()=>{
 const f=fresh(),c=f.checkpoint(),fact={actionId:f.row.id,argsHash:f.row.args_hash,name:f.name,capabilityId:f.cap.id,version:f.cap.version,bindingHash:f.cap.bindingHash,risk:'READ' as const,resourceId:f.service.resource,args:{message:'SYNTHETIC question'},result:dataReceipt(f),authEpoch:1,policyVersion:'synthetic-policy',audience:{kind:'GROUP',targetId:f.input.group.conversationId}};
 const withFact=checkpointSchema.parse({...c,facts:[fact]});expect(f.verify(withFact)).toBe(true);expect(f.verify({...withFact,facts:[{...fact,name:f.caseName}]})).toBe(false);expect(f.verify({...withFact,facts:[{...fact,actionId:randomUUID()}]})).toBe(false);expect(f.verify(withFact,[{...f.row,binding_hash:hash('SYNTHETIC_OTHER')}])).toBe(false);
});
it('admits only enumerated checkpoint omissions tied to a real certified action',()=>{
 const f=fresh(),c=f.checkpoint();for(const reason of ['RESULT_NOT_VERIFIED','LEGACY_OR_MISSING_PROVENANCE','CURRENT_AUTHORIZATION_OR_SOURCE_CHANGED','INVALID_OR_UNAVAILABLE_PROVENANCE','CONTEXT_BUDGET'])expect(f.verify({...c,omitted:[{actionId:f.row.id,reason}]})).toBe(true);
 expect(f.verify({...c,omitted:[{actionId:f.row.id,reason:'SYNTHETIC_ASSUMED_PERMISSION'}]})).toBe(false);expect(f.verify({...c,omitted:[{actionId:randomUUID(),reason:'CONTEXT_BUDGET'}]})).toBe(false);expect(f.verify({...c,omitted:[{actionId:f.caseRow.id,reason:'CONTEXT_BUDGET'}]},[f.row,f.caseRow])).toBe(false);
});
it('checks every unexecuted call and refuses mixed-family checkpoints',()=>{
 const f=fresh(),c=f.checkpoint();expect(f.verify({...c,unexecutedCalls:[{callId:'pending',name:f.name}]})).toBe(true);expect(f.verify({...c,unexecutedCalls:[{callId:'pending',name:'unregistered'}]})).toBe(false);expect(f.verify({...c,unexecutedCalls:[{callId:'pending',name:f.caseName}]})).toBe(false);
 const caseCheckpoint={...c,actions:[{id:f.caseRow.id,capabilityId:f.caseCap.id,argsHash:f.caseRow.args_hash,state:f.caseRow.state,risk:'READ'}],unexecutedCalls:[{callId:'case-only',name:f.caseName}]};expect(f.verify(caseCheckpoint,[f.caseRow])).toBe(true);expect(f.verify({...caseCheckpoint,actions:[...caseCheckpoint.actions,...c.actions]},[f.row,f.caseRow])).toBe(false);
});
