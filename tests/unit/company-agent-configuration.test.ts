import '../support/isolation.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../../packages/gateway/src/index.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Vault,hash} from '../../packages/storage/src/crypto.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';
import {agentPilotBindings,type AgentPilotPolicy} from '../../packages/company/src/agent-capability.js';
import {formalProfileFingerprint} from '../../packages/config/src/formal-profile.js';
import {agentGroupPilotBindings,type AgentGroupPilotPolicy} from '../../packages/company/src/agent-group-policy.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {configureCompanyAgent} from '../../packages/company/src/agent-configuration.js';
import {AgentTransportError} from '../../packages/company/src/agent-transport.js';

type Service=NonNullable<ReturnType<typeof configureCompanyAgent>>;
type Approval={id:string;version:string;bindingHash:string};
const endpoint='https://synthetic-configuration.invalid/mcp',question='SYNTHETIC exact configuration question';
let directory:string,policyFile:string,policy:AgentPilotPolicy,token:string,gateway:Gateway,vault:Vault,environment:NodeJS.ProcessEnv;
const rejectGlobalFetch=()=>vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('SYNTHETIC_GLOBAL_FETCH_FORBIDDEN');});
let fetcher:ReturnType<typeof vi.fn<typeof fetch>>,globalFetch:ReturnType<typeof rejectGlobalFetch>;
const services:Service[]=[];
function configure(env:NodeJS.ProcessEnv=environment,approved?:readonly Approval[]){
 const service=configureCompanyAgent(gateway,vault,env,fetcher,approved);if(service)services.push(service);return service;
}
async function privateFile(body:Buffer|string=JSON.stringify(policy)){
 await writeFile(policyFile,body,{mode:0o600});await chmod(policyFile,0o600);
}
function expectPrivateFailure(env:NodeJS.ProcessEnv=environment){
 let failure:unknown;try{configure(env);}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(AgentTransportError);expect((failure as AgentTransportError).code).toBe('AGENT_PRIVATE_POLICY_INVALID');
 expect((failure as Error).message).toBe('AGENT_PRIVATE_POLICY_INVALID');
 for(const value of [token,endpoint,question,policyFile])expect((failure as Error).message).not.toContain(value);
 expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
}
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'oa-company-agent-config-'));await chmod(directory,0o700);policyFile=join(directory,'policy.json');token=randomBytes(32).toString('hex');
 vault=new Vault(new Map([['1',randomBytes(32)]]),'1');gateway=new Gateway({} as RuntimeStore);
 policy={schemaVersion:1,kind:'ENTERPRISE_AGENT_PRIVATE_PILOT',id:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),connection:{connectorId:'synthetic.configuration',endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash(endpoint),credentialHash:hash(token),server:{name:'synthetic-configuration-agent',version:'1'},toolName:'chat',inputSchemaHash:agentChatInputSchemaHash({type:'object',properties:{message:{type:'string'},conversationId:{type:'integer'},images:{type:'array',items:{type:'object'}}}})},validFrom:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+300000).toISOString(),approvalReference:'SYNTHETIC_EXPLICIT_CONFIGURATION_APPROVAL',scope:{id:randomUUID(),topics:['CODE','LOG','DATA'],questionHashes:[hash(question)],readOnlyReviewRef:'SYNTHETIC_READ_ONLY_QUESTION_REVIEW',actorResourceReviewRef:'SYNTHETIC_ACTOR_RESOURCE_REVIEW',resourceReviewRef:'SYNTHETIC_BOUNDED_RESOURCE_REVIEW',modelEgressAllowed:true,classification:'RESTRICTED'},budget:{id:randomUUID(),approvalReference:'SYNTHETIC_EXACT_SCOPE_BUDGET_REVIEW',expiresAt:new Date(Date.now()+180000).toISOString(),waitBudgetMs:120000,maxDispatched:2,maxUnresolved:1,enterpriseCost:'UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE'}};
 environment={COMPANY_AGENT_PILOT_POLICY_FILE:policyFile,AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token};
 fetcher=vi.fn<typeof fetch>(async()=>{throw Error('SYNTHETIC_FETCH_FORBIDDEN');});globalFetch=rejectGlobalFetch();await privateFile();
});
afterEach(async()=>{
 try{for(const service of services.splice(0))await service.close();expect(fetcher).not.toHaveBeenCalled();expect(globalFetch).not.toHaveBeenCalled();}
 finally{globalFetch?.mockRestore();if(directory)await rm(directory,{recursive:true,force:true});}
});

