import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import type {GroupInfoPayloadProfile} from '../../packages/dws/src/group-contract.js';

// The launcher uses an environment allowlist. Fail closed if invoked unsanitized.
assert.deepEqual(Object.keys(process.env).filter(k => /(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)), []);
const attempts: string[] = [];
const deny = (surface: string) => () => { attempts.push(surface); throw new Error('OFFLINE_IO_DENIED'); };
for (const key of ['connect', 'createConnection'] as const) mock.method(net, key, deny(`net.${key}`));
mock.method(net.Socket.prototype, 'connect', deny('Socket.connect'));
mock.method(net.Server.prototype, 'listen', deny('Server.listen'));
mock.method(tls, 'connect', deny('tls.connect'));
for (const key of ['request', 'get'] as const) {
  mock.method(http, key, deny(`http.${key}`));
  mock.method(https, key, deny(`https.${key}`));
}
mock.method(dgram, 'createSocket', deny('dgram.createSocket'));
for (const key of ['bind', 'send', 'connect'] as const) mock.method(dgram.Socket.prototype, key, deny(`dgram.${key}`));
for (const key of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr',
  'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  mock.method(dns, key, deny(`dns.${key}`));
  mock.method(dns.promises, key, deny(`dns.promises.${key}`));
  mock.method(dns.Resolver.prototype, key, deny(`dns.Resolver.${key}`));
  mock.method(dns.promises.Resolver.prototype, key, deny(`dns.promises.Resolver.${key}`));
}
for (const key of ['lookup', 'lookupService'] as const) {
  mock.method(dns, key, deny(`dns.${key}`));
  mock.method(dns.promises, key, deny(`dns.promises.${key}`));
}
mock.method(globalThis, 'fetch', deny('fetch'));
syncBuiltinESMExports();
// pg is imported solely to deny connections/queries before the actual adapter import.
const {default: pg} = await import('pg');
for (const key of ['connect', 'query'] as const) {
  mock.method(pg.Client.prototype, key, deny(`pg.Client.${key}`));
  mock.method(pg.Pool.prototype, key, deny(`pg.Pool.${key}`));
}
const {projectGroupMembers, projectGroupAudience, groupInfoPayloadProfile} = await import('../../packages/dws/src/group-contract.js');
const {groupMembersReply, groupInfoReply, syntheticGroupInfoProfile} = await import('../support/group-members.js');
assert.deepEqual(attempts, [], 'importing the actual adapter must not attempt IO');
after(() => assert.deepEqual(attempts, [], 'adapter scenarios must attempt zero network/DB operations'));

const groupId = 'cidSynthetic==';
type Reply = ReturnType<typeof groupMembersReply>;
function roster(): Reply {
  const r = groupMembersReply(groupId, ['open-a', 'open-b', 'open-c']);
  r.data.users[0]!.role = '群主';
  r.data.bots.push({openBotId: 'bot-2', openDingtalkId: 'bot-open-2', name: 'synthetic bot two', robotCode: 'robot-2'});
  r.data.counts = {users: 3, bots: 2, total: 5};
  r.data.buckets.bots.count = 2;
  return r;
}
const project = (r: unknown = roster()) => projectGroupMembers(r, groupId);
const info = () => groupInfoReply(3, 2, 'synthetic-r7');
const audience = (before: unknown, afterValue: unknown = before, profile: GroupInfoPayloadProfile = syntheticGroupInfoProfile) =>
  projectGroupAudience(before, project(), afterValue, profile);
const rejectsCode = (fn: () => unknown, code: string) => assert.throws(fn,
  (error: unknown) => error instanceof Error && 'code' in error && error.code === code, code);

test('offline guard blocks network, listeners and database methods without contacting any target', () => {
  const calls = [() => net.connect(1, '127.0.0.1'), () => net.createServer().listen(0),
    () => tls.connect(443, 'example.invalid'), () => http.get('http://example.invalid'),
    () => https.get('https://example.invalid'), () => dns.lookup('example.invalid', () => {}),
    () => dgram.createSocket('udp4'), () => fetch('https://example.invalid'),
    () => Reflect.apply(pg.Client.prototype.connect, null, []), () => Reflect.apply(pg.Pool.prototype.query, null, ['SELECT 1'])];
  for (const call of calls) assert.throws(call, /OFFLINE_IO_DENIED/);
  assert.equal(attempts.length, calls.length);
  attempts.length = 0;
});

