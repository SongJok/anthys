import {describe, expect, it} from 'vitest';
import {caseRosterPolicySchema, caseRosterDelegationSchema, caseRosterSignedResultSchema,
  caseRosterTargetSchema, snapshotCaseRosterPolicies, caseRosterTargetForPolicy,
  validateCaseRosterDelegation, validateCaseRosterResult, CASE_ROSTER_NOTICE,
  type CaseRosterPolicy, type CaseRosterDelegation} from '../../packages/dws/src/case-roster-protocol.js';
import {groupTargetSchema, groupDelegationSchema, rpcHash} from '../../packages/dws/src/signed-protocol.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-10-19T00:00:00Z');
function policy(): CaseRosterPolicy {
  return {schemaVersion: 1, purpose: 'H5_SESSION', capabilityBindingId: 'dws.group.case-roster.v1',
    principal: {tenantId: id(1), ownerId: id(2), identityId: id(3), authEpoch: 4, authorizationVersion: 5,
      audience: {kind: 'PRIVATE_USER', id: id(2)}, subject: {corpId: 'corp', userId: 'service-A'}},
    contractId: id(10), delegationId: id(11), allowedActions: ['case.read'],
    scopeId: id(6), scopeVersion: 7, conversationId: 'group-8',
    profile: {schemaVersion: 1, reviewRef: 'synthetic-reviewed-profile', conversationPointer: '/conversationId',
      typePointer: '/kind', typeValue: 'GROUP', revisionPointer: '/revision', userCountPointer: '/humans',
      botCountPointer: '/bots', revisionMeaning: 'EVERY_HUMAN_AND_BOT_ROSTER_CHANGE',
      countMeaning: 'ALL_HUMANS_AND_BOTS_INCLUDING_EXTERNAL', independentFromProjectedRoster: true},
    binaryHash: 'a'.repeat(64), membersSchemaHash: 'b'.repeat(64), infoSchemaHash: 'c'.repeat(64),
    validFrom: now - 1000, expiresAt: now + 1000};
}
function delegation(p = policy()): CaseRosterDelegation {
  return {...structuredClone(p.principal), purpose: 'H5_SESSION', capabilityBindingId: 'dws.group.case-roster.v1',
    requester: {actorId: id(20), sessionId: id(21), authEpoch: 22},
    contract: {contractId: p.contractId, delegationId: p.delegationId, version: 1, revisionHash: 'd'.repeat(64)},
    action: 'case.read'};
}
function result(p = policy(), d = delegation(p)) {
  const group = caseRosterTargetForPolicy(p), users = [{openDingtalkId: 'open-A', role: 'owner'}], bots: never[] = [];
  const record = {conversationId: group.conversationId, revision: 'r1', userCount: 1, botCount: 0};
  return {operation: 'READ_GROUP_CASE_ROSTER', grantsAuthority: false, delegationHash: rpcHash(d), group,
    observation: {contractVersion: 'im.group-members.v1', conversationId: group.conversationId, users, bots,
      membershipHash: rpcHash({contractVersion: 'im.group-members.v1', conversationId: group.conversationId, users, bots}),
      internalMembersVerified: false, platformCountsVerified: true,
      independentSource: {reviewRef: p.profile.reviewRef, revision: 'r1', userCount: 1, botCount: 0,
        recordHash: rpcHash(record), profileHash: group.profileHash}}};
}