it.each(['empty','existing-mcp-only','existing-chat-only','blank-policy'] as const)('defaults disconnected with %s configuration and exposes no capability',mode=>{
 const env:NodeJS.ProcessEnv=mode==='empty'?{}:mode==='existing-mcp-only'?{AIDER_AI_DD_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token}:mode==='existing-chat-only'?{AIDER_AI_DD_CHAT_MCP:endpoint,AIDER_AI_DD_MCP_TOKEN:token}:{...environment,COMPANY_AGENT_PILOT_POLICY_FILE:''};
 expect(configure(env)).toBeUndefined();expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();
});
it('registers valid private policy locally and closes without a poll, database, or HTTP call',async()=>{
 const service=configure();expect(service).toBeDefined();expect(service!.scope).toEqual({tenantId:policy.tenantId,actorId:policy.actorId});
 expect(gateway.describeCapability('company.agent.ask','1.0.0')).toMatchObject({id:'company.agent.ask',version:'1.0.0',provider:'MCP',risk:'READ',bindingHash:agentPilotBindings(policy).bindingHash});
 expect(service!.connectionHash).toBe(agentPilotBindings(policy).connectionHash);expect(service!.policy.connection.endpointHash).toBe(hash(endpoint));expect(service!.policy.connection.credentialHash).toBe(hash(token));
 const publicPins=JSON.stringify({policy:service!.policy,descriptor:gateway.describeCapability('company.agent.ask','1.0.0')});for(const raw of [endpoint,token,question,policyFile])expect(publicPins).not.toContain(raw);
 expect(Object.isFrozen(service!.policy.scope.questionHashes)).toBe(true);expect(fetcher).not.toHaveBeenCalled();await service!.close();
});
it('accepts the inclusive 262144-byte bound without executing a worker',async()=>{
 const json=JSON.stringify(policy);expect(Buffer.byteLength(json)).toBeLessThan(262144);await privateFile(json+' '.repeat(262144-Buffer.byteLength(json)));expect(configure()).toBeDefined();
});
it('rejects a missing policy with the fixed error and no configuration disclosure',()=>{expectPrivateFailure({...environment,COMPANY_AGENT_PILOT_POLICY_FILE:join(directory,'absent.json')});});
it('rejects a directory instead of a private policy file',()=>{expectPrivateFailure({...environment,COMPANY_AGENT_PILOT_POLICY_FILE:directory});});
it('refuses a final-path symlink even when its target is a valid 0600 policy',async()=>{
 const link=join(directory,'linked.json');await symlink(policyFile,link);expectPrivateFailure({...environment,COMPANY_AGENT_PILOT_POLICY_FILE:link});
});
it.each([0o400,0o644,0o666,0o700])('rejects policy mode %i instead of exactly 0600',async mode=>{await chmod(policyFile,mode);expectPrivateFailure();});
it.each([0,1,262145])('rejects a %i-byte policy before registration',async size=>{await privateFile(Buffer.alloc(size,0x20));expectPrivateFailure();});
it.each(['invalid-json','invalid-utf8'] as const)('rejects %s without returning file content',async mode=>{
 await privateFile(mode==='invalid-json'?'{SYNTHETIC_INVALID_JSON':Buffer.from([0xc3,0x28]));expectPrivateFailure();
});
it.each(['unknown-root','unknown-scope','missing-subject','invalid-hash','unreviewed-egress','excess-wait','invalid-window','duplicate-question'] as const)('rejects strict policy schema violation %s',async mode=>{
 const changed=structuredClone(policy) as unknown as Record<string,unknown>,scope=changed['scope'] as Record<string,unknown>,connection=changed['connection'] as Record<string,unknown>,budget=changed['budget'] as Record<string,unknown>;
 if(mode==='unknown-root')changed['endpoint']=endpoint;if(mode==='unknown-scope')scope['userScope']='SYNTHETIC';if(mode==='missing-subject')delete changed['actorId'];if(mode==='invalid-hash')connection['endpointHash']='not-a-sha256';if(mode==='unreviewed-egress')scope['modelEgressAllowed']=false;if(mode==='excess-wait')budget['waitBudgetMs']=1200001;if(mode==='invalid-window')changed['validUntil']=policy.validFrom;if(mode==='duplicate-question')scope['questionHashes']=[hash(question),hash(question)];
 await privateFile(JSON.stringify(changed));expectPrivateFailure();
});
it.each(['endpoint-changed','endpoint-missing','token-changed','token-missing','other-endpoint-only'] as const)('refuses %s existing environment against its exact reviewed hashes',mode=>{
 const env={...environment};if(mode==='endpoint-changed')env['AIDER_AI_DD_CHAT_MCP']=endpoint+'/changed';if(mode==='endpoint-missing')delete env['AIDER_AI_DD_CHAT_MCP'];if(mode==='token-changed')env['AIDER_AI_DD_MCP_TOKEN']=randomBytes(32).toString('hex');if(mode==='token-missing')delete env['AIDER_AI_DD_MCP_TOKEN'];if(mode==='other-endpoint-only'){delete env['AIDER_AI_DD_CHAT_MCP'];env['AIDER_AI_DD_MCP']=endpoint;}
 let failure:unknown;try{configure(env);}catch(error){failure=error;}expect(failure).toBeInstanceOf(AgentTransportError);const expected=['endpoint-missing','other-endpoint-only'].includes(mode)?'AGENT_CONNECTION_MISSING_AIDER_AI_DD_CHAT_MCP':'AGENT_CONNECTION_CONFIGURATION_CHANGED';expect((failure as AgentTransportError).code).toBe(expected);expect((failure as Error).message).toBe(expected);
 for(const raw of [endpoint,token,question,policyFile])expect((failure as Error).message).not.toContain(raw);expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();
});
it.each(['empty','other-capability','wrong-version'] as const)('keeps a FORMAL %s approval list disconnected without opening its policy',mode=>{
 const approved=mode==='empty'?[]:mode==='other-capability'?[{id:'tasks.get',version:'1.0.0',bindingHash:hash('SYNTHETIC_OTHER_BINDING')}]:[{id:'company.agent.ask',version:'2.0.0',bindingHash:hash('SYNTHETIC_WRONG_VERSION')}];
 expect(configure({...environment,COMPANY_AGENT_PILOT_POLICY_FILE:join(directory,'must-not-open.json')},approved)).toBeUndefined();expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();
});
it('keeps a FORMAL mismatched binding disconnected before registration',()=>{
 expect(configure(environment,[{id:'company.agent.ask',version:'1.0.0',bindingHash:hash('SYNTHETIC_UNAPPROVED_BINDING')}])).toBeUndefined();expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();
});
it('registers only the exact FORMAL capability version and binding without fetching upstream',()=>{
 const approved=[{id:'company.agent.ask',version:'1.0.0',bindingHash:agentPilotBindings(policy).bindingHash}];expect(configure(environment,approved)).toBeDefined();expect(fetcher).not.toHaveBeenCalled();
});

