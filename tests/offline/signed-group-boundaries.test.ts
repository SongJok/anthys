import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdtemp, realpath, rm} from 'node:fs/promises';
import {lstatSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import type {DwsState, DwsSubject} from '../../packages/dws/src/contracts.js';
import type {DwsRunner, DwsRunnerConfig} from '../../packages/dws/src/runner.js';
import type {GroupAudienceObservation} from '../../packages/dws/src/group-contract.js';
import type {DwsGroupDelegation, DwsGroupScope, DwsSignedGroupReadRequest, DwsReadPolicy} from '../../packages/dws/src/signed-protocol.js';

assert.deepEqual(Object.keys(process.env).filter(k => /(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)), []);
const sockets = new Set<string>(), deniedIO: string[] = [];
const deny = (surface: string): never => { deniedIO.push(surface); throw new Error('OFFLINE_IO_DENIED'); };
function privateSocket(path: unknown, exists: boolean): boolean {
  if (typeof path !== 'string' || !sockets.has(path)) return false;
  try {
    const parent = dirname(path), dir = lstatSync(parent);
    if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(parent) !== parent || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()) return false;
    if (!exists) return true;
    const socket = lstatSync(path); return socket.isSocket() && (socket.mode & 0o077) === 0;
  } catch { return false; }
}
function connectionPath(args: unknown[]): unknown {
  let first = args[0]; if (Array.isArray(first)) first = first[0];
  return typeof first === 'string' ? first : first && typeof first === 'object' ? Reflect.get(first, 'path') : undefined;
}
const socketConnect = net.Socket.prototype.connect;
mock.method(net.Socket.prototype, 'connect', function(this: net.Socket, ...args: unknown[]) {
  if (!privateSocket(connectionPath(args), true)) deny('Socket.connect');
  return Reflect.apply(socketConnect, this, args);
});
for (const key of ['connect', 'createConnection'] as const) {
  const original = net[key]; mock.method(net, key, (...args: unknown[]) => {
    if (!privateSocket(connectionPath(args), true)) deny(`net.${key}`);
    return Reflect.apply(original, net, args);
  });
}
const listen = net.Server.prototype.listen;
mock.method(net.Server.prototype, 'listen', function(this: net.Server, ...args: unknown[]) {
  if (!privateSocket(connectionPath(args), false)) deny('Server.listen');
  return Reflect.apply(listen, this, args);
});
for (const module of [http, https]) for (const key of ['request', 'get'] as const) {
  const original = module[key]; mock.method(module, key, (...args: unknown[]) => {
    const target = args[0];
    if (module !== http || !target || typeof target !== 'object' || !privateSocket(Reflect.get(target, 'socketPath'), true)
      || !['/v1/challenge', '/v1/read'].includes(String(Reflect.get(target, 'path')))) deny(`http.${key}`);
    return Reflect.apply(original, module, args);
  });
}
mock.method(tls, 'connect', () => deny('tls.connect'));
mock.method(globalThis, 'fetch', () => deny('fetch'));
mock.method(dgram, 'createSocket', () => deny('dgram.createSocket'));
for (const key of ['bind', 'connect', 'send'] as const) mock.method(dgram.Socket.prototype, key, () => deny(`dgram.${key}`));
for (const key of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  mock.method(dns, key, () => deny(`dns.${key}`)); mock.method(dns.promises, key, () => deny(`dns.promises.${key}`));
}
for (const key of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr',
  'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  mock.method(dns.Resolver.prototype, key, () => deny(`dns.Resolver.${key}`));
  mock.method(dns.promises.Resolver.prototype, key, () => deny(`dns.promises.Resolver.${key}`));
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, key, () => deny(`child_process.${key}`));
syncBuiltinESMExports();
const {default: pg} = await import('pg');
for (const key of ['connect', 'query'] as const) {
  mock.method(pg.Client.prototype, key, () => deny(`pg.Client.${key}`));
  mock.method(pg.Pool.prototype, key, () => deny(`pg.Pool.${key}`));
}
const {SignedDwsReadService, readBindingHash} = await import('../../packages/dws/src/signed-service.js');
const {SignedDwsReadClient, postDwsSocket} = await import('../../packages/dws/src/signed-client.js');
const {groupTargetForScope, snapshotGroupScopes, rpcHash, signEnvelope, openEnvelope, challengeSchema, requestSchema,
  responseSchema, groupResultByteLimit} = await import('../../packages/dws/src/signed-protocol.js');