test('complete synthetic two-source projection does not certify internal members or grant any authority', () => {
  const observed = audience(info(), structuredClone(info()));
  assert.deepEqual(observed.users, [
    {openDingtalkId: 'open-a', role: '群主'}, {openDingtalkId: 'open-b', role: '普通成员'},
    {openDingtalkId: 'open-c', role: '普通成员'},
  ]);
  assert.deepEqual(observed.bots, [
    {openBotId: 'bot-1', openDingtalkId: 'bot-open', robotCode: 'robot-1'},
    {openBotId: 'bot-2', openDingtalkId: 'bot-open-2', robotCode: 'robot-2'},
  ]);
  assert.equal(observed.platformCountsVerified, true);
  assert.equal(observed.internalMembersVerified, false);
  assert.deepEqual(Object.keys(observed).sort(), ['bots', 'contractVersion', 'conversationId',
    'independentSource', 'internalMembersVerified', 'membershipHash', 'platformCountsVerified', 'users']);
  assert.equal(observed.independentSource.reviewRef, 'synthetic-independent-roster-review');
  assert.deepEqual([observed.independentSource.userCount, observed.independentSource.botCount], [3, 2]);
});

test('same nicknames never collapse distinct stable member identities; name changes do not change the hash', () => {
  const r = roster();
  for (const u of r.data.users) { u.name = '同名成员'; u.nick = '同名成员'; }
  const first = project(r);
  assert.deepEqual(first.users.map(u => u.openDingtalkId), ['open-a', 'open-b', 'open-c']);
  for (const u of r.data.users) { u.name = 'PRIVATE NEW DISPLAY'; u.nick = 'PRIVATE NEW NICK'; }
  for (const b of r.data.bots) b.name = 'PRIVATE BOT DISPLAY';
  const last = project(r);
  assert.equal(last.membershipHash, first.membershipHash);
  assert.ok(!JSON.stringify(last).includes('PRIVATE'));
  r.data.users[1]!.openDingtalkId = 'open-replacement';
  assert.notEqual(project(r).membershipHash, first.membershipHash);
});

test('human and bot ordering, terminal pagination history and display metadata do not change membership hash', () => {
  const r = roster(), saved = structuredClone(r), first = project(r);
  r.data.users.reverse(); r.data.bots.reverse();
  r.data.buckets.users.pagesFetched = 50;
  r.data.nextCursor = 'different-stale-terminal-cursor'; r.data.buckets.users.nextCursor = '';
  assert.equal(project(r).membershipHash, first.membershipHash);
  assert.deepEqual(project(saved), first);
  assert.deepEqual(saved, roster(), 'projectGroupMembers must not mutate the input');
});

for (const field of ['openBotId', 'openDingtalkId', 'robotCode'] as const) test(`bot ${field} changes remain visible in the membership hash`, () => {
  const r = roster(), first = project(r); r.data.bots[1]![field] += '-changed';
  assert.notEqual(project(r).membershipHash, first.membershipHash);
  assert.equal(project(r).internalMembersVerified, false);
});
test('opaque role metadata changes are visible without certifying a platform administrator', () => {
  const r = roster(), first = project(r); r.data.users[0]!.role = 'synthetic delegated administrator';
  const next = project(r); assert.notEqual(next.membershipHash, first.membershipHash);
  assert.equal(next.users[0]!.role, 'synthetic delegated administrator');
  assert.equal(next.internalMembersVerified, false);
});

const incomplete: [string, (r: Reply) => void][] = [
  ['top failure count', r => { r.data.failedCount = 1; }],
  ['top failure record', r => { Object.assign(r.data, {failures: [{error: 'synthetic upstream failure'}]}); }],
  ['nested user failure count', r => { r.data.buckets.users.failedCount = 1; }],
  ['nested user failure record', r => { Object.assign(r.data.buckets.users, {failures: [{code: 'synthetic denied'}]}); }],
  ['nested user partial flag', r => { r.data.buckets.users.partial = true; }],
  ['bot bucket incomplete', r => { r.data.buckets.bots.complete = false; }],
];
for (const [name, change] of incomplete) test(`reject ${name} even with matching independent counts`, () => {
  const r = roster(); change(r); rejectsCode(() => project(r), 'DWS_GROUP_MEMBERS_INCOMPLETE');
});
test('top errors array cannot be hidden by successful complete flags', () => {
  const r = roster(); rejectsCode(() => project({...r, data: {...r.data, errors: [{message: 'synthetic failed page'}]}}), 'DWS_GROUP_MEMBERS_INCOMPLETE');
});
for (const [name, change] of [
  ['user bucket count', (r: Reply) => { r.data.buckets.users.count = 2; }],
  ['human total', (r: Reply) => { r.data.counts.users = 2; }],
  ['bot bucket count', (r: Reply) => { r.data.buckets.bots.count = 1; }],
  ['bot total', (r: Reply) => { r.data.counts.bots = 1; }],
  ['duplicate stable bot ID', (r: Reply) => { r.data.bots[1]!.openBotId = 'bot-1'; }],
] as const) test(`reject ${name} independently of aggregate total`, () => {
  const r = roster(); change(r); rejectsCode(() => project(r), 'DWS_GROUP_MEMBERS_COUNT_MISMATCH');
});
for (const id of ['open a', 'open\u0000a', 'open\u202ea', 'open\u2066a', ' open-a', 'open-a\n']) {
  test(`stable human and bot IDs reject whitespace/control variant ${JSON.stringify(id)}`, () => {
    const human = roster(); human.data.users[1]!.openDingtalkId = id;
    rejectsCode(() => project(human), 'DWS_GROUP_MEMBERS_UNVERIFIED');
    const bot = roster(); bot.data.bots[1]!.openBotId = id;
    rejectsCode(() => project(bot), 'DWS_GROUP_MEMBERS_UNVERIFIED');
  });
}
for (const patch of [{ok: false}, {outcome: 'partial_success'}, {identity: 'app'}, {dry_run: true}]) test(`failed or non-user projection envelope ${JSON.stringify(patch)} rejected`, () => {
  rejectsCode(() => project({...roster(), ...patch}), 'DWS_GROUP_MEMBERS_UNVERIFIED');
});
test('unrecognized sampling and pagination shape cannot be laundered into the pinned CLI contract', () => {
  const r = roster();
  rejectsCode(() => project({...r, data: {...r.data, sampled: true}}), 'DWS_GROUP_MEMBERS_UNVERIFIED');
  for (const pagesFetched of [0, 51, 1.5]) {
    const changed = roster(); changed.data.buckets.users.pagesFetched = pagesFetched;
    rejectsCode(() => project(changed), 'DWS_GROUP_MEMBERS_UNVERIFIED');
  }
});