describe('closed H5 session case roster protocol data', () => {
  it('accepts an exact fixed policy and a different actual H5 requester without claiming authority', () => {
    const p = policy(), d = delegation(p);
    expect(validateCaseRosterDelegation(d, p, {now})).toEqual(d);
    const validated = validateCaseRosterResult(result(p, d), {delegation: d, policy: p, now});
    expect(validated.grantsAuthority).toBe(false);
    expect(validated.value.users[0]?.openDingtalkId).toBe('open-A');
    expect(validated.notice).toBe(CASE_ROSTER_NOTICE);
    expect(validated.notice).toContain('不证明数据库会话');
    expect(validated.notice).toContain('不授予 H5 私有数据访问权');
  });
  it('snapshots independently, deeply freezes policies and rejects duplicate scopes', () => {
    const p = policy(), snapshot = snapshotCaseRosterPolicies([p]);
    p.profile.reviewRef = 'changed';
    expect(snapshot[0]?.profile.reviewRef).toBe('synthetic-reviewed-profile');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.profile)).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.allowedActions)).toBe(true);
    expect(() => snapshotCaseRosterPolicies([policy(), policy()])).toThrow('DWS_RPC_GROUP_SCOPE_INVALID');
    expect(snapshotCaseRosterPolicies(undefined)).toEqual([]);
    expect(() => snapshotCaseRosterPolicies([{}])).toThrow();
    expect(() => snapshotCaseRosterPolicies(Array.from({length: 33}, (_, n) => ({...policy(), scopeId: id(n + 100)})))).toThrow();
  });
  it('uses the compatible strict group target and hashes all fixed policy fields', () => {
    const p = policy(), target = caseRosterTargetForPolicy(p);
    expect(groupTargetSchema.parse(target)).toEqual(target);
    expect(caseRosterTargetSchema.parse(target)).toEqual(target);
    expect(target.scopeHash).toBe(rpcHash(caseRosterPolicySchema.parse(p)));
    const changes = [
      {...p, contractId: id(30)}, {...p, delegationId: id(31)}, {...p, allowedActions: ['case.update']},
      {...p, scopeVersion: 8}, {...p, conversationId: 'different'}, {...p, expiresAt: p.expiresAt + 1},
      {...p, binaryHash: '1'.repeat(64)}, {...p, membersSchemaHash: '2'.repeat(64)}, {...p, infoSchemaHash: '3'.repeat(64)},
      {...p, profile: {...p.profile, reviewRef: 'other'}}, {...p, principal: {...p.principal, authorizationVersion: 6}},
    ];
    for (const other of changes) expect(caseRosterTargetForPolicy(other).scopeHash).not.toBe(target.scopeHash);
  });
  it('rejects mismatched tenant, owner, identity, epochs, subject and owner audience', () => {
    const p = policy(), d = delegation(p);
    for (const change of [{tenantId: id(30)}, {ownerId: id(31)}, {identityId: id(32)}, {authEpoch: 99},
      {authorizationVersion: 99}, {subject: {corpId: 'other', userId: 'service-A'}},
      {subject: {corpId: 'corp', userId: 'requester-B'}}, {audience: {kind: 'PRIVATE_USER', id: id(20)}}]) {
      expect(() => validateCaseRosterDelegation({...d, ...change}, p, {now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    }
    expect(caseRosterPolicySchema.safeParse({...p, principal: {...p.principal, audience: {kind: 'PRIVATE_USER', id: id(20)}}}).success).toBe(false);
  });
  it('pins contract and delegation while explicitly limiting allowed actions', () => {
    const p = policy(), d = delegation(p);
    for (const contract of [{...d.contract, contractId: id(30)}, {...d.contract, delegationId: id(31)}])
      expect(() => validateCaseRosterDelegation({...d, contract}, p, {now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    for (const action of ['case.create', 'case.update'])
      expect(() => validateCaseRosterDelegation({...d, action}, p, {now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    p.allowedActions = ['case.update'];
    expect(validateCaseRosterDelegation({...d, action: 'case.update'}, p, {now}).action).toBe('case.update');
    for (const allowedActions of [undefined, [], ['case.read', 'case.read'], ['question.answer']])
      expect(caseRosterPolicySchema.safeParse({...p, allowedActions}).success).toBe(false);
  });
  it('a historical read/update roster policy cannot authorize escalation, and an explicit new action changes its exact installation hash',()=>{
    const p=policy(),d={...delegation(p),action:'case.escalate' as const};
    const original=caseRosterTargetForPolicy(p).scopeHash;
    for(const allowedActions of [['case.read'],['case.create','case.update'],['case.read','case.create','case.update']] as CaseRosterPolicy['allowedActions'][])
      expect(()=>validateCaseRosterDelegation(d,{...p,allowedActions},{now})).toThrow('DWS_RPC_SCOPE_MISMATCH');
    const reviewed={...p,allowedActions:['case.read','case.escalate'] as CaseRosterPolicy['allowedActions']};
    expect(validateCaseRosterDelegation(d,reviewed,{now}).action).toBe('case.escalate');
    expect(caseRosterTargetForPolicy(reviewed).scopeHash).not.toBe(original);
    expect(caseRosterTargetForPolicy(p).scopeHash).toBe(original);
  });
  it('allows dynamic session dimensions and revision only as signed caller assertions', () => {
    const p = policy(), d = delegation(p);
    const changes = [{...d, requester: {...d.requester, actorId: id(40)}},
      {...d, requester: {...d.requester, sessionId: id(41)}}, {...d, requester: {...d.requester, authEpoch: 42}},
      {...d, contract: {...d.contract, version: 2}}, {...d, contract: {...d.contract, revisionHash: 'e'.repeat(64)}}];
    for (const changed of changes) {
      expect(validateCaseRosterDelegation(changed, p, {now})).toEqual(changed);
      expect(() => validateCaseRosterResult(result(p, d), {delegation: changed, policy: p, now})).toThrow('DWS_RPC_GROUP_RESULT_INVALID');
      expect(validateCaseRosterResult(result(p, changed), {delegation: changed, policy: p, now}).grantsAuthority).toBe(false);
    }
    // No assertion that actor 40 has a real session or is a current group member.
  });
  it('rejects native and extra-field shapes instead of weakening existing native schemas', () => {
    const p = policy(), d = delegation(p);
    for (const change of [{taskId: id(50)}, {runId: id(51)}, {argv: ['read']}, {endpoint: 'https://example.invalid'},
      {purpose: 'NATIVE_RUN'}, {capabilityBindingId: 'dws.group.audience.v1'}])
      expect(caseRosterDelegationSchema.safeParse({...d, ...change}).success).toBe(false);
    expect(groupDelegationSchema.safeParse(d).success).toBe(false);
    expect(caseRosterDelegationSchema.safeParse({...p.principal, taskId: id(50), runId: id(51), capabilityBindingId: 'dws.group.audience.v1'}).success).toBe(false);
    expect(caseRosterPolicySchema.safeParse({...p, approved: true}).success).toBe(false);
    expect(caseRosterDelegationSchema.safeParse({...d, requester: {...d.requester, role: 'ADMIN'}}).success).toBe(false);
    expect(caseRosterDelegationSchema.safeParse({...d, contract: {...d.contract, approved: true}}).success).toBe(false);
  });
  it('enforces validity endpoints and explicit finite clock without obtaining wall time', () => {
    const p = policy(), d = delegation(p);
    expect(validateCaseRosterDelegation(d, p, {now: p.validFrom})).toEqual(d);
    for (const clock of [p.validFrom - 1, p.expiresAt, NaN, Infinity, -1, now + 0.5])
      expect(() => validateCaseRosterDelegation(d, p, {now: clock})).toThrow('DWS_RPC_EXPIRED');
    expect(caseRosterPolicySchema.safeParse({...p, expiresAt: p.validFrom}).success).toBe(false);
    expect(() => validateCaseRosterResult(result(p, d), {delegation: d, policy: p, now: p.expiresAt})).toThrow('DWS_RPC_EXPIRED');
  });
  it('rejects target, scope/version/hash, profile and result delegation tampering', () => {
    const p = policy(), d = delegation(p), r = result(p, d);
    const targets = [{...r.group, conversationId: 'other'}, {...r.group, scopeId: id(60)}, {...r.group, scopeVersion: 99},
      {...r.group, scopeHash: '0'.repeat(64)}, {...r.group, profileHash: '0'.repeat(64)},
      {...r.group, binaryHash: '0'.repeat(64)}, {...r.group, membersSchemaHash: '0'.repeat(64)}, {...r.group, infoSchemaHash: '0'.repeat(64)}];
    for (const group of targets) expect(() => validateCaseRosterResult({...r, group}, {delegation: d, policy: p, now})).toThrow();
    for (const change of [{delegationHash: '0'.repeat(64)}, {grantsAuthority: true}, {operation: 'READ_GROUP_AUDIENCE'},
      {published: true}, {group: {...r.group, endpoint: 'bad'}}])
      expect(() => validateCaseRosterResult({...r, ...change}, {delegation: d, policy: p, now})).toThrow();
  });
  it('requires complete consistent independent observation and rejects arbitrary source assertions', () => {
    const p = policy(), d = delegation(p), r = result(p, d), o = r.observation;
    for (const observation of [{...o, internalMembersVerified: true}, {...o, platformCountsVerified: false},
      {...o, membershipHash: '0'.repeat(64)}, {...o, users: [...o.users, ...o.users]},
      {...o, independentSource: {...o.independentSource, userCount: 2}},
      {...o, independentSource: {...o.independentSource, recordHash: '0'.repeat(64)}},
      {...o, partial: true}]) {
      expect(caseRosterSignedResultSchema.safeParse({...r, observation}).success).toBe(false);
    }
    const wrongReview = {...r, observation: {...o, independentSource: {...o.independentSource, reviewRef: 'unapproved'}}};
    expect(() => validateCaseRosterResult(wrongReview, {delegation: d, policy: p, now})).toThrow();
  });
  it('binds action changes in result even when both actions are explicitly installed', () => {
    const p = policy(); p.allowedActions = ['case.read', 'case.create'];
    const d = delegation(p), changed = {...d, action: 'case.create'};
    expect(validateCaseRosterDelegation(changed, p, {now}).action).toBe('case.create');
    expect(() => validateCaseRosterResult(result(p, d), {delegation: changed, policy: p, now})).toThrow();
  });
});