function groupConfiguration(){
 const group:AgentGroupPilotPolicy={...policy,kind:'ENTERPRISE_AGENT_GROUP_MENTION_PILOT',scope:{...policy.scope,classification:'INTERNAL'},budget:{...policy.budget,maxDispatched:1},group:{conversationId:'synthetic-approved-group',mode:'MENTION_ONLY',scopeId:randomUUID(),scopeVersion:1,contractId:randomUUID(),contractVersion:1,contractHash:hash('SYNTHETIC CONTRACT'),membershipHash:hash('SYNTHETIC MEMBERS'),directoryHash:hash('SYNTHETIC DIRECTORY'),audienceReviewRef:'SYNTHETIC_NEW_AUDIENCE_REVIEW',sharingReviewRef:'SYNTHETIC_NEW_SHARING_REVIEW'}};
 const formal=formalProfileFingerprint({schemaVersion:2,kind:'FORMAL_GROUP_MENTION_ENTERPRISE',authorizationId:randomUUID(),tenantId:group.tenantId,actorId:group.actorId,sourceTrialProfileHash:hash('SYNTHETIC CLOSED'),corpId:'synthetic-corp',externalUserId:'synthetic-user',robotCode:'synthetic-robot',conversationId:group.group.conversationId,validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+120000).toISOString(),budgetPolicyHash:hash('SYNTHETIC POLICY'),approvalReference:'SYNTHETIC_NEW_FORMAL_REVIEW',modelAllowed:true,modelApprovalReference:'SYNTHETIC_NEW_MODEL_REVIEW',entrypoints:['INGRESS','WORKER','NOTIFIER','API'],inputPolicy:{attachments:false,controls:false},capabilities:[{id:'company.agent.ask',version:'1.0.0',bindingHash:agentGroupPilotBindings(group).bindingHash},{id:'dws.group.audience',version:'1.0.0',bindingHash:hash('SYNTHETIC ROSTER')}],group:{mode:'MENTION_ONLY',contractId:group.group.contractId,contractVersion:1,contractHash:group.group.contractHash,scopeId:group.group.scopeId,scopeVersion:1,membershipHash:group.group.membershipHash,directoryHash:group.group.directoryHash,enterprisePolicyHash:hash(canonical(group)),enterpriseResource:'enterprise-agent:'+group.scope.id,questionHash:hash(question),audienceReviewReference:group.group.audienceReviewRef,sharingReviewReference:group.group.sharingReviewRef,allowStop:true}}).profile;
 return {group,formal};
}
it.each(['private-policy','tenant','actor','conversation','contract','scope','members','directory','question','resource','audience-review','sharing-review','policy-hash','short-window','wider-budget'] as const)('FORMAL group startup rejects %s before registration or any HTTP',async mode=>{
 const {group,formal}=groupConfiguration();if(formal.schemaVersion!==2)throw Error('SYNTHETIC GROUP REQUIRED');
 if(mode==='tenant')formal.tenantId=randomUUID();if(mode==='actor')formal.actorId=randomUUID();if(mode==='conversation')formal.conversationId+='changed';if(mode==='contract')formal.group.contractVersion++;if(mode==='scope')formal.group.scopeVersion++;if(mode==='members')formal.group.membershipHash=hash('changed');if(mode==='directory')formal.group.directoryHash=hash('changed');if(mode==='question')formal.group.questionHash=hash('changed');if(mode==='resource')formal.group.enterpriseResource='enterprise-agent:'+randomUUID();if(mode==='audience-review')formal.group.audienceReviewReference+='changed';if(mode==='sharing-review')formal.group.sharingReviewReference+='changed';if(mode==='policy-hash')formal.group.enterprisePolicyHash=hash('changed');if(mode==='short-window'){group.validUntil=new Date(Date.now()+90000).toISOString();group.budget.expiresAt=new Date(Date.now()+80000).toISOString();}if(mode==='wider-budget')group.budget.maxDispatched=2;if(mode==='short-window'||mode==='wider-budget')formal.group.enterprisePolicyHash=hash(canonical(group));
 const candidate=mode==='private-policy'?policy:group;await privateFile(JSON.stringify(candidate));
 const binding=mode==='private-policy'?agentPilotBindings(policy).bindingHash:agentGroupPilotBindings(group).bindingHash;
 expect(()=>configureCompanyAgent(gateway,vault,environment,fetcher,[{id:'company.agent.ask',version:'1.0.0',bindingHash:binding}],formal)).toThrow('AGENT_FORMAL_GROUP_TARGET_MISMATCH');expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});

