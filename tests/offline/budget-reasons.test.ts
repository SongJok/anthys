import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';

// Run with an environment allowlist and the repository's explicit network guard.
assert.equal(Reflect.get(globalThis, Symbol.for('anthys.testNetworkGuard')), true);
assert.deepEqual(Object.keys(process.env).filter(key => /(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(key)), []);
const attempts: string[] = [];
const deny = () => { attempts.push('network'); throw new Error('BUDGET_REASONS_OFFLINE_IO_DENIED'); };
for (const method of ['connect', 'createConnection'] as const) mock.method(net, method, deny);
mock.method(net.Socket.prototype, 'connect', deny);
mock.method(net.Server.prototype, 'listen', deny);
mock.method(tls, 'connect', deny);
for (const module of [http, https]) for (const method of ['request', 'get'] as const) mock.method(module, method, deny);
mock.method(globalThis, 'fetch', deny);
mock.method(dgram, 'createSocket', deny);
for (const method of ['bind', 'send', 'connect'] as const) mock.method(dgram.Socket.prototype, method, deny);
for (const method of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] as const) {
  mock.method(dns, method, deny);
  mock.method(dns.promises, method, deny);
}
syncBuiltinESMExports();
// Import only the actual UI mapping, after denying network operations.
const {budgetReasons} = await import('../../apps/web/src/budget-reasons.js');
after(() => assert.deepEqual(attempts, [], 'the mapping import and scenarios must attempt zero network operations'));

test('cache tariff and cache usage errors explain different evidence to check', () => {
  assert.match(budgetReasons.MODEL_CACHE_TARIFF_UNCONFIRMED!, /缓存计价依据尚未确认/);
  assert.match(budgetReasons.MODEL_CACHE_TARIFF_UNCONFIRMED!, /管理员核对缓存费率与计费凭据/);
  assert.match(budgetReasons.MODEL_CACHED_USAGE_INVALID!, /缓存用量数据异常/);
  assert.match(budgetReasons.MODEL_CACHED_USAGE_INVALID!, /管理员核对缓存用量与总输入用量/);
  for (const code of ['MODEL_CACHE_TARIFF_UNCONFIRMED', 'MODEL_CACHED_USAGE_INVALID']) {
    assert.doesNotMatch(budgetReasons[code]!, /额度不足|已结算|已发送|任务已完成/);
  }
});

test('missing or inconsistent usage remains unknown, with a safe next step', () => {
  const text = budgetReasons.MODEL_USAGE_UNAVAILABLE!;
  assert.match(text, /用量缺失或数据不一致/);
  assert.match(text, /费用尚未核实/);
  assert.match(text, /管理员核对服务商用量记录/);
  assert.doesNotMatch(text, /额度不足|已结算|已发送|任务已完成/);
});

test('release rejection covers either settled dimension without claiming all cost is settled', () => {
  const text = budgetReasons.SETTLED_MODEL_COST_CANNOT_BE_RELEASED!;
  assert.match(text, /用量或费用结算记录/);
  assert.match(text, /不能按未发送请求释放额度/);
  assert.match(text, /管理员核对发送状态与结算凭据/);
  assert.match(text, /费用未知部分仍保留预留额度/);
  assert.doesNotMatch(text, /费用已结算|请求已发送|任务已完成/);
});

test('new feedback retains unknown reservations and never suggests another charge or retry', () => {
  for (const code of ['MODEL_CACHE_TARIFF_UNCONFIRMED', 'MODEL_CACHED_USAGE_INVALID', 'MODEL_USAGE_UNAVAILABLE', 'SETTLED_MODEL_COST_CANNOT_BE_RELEASED']) {
    const text = budgetReasons[code]!;
    assert.match(text, /仍保留预留额度/, code);
    assert.match(text, /核对前请勿重试或重复扣费/, code);
    assert.doesNotMatch(text, /自动重试|自动恢复|自动提额|提高额度|无需核对|重新提交/, code);
  }
});

test('all eight existing scope messages retain token, money and reservation semantics', () => {
  for (const [scope, label] of Object.entries({TENANT: '企业', DEPARTMENT: '部门', USER: '个人', TASK: '任务'})) {
    for (const [kind, resource] of Object.entries({TOKEN: '用量', MONEY: '费用'})) {
      assert.equal(budgetReasons[`MODEL_${kind}_BUDGET_EXHAUSTED_${scope}`], `${label}模型${resource}额度不足，任务已暂停；尚未确认的既有用量仍保留额度。`);
    }
  }
  assert.equal(budgetReasons.LEGACY_MODEL_COST_RECONCILIATION_REQUIRED, '既有模型费用尚未核对，后续请求已暂停，请管理员处理。');
  assert.equal(budgetReasons.MODEL_BUDGET_POLICY_UNCONFIGURED, '模型预算配置需要管理员确认，任务已暂停。');
});

test('unknown and unobserved codes remain available to the consumer fallback', () => {
  for (const code of ['UNKNOWN_BUDGET_REASON', 'MODEL_TOKEN_BUDGET_EXHAUSTED_UNKNOWN', 'MODEL_COST_RECONCILIATION_REQUIRED', 'MODEL_COST_CANNOT_BE_RELEASED']) {
    assert.equal(budgetReasons[code], undefined);
  }
});