const {projectGroupMembers, projectGroupAudience} = await import('../../packages/dws/src/group-contract.js');
const {groupMembersReply, groupInfoReply, syntheticGroupInfoProfile} = await import('../support/group-members.js');
assert.deepEqual(deniedIO, [], 'target import must perform no IO');
after(() => { assert.deepEqual(deniedIO, []); assert.equal(sockets.size, 0); });

function state(subject: DwsSubject): DwsState {
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  return {schemaVersion: 1, files: {'config/profiles.json': base64({profiles: [subject]}),
    'keychain/dws-cli/dek': base64('SYNTHETIC_DEK'), 'keychain/dws-cli/auth-token.enc': base64('SYNTHETIC_STATE_ONLY')}};
}
type StubRunner = Pick<DwsRunner, 'config' | 'verify' | 'readSelf' | 'readGroupAudience'>;
async function fixture(options: {enabled?: boolean; listen?: boolean; scopeChange?: (s: DwsGroupScope) => void; maxReplayEntries?: number} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'oa-sg-')); await chmod(root, 0o700);
  const socketPath = join(root, 'runner.sock'); sockets.add(socketPath);
  const caller = generateKeyPairSync('ed25519'), signer = generateKeyPairSync('ed25519'), ownerId = randomUUID();
  const delegation: DwsGroupDelegation = {tenantId: randomUUID(), ownerId, identityId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    authEpoch: 1, authorizationVersion: 3, capabilityBindingId: 'dws.group.audience.v1', audience: {kind: 'PRIVATE_USER', id: ownerId},
    subject: {corpId: 'synthetic-corp', userId: 'synthetic-user'}};
  const config: DwsRunnerConfig = {mode: 'SYNTHETIC_TEST', binaryFile: '/unused/offline-binary', root: '/unused/offline-root',
    binaryHash: '1'.repeat(64), schemaHash: '2'.repeat(64), groupMembersSchemaHash: '3'.repeat(64), groupInfoSchemaHash: '4'.repeat(64), timeoutMs: 3000, maxOutputBytes: 128000};
  const scope: DwsGroupScope = {scopeId: randomUUID(), scopeVersion: 7, conversationId: 'cidSynthetic==', delegation: structuredClone(delegation),
    profile: structuredClone(syntheticGroupInfoProfile), binaryHash: config.binaryHash, membersSchemaHash: config.groupMembersSchemaHash!,
    infoSchemaHash: config.groupInfoSchemaHash!, validFrom: Date.now() - 10000, expiresAt: Date.now() + 60000};
  options.scopeChange?.(scope);
  const calls: {phase: string; subject: DwsSubject; args?: unknown; profile?: unknown}[] = [];
  let alter: (o: GroupAudienceObservation) => unknown = o => o;
  let duringRead: (() => void) | undefined;
  const runner: StubRunner = {config,
    verify: async (subject, current) => { calls.push({phase: 'VERIFY', subject}); return {value: {verified: true}, state: structuredClone(current)}; },
    readSelf: async (subject, current) => { calls.push({phase: 'SELF', subject}); return {value: {userId: subject.userId, name: 'synthetic self'}, state: structuredClone(current)}; },
    readGroupAudience: async (subject, current, args, profile) => {
      calls.push({phase: 'GROUP', subject, args: structuredClone(args), profile: structuredClone(profile)}); duringRead?.();
      const raw = groupMembersReply(args.conversationId), info = groupInfoReply();
      const projected = projectGroupAudience(info, projectGroupMembers(raw, args.conversationId), info, profile);
      // Explicit fault injection only; healthy result always comes from real adapters.
      return {value: alter(projected) as GroupAudienceObservation, state: structuredClone(current)};
    }};
  const policy: DwsReadPolicy = {tenantId: delegation.tenantId, corpId: delegation.subject.corpId, policyHash: rpcHash({review: 'synthetic independent policy'}),
    callerKeyId: 'test-caller', callerPublicKey: caller.publicKey, runnerKeyId: 'test-runner', runnerPrivateKey: signer.privateKey,
    maxRequestMs: 3000, maxConcurrent: 4, maxReplayEntries: options.maxReplayEntries ?? 32,
    ...(options.enabled === false ? {} : {groupScopes: [scope]})};
  let service: InstanceType<typeof SignedDwsReadService>;
  try { service = new SignedDwsReadService(runner, policy); if (options.listen !== false) await service.listen(socketPath); }
  catch (error) { sockets.delete(socketPath); await rm(root, {recursive: true, force: true}); throw error; }
  const clientConfig = {socketPath, callerKeyId: 'test-caller', callerPrivateKey: caller.privateKey, runnerKeyId: 'test-runner', runnerPublicKey: signer.publicKey,
    bindingHash: service.bindingHash, policyHash: policy.policyHash, timeoutMs: 3000};
  const client = new SignedDwsReadClient(clientConfig), target = groupTargetForScope(scope);
  const read = () => client.readGroupAudience(delegation, state(delegation.subject), target, AbortSignal.timeout(4000));
  async function signedRequest(): Promise<DwsSignedGroupReadRequest> {
    const nonce = randomUUID(), hello = await postDwsSocket(socketPath, '/v1/challenge', {protocol: 'OA_DWS_READ_V1', nonce}, AbortSignal.timeout(4000));
    const challenge = openEnvelope(hello, 'test-runner', signer.publicKey, challengeSchema), now = Date.now();
    return {type: 'READ_REQUEST', protocol: 'OA_DWS_READ_V1', instanceId: challenge.instanceId, requestId: randomUUID(), bindingHash: service.bindingHash,
      policyHash: policy.policyHash, issuedAt: now, expiresAt: Math.min(now + 2500, challenge.expiresAt), operation: 'READ_GROUP_AUDIENCE',
      delegation: structuredClone(delegation), group: structuredClone(target), state: state(delegation.subject)};
  }
  async function rawRead(raw: unknown) { return openEnvelope(await postDwsSocket(socketPath, '/v1/read', raw, AbortSignal.timeout(4000)), 'test-runner', signer.publicKey, responseSchema); }
  return {root, socketPath, caller, signer, delegation, config, scope, runner, policy, service, clientConfig, client, target, calls, read, signedRequest, rawRead,
    alter: (fn: typeof alter) => { alter = fn; }, duringRead: (fn: () => void) => { duringRead = fn; },
    close: async () => { await service.close(); sockets.delete(socketPath); await rm(root, {recursive: true, force: true}); }};
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && 'code' in error && error.code === code, code);
}
test('offline guard denies TCP/DNS/TLS/fetch, foreign sockets, PG and process creation', () => {
  for (const call of [() => net.connect(1, '127.0.0.1'), () => net.createServer().listen(0), () => net.connect('/var/run/docker.sock'),
    () => http.request({socketPath: '/var/run/docker.sock', path: '/v1/read'}), () => https.get('https://example.invalid'),
    () => dns.lookup('example.invalid', () => {}), () => tls.connect(443), () => fetch('https://example.invalid'),
    () => dgram.createSocket('udp4'), () => Reflect.apply(pg.Client.prototype.connect, null, []),
    () => childProcess.spawn('never-executed')]) assert.throws(call, /OFFLINE_IO_DENIED/);
  assert.equal(deniedIO.length, 11); deniedIO.length = 0;
});
test('actual client -> private Unix IPC -> service -> stub returns bound metadata, not internal/ACL authority', async () => {
  const f = await fixture(); try {
    const result = await f.read(); assert.equal(result.grantsAuthority, false); assert.equal(result.value.internalMembersVerified, false);
    assert.equal(result.value.platformCountsVerified, true); assert.equal(result.value.conversationId, f.target.conversationId);
    assert.equal(result.value.independentSource.profileHash, f.target.profileHash);
    assert.ok(!JSON.stringify(result.value).includes('private')); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.phase, 'GROUP'); assert.deepEqual(f.calls[0]!.subject, f.delegation.subject);
    assert.deepEqual(f.calls[0]!.profile, f.scope.profile);
    assert.deepEqual(Object.keys(f.calls[0]!.args as object).sort(), ['authorizationVersion', 'conversationId', 'requestNonce']);
    assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600); assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
  } finally { await f.close(); }
});
test('default policy/hash and old verify/readSelf wire contracts remain compatible; group is disabled by default', async () => {
  const f = await fixture({enabled: false}); try {
    assert.equal(f.service.bindingHash, rpcHash({protocol: 'OA_DWS_READ_V1', binaryHash: f.config.binaryHash,
      schemaHash: f.config.schemaHash, operations: ['VERIFY_IDENTITY', 'READ_SELF']}));
    assert.equal(readBindingHash(f.runner), readBindingHash(f.runner, []));
    await rejectsCode(f.read(), 'DWS_RPC_SCOPE_MISMATCH'); assert.equal(f.calls.length, 0);
    const legacy = {...f.delegation, capabilityBindingId: 'dws.contact.me.v1' as const};
    assert.equal((await f.client.readSelf(legacy, state(legacy.subject), AbortSignal.timeout(4000))).value.userId, legacy.subject.userId);
    assert.deepEqual((await f.client.verify({...legacy, capabilityBindingId: 'dws.identity.verify.v1'}, state(legacy.subject), AbortSignal.timeout(4000))).value, {verified: true});
    assert.deepEqual(f.calls.map(c => c.phase), ['SELF', 'VERIFY']);
  } finally { await f.close(); }
});
test('group-enabled binding is opt-in and changes with scope snapshot; legacy reads still work on it', async () => {
  const f = await fixture(); try {
    assert.notEqual(f.service.bindingHash, readBindingHash(f.runner)); assert.equal(f.service.bindingHash, readBindingHash(f.runner, [f.scope]));
    const changed = structuredClone(f.scope); changed.scopeVersion++;
    assert.notEqual(f.service.bindingHash, readBindingHash(f.runner, [changed]));
    const legacy = {...f.delegation, capabilityBindingId: 'dws.contact.me.v1' as const};
    assert.equal((await f.client.readSelf(legacy, state(legacy.subject), AbortSignal.timeout(4000))).value.userId, legacy.subject.userId);
  } finally { await f.close(); }
});
test('signed response and actual runner arguments bind the same request nonce, full delegation and fixed group target', async () => {
  const f = await fixture(); try {
    const request = await f.signedRequest(), reply = await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey));
    assert.equal(reply.requestHash, rpcHash(request)); assert.equal(reply.requestId, request.requestId);
    assert.ok(reply.result.ok); if (!reply.result.ok) assert.fail('expected signed metadata result');
    const value = reply.result.value as {delegationHash: string; group: unknown; grantsAuthority: boolean};
    assert.equal(value.delegationHash, rpcHash(request.delegation)); assert.deepEqual(value.group, request.group); assert.equal(value.grantsAuthority, false);
    assert.deepEqual(f.calls[0]!.args, {conversationId: request.group.conversationId,
      authorizationVersion: request.delegation.authorizationVersion, requestNonce: request.requestId});
  } finally { await f.close(); }
});
test('strict finite scope configuration rejects unknown/missing fields, duplicates, invalid windows or owner-private mismatch', async () => {
  const f = await fixture(); try {
    const invalid = [{...f.scope, endpoint: 'https://example.invalid'}, {...f.scope, profile: {...f.scope.profile, arbitrary: true}},
      {...f.scope, expiresAt: f.scope.validFrom}, {...f.scope, delegation: {...f.delegation, audience: {kind: 'GROUP', id: f.delegation.ownerId}}},
      {...f.scope, delegation: {...f.delegation, audience: {kind: 'PRIVATE_USER', id: randomUUID()}}}, {...f.scope, scopeVersion: 0}];
    for (const scope of invalid) assert.throws(() => snapshotGroupScopes([scope]), /DWS_RPC_GROUP_SCOPE_INVALID/);
    assert.throws(() => snapshotGroupScopes([f.scope, f.scope]), /DWS_RPC_GROUP_SCOPE_INVALID/);
    assert.throws(() => snapshotGroupScopes(Array.from({length: 33}, () => ({...f.scope, scopeId: randomUUID()}))), /DWS_RPC_GROUP_SCOPE_INVALID/);
    const changes: ((s: DwsGroupScope) => void)[] = [s => { s.binaryHash = '9'.repeat(64); }, s => { s.delegation.tenantId = randomUUID(); },
      s => { s.delegation.subject.corpId = 'foreign-corp'; }];
    for (const change of changes) {
      const s = structuredClone(f.scope); change(s); assert.throws(() => new SignedDwsReadService(f.runner, {...f.policy, groupScopes: [s]}), /DWS_RPC_GROUP_SCOPE_INVALID/);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('scope/profile/policy mutation after service construction cannot change the approved snapshot or its binding hash', async () => {
  const f = await fixture(); try {
    const before = f.service.bindingHash, expectedProfile = structuredClone(f.scope.profile);
    f.scope.profile.reviewRef = 'UNAPPROVED MUTATION'; f.scope.conversationId = 'cidOther=='; f.scope.delegation.ownerId = randomUUID();
    f.scope.delegation.audience.id = f.scope.delegation.ownerId;
    f.policy.tenantId = randomUUID(); f.policy.maxRequestMs = 1;
    assert.equal((await f.read()).value.conversationId, 'cidSynthetic=='); assert.deepEqual(f.calls[0]!.profile, expectedProfile);
    assert.equal(f.service.bindingHash, before); assert.notEqual(readBindingHash(f.runner, [f.scope]), before);
  } finally { await f.close(); }
});
for (const field of ['tenantId', 'ownerId', 'identityId', 'taskId', 'runId', 'authEpoch', 'authorizationVersion'] as const) {
  test(`signed group delegation ${field} mismatch reaches no runner`, async () => {
    const f = await fixture(); try {
      const request = await f.signedRequest();
      if (field === 'authEpoch' || field === 'authorizationVersion') request.delegation[field]++;
      else request.delegation[field] = randomUUID();
      if (field === 'ownerId') request.delegation.audience.id = request.delegation.ownerId;
      assert.deepEqual((await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey))).result, {ok: false, code: 'DWS_RPC_SCOPE_MISMATCH'});
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
}
for (const field of ['conversationId', 'scopeId', 'scopeVersion', 'scopeHash', 'profileHash', 'binaryHash', 'membersSchemaHash', 'infoSchemaHash'] as const) {
  test(`signed group target ${field} mismatch reaches no runner`, async () => {
    const f = await fixture(); try {
      const request = await f.signedRequest();
      if (field === 'scopeVersion') request.group[field]++;
      else request.group[field] = field === 'scopeId' ? randomUUID() : field === 'conversationId' ? 'cidOther==' : '9'.repeat(64);
      assert.deepEqual((await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey))).result, {ok: false, code: 'DWS_RPC_SCOPE_MISMATCH'});
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
}
test('bad signature, untrusted key, caller mapping/argv/path/write and wrong owner state are rejected without execution', async () => {
  const f = await fixture(); try {
    for (const extra of [{argv: ['im', 'send']}, {endpoint: 'https://example.invalid'}, {profile: f.scope.profile}, {path: '/tmp/forbidden'}, {operation: 'SEND_MESSAGE'}]) {
      const request = await f.signedRequest(); await rejectsCode(f.rawRead(signEnvelope({...request, ...extra}, 'test-caller', f.caller.privateKey)), 'DWS_RPC_TRANSPORT_FAILED');
    }
    let request = await f.signedRequest(); const envelope = signEnvelope(request, 'test-caller', f.caller.privateKey);
    await rejectsCode(f.rawRead({...envelope, signature: 'A'.repeat(86)}), 'DWS_RPC_TRANSPORT_FAILED');
    await rejectsCode(f.rawRead(signEnvelope(request, 'test-caller', generateKeyPairSync('ed25519').privateKey)), 'DWS_RPC_TRANSPORT_FAILED');
    request = await f.signedRequest(); request.state = state({...f.delegation.subject, userId: 'foreign-user'});
    assert.deepEqual((await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey))).result, {ok: false, code: 'DWS_RPC_STATE_INVALID'});
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('expired/future request, stale instance/binding/policy and scope time windows fail closed', async () => {
  const f = await fixture(); try {
    for (const [field, value, code] of [['expiresAt', Date.now() - 1, 'DWS_RPC_EXPIRED'], ['issuedAt', Date.now() + 10000, 'DWS_RPC_EXPIRED'],
      ['instanceId', randomUUID(), 'DWS_RPC_BINDING_CHANGED'], ['bindingHash', '0'.repeat(64), 'DWS_RPC_BINDING_CHANGED'], ['policyHash', '0'.repeat(64), 'DWS_RPC_BINDING_CHANGED']] as const) {
      const request = await f.signedRequest(); Object.assign(request, {[field]: value});
      assert.deepEqual((await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey))).result, {ok: false, code});
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
  for (const scopeChange of [(s: DwsGroupScope) => { s.validFrom = Date.now() + 30000; }, (s: DwsGroupScope) => { s.validFrom = Date.now() - 2000; s.expiresAt = Date.now() - 1; }]) {
    const expired = await fixture({scopeChange}); try { await rejectsCode(expired.read(), 'DWS_RPC_EXPIRED'); assert.equal(expired.calls.length, 0); } finally { await expired.close(); }
  }
});
test('subject/capability/private-audience mismatches cannot be reinterpreted as a group delegation', async () => {
  const f = await fixture(); try {
    for (const patch of [{subject: {...f.delegation.subject, userId: 'other-user'}},
      {audience: {kind: 'PRIVATE_USER', id: randomUUID()}}]) {
      const request = await f.signedRequest(); Object.assign(request.delegation, patch);
      assert.deepEqual((await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey))).result, {ok: false, code: 'DWS_RPC_SCOPE_MISMATCH'});
    }
    for (const patch of [{capabilityBindingId: 'dws.contact.me.v1'}, {audience: {kind: 'GROUP', id: f.delegation.ownerId}}]) {
      const request = await f.signedRequest(); Object.assign(request.delegation, patch);
      await rejectsCode(f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey)), 'DWS_RPC_TRANSPORT_FAILED');
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('a concurrent replay executes exactly once; full nonce storage does not evict the consumed request', async () => {
  const f = await fixture({maxReplayEntries: 1}); try {
    const request = await f.signedRequest(), envelope = signEnvelope(request, 'test-caller', f.caller.privateKey);
    const results = await Promise.all([f.rawRead(envelope), f.rawRead(envelope)]);
    assert.equal(results.filter(r => r.result.ok).length, 1); assert.equal(f.calls.length, 1);
    assert.deepEqual(results.find(r => !r.result.ok)!.result, {ok: false, code: 'DWS_RPC_REPLAY'});
    const next = await f.signedRequest(); assert.deepEqual((await f.rawRead(signEnvelope(next, 'test-caller', f.caller.privateKey))).result, {ok: false, code: 'DWS_RPC_BUSY'});
    assert.deepEqual((await f.rawRead(envelope)).result, {ok: false, code: 'DWS_RPC_REPLAY'}); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
test('runner binary/schema binding changes before or during read reject rather than fall back', async () => {
  const before = await fixture(); try {
    before.config.groupInfoSchemaHash = '8'.repeat(64); await rejectsCode(before.read(), 'DWS_RPC_BINDING_CHANGED'); assert.equal(before.calls.length, 0);
  } finally { await before.close(); }
  const during = await fixture(); try {
    during.duringRead(() => { during.config.binaryHash = '8'.repeat(64); });
    await rejectsCode(during.read(), 'DWS_RPC_BINDING_CHANGED'); assert.equal(during.calls.length, 1);
  } finally { await during.close(); }
});
test('partial, unverified, unknown, mismatched or oversized runner projections are never signed as success', async () => {
  const variants: ((o: GroupAudienceObservation) => unknown)[] = [o => ({...o, partial: true}), o => ({...o, internalMembersVerified: true}),
    o => ({...o, platformCountsVerified: false}), o => ({...o, conversationId: 'cidWrong=='}),
    o => ({...o, membershipHash: '0'.repeat(64)}), o => ({...o, independentSource: {...o.independentSource, profileHash: '0'.repeat(64)}}),
    o => ({...o, independentSource: {...o.independentSource, recordHash: '0'.repeat(64)}}),
    o => ({...o, independentSource: {...o.independentSource, userCount: 3}}), o => ({...o, unexpected: 'SECRET_STDERR'}),
    o => ({...o, padding: 'x'.repeat(groupResultByteLimit + 1)}), o => ({...o, users: [o.users[0], o.users[0]]}),
    o => ({...o, users: o.users.map(u => ({...u, name: 'PRIVATE_DISPLAY'}))})];
  for (const variant of variants) {
    const f = await fixture(); try { f.alter(variant); await rejectsCode(f.read(), 'DWS_RPC_GROUP_RESULT_INVALID'); assert.equal(f.calls.length, 1); }
    finally { await f.close(); }
  }
});
test('expiry during projection validation cannot release a successful metadata response', async () => {
  const f = await fixture(); let restoreClock: (() => void) | undefined;
  try {
    const request = await f.signedRequest();
    f.alter(o => {
      // A JSON-compatible result with a fault-injection getter that advances time
      // after the first completion-time check, during validation of the projection.
      Object.defineProperty(o, 'conversationId', {enumerable: true, get() {
        if (!restoreClock) { const clock = mock.method(Date, 'now', () => f.scope.expiresAt + 1); restoreClock = () => clock.mock.restore(); }
        return f.scope.conversationId;
      }});
      return o;
    });
    const reply = await f.rawRead(signEnvelope(request, 'test-caller', f.caller.privateKey));
    assert.deepEqual(reply.result, {ok: false, code: 'DWS_RPC_EXPIRED'}); assert.equal(f.calls.length, 1);
  } finally { restoreClock?.(); await f.close(); }
});
test('client rejects signed result delegation/target/profile/hash/signature mismatches over real Unix IPC', async () => {
  for (const fault of ['delegation', 'target', 'binary', 'schema', 'profile', 'membership', 'requestHash', 'instance', 'signature', 'authority', 'unknown'] as const) {
    const f = await fixture({listen: false}); let server: ReturnType<typeof http.createServer> | undefined;
    try {
      const instanceId = randomUUID();
      server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let payload: unknown;
        if (req.url === '/v1/challenge') payload = {type: 'CHALLENGE', protocol: 'OA_DWS_READ_V1', nonce: raw.nonce, instanceId,
          bindingHash: f.service.bindingHash, policyHash: f.policy.policyHash, issuedAt: Date.now(), expiresAt: Date.now() + 3000};
        else {
          const request = openEnvelope(raw, 'test-caller', f.caller.publicKey, requestSchema); assert.equal(request.operation, 'READ_GROUP_AUDIENCE');
          if (request.operation !== 'READ_GROUP_AUDIENCE') throw Error('unexpected leaf');
          const info = groupInfoReply(), observation = projectGroupAudience(info, projectGroupMembers(groupMembersReply(), f.target.conversationId), info, f.scope.profile);
          const value = {operation: 'READ_GROUP_AUDIENCE', grantsAuthority: false, delegationHash: rpcHash(request.delegation), group: {...request.group}, observation};
          if (fault === 'delegation') value.delegationHash = '0'.repeat(64);
          if (fault === 'target') value.group.scopeVersion++;
          if (fault === 'binary') value.group.binaryHash = '0'.repeat(64);
          if (fault === 'schema') value.group.membersSchemaHash = '0'.repeat(64);
          if (fault === 'profile') value.observation.independentSource.profileHash = '0'.repeat(64);
          if (fault === 'membership') value.observation.membershipHash = '0'.repeat(64);
          if (fault === 'authority') value.grantsAuthority = true;
          if (fault === 'unknown') Object.assign(value, {privateData: 'SECRET'});
          payload = {type: 'READ_RESPONSE', protocol: 'OA_DWS_READ_V1', instanceId: fault === 'instance' ? randomUUID() : instanceId,
            requestId: request.requestId, requestHash: fault === 'requestHash' ? '0'.repeat(64) : rpcHash(request), result: {ok: true, value, state: request.state}};
        }
        res.writeHead(200, {'content-type': 'application/json', connection: 'close'});
        res.end(JSON.stringify(signEnvelope(payload, 'test-runner', fault === 'signature' ? generateKeyPairSync('ed25519').privateKey : f.signer.privateKey)));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(f.socketPath, () => { server!.removeListener('error', reject); resolve(); });
      }); await chmod(f.socketPath, 0o600);
      const code = fault === 'requestHash' || fault === 'instance' ? 'DWS_RPC_RESPONSE_MISMATCH' : fault === 'signature' ? 'DWS_RPC_SIGNATURE_INVALID' : 'DWS_RPC_GROUP_RESULT_INVALID';
      await rejectsCode(f.read(), code); assert.equal(f.calls.length, 0, 'client must never fall back to a local runner');
    } finally { try { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); } finally { await f.close(); } }
  }
});