for (const [name, change] of [
  ['human count', (r: ReturnType<typeof info>) => { r.data.allHumanCount = 4; }],
  ['bot count', (r: ReturnType<typeof info>) => { r.data.allBotCount = 1; }],
  ['revision with unchanged counts', (r: ReturnType<typeof info>) => { r.data.rosterRevision = 'synthetic-r8'; }],
] as const) test(`independent before/after ${name} change rejects a seemingly complete roster`, () => {
  const before = info(), afterValue = info(); change(afterValue);
  rejectsCode(() => audience(before, afterValue), 'DWS_GROUP_ROSTER_CHANGED');
});
test('a changed human or robot roster at equal counts yields a new hash, and its independent revision invalidates an earlier observation', () => {
  const original = roster(), replaced = roster();
  replaced.data.users[1]!.openDingtalkId = 'open-new'; replaced.data.bots[1]!.robotCode = 'robot-new';
  assert.notEqual(project(replaced).membershipHash, project(original).membershipHash);
  rejectsCode(() => projectGroupAudience(info(), project(replaced), groupInfoReply(3, 2, 'synthetic-r8'), syntheticGroupInfoProfile), 'DWS_GROUP_ROSTER_CHANGED');
});
test('independent group identity and type are checked on both sides', () => {
  for (const patch of [{groupId: 'cidWrong=='}, {type: 'PRIVATE_USER'}]) {
    const valid = info(), invalid = {...info(), data: {...info().data, ...patch}};
    rejectsCode(() => audience(invalid, valid), 'DWS_GROUP_INFO_UNVERIFIED');
    rejectsCode(() => audience(valid, invalid), 'DWS_GROUP_INFO_UNVERIFIED');
  }
});
test('independent count fields require bounded integers without coercion', () => {
  for (const [field, values] of [['allHumanCount', [0, 2001, 3.5, '3', null, NaN]],
    ['allBotCount', [-1, 101, 2.5, '2', null, Infinity]]] as const) {
    for (const value of values) { const r = {...info(), data: {...info().data, [field]: value}};
      rejectsCode(() => audience(r), 'DWS_GROUP_INFO_UNVERIFIED'); }
  }
});

function deepProfile(): GroupInfoPayloadProfile {
  return {...syntheticGroupInfoProfile, conversationPointer: '/data/record/groupId', typePointer: '/data/record/type',
    revisionPointer: '/data/record/rosterRevision', userCountPointer: '/data/record/allHumanCount', botCountPointer: '/data/record/allBotCount'};
}
const deepInfo = () => ({ok: true, outcome: 'success', data: {record: {...info().data}}});
for (const signal of [{success: false}, {outcome: 'unknown'}, {outcome: 'partial_failure'},
  {status: 'failure'}, {status: 'failed'}, {status: 'partial_success'}, {status: 'partial_failure'}, {status: 'unknown'}]) {
  test(`nested independent business failure ${JSON.stringify(signal)} rejected on either side`, () => {
    const bad = deepInfo(); Object.assign(bad.data.record, signal);
    rejectsCode(() => audience(bad, deepInfo(), deepProfile()), 'DWS_GROUP_INFO_UNVERIFIED');
    rejectsCode(() => audience(deepInfo(), bad, deepProfile()), 'DWS_GROUP_INFO_UNVERIFIED');
  });
}
test('failed ancestors of each reviewed pointer are rejected, even when leaf values match', () => {
  const profile = {...deepProfile(), userCountPointer: '/data/counts/humans', botCountPointer: '/data/counts/bots'};
  const bad = {...deepInfo(), data: {...deepInfo().data, counts: {humans: 3, bots: 2, error: {message: 'synthetic denied'}}}};
  rejectsCode(() => audience(bad, bad, profile), 'DWS_GROUP_INFO_UNVERIFIED');
});

