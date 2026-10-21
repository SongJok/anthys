import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import type {GroupContract, GroupContractContext} from '../../packages/groups/src/contract-model.js';

// These guards precede the dynamic target import. No host, including localhost, is allowed.
const attempts: string[] = [];
const deny = (surface: string) => () => { attempts.push(surface); throw new Error('OFFLINE_NETWORK_DENIED'); };
mock.method(net, 'connect', deny('net.connect'));
mock.method(net, 'createConnection', deny('net.createConnection'));
mock.method(net.Socket.prototype, 'connect', deny('Socket.connect'));
mock.method(net.Server.prototype, 'listen', deny('Server.listen'));
mock.method(tls, 'connect', deny('tls.connect'));
mock.method(http, 'request', deny('http.request'));
mock.method(http, 'get', deny('http.get'));
mock.method(https, 'request', deny('https.request'));
mock.method(https, 'get', deny('https.get'));
mock.method(dgram, 'createSocket', deny('dgram.createSocket'));
mock.method(dgram.Socket.prototype, 'bind', deny('dgram.bind'));
mock.method(dgram.Socket.prototype, 'send', deny('dgram.send'));
mock.method(dgram.Socket.prototype, 'connect', deny('dgram.connect'));
mock.method(dns, 'lookupService', deny('dns.lookupService'));
mock.method(dns.promises, 'lookupService', deny('dns.promises.lookupService'));
const resolverMethods = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const;
for (const key of resolverMethods) {
  mock.method(dns, key, deny(`dns.${key}`));
  mock.method(dns.promises, key, deny(`dns.promises.${key}`));
  mock.method(dns.Resolver.prototype, key, deny(`dns.Resolver.${key}`));
  mock.method(dns.promises.Resolver.prototype, key, deny(`dns.promises.Resolver.${key}`));
}
mock.method(dns, 'lookup', deny('dns.lookup'));
mock.method(dns.promises, 'lookup', deny('dns.promises.lookup'));
mock.method(globalThis, 'fetch', deny('fetch'));
syncBuiltinESMExports();
const {evaluateGroupContract, GROUP_CONTRACT_DEFAULTS} = await import('../../packages/groups/src/contract-model.js');

