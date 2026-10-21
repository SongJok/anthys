import {describe, expect, it} from 'vitest';
import {planGroupReminder} from '../../packages/groups/src/reminder-policy.js';
import type {GroupContract} from '../../packages/groups/src/contract-model.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(now = '2026-10-19T10:00:00Z', timezone = 'UTC') {
  const contract: GroupContract = {schemaVersion: 1, id: 'contract', tenantId: 'tenant', groupId: 'group', version: 1,
    serviceIdentityId: 'service', administratorAuthorization: {actorId: 'admin', evidenceRef: 'unverified-ref'},
    responsibilityScope: ['registered-cases'], sources: {entries: [{kind: 'MENTION', resourceRef: 'mention'}]},
    actions: {allowed: ['case.remind'], prohibited: []},
    workHours: {timezone, windows: [{daysOfWeek: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'}]},
    mentionUserIds: [id(100)], escalationUserIds: [id(101)], validFrom: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z', state: 'ACTIVE', stateUpdatedAt: '2026-01-01T00:00:00Z',
    budget: {currency: 'CNY', maxAmountMinor: 0}, revocation: {method: 'server-revoke'}};
  return {contract, context: {tenantId: 'tenant', groupId: 'group', contractId: 'contract',
    serviceIdentityId: 'service', currentVersion: 1, now: Date.parse(now)},
  cases: [{id: id(1), version: 1, resourceRef: 'resource:one', ownerId: id(100), state: 'OPEN', dueAt: '2026-10-18T00:00:00Z'}],
  usage: {tenantId: 'tenant', groupId: 'group', from: new Date(Date.parse(now) - 48 * 3600000).toISOString(),
    until: now, complete: true, includesAllUnresolved: true,
    notifications: [] as {notificationId: string; at: string; caseIds: string[]; state: string}[]}};
}
const notification = (n: number, caseIds: string[] = [id(1)], state = 'APPLIED_UNVERIFIED', at = '2026-10-19T09:30:00Z') =>
  ({notificationId: id(n + 200), at, caseIds, state});

describe('pure group reminder candidate policy', () => {
  it('returns one bounded digest preserving resources/versions and only permitted owner mentions', () => {
    const input = fixture();
    input.cases.push({...input.cases[0]!, id: id(2), version: 2, resourceRef: 'resource:two', ownerId: id(101)});
    const snapshot = structuredClone(input);
    const plan = planGroupReminder(input);
    expect(plan.status).toBe('CANDIDATE');
    expect(plan.digest?.items.map(c => [c.id, c.version, c.resourceRef])).toEqual([[id(1), 1, 'resource:one'], [id(2), 2, 'resource:two']]);
    expect(plan.digest?.mentions).toEqual([id(100)]);
    expect(plan.digest?.mentionAll).toBe(false);
    expect(plan.notice).toContain('不证明授权');
    expect(plan.notice).toContain('真实持久账本');
    expect(input).toEqual(snapshot);
  });
  it('requires explicit permission and active current contract, never authority from metadata', () => {
    for (const state of ['PAUSED', 'REVOKED', 'EXPIRED'] as const) {
      const input = fixture(); input.contract.state = state;
      expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    }
    const input = fixture(); input.contract.actions.allowed = [];
    expect(planGroupReminder(input).reason).toBe('ACTION_DENIED');
    input.contract.actions.prohibited = ['case.remind'];
    expect(planGroupReminder(input).reason).toBe('ACTION_DENIED');
    input.contract.actions.allowed = ['case.remind'];
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    input.contract.actions.prohibited = []; input.context.currentVersion++;
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    const expired = fixture('2027-01-01T00:00:00Z');
    expect(planGroupReminder(expired).reason).toBe('CONTRACT_DENIED');
  });
  it('handles local work hours with inclusive start/exclusive end', () => {
    expect(planGroupReminder(fixture('2026-10-19T01:00:00Z', 'Asia/Shanghai')).status).toBe('CANDIDATE');
    expect(planGroupReminder(fixture('2026-10-19T10:00:00Z', 'Asia/Shanghai')).reason).toBe('OUTSIDE_WORK_HOURS');
    expect(planGroupReminder(fixture('2026-10-18T02:00:00Z', 'Asia/Shanghai')).reason).toBe('OUTSIDE_WORK_HOURS');
  });
  it('uses preceding weekday after midnight in overnight windows', () => {
    const input = fixture('2026-10-20T00:30:00Z');
    input.contract.workHours.windows = [{daysOfWeek: [1], start: '22:00', end: '02:00'}];
    expect(planGroupReminder(input).status).toBe('CANDIDATE');
    input.context.now = Date.parse('2026-10-20T02:00:00Z'); input.usage.until = '2026-10-20T02:00:00Z';
    expect(planGroupReminder(input).reason).toBe('OUTSIDE_WORK_HOURS');
  });
  it('uses IANA DST wall clocks without inventing an occurrence or sending', () => {
    for (const now of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z']) {
      const input = fixture(now, 'America/Los_Angeles');
      input.contract.workHours.windows = [{daysOfWeek: [7], start: '01:00', end: '02:00'}];
      expect(planGroupReminder(input).status).toBe('CANDIDATE');
    }
    const spring = fixture('2026-03-08T10:30:00Z', 'America/Los_Angeles');
    spring.contract.workHours.windows = [{daysOfWeek: [7], start: '02:00', end: '03:00'}];
    expect(planGroupReminder(spring).reason).toBe('OUTSIDE_WORK_HOURS');
  });
  it('skips unowned, undated, future and non-remindable states including confirmation wait', () => {
    for (const state of ['PROPOSED', 'WAITING_CONFIRMATION', 'RESOLVED', 'CLOSED', 'CANCELLED']) {
      const input = fixture(); input.cases[0]!.state = state;
      expect(planGroupReminder(input).skipped[0]?.reason).toBe('STATE_NOT_REMINDABLE');
    }
    for (const state of ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED']) {
      const input = fixture(); input.cases[0]!.state = state;
      expect(planGroupReminder(input).status).toBe('CANDIDATE');
    }
    const input = fixture();
    expect(planGroupReminder({...input, cases: [{...input.cases[0], ownerId: null}]}).skipped[0]?.reason).toBe('NO_OWNER');
    expect(planGroupReminder({...input, cases: [{...input.cases[0], dueAt: null}]}).skipped[0]?.reason).toBe('NO_DUE_DATE');
    expect(planGroupReminder({...input, cases: [{...input.cases[0], dueAt: '2026-10-20T00:00:00Z'}]}).skipped[0]?.reason).toBe('NOT_DUE');
  });
  it('counts FAILED/SUPPRESSED toward per-case local-day quota with no refund', () => {
    const input = fixture();
    input.usage.notifications = [notification(1, [id(1)], 'FAILED'), notification(2, [id(1)], 'SUPPRESSED')];
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('CASE_DAILY_QUOTA');
    input.contract.limits = {remindersPerCasePerDay: 1}; input.usage.notifications.pop();
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('CASE_DAILY_QUOTA');
    input.contract.limits = {remindersPerCasePerDay: 0}; input.usage.notifications = [];
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('CASE_DAILY_QUOTA');
  });
  it('counts cases by local date, including DST and UTC date differing', () => {
    const input = fixture('2026-10-19T01:00:00Z', 'Asia/Shanghai');
    input.usage.notifications = [notification(1, [id(1)], 'FAILED', '2026-10-18T16:00:00Z'),
      notification(2, [id(1)], 'FAILED', '2026-10-18T17:00:00Z')];
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('CASE_DAILY_QUOTA');
    input.usage.notifications[0]!.at = '2026-10-18T15:59:59Z';
    expect(planGroupReminder(input).status).toBe('CANDIDATE');
  });
  it('counts a multi-case digest only once toward rolling group quota', () => {
    const input = fixture(); input.contract.limits = {summariesPerGroupPerHour: 2};
    input.usage.notifications = [notification(1, [id(2), id(3), id(4), id(5), id(6), id(7)])];
    expect(planGroupReminder(input).status).toBe('CANDIDATE');
    input.usage.notifications.push(notification(2, [id(2)]));
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('GROUP_HOURLY_QUOTA');
    input.usage.notifications[0]!.at = '2026-10-19T09:00:00Z';
    expect(planGroupReminder(input).status).toBe('CANDIDATE');
    input.contract.limits = {summariesPerGroupPerHour: 0};
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('GROUP_HOURLY_QUOTA');
  });
  it('defaults to six group digests per hour and two reminders per case', () => {
    const input = fixture();
    input.usage.notifications = Array.from({length: 6}, (_, n) => notification(n, [id(999)]));
    expect(planGroupReminder(input).skipped[0]?.reason).toBe('GROUP_HOURLY_QUOTA');
    input.usage.notifications.pop();
    expect(planGroupReminder(input).status).toBe('CANDIDATE');
  });
  it('blocks old PENDING/UNKNOWN cases indefinitely and charges each group digest once', () => {
    for (const state of ['PENDING', 'UNKNOWN']) {
      const input = fixture(); input.contract.limits = {summariesPerGroupPerHour: 1};
      input.usage.notifications = [notification(1, [id(1)], state, '2025-01-01T00:00:00Z')];
      expect(planGroupReminder(input).skipped[0]?.reason).toBe('UNRESOLVED_NOTIFICATION');
      input.cases[0]!.id = id(2);
      expect(planGroupReminder(input).skipped[0]?.reason).toBe('GROUP_HOURLY_QUOTA');
    }
  });
  it('deduplicates identical cases/digests and case IDs without multiplying consumption', () => {
    const input = fixture(); input.cases.push(structuredClone(input.cases[0]!));
    input.usage.notifications = [notification(1, [id(1), id(1), id(2)]), notification(1, [id(2), id(1)])];
    const plan = planGroupReminder(input);
    expect(plan.status).toBe('CANDIDATE');
    expect(plan.duplicates).toEqual({cases: 1, notifications: 1});
    expect(plan.digest?.items).toHaveLength(1);
  });
  it('rejects conflicting case versions/content and conflicting notification time/state/content', () => {
    const input = fixture(); input.cases.push({...input.cases[0]!, version: 2});
    expect(planGroupReminder(input).reason).toBe('CONFLICTING_CASE');
    input.cases.pop();
    for (const change of [{state: 'UNKNOWN'}, {at: '2026-10-19T09:31:00Z'}, {caseIds: [id(2)]}]) {
      input.usage.notifications = [notification(1), {...notification(1), ...change}];
      expect(planGroupReminder(input).reason).toBe('CONFLICTING_NOTIFICATION');
    }
  });
  it('requires bound complete 48h coverage plus all historical unresolved notifications', () => {
    const input = fixture();
    for (const change of [{complete: false}, {includesAllUnresolved: false}, {groupId: 'other'}, {tenantId: 'other'},
      {from: '2026-10-18T00:00:00Z'}, {until: '2026-10-19T09:59:59Z'}]) {
      expect(planGroupReminder({...input, usage: {...input.usage, ...change}}).status).toBe('BLOCKED');
    }
    input.usage.notifications = [notification(1, [id(1)], 'FAILED', '2025-01-01T00:00:00Z')];
    expect(planGroupReminder(input).reason).toBe('USAGE_COVERAGE_INVALID');
    input.usage.notifications[0]!.at = '2026-10-19T10:00:01Z';
    expect(planGroupReminder(input).reason).toBe('USAGE_COVERAGE_INVALID');
  });
  it('rejects non-MENTION_ONLY sources and future contract validity without adding capability', () => {
    const input = fixture(); input.contract.sources.mode = 'AUTHORIZED_HISTORY';
    expect(planGroupReminder(input).status).toBe('BLOCKED');
    input.contract.sources.mode = 'MENTION_ONLY'; input.contract.validFrom = '2026-10-20T00:00:00Z';
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    input.contract.validFrom = '2026-01-01T00:00:00Z'; input.contract.mentionUserIds = [];
    expect(planGroupReminder(input).digest?.mentions).toEqual([]);
  });
  it('does not multiply quota for each proposed item in the one resulting digest', () => {
    const input = fixture(); input.contract.limits = {summariesPerGroupPerHour: 1};
    input.cases.push({...input.cases[0]!, id: id(2), resourceRef: 'other'});
    const plan = planGroupReminder(input);
    expect(plan.digest?.items).toHaveLength(2);
    expect(plan.digest?.groups[0]?.caseIds).toEqual([id(1), id(2)]);
    expect(planGroupReminder({...input, cases: [...input.cases].reverse()})).toEqual(plan);
  });
  it('sorts and truncates deterministically without merging resource/version identity', () => {
    const input = fixture();
    input.cases = Array.from({length: 21}, (_, n) => ({...input.cases[0]!, id: id(n + 1), version: n + 1, resourceRef: `r:${n}`})).reverse();
    input.cases[0]!.dueAt = '2026-10-17T00:00:00Z';
    const plan = planGroupReminder(input);
    expect(plan.digest?.items).toHaveLength(20);
    expect(plan.digest?.items[0]?.id).toBe(id(21));
    expect(plan.truncated).toBe(true);
    expect(plan.skipped).toContainEqual({id: id(20), reason: 'DIGEST_ITEM_LIMIT'});
    expect(plan.digest?.groups).toHaveLength(1);
    expect(plan.digest?.groups[0]?.caseIds).toHaveLength(20);
    expect(planGroupReminder({...input, maxItems: 1}).digest?.items).toHaveLength(1);
  });
  it('fails closed for unknown fields, malformed dates/states/timezones and excessive limits', () => {
    const input = fixture();
    for (const bad of [{...input, actorId: id(100)}, {...input, maxItems: 21},
      {...input, cases: [{...input.cases[0], dueAt: '2026-02-30T10:00:00Z'}]},
      {...input, cases: [{...input.cases[0], dueAt: '1'}]},
      {...input, cases: [{...input.cases[0], permission: 'admin'}]},
      {...input, usage: {...input.usage, notifications: [notification(1, [id(1)], 'SENT')]}}]) {
      expect(planGroupReminder(bad).status).toBe('BLOCKED');
    }
    input.contract.workHours.timezone = 'Moon/Base';
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    input.contract.workHours.timezone = 'UTC'; input.contract.limits = {summariesPerGroupPerHour: 7};
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
    input.contract.limits = {}; input.contract.allowMentionAll = true;
    expect(planGroupReminder(input).reason).toBe('CONTRACT_DENIED');
  });
  it('does not inspect getters or accept cyclic/non-data inputs', () => {
    let calls = 0;
    const raw = {get context() {calls++; throw new Error('must not execute');}};
    expect(planGroupReminder(raw).reason).toBe('INVALID_INPUT'); expect(calls).toBe(0);
    const cyclic: {self?: unknown} = {}; cyclic.self = cyclic;
    expect(planGroupReminder(cyclic).reason).toBe('INVALID_INPUT');
    expect(planGroupReminder(null).reason).toBe('INVALID_INPUT');
  });
});