for (const pointer of ['', 'data/groupId', '/data//groupId', '/data/groupId/', '/data/~2bad', '/data/bad~',
  '/__proto__/groupId', '/data/constructor/groupId', '/data/prototype', '/' + Array(12).fill('record').join('/')]) {
  test(`reviewed profile rejects dangerous or malformed pointer ${JSON.stringify(pointer)}`, () => {
    assert.equal(groupInfoPayloadProfile.safeParse({...syntheticGroupInfoProfile, conversationPointer: pointer}).success, false);
  });
}
test('JSON pointer escaped slash, escaped tilde and single-pass decoding select distinct own properties', () => {
  const profile = {...syntheticGroupInfoProfile, conversationPointer: '/data/group~1id', revisionPointer: '/data/rev~0tag',
    userCountPointer: '/data/~01humans', botCountPointer: '/data/all~1bots'};
  const raw = {ok: true, data: {'group/id': groupId, 'rev~tag': 'synthetic-r7', '~1humans': 3,
    'all/bots': 2, type: 'GROUP', group: {id: 'cidWrong=='}, '/humans': 99}};
  assert.equal(audience(raw, structuredClone(raw), profile).internalMembersVerified, false);
  assert.equal(audience(raw, raw, profile).independentSource.revision, 'synthetic-r7');
});
test('pointer resolution cannot read inherited or array-indexed records', () => {
  const inherited = {ok: true, data: Object.create(info().data)};
  rejectsCode(() => audience(inherited), 'DWS_GROUP_INFO_UNVERIFIED');
  const array = {ok: true, data: [info().data]};
  const profile = {...deepProfile(), conversationPointer: '/data/0/groupId', typePointer: '/data/0/type',
    revisionPointer: '/data/0/rosterRevision', userCountPointer: '/data/0/allHumanCount', botCountPointer: '/data/0/allBotCount'};
  rejectsCode(() => audience(array, array, profile), 'DWS_GROUP_INFO_UNVERIFIED');
});
test('unreviewed independence, revision semantics and count scope cannot be asserted by the profile', () => {
  for (const patch of [{independentFromProjectedRoster: false}, {reviewRef: '   '},
    {revisionMeaning: 'ONLY_HUMAN_CHANGES'}, {countMeaning: 'INTERNAL_HUMANS_ONLY'}, {schemaVersion: 2}]) {
    assert.equal(groupInfoPayloadProfile.safeParse({...syntheticGroupInfoProfile, ...patch}).success, false);
  }
});
test('review reference changes affect profile evidence, not membership identity', () => {
  const first = audience(info()), next = audience(info(), info(), {...syntheticGroupInfoProfile, reviewRef: 'synthetic-second-review'});
  assert.equal(first.membershipHash, next.membershipHash);
  assert.equal(first.independentSource.recordHash, next.independentSource.recordHash);
  assert.notEqual(first.independentSource.profileHash, next.independentSource.profileHash);
});
test('independent evidence hashes ignore display-only payload changes and key insertion order', () => {
  const a = info(), b = {data: {...a.data, displayName: 'PRIVATE INFO DISPLAY'}, outcome: 'success', ok: true};
  assert.equal(audience(a, b).independentSource.recordHash, audience(a).independentSource.recordHash);
  assert.ok(!JSON.stringify(audience(a, b)).includes('PRIVATE'));
});
test('oversized independent records are rejected before certifying otherwise matching counts', () => {
  const r = {...info(), padding: 'x'.repeat(131073)};
  rejectsCode(() => audience(r), 'DWS_GROUP_INFO_UNVERIFIED');
});

// A completed roster must not be certified using an explicitly partial independent
// response. These regression assertions intentionally stay red if the adapter lacks
// the guard; this task is not authorized to repair shared production implementation.
for (const signal of [{partial: true}, {complete: false}, {hasMore: true}]) {
  test(`REGRESSION: independent partial/paged ancestor ${JSON.stringify(signal)} cannot certify all-member counts`, () => {
    const bad = deepInfo(); Object.assign(bad.data.record, signal);
    rejectsCode(() => audience(bad, bad, deepProfile()), 'DWS_GROUP_INFO_UNVERIFIED');
  });
}