const context: GroupContractContext = {
  tenantId: 'TENANT_A', groupId: 'G_RELEASE', contractId: 'contract-release',
  serviceIdentityId: 'SERVICE_RELEASE', currentVersion: 3, now: Date.parse('2026-10-17T08:00:00Z'),
};
function minimal(): GroupContract {
  return {
    schemaVersion: 1, id: context.contractId, tenantId: context.tenantId,
    groupId: context.groupId, version: 3, serviceIdentityId: context.serviceIdentityId,
    administratorAuthorization: {actorId: 'CAROL', evidenceRef: 'synthetic-review-only'},
    responsibilityScope: ['Track release blockers submitted to the assistant'],
    sources: {entries: [{kind: 'MENTION', resourceRef: 'synthetic-message'}]},
    actions: {allowed: ['case.record'], prohibited: ['case.assign']},
    workHours: {timezone: 'Asia/Shanghai', windows: [{daysOfWeek: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'}]},
    mentionUserIds: [], escalationUserIds: [],
    validFrom: '2026-10-17T00:00:00Z', expiresAt: '2026-11-17T00:00:00Z',
    state: 'ACTIVE', stateUpdatedAt: '2026-10-17T00:00:00Z',
    budget: {currency: 'CNY', maxAmountMinor: 0}, revocation: {method: 'Authenticated administrator revocation'},
  };
}
function enhanced(mode: 'AUTHORIZED_HISTORY' | 'AUTHORIZED_EVENTS' = 'AUTHORIZED_HISTORY'): GroupContract {
  const d = minimal();
  d.sources = {mode, entries: [{kind: mode === 'AUTHORIZED_HISTORY' ? 'HISTORY' : 'EVENT', resourceRef: 'synthetic-source'}],
    enhanced: {
      authorization: {ref: 'synthetic-enhanced-review', actorId: 'CAROL', tenantId: context.tenantId,
        groupId: context.groupId, serviceIdentityId: context.serviceIdentityId,
        grantedAt: '2026-10-17T00:00:00Z', expiresAt: '2026-11-17T00:00:00Z'},
      notice: {ref: 'synthetic-notice', displayedAt: '2026-10-17T00:00:00Z'},
      window: {from: '2026-10-16T00:00:00Z', to: '2026-10-17T08:00:00Z'}, retentionDays: 7,
    }};
  return d;
}
function denied(d: unknown, code: string, c: unknown = context) {
  const result = evaluateGroupContract(d, c);
  assert.equal(result.status, 'DENIED');
  assert.ok(result.gaps.some(g => g.code === code), JSON.stringify(result));
  assert.ok(result.gaps.every(g => g.path.startsWith('contract') || g.path.startsWith('context')));
}

test('offline guard self-check blocks TCP, TLS, HTTP, DNS, UDP and fetch', () => {
  for (const call of [() => net.connect(1, '127.0.0.1'), () => tls.connect(443, 'example.invalid'),
    () => http.get('http://127.0.0.1'), () => https.get('https://example.invalid'),
    () => dns.lookup('example.invalid', () => {}), () => dgram.createSocket('udp4'),
    () => fetch('https://example.invalid')]) assert.throws(call, /OFFLINE_NETWORK_DENIED/);
  assert.equal(attempts.length, 7);
  attempts.length = 0;
});
after(() => assert.deepEqual(attempts, [], 'target and rule tests must attempt zero network operations'));

test('minimal synthetic contract is eligible only for data rules; defaults are conservative', () => {
  assert.deepEqual(GROUP_CONTRACT_DEFAULTS, {sourceMode: 'MENTION_ONLY', remindersPerCasePerDay: 2,
    summariesPerGroupPerHour: 6, allowMentionAll: false});
  assert.deepEqual(evaluateGroupContract(minimal(), context), {status: 'ELIGIBLE', gaps: []});
  assert.deepEqual(Object.keys(evaluateGroupContract(minimal(), context)).sort(), ['gaps', 'status']);
  assert.ok(Object.isFrozen(GROUP_CONTRACT_DEFAULTS));
});
test('deterministic evaluation does not mutate caller data and does not use wall clock', () => {
  const d = minimal(), before = structuredClone(d);
  const wallClock = mock.method(Date, 'now', () => { throw new Error('WALL_CLOCK_FORBIDDEN'); });
  try {
    assert.deepEqual(evaluateGroupContract(d, context), evaluateGroupContract(d, context));
    assert.deepEqual(d, before);
    denied(d, 'EXPIRED', {...context, now: Date.parse(d.expiresAt)});
  } finally { wallClock.mock.restore(); }
});

for (const key of ['tenantId', 'groupId', 'serviceIdentityId', 'id'] as const) {
  test(`reject wrong ${key}`, () => { const d = minimal(); d[key] = 'OTHER'; denied(d, 'BINDING_MISMATCH'); });
}
for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, 4]) {
  test(`reject invalid or stale version ${version}`, () => {
    const d = minimal(); d.version = version;
    denied(d, Number.isSafeInteger(version) && version > 0 ? 'VERSION_MISMATCH' : 'INVALID_VERSION');
  });
}
for (const key of Object.keys(minimal())) {
  test(`required field ${key} is not silently defaulted`, () => {
    const d = minimal() as unknown as Record<string, unknown>; delete d[key];
    assert.equal(evaluateGroupContract(d, context).status, 'DENIED');
  });
}
for (const state of ['PAUSED', 'REVOKED', 'EXPIRED'] as const) {
  test(`deny current ${state} snapshot`, () => { const d = minimal(); d.state = state; denied(d, 'INACTIVE_CONTRACT'); });
}
test('no invented transition history or permanent revocation latch', () => {
  const d = minimal(); d.state = 'REVOKED'; denied(d, 'INACTIVE_CONTRACT');
  d.state = 'ACTIVE'; assert.equal(evaluateGroupContract(d, context).status, 'ELIGIBLE');
});
const badTimes = ['2026-02-30T00:00:00Z', '2026-10-17', '2026-10-17T00:00:00+08:00',
  '2026-10-17T24:00:00Z', '2026-10-17T00:60:00Z', 'invalid'];
for (const value of badTimes) test(`reject noncanonical UTC timestamp ${value}`, () => {
  const d = minimal(); d.validFrom = value; denied(d, 'INVALID_UTC_TIME');
});
test('inclusive validFrom and exclusive expiry boundaries', () => {
  const d = minimal();
  assert.equal(evaluateGroupContract(d, {...context, now: Date.parse(d.validFrom)}).status, 'ELIGIBLE');
  denied(d, 'NOT_YET_VALID', {...context, now: Date.parse(d.validFrom) - 1});
  assert.equal(evaluateGroupContract(d, {...context, now: Date.parse(d.expiresAt) - 1}).status, 'ELIGIBLE');
  denied(d, 'EXPIRED', {...context, now: Date.parse(d.expiresAt)});
  d.expiresAt = d.validFrom; denied(d, 'INVALID_VALIDITY_WINDOW');
});
for (const now of [undefined, NaN, Infinity, 1.5, 9e15]) test(`reject invalid injected now ${String(now)}`, () => denied(minimal(), 'INVALID_CLOCK', {...context, now}));
for (const zone of ['Mars/Olympus', '+08:00', 'CST', '', ' Asia/Shanghai']) test(`reject invalid or ambiguous timezone ${zone}`, () => {
  const d = minimal(); d.workHours.timezone = zone; denied(d, 'INVALID_TIMEZONE');
});
test('overnight work windows and explicit no work windows are metadata, not scheduling permission', () => {
  const d = minimal(); d.workHours.windows[0]!.start = '22:00'; d.workHours.windows[0]!.end = '06:00';
  assert.equal(evaluateGroupContract(d, context).status, 'ELIGIBLE');
  d.workHours.windows = []; assert.equal(evaluateGroupContract(d, context).status, 'ELIGIBLE');
});
for (const [field, maximum] of [['remindersPerCasePerDay', 2], ['summariesPerGroupPerHour', 6]] as const) {
  for (const value of [maximum + 1, -1, 0.5, NaN, Infinity]) test(`reject ${field}=${value}`, () => {
    const d = minimal(); d.limits = {[field]: value}; denied(d, 'INVALID_LIMIT');
  });
  for (const value of [0, 1, maximum]) test(`accept bounded ${field}=${value}`, () => {
    const d = minimal(); d.limits = {[field]: value}; assert.equal(evaluateGroupContract(d, context).status, 'ELIGIBLE');
  });
}
test('explicit @all cannot grant rights in this slice', () => { const d = minimal(); d.allowMentionAll = true; denied(d, 'MENTION_ALL_UNSUPPORTED'); });
test('prohibited actions override conflicting allowed action metadata', () => {
  const d = minimal(); d.actions.prohibited.push('case.record'); denied(d, 'ACTION_CONFLICT');
});
test('unrecognized fields cannot smuggle administrator or sending authority', () => {
  denied({...minimal(), administrator: true, canSend: true}, 'UNKNOWN_FIELD');
});
test('private DWS conversations are not an available source kind', () => {
  const d = minimal() as unknown as Record<string, unknown>;
  d.sources = {entries: [{kind: 'PRIVATE_DWS', resourceRef: 'private'}]}; denied(d, 'UNSUPPORTED_SOURCE');
});
test('manual imports require an authorization reference', () => {
  const d = minimal(); d.sources.entries = [{kind: 'AUTHORIZED_IMPORT', resourceRef: 'import'}];
  denied(d, 'REQUIRED_TEXT'); d.sources.entries[0]!.authorizationRef = 'synthetic-import-review';
  assert.equal(evaluateGroupContract(d, context).status, 'ELIGIBLE');
});
for (const mode of ['AUTHORIZED_HISTORY', 'AUTHORIZED_EVENTS'] as const) {
  test(`${mode} complete metadata eligible only as data`, () => assert.equal(evaluateGroupContract(enhanced(mode), context).status, 'ELIGIBLE'));
  test(`${mode} without enhanced metadata denied`, () => { const d = enhanced(mode); delete d.sources.enhanced; denied(d, 'INVALID_OBJECT'); });
  test(`${mode} cannot be used by default MENTION_ONLY`, () => { const d = enhanced(mode); delete d.sources.mode; denied(d, 'SOURCE_MODE_MISMATCH'); });
}
for (const key of ['authorization', 'notice', 'window', 'retentionDays'] as const) test(`missing enhanced ${key} denied`, () => {
  const d = enhanced(); delete (d.sources.enhanced as unknown as Record<string, unknown>)[key];
  assert.equal(evaluateGroupContract(d, context).status, 'DENIED');
});
for (const key of ['tenantId', 'groupId', 'serviceIdentityId'] as const) test(`enhanced authorization wrong ${key} denied`, () => {
  const d = enhanced(); d.sources.enhanced!.authorization[key] = 'OTHER'; denied(d, 'BINDING_MISMATCH');
});
test('expired, future and revoked enhanced authorization denied', () => {
  let d = enhanced(); d.sources.enhanced!.authorization.expiresAt = '2026-10-17T08:00:00Z'; denied(d, 'AUTHORIZATION_EXPIRED');
  d = enhanced(); d.sources.enhanced!.authorization.grantedAt = '2026-10-18T00:00:00Z'; denied(d, 'AUTHORIZATION_NOT_YET_VALID');
  d = enhanced(); d.sources.enhanced!.authorization.revokedAt = '2026-10-17T07:00:00Z'; denied(d, 'AUTHORIZATION_REVOKED');
});
test('future notice, inverted source window and invalid retention denied', () => {
  let d = enhanced(); d.sources.enhanced!.notice.displayedAt = '2026-10-18T00:00:00Z'; denied(d, 'NOTICE_NOT_YET_DISPLAYED');
  d = enhanced(); d.sources.enhanced!.window.from = d.sources.enhanced!.window.to; denied(d, 'INVALID_SOURCE_WINDOW');
  for (const n of [0, -1, 0.5, NaN]) { d = enhanced(); d.sources.enhanced!.retentionDays = n; denied(d, 'INVALID_RETENTION'); }
});
test('malformed, empty, unknown and null input fail closed', () => {
  for (const d of [null, undefined, [], 7, {}, {...minimal(), limits: {remindersPerCasePerDay: null}},
    {...minimal(), schemaVersion: 2}, {...minimal(), state: 'UNKNOWN'},
    {...minimal(), workHours: {timezone: 'UTC', windows: [{daysOfWeek: [8], start: '25:00', end: '25:00'}]}},
    {...minimal(), budget: {currency: 'cny', maxAmountMinor: -1}}]) assert.equal(evaluateGroupContract(d, context).status, 'DENIED');
  assert.equal(evaluateGroupContract(minimal(), {}).status, 'DENIED');
});
test('sparse arrays cannot satisfy required source and scope fields', () => {
  const d = minimal(); d.sources.entries = new Array(1);
  assert.equal(evaluateGroupContract(d, context).status, 'DENIED');
  const s = minimal(); s.responsibilityScope = new Array(1);
  assert.equal(evaluateGroupContract(s, context).status, 'DENIED');
});
test('inherited contract metadata cannot satisfy required fields', () => {
  assert.equal(evaluateGroupContract(Object.create(minimal()), context).status, 'DENIED');
});
test('accessor metadata is rejected without invoking caller code', () => {
  const d = minimal();
  Object.defineProperty(d, 'tenantId', {get() { throw new Error('GETTER_MUST_NOT_RUN'); }});
  assert.equal(evaluateGroupContract(d, context).status, 'DENIED');
});