it('exact FORMAL group target registers the certified adapter without polling or HTTP',async()=>{
 const {group,formal}=groupConfiguration();await privateFile(JSON.stringify(group));Reflect.set(gateway.store,'groupAudiences',{});
 const service=configureCompanyAgent(gateway,vault,environment,fetcher,formal.capabilities,formal);expect(service).toBeDefined();services.push(service!);expect(service!.policy.kind).toBe('ENTERPRISE_AGENT_GROUP_MENTION_PILOT');expect(gateway.describeCapability('company.agent.ask','1.0.0')?.bindingHash).toBe(agentGroupPilotBindings(group).bindingHash);expect(fetcher).not.toHaveBeenCalled();
});

it('a new policy without endpointKey defaults only to CHAT and retains the same normalized reviewed pins',async()=>{
 const raw=structuredClone(policy) as unknown as {connection:Record<string,unknown>};delete raw.connection['endpointKey'];await privateFile(JSON.stringify(raw));environment['AIDER_AI_DD_MCP']='https://synthetic-other-default.invalid/mcp';const service=configure()!;expect(service.policy.connection.endpointKey).toBe('AIDER_AI_DD_CHAT_MCP');expect(service.bindingHash).toBe(agentPilotBindings(policy).bindingHash);expect(service.policy.connection.endpointHash).toBe(hash(endpoint));
});
it('an explicitly reviewed legacy MCP key remains exact even when CHAT also exists',async()=>{
 policy.connection.endpointKey='AIDER_AI_DD_MCP';await privateFile();const env={...environment,AIDER_AI_DD_MCP:endpoint,AIDER_AI_DD_CHAT_MCP:'https://synthetic-unreviewed-chat.invalid/mcp'},service=configure(env)!;expect(service.policy.connection.endpointKey).toBe('AIDER_AI_DD_MCP');expect(service.bindingHash).toBe(agentPilotBindings(policy).bindingHash);expect(service.policy.connection.endpointHash).toBe(hash(endpoint));
});
it('an omitted-key CHAT default with only another configured endpoint fails with the exact key and zero HTTP',async()=>{
 const raw=structuredClone(policy) as unknown as {connection:Record<string,unknown>};delete raw.connection['endpointKey'];await privateFile(JSON.stringify(raw));const env:NodeJS.ProcessEnv={...environment,AIDER_AI_DD_MCP:endpoint};delete env['AIDER_AI_DD_CHAT_MCP'];expect(()=>configure(env)).toThrow('AGENT_CONNECTION_MISSING_AIDER_AI_DD_CHAT_MCP');expect(gateway.describeCapability('company.agent.ask','1.0.0')).toBeNull();
});
