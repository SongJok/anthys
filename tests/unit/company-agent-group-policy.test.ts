import {randomUUID} from 'node:crypto';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
import {agentPilotPolicySchema} from '../../packages/company/src/agent-capability.js';
import {agentTextResultContract} from '../../packages/company/src/agent-result.js';
import {agentGroupPilotPolicySchema,agentGroupPilotBindings,type AgentGroupPilotPolicy} from '../../packages/company/src/agent-group-policy.js';
const policy=():AgentGroupPilotPolicy=>({schemaVersion:1,kind:'ENTERPRISE_AGENT_GROUP_MENTION_PILOT',id:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),connection:{connectorId:'synthetic.group',endpointKey:'AIDER_AI_DD_CHAT_MCP',endpointHash:hash('SYNTHETIC_ENDPOINT'),credentialHash:hash('SYNTHETIC_CREDENTIAL'),server:{name:'synthetic-group-agent',version:'1'},toolName:'chat',inputSchemaHash:hash('SYNTHETIC_INPUT_SCHEMA')},validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',approvalReference:'SYNTHETIC_GROUP_PILOT_APPROVAL',scope:{id:randomUUID(),topics:['CODE','LOG','DATA'],questionHashes:[hash('SYNTHETIC exact group question')],readOnlyReviewRef:'SYNTHETIC_READ_ONLY_REVIEW',actorResourceReviewRef:'SYNTHETIC_ACTOR_RESOURCE_REVIEW',resourceReviewRef:'SYNTHETIC_RESOURCE_REVIEW',modelEgressAllowed:true,classification:'INTERNAL'},group:{conversationId:'cidSyntheticGroup==',mode:'MENTION_ONLY',scopeId:randomUUID(),scopeVersion:1,contractId:randomUUID(),contractVersion:1,contractHash:hash('SYNTHETIC_GROUP_CONTRACT'),membershipHash:hash('SYNTHETIC_MEMBERSHIP'),directoryHash:hash('SYNTHETIC_DIRECTORY'),audienceReviewRef:'SYNTHETIC_AUDIENCE_REVIEW',sharingReviewRef:'SYNTHETIC_GROUP_SHARING_REVIEW'},budget:{id:randomUUID(),approvalReference:'SYNTHETIC_GROUP_BUDGET_REVIEW',expiresAt:'2026-12-01T00:00:00.000Z',waitBudgetMs:1200000,maxDispatched:1,maxUnresolved:1,enterpriseCost:'UNKNOWN_ACCEPTED_FOR_EXACT_SCOPE'}});
const rejected=(raw:unknown)=>expect(agentGroupPilotPolicySchema.safeParse(raw).success).toBe(false);
it('parses only an explicit group mention policy and never grants authorization',()=>{
 const input=policy(),parsed=agentGroupPilotPolicySchema.parse(input),pins=agentGroupPilotBindings(input);expect(parsed).toEqual(input);expect(parsed).not.toBe(input);
 expect(Object.keys(pins).sort()).toEqual(['policy','upstreamHash','connectionHash','scopeHash','budgetHash','bindingHash','resource'].sort());expect(pins.resource).toBe('enterprise-agent:'+input.scope.id);expect(pins.upstreamHash).toBe(input.connection.endpointHash);expect(agentPilotPolicySchema.safeParse(input).success).toBe(false);
 rejected({...input,kind:'ENTERPRISE_AGENT_PRIVATE_PILOT'});const {group:_group,...missing}=input;rejected(missing);
});
it.each(['root','scope','group','budget','connection','server'] as const)('rejects unknown %s fields, including supplied authority',place=>{
 const input=policy(),raw=structuredClone(input) as unknown as Record<string,unknown>;
 if(place==='root')raw['authorized']=true;else if(place==='server')(raw['connection'] as {server:Record<string,unknown>}).server['verified']=true;else(raw[place] as Record<string,unknown>)['members']=[{admin:true}];rejected(raw);
});
it.each(['AUTHORIZED_HISTORY','AUTHORIZED_EVENTS','PRIVATE_USER','mention_only',''] as const)('refuses group source mode %s',mode=>{const input=policy();rejected({...input,group:{...input.group,mode}});});
it.each(['PUBLIC','CONFIDENTIAL','RESTRICTED','internal',''] as const)('refuses classification %s instead of the explicit INTERNAL ceiling',classification=>{const input=policy();rejected({...input,scope:{...input.scope,classification}});});
it('keeps conversation text exact while rejecting blank/overlength values',()=>{
 const input=policy();for(const conversationId of ['', ' ', '\t\n', 'x'.repeat(257)])rejected({...input,group:{...input.group,conversationId}});
 expect(agentGroupPilotPolicySchema.parse({...input,group:{...input.group,conversationId:'x'.repeat(256)}}).group.conversationId).toHaveLength(256);
 expect(agentGroupPilotPolicySchema.parse({...input,group:{...input.group,conversationId:' cidExact '}}).group.conversationId).toBe(' cidExact ');
});
it.each(['scopeVersion','contractVersion'] as const)('bounds %s to positive safe integers',field=>{
 const input=policy();for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])rejected({...input,group:{...input.group,[field]:value}});
 expect(agentGroupPilotPolicySchema.safeParse({...input,group:{...input.group,[field]:Number.MAX_SAFE_INTEGER}}).success).toBe(true);
});
it('requires every group binding and independent bounded review reference',()=>{
 const input=policy();for(const field of Object.keys(input.group)){const group={...input.group} as Record<string,unknown>;delete group[field];rejected({...input,group});}
 for(const field of ['scopeId','contractId'])rejected({...input,group:{...input.group,[field]:'not-a-uuid'}});
 for(const contractHash of ['A'.repeat(64),'a'.repeat(63),'g'.repeat(64)])rejected({...input,group:{...input.group,contractHash}});
 for(const field of ['audienceReviewRef','sharingReviewRef'])for(const value of ['', 'x'.repeat(7), 'x'.repeat(1025)])rejected({...input,group:{...input.group,[field]:value}});
});
it('inherits strict private subject, review, egress, topic, and exact-question limits',()=>{
 const input=policy();rejected({...input,tenantId:'other-tenant'});rejected({...input,actorId:'other-owner'});rejected({...input,approvalReference:'short'});
 for(const change of [{modelEgressAllowed:false},{topics:[]},{topics:['CODE','CODE']},{topics:['WRITE']},{questionHashes:[]},{questionHashes:[input.scope.questionHashes[0],input.scope.questionHashes[0]]},{questionHashes:['invalid']},{questionHashes:Array.from({length:1001},(_,i)=>hash(String(i)))}])rejected({...input,scope:{...input.scope,...change}});
 expect(agentGroupPilotPolicySchema.safeParse({...input,scope:{...input.scope,questionHashes:Array.from({length:1000},(_,i)=>hash(String(i)))}}).success).toBe(true);
});
it('retains the private policy cross-field window checks instead of dropping refinements',()=>{
 const input=policy();rejected({...input,validUntil:input.validFrom});rejected({...input,validFrom:input.validUntil});rejected({...input,budget:{...input.budget,expiresAt:input.validFrom}});rejected({...input,budget:{...input.budget,expiresAt:'2028-01-01T00:00:00.000Z'}});
 expect(agentGroupPilotPolicySchema.safeParse({...input,budget:{...input.budget,expiresAt:input.validUntil}}).success).toBe(true);rejected({...input,validFrom:'not-a-date'});
});
it('bounds wait and quotas without inventing a clock, known cost, or automatic retry',()=>{
 const input=policy();for(const waitBudgetMs of [0,-1,1.5,1200001,NaN,Infinity])rejected({...input,budget:{...input.budget,waitBudgetMs}});for(const waitBudgetMs of [1,1200000])expect(agentGroupPilotPolicySchema.safeParse({...input,budget:{...input.budget,waitBudgetMs}}).success).toBe(true);
 for(const [field,max] of [['maxDispatched',1000],['maxUnresolved',8]] as const){for(const value of [0,-1,1.5,max+1])rejected({...input,budget:{...input.budget,[field]:value}});expect(agentGroupPilotPolicySchema.safeParse({...input,budget:{...input.budget,[field]:max}}).success).toBe(true);}
 rejected({...input,budget:{...input.budget,enterpriseCost:'ZERO'}});expect(agentGroupPilotPolicySchema.safeParse(input).success).toBe(true);
});
it('binds every group field and original subject to scope and capability summaries',()=>{
 const input=policy(),base=agentGroupPilotBindings(input);
 const changes=[{conversationId:'cidOther=='},{scopeId:randomUUID()},{scopeVersion:2},{contractId:randomUUID()},{contractVersion:2},{contractHash:hash('SYNTHETIC_NEW_CONTRACT')},{membershipHash:hash('SYNTHETIC_NEW_MEMBERSHIP')},{directoryHash:hash('SYNTHETIC_NEW_DIRECTORY')},{audienceReviewRef:'SYNTHETIC_NEW_AUDIENCE_REVIEW'},{sharingReviewRef:'SYNTHETIC_NEW_SHARING_REVIEW'}];
 for(const change of changes){const next=agentGroupPilotBindings({...input,group:{...input.group,...change}});expect(next.scopeHash).not.toBe(base.scopeHash);expect(next.bindingHash).not.toBe(base.bindingHash);expect(next.budgetHash).toBe(base.budgetHash);}
 for(const change of [{tenantId:randomUUID()},{actorId:randomUUID()}]){const next=agentGroupPilotBindings({...input,...change});expect(next.scopeHash).not.toBe(base.scopeHash);expect(next.bindingHash).not.toBe(base.bindingHash);}
});
it('keeps cumulative budget identity across scope/expiry/alias edits and physical upstream identity across aliases',()=>{
 const input=policy(),base=agentGroupPilotBindings(input),changed=structuredClone(input);changed.scope.questionHashes.push(hash('SYNTHETIC second question'));changed.validUntil='2027-02-01T00:00:00.000Z';changed.connection.connectorId='synthetic.alias';
 const next=agentGroupPilotBindings(changed);expect(next.budgetHash).toBe(base.budgetHash);expect(next.upstreamHash).toBe(base.upstreamHash);expect(next.connectionHash).not.toBe(base.connectionHash);expect(next.scopeHash).not.toBe(base.scopeHash);
 expect(agentGroupPilotBindings({...input,budget:{...input.budget,id:randomUUID()}}).budgetHash).not.toBe(base.budgetHash);expect(agentGroupPilotBindings({...input,connection:{...input.connection,endpointHash:hash('SYNTHETIC_NEW_UPSTREAM')}}).upstreamHash).not.toBe(base.upstreamHash);
 expect(base.budgetHash).toBe(hash(canonical({tenantId:input.tenantId,budgetId:input.budget.id})));
});
it('matches exact canonical scope/binding formulas and ignores object key insertion order',()=>{
 const input=policy(),base=agentGroupPilotBindings(input);
 expect(base.scopeHash).toBe(hash(canonical({id:input.id,tenantId:input.tenantId,actorId:input.actorId,connectionHash:base.connectionHash,scope:input.scope,group:input.group,validFrom:input.validFrom,validUntil:input.validUntil,approvalReference:input.approvalReference})));
 expect(base.bindingHash).toBe(hash(canonical({id:'company.agent.ask',version:'1.0.0',policy:input,outputSchema:agentTextResultContract.outputSchema})));
 const reversed=Object.fromEntries(Object.entries(input).reverse()) as AgentGroupPilotPolicy;expect(agentGroupPilotBindings(reversed)).toEqual(base);
});
it('returns deep-frozen independent policy pins without external I/O or authority side effects',()=>{
 const input=policy(),blocked=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('SYNTHETIC_FETCH_FORBIDDEN');});
 try{const base=agentGroupPilotBindings(input);expect(Object.isFrozen(base.policy)).toBe(true);expect(Object.isFrozen(base.policy.group)).toBe(true);expect(Object.isFrozen(base.policy.connection.server)).toBe(true);expect(Object.isFrozen(base.policy.scope.questionHashes)).toBe(true);
  expect(()=>base.policy.scope.questionHashes.push(hash('SYNTHETIC_MUTATION'))).toThrow(TypeError);expect(()=>{base.policy.group.contractVersion=2;}).toThrow(TypeError);expect(()=>{base.policy.scope.classification='INTERNAL';}).toThrow(TypeError);
  input.group.conversationId='cidCallerChanged==';input.scope.questionHashes.push(hash('SYNTHETIC_CALLER_MUTATION'));expect(base.policy.group.conversationId).toBe('cidSyntheticGroup==');expect(base.policy.scope.questionHashes).toHaveLength(1);expect(blocked).not.toHaveBeenCalled();
 }finally{blocked.mockRestore();}
});

it.each(['membershipHash','directoryHash'] as const)('requires an exact reviewed %s even when scope version and review reference are unchanged',field=>{const input=policy(),group={...input.group};delete (group as Partial<typeof group>)[field];rejected({...input,group});rejected({...input,group:{...input.group,[field]:'invalid'}});});
