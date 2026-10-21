import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ArtifactsFlow, ArtifactRequestFailure, createArtifactsTransport, artifactFormats, artifactToolDraftNotice, artifactMime, artifactViewLifetimeMs, validArtifactTarget, canShowTaskArtifacts, type ArtifactMetadata, type ArtifactTransport, type ArtifactFormat } from '../../apps/web/src/artifacts-flow.js';
const taskId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333', otherTask = '44444444-4444-4444-8444-444444444444', otherRun = '55555555-5555-4555-8555-555555555555', key = '66666666-6666-4666-8666-666666666666';
const now = Date.parse('2026-10-19T07:00:00.000Z'), iso = new Date(now).toISOString(), bytes = Uint8Array.from(Buffer.from('Actual safe file')), digest = createHash('sha256').update(bytes).digest('hex');
const metadata = (overrides: Partial<ArtifactMetadata> = {}): ArtifactMetadata => ({ id, taskId, runId, format: 'pdf', mime: artifactMime.pdf, fileName: 'result.pdf', byteSize: bytes.byteLength, sha256: digest, createdAt: iso, source: { mode: 'VERIFIED_TASK_RESULT', classification: 'INTERNAL', verification: 'VERIFIED', asOf: iso, notice: '仅基于本次运行已核验资料。' }, ...overrides });
const token = 'A'.repeat(43);
const ticket = (overrides: Record<string, unknown> = {}) => ({ ticket: token, expiresAt: new Date(now + 30000).toISOString(), artifactId: id, sha256: digest, byteSize: bytes.byteLength, ...overrides });
const page = (items: unknown[] = [metadata()], asOf = iso) => ({ items, asOf });
function deferred<T = unknown>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function transport(request: ArtifactTransport['request'] = async () => page(), download: ArtifactTransport['download'] = async () => ({ bytes, mime: artifactMime.pdf }), grant: ArtifactTransport['request'] = async () => ticket()): ArtifactTransport { return { request: (path, input) => path.endsWith('/download-ticket') ? grant(path, input) : request(path, input), download }; }
const flow = (t = transport(), clock = () => now) => new ArtifactsFlow(t, { taskId, runId }, () => key, clock);
const signal = () => new AbortController().signal;
const fetchStub = (fn: (input: string, init: RequestInit) => Response | Promise<Response>) => ((input, init) => Promise.resolve(fn(String(input), init ?? {}))) as typeof fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
test('reads strict READY-only metadata for the current task and filters other runs', async () => {
    const f = flow(transport(async () => page([metadata(), metadata({ id: key, runId: otherRun })])));
    assert.equal((await f.read())?.ok, true);
    assert.deepEqual(f.items.map(i => i.id), [id]);
    assert.equal(f.canCreate, true);
    assert.equal(f.downloadHref(id), `/api/v1/artifacts/${id}/download`);
    assert.equal(f.downloadHref('https://evil.invalid'), null);
    assert.equal(f.snapshot?.asOf, iso);
});
test('retains honest partial and unverified source qualifiers rather than inventing verification', async () => {
    for (const verification of ['VERIFIED', 'PARTIAL', 'UNVERIFIED'] as const) {
        const item = metadata();
        item.source.verification = verification;
        const f = flow(transport(async () => page([item])));
        assert.equal((await f.read())?.ok, true);
        assert.equal(f.items[0]?.source.verification, verification);
        assert.equal(f.items[0]?.source.notice, item.source.notice);
    }
});
test('creates exactly once on double click, binds run and format, and sends no body text or identity', async () => {
    const pending = deferred(), calls: {
        path: string;
        request: Parameters<ArtifactTransport['request']>[1];
    }[] = [];
    const f = flow(transport(async (path, request) => { calls.push({ path, request }); return request.method === 'GET' ? page() : pending.promise; }));
    await f.read();
    const first = f.create('pdf');
    assert.equal(f.busy, true);
    assert.deepEqual(f.items, []);
    assert.equal(await f.create('pdf'), null);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.path, `/api/v1/tasks/${taskId}/artifacts`);
    assert.deepEqual(calls[1]?.request.body, { runId, format: 'pdf' });
    assert.equal(calls[1]?.request.key, key);
    assert.ok(calls[1]?.request.signal instanceof AbortSignal);
    pending.resolve({ artifact: metadata(), replayed: false });
    assert.equal((await first)?.ok, true);
    assert.equal(f.receipt?.artifact.id, id);
    assert.equal(f.busy, false);
});
test('accepts replayed receipts as the same generation rather than claiming a new external action', async () => {
    const f = flow(transport(async (_p, r) => r.method === 'GET' ? page() : { artifact: metadata(), replayed: true }));
    await f.read();
    const outcome = await f.create('pdf');
    assert.equal(outcome?.ok, true);
    assert.match(outcome!.notice, /同一次生成/);
    assert.equal(f.receipt?.replayed, true);
});
test('all eight API formats use exact MIME, including md mapped to the renderer markdown format by the server', async () => {
    for (const format of artifactFormats) {
        const item = metadata({ format, mime: artifactMime[format], fileName: 'result.' + format });
        const f = flow(transport(async (_p, r) => r.method === 'GET' ? page([]) : { artifact: item, replayed: false }));
        await f.read();
        assert.equal((await f.create(format))?.ok, true);
        assert.equal(f.items[0]?.format, format);
    }
});
test('invalid targets and local create values never dispatch a request or leave old entries', async () => {
    assert.equal(validArtifactTarget(taskId, runId), true);
    assert.equal(validArtifactTarget('../private', runId), false);
    assert.throws(() => new ArtifactsFlow(transport(), { taskId: 'bad', runId }));
    let calls = 0;
    const f = flow(transport(async () => { calls++; return page(); }));
    assert.equal((await f.create('pdf'))?.ok, false);
    assert.equal(calls, 0);
    await f.read();
    assert.equal((await f.create('exe' as ArtifactFormat))?.ok, false);
    assert.equal(calls, 1);
    assert.deepEqual(f.items, []);
    assert.equal(f.resultUnknown, false);
});
test('strict metadata rejects unknown states, forged permission/URL fields, invalid sizes and hashes', async () => {
    const values: unknown[] = [{ ...metadata(), state: 'BLOCKED' }, { ...metadata(), state: 'READY' }, { ...metadata(), authorized: true }, { ...metadata(), downloadUrl: 'https://evil' }, metadata({ mime: 'text/html' }), metadata({ fileName: '../result.pdf' }), metadata({ fileName: 'result.html' }), metadata({ fileName: 'CON.pdf' }), metadata({ byteSize: 0 }), metadata({ byteSize: 8388609 }), metadata({ sha256: 'x'.repeat(64) }), metadata({ id: 'not-uuid' }), metadata({ createdAt: 'yesterday' }), { ...metadata(), source: { ...metadata().source, verification: 'UNKNOWN' } }, { ...metadata(), source: { ...metadata().source, acl: 'public' } }];
    for (const value of values) {
        const f = flow(transport(async () => page([value])));
        assert.equal((await f.read())?.ok, false);
        assert.equal(f.snapshot, null);
        assert.equal(f.downloadHref(id), null);
    }
});
test('rejects wrong task, duplicate IDs, stale/future lists, future metadata and unknown list keys', async () => {
    const values = [page([metadata({ taskId: otherTask })]), page([metadata(), metadata()]), page([], new Date(now - 60001).toISOString()), page([], new Date(now + 5001).toISOString()), page([metadata({ createdAt: new Date(now + 5001).toISOString() })]), { ...page(), status: 'READY' }];
    for (const value of values) {
        const f = flow(transport(async () => value));
        assert.equal((await f.read())?.ok, false);
        assert.equal(f.snapshot, null);
    }
});
test('malformed or mismatched create receipts become unknown and cannot expose downloads', async () => {
    const values = [{ artifact: metadata({ taskId: otherTask }), replayed: false }, { artifact: metadata({ runId: otherRun }), replayed: false }, { artifact: metadata({ format: 'txt', mime: artifactMime.txt, fileName: 'result.txt' }), replayed: false }, { artifact: metadata(), replayed: 'true' }, { artifact: metadata(), replayed: false, state: 'READY' }, { artifact: { ...metadata(), state: 'FAILED' }, replayed: false }];
    for (const value of values) {
        const f = flow(transport(async (_p, r) => r.method === 'GET' ? page() : value));
        await f.read();
        assert.equal((await f.create('pdf'))?.ok, false);
        assert.equal(f.receipt, null);
        assert.equal(f.snapshot, null);
        assert.equal(f.resultUnknown, true);
        assert.equal(f.downloadHref(id), null);
        assert.equal(await f.create('pdf'), null);
    }
});
test('explicit 401/403/409/413/422 failures clear old entries without optimistic READY or automatic retry', async () => {
    for (const status of [401, 403, 409, 413, 422]) {
        let calls = 0;
        const f = flow(transport(async (_p, r) => { calls++; if (r.method === 'GET')
            return page(); throw new ArtifactRequestFailure(status); }));
        await f.read();
        const outcome = await f.create('pdf');
        assert.equal(outcome?.ok, false);
        assert.equal(outcome?.sessionLost, status === 401 ? true : undefined);
        assert.deepEqual(f.items, []);
        assert.equal(f.receipt, null);
        assert.equal(f.resultUnknown, false);
        assert.equal(f.canCreate, false);
        assert.equal(calls, 2);
    }
});
test('unknown/network/503 creates require explicit reconciliation and never automatically resend even after a list read', async () => {
    for (const error of [Error('network lost'), new ArtifactRequestFailure(503)]) {
        let writes = 0;
        const f = flow(transport(async (_p, r) => { if (r.method === 'GET')
            return page(); writes++; throw error; }));
        await f.read();
        assert.equal((await f.create('pdf'))?.ok, false);
        assert.equal(f.resultUnknown, true);
        assert.equal(await f.create('pdf'), null);
        await f.read();
        assert.equal(f.items.length, 1);
        assert.equal(f.canCreate, false);
        assert.equal(await f.create('pdf'), null);
        assert.equal(writes, 1);
    }
});
test('read failures and session loss discard previous metadata', async () => {
    for (const status of [401, 403, 503]) {
        let reads = 0;
        const f = flow(transport(async () => { if (++reads === 1)
            return page(); throw new ArtifactRequestFailure(status); }));
        await f.read();
        const outcome = await f.read();
        assert.equal(outcome?.ok, false);
        assert.equal(outcome?.sessionLost, status === 401 ? true : undefined);
        assert.equal(f.snapshot, null);
        assert.equal(f.downloadHref(id), null);
    }
});
test('cancel aborts reads and ignores late results', async () => {
    const pending = deferred();
    let readSignal: AbortSignal | undefined;
    const f = flow(transport(async (_p, r) => { readSignal = r.signal; return pending.promise; }));
    const first = f.read();
    f.cancel();
    assert.equal(readSignal?.aborted, true);
    assert.equal(f.busy, false);
    pending.resolve(page());
    assert.equal(await first, null);
    assert.equal(f.snapshot, null);
});
test('cancel during a create is UNKNOWN, aborts transport, and a late receipt cannot restore old files', async () => {
    const pending = deferred();
    let requestSignal: AbortSignal | undefined;
    const f = flow(transport(async (_p, r) => { if (r.method === 'GET')
        return page(); requestSignal = r.signal; return pending.promise; }));
    await f.read();
    const first = f.create('pdf');
    const outcome = f.cancel();
    assert.equal(outcome.ok, false);
    assert.match(outcome.notice, /仍待核对/);
    assert.equal(f.resultUnknown, true);
    assert.equal(requestSignal?.aborted, true);
    pending.resolve({ artifact: metadata(), replayed: false });
    assert.equal(await first, null);
    assert.equal(f.receipt, null);
    assert.equal(f.downloadHref(id), null);
});
test('old read/create errors cannot overwrite a later read after clear or a new target session', async () => {
    for (const operation of ['read', 'create'] as const) {
        const old = deferred();
        let count = 0;
        const f = flow(transport(async () => { count++; return count === 2 ? old.promise : page(); }));
        await f.read();
        const first = operation === 'read' ? f.read() : f.create('pdf');
        f.clear();
        assert.equal((await f.read())?.ok, true);
        old.reject(new ArtifactRequestFailure(401));
        assert.equal(await first, null);
        assert.equal(f.snapshot?.items[0]?.id, id);
        const newSession = new ArtifactsFlow(transport(async () => page([metadata({ runId: otherRun })])), { taskId, runId: otherRun }, () => key, () => now);
        await newSession.read();
        assert.equal(newSession.items[0]?.runId, otherRun);
    }
});
test('metadata expires on local or server freshness bounds and never acts as download authorization', async () => {
    let clock = now;
    const f = flow(transport(), () => clock);
    await f.read();
    clock += artifactViewLifetimeMs;
    assert.deepEqual(f.items, []);
    assert.equal(f.downloadHref(id), null);
    assert.equal(f.canCreate, false);
    assert.equal(f.expire(), true);
    assert.equal(f.snapshot, null);
    let requests = 0;
    const old = flow(transport(async () => page([metadata({ createdAt: new Date(now - 59000).toISOString(), source: { ...metadata().source, asOf: new Date(now - 59000).toISOString() } })], new Date(now - 59000).toISOString()), async () => { requests++; return { bytes, mime: artifactMime.pdf }; }), () => clock);
    clock = now;
    assert.equal((await old.read())?.ok, true);
    assert.equal(old.fresh, true);
    clock += 1000;
    assert.equal(old.fresh, false);
    assert.equal((await old.download(id))?.outcome.ok, false);
    assert.equal(requests, 0);
});
test('protected download uses only fixed id path, validates exact bytes/MIME/SHA, and does not claim browser persistence', async () => {
    const paths: string[] = [];
    const f = flow(transport(undefined, async (path) => { paths.push(path); return { bytes, mime: artifactMime.pdf }; }));
    await f.read();
    const result = await f.download(id);
    assert.equal(result?.outcome.ok, true);
    assert.match(result!.outcome.notice, /准备交给浏览器/);
    assert.deepEqual(paths, [`/api/v1/artifacts/${id}/download`]);
    assert.deepEqual(result?.file?.bytes, bytes);
    assert.equal(result?.file?.fileName, 'result.pdf');
});
test('download mismatch, access revocation, and session loss erase files with no saved payload', async () => {
    for (const download of [async () => ({ bytes: Uint8Array.from([1]), mime: artifactMime.pdf }), async () => ({ bytes, mime: 'text/html' }), async () => ({ bytes: Uint8Array.from(bytes, b => b ^ 1), mime: artifactMime.pdf }), async () => { throw new ArtifactRequestFailure(401); }, async () => { throw new ArtifactRequestFailure(403); }]) {
        const f = flow(transport(undefined, download));
        await f.read();
        const result = await f.download(id);
        assert.equal(result?.outcome.ok, false);
        assert.equal(result?.file, undefined);
        assert.equal(f.downloadHref(id), null);
        assert.equal(f.receipt, null);
    }
});
test('download cancellation and target clearing discard late bytes and block double clicks', async () => {
    const pending = deferred<{
        bytes: Uint8Array;
        mime: string;
    }>();
    let fileSignal: AbortSignal | undefined, calls = 0;
    const f = flow(transport(undefined, async (_p, _ticket, s) => { calls++; fileSignal = s; return pending.promise; }));
    await f.read();
    const first = f.download(id);
    assert.equal(await f.download(id), null);
    assert.equal(calls, 1);
    f.clear();
    assert.equal(fileSignal?.aborted, true);
    pending.resolve({ bytes, mime: artifactMime.pdf });
    assert.equal(await first, null);
    assert.equal(f.receipt, null);
});
test('transport unwraps the project data envelope and fixes CSRF, idempotency, same-origin and no-redirect settings', async () => {
    const calls: {
        path: string;
        init: RequestInit;
    }[] = [], t = createArtifactsTransport('csrf-value', fetchStub((path, init) => { calls.push({ path, init }); return json({ data: page() }); })), path = `/api/v1/tasks/${taskId}/artifacts`;
    assert.deepEqual(await t.request(path, { method: 'GET', signal: signal() }), page());
    await t.request(path, { method: 'POST', signal: signal(), key, body: { runId, format: 'md' } });
    for (const call of calls) {
        assert.equal(call.path, path);
        assert.equal(call.init.credentials, 'same-origin');
        assert.equal(call.init.mode, 'same-origin');
        assert.equal(call.init.redirect, 'error');
        assert.equal(call.init.cache, 'no-store');
    }
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { runId, format: 'md' });
    assert.equal(new Headers(calls[1]?.init.headers).get('x-csrf-token'), 'csrf-value');
    assert.equal(new Headers(calls[1]?.init.headers).get('idempotency-key'), key);
});
test('transport rejects arbitrary URLs, host paths, payload identity, invalid CSRF/key and GET bodies before fetch', async () => {
    let calls = 0;
    const t = createArtifactsTransport('csrf', fetchStub(() => { calls++; return json({ data: page() }); })), path = `/api/v1/tasks/${taskId}/artifacts`;
    for (const bad of ['https://evil.invalid/api/v1/tasks/' + taskId + '/artifacts', '//evil.invalid/file', '/etc/passwd', '/api/v1/tasks/../artifacts', path + '?url=https://evil'])
        await assert.rejects(t.request(bad, { method: 'GET', signal: signal() }));
    await assert.rejects(t.request(path, { method: 'POST', signal: signal(), key, body: { runId, format: 'pdf', tenantId: taskId } }));
    await assert.rejects(t.request(path, { method: 'POST', signal: signal(), key: 'bad', body: { runId, format: 'pdf' } }));
    await assert.rejects(t.request(path, { method: 'GET', signal: signal(), body: {} }));
    await assert.rejects(createArtifactsTransport('', fetchStub(() => { calls++; return json({ data: page() }); })).request(path, { method: 'POST', signal: signal(), key, body: { runId, format: 'pdf' } }));
    await assert.rejects(t.download('https://evil.invalid/file', token, signal()));
    assert.equal(calls, 0);
});
test('transport refuses missing/malformed envelopes, nonJSON, overlarge bodies, malformed UTF8 and redirects', async () => {
    const path = `/api/v1/tasks/${taskId}/artifacts`, responses = [json({}), json(page()), json({ data: page(), extra: true }), new Response('<html>', { headers: { 'content-type': 'text/html' } }), new Response('{bad', { headers: { 'content-type': 'application/json' } }), new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), json({ data: 'x'.repeat(2097153) }), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2097153' } })];
    for (const response of responses) {
        const t = createArtifactsTransport('csrf', fetchStub(() => response));
        await assert.rejects(t.request(path, { method: 'GET', signal: signal() }));
    }
    const redirect = json({ data: page() });
    Object.defineProperty(redirect, 'redirected', { value: true });
    await assert.rejects(createArtifactsTransport('csrf', fetchStub(() => redirect)).request(path, { method: 'GET', signal: signal() }), /ARTIFACT_REDIRECT_DENIED/);
});
test('transport surfaces HTTP failures exactly and never turns BLOCKED/FAILED errors into READY metadata', async () => {
    const path = `/api/v1/tasks/${taskId}/artifacts`;
    for (const status of [401, 403, 409, 413, 422, 503]) {
        const t = createArtifactsTransport('csrf', fetchStub(() => json({ error: { code: 'BLOCKED', detail: 'do not expose' } }, status)));
        await assert.rejects(t.request(path, { method: 'GET', signal: signal() }), (error: unknown) => error instanceof ArtifactRequestFailure && error.status === status && !error.message.includes('detail'));
    }
});
test('download transport returns bounded same-origin bytes and rejects remote redirects and oversized responses', async () => {
    let init: RequestInit | undefined;
    const t = createArtifactsTransport('csrf', fetchStub((_path, value) => { init = value; return new Response(bytes, { headers: { 'content-type': artifactMime.pdf } }); }));
    const result = await t.download(`/api/v1/artifacts/${id}/download`, token, signal());
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.mime, artifactMime.pdf);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'same-origin');
    await assert.rejects(createArtifactsTransport('csrf', fetchStub(() => new Response(bytes, { headers: { 'content-length': '8388609' } }))).download(`/api/v1/artifacts/${id}/download`, token, signal()));
    const redirect = new Response(bytes);
    Object.defineProperty(redirect, 'redirected', { value: true });
    await assert.rejects(createArtifactsTransport('csrf', fetchStub(() => redirect)).download(`/api/v1/artifacts/${id}/download`, token, signal()), /ARTIFACT_REDIRECT_DENIED/);
});
test('task workbench offers artifacts only for visible current SUCCEEDED or PARTIAL results', () => {
    for (const status of ['SUCCEEDED', 'PARTIAL']) assert.equal(canShowTaskArtifacts({ status, result: '当前可读结果' }), true);
    for (const run of [{ status: 'RUNNING', result: 'old' }, { status: 'READY', result: 'old' }, { status: 'SUCCEEDED', result: null }, { status: 'PARTIAL', result: '  ' }, { status: 'SUCCEEDED', result: 'old', result_access: 'CURRENT_SOURCE_UNVERIFIED' }, { status: 'SUCCEEDED', result: 'old', group_reply_pending: true }, { status: 'PARTIAL', result: 'old', source_reply_pending: true }])
        assert.equal(canShowTaskArtifacts(run), false);
});
test('download obtains one bound ticket and uses the identical signal through both phases without exposing it in state', async () => {
    const phases: string[] = [], signals: AbortSignal[] = [];
    const f = flow(transport(undefined, async (path, value, active) => { phases.push(path); signals.push(active); assert.equal(value, token); return { bytes, mime: artifactMime.pdf }; }, async (path, request) => {
        phases.push(path); signals.push(request.signal); assert.deepEqual(request.body, {}); assert.equal(request.method, 'POST'); assert.equal(request.key, undefined); return ticket();
    }));
    await f.read();
    assert.equal((await f.download(id))?.outcome.ok, true);
    assert.deepEqual(phases, [`/api/v1/artifacts/${id}/download-ticket`, `/api/v1/artifacts/${id}/download`]);
    assert.equal(signals[0], signals[1]);
    assert.equal(JSON.stringify({ snapshot: f.snapshot, receipt: f.receipt }).includes(token), false);
});
test('mismatched, expired, overlong, malformed or expanded ticket receipts cannot start a byte download', async () => {
    const values = [ticket({ artifactId: otherTask }), ticket({ sha256: '0'.repeat(64) }), ticket({ byteSize: 1 }), ticket({ byteSize: 8388609 }), ticket({ ticket: 'x'.repeat(42) }), ticket({ ticket: 'https://evil.invalid' }), ticket({ ticket: '+'.repeat(43) }), ticket({ expiresAt: iso }), ticket({ expiresAt: new Date(now + 30001).toISOString() }), ticket({ expiresAt: 'tomorrow' }), ticket({ url: 'https://evil.invalid' }), { data: ticket() }];
    for (const value of values) {
        let gets = 0;
        const f = flow(transport(undefined, async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async () => value));
        await f.read();
        const result = await f.download(id);
        assert.equal(result?.outcome.ok, false);
        assert.equal(result?.file, undefined);
        assert.equal(gets, 0);
        assert.equal(f.snapshot, null);
        assert.equal(f.receipt, null);
    }
});
test('ticket HTTP/session/permission errors clear old entries and never fall through to the byte endpoint', async () => {
    for (const status of [401, 403, 409, 422, 503]) {
        let grants = 0, gets = 0;
        const f = flow(transport(undefined, async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async () => { grants++; throw new ArtifactRequestFailure(status); }));
        await f.read();
        const result = await f.download(id);
        assert.equal(result?.outcome.sessionLost, status === 401 ? true : undefined);
        assert.equal(result?.outcome.ok, false);
        assert.equal(grants, 1); assert.equal(gets, 0);
        assert.equal(f.items.length, 0);
    }
});
test('cancel or target clearing while waiting for a ticket blocks late bytes and duplicate tickets', async () => {
    for (const action of ['cancel', 'clear'] as const) {
        const pending = deferred(); let grants = 0, gets = 0; let active: AbortSignal | undefined;
        const f = flow(transport(undefined, async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async (_p, request) => { grants++; active = request.signal; return pending.promise; }));
        await f.read();
        const first = f.download(id);
        assert.equal(await f.download(id), null);
        f[action]();
        assert.equal(active?.aborted, true);
        pending.resolve(ticket());
        assert.equal(await first, null);
        assert.equal(grants, 1); assert.equal(gets, 0); assert.equal(f.receipt, null);
    }
});
test('a late ticket 401 cannot invalidate a newer list epoch', async () => {
    const old = deferred();
    const f = flow(transport(undefined, undefined, async () => old.promise));
    await f.read(); const first = f.download(id); f.clear(); await f.read();
    old.reject(new ArtifactRequestFailure(401));
    assert.equal(await first, null);
    assert.equal(f.items[0]?.id, id);
});
test('time spent waiting for a ticket cannot revive an expired grant', async () => {
    let clock = now, gets = 0;
    const f = flow(transport(undefined, async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async () => { clock += 30001; return ticket(); }), () => clock);
    await f.read();
    assert.equal((await f.download(id))?.outcome.ok, false);
    assert.equal(gets, 0);
});
test('each explicit later download requests a new single-use ticket; neither phase automatically retries', async () => {
    const used: string[] = []; let grants = 0;
    const f = flow(transport(undefined, async (_p, credential) => { used.push(credential); return { bytes, mime: artifactMime.pdf }; }, async () => ticket({ ticket: String.fromCharCode(65 + grants++).repeat(43) })));
    await f.read();
    assert.equal((await f.download(id))?.outcome.ok, true);
    assert.equal((await f.download(id))?.outcome.ok, true);
    assert.equal(grants, 2); assert.equal(used.length, 2); assert.notEqual(used[0], used[1]);
    let failedGrants = 0, failedGets = 0;
    const rejected = flow(transport(undefined, async () => { failedGets++; throw new ArtifactRequestFailure(409); }, async () => { failedGrants++; return ticket(); }));
    await rejected.read();
    assert.equal((await rejected.download(id))?.outcome.ok, false);
    assert.equal(failedGrants, 1); assert.equal(failedGets, 1);
    assert.equal((await rejected.download(id))?.outcome.ok, false);
    assert.equal(failedGrants, 1); assert.equal(failedGets, 1);
});
test('ticket transport sends CSRF with an exact empty JSON body, and byte GET carries the secret only in its header', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const t = createArtifactsTransport('csrf-value', fetchStub((path, init) => { calls.push({ path, init }); return path.endsWith('/download-ticket') ? json({ data: ticket() }) : new Response(bytes, { headers: { 'content-type': artifactMime.pdf } }); }));
    const active = signal();
    assert.deepEqual(await t.request(`/api/v1/artifacts/${id}/download-ticket`, { method: 'POST', body: {}, signal: active }), ticket());
    await t.download(`/api/v1/artifacts/${id}/download`, token, active);
    assert.equal(calls[0]?.init.body, '{}');
    assert.equal(new Headers(calls[0]?.init.headers).get('x-csrf-token'), 'csrf-value');
    assert.equal(new Headers(calls[0]?.init.headers).has('idempotency-key'), false);
    assert.equal(new Headers(calls[1]?.init.headers).get('x-artifact-download-ticket'), token);
    assert.equal(calls[1]?.init.body, undefined);
    for (const call of calls) {
        assert.equal(call.path.includes(token), false); assert.equal(call.path.includes('?'), false);
        assert.equal(call.init.signal, active); assert.equal(call.init.mode, 'same-origin');
        assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
    }
});
test('transport rejects ticket bypasses and aborted work before fetch', async () => {
    let calls = 0;
    const t = createArtifactsTransport('csrf', fetchStub(() => { calls++; return json({ data: ticket() }); })), path = `/api/v1/artifacts/${id}/download-ticket`;
    for (const request of [{ method: 'GET' as const, signal: signal() }, { method: 'POST' as const, signal: signal(), body: { artifactId: id } }, { method: 'POST' as const, signal: signal(), body: {}, key }])
        await assert.rejects(t.request(path, request));
    await assert.rejects(t.request(path + '?ticket=' + token, { method: 'POST', body: {}, signal: signal() }));
    await assert.rejects(t.download(`/api/v1/artifacts/${id}/download?ticket=${token}`, token, signal()));
    await assert.rejects(t.download(`/api/v1/artifacts/${id}/download`, '', signal()));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(t.request(path, { method: 'POST', body: {}, signal: controller.signal }));
    await assert.rejects(t.download(`/api/v1/artifacts/${id}/download`, token, controller.signal));
    assert.equal(calls, 0);
});

const draft = (): ArtifactMetadata => metadata({ source: { mode: 'TOOL_DRAFT', classification: 'INTERNAL', verification: 'UNVERIFIED', asOf: iso, notice: artifactToolDraftNotice } });
test('tool drafts remain UNVERIFIED alongside old entries and use the unchanged single-use ticket byte checks', async () => {
    let grants = 0, downloads = 0;
    const f = flow(transport(async () => page([draft(), metadata({ id: key })]), async (_path, value) => { downloads++; assert.equal(value, token); return { bytes, mime: artifactMime.pdf }; }, async () => { grants++; return ticket(); }));
    assert.equal((await f.read())?.ok, true);
    assert.deepEqual(f.items.map(item => item.source.mode), ['TOOL_DRAFT', 'VERIFIED_TASK_RESULT']);
    assert.equal(f.items[0]?.source.verification, 'UNVERIFIED');
    assert.equal(f.items[0]?.source.notice, artifactToolDraftNotice);
    assert.equal((await f.download(id))?.outcome.ok, true);
    assert.equal(f.receipt?.artifact.source.mode, 'TOOL_DRAFT');
    assert.equal(f.receipt?.artifact.source.verification, 'UNVERIFIED');
    assert.equal(grants, 1); assert.equal(downloads, 1);
    assert.equal(JSON.stringify(f.receipt).includes(token), false);
});
test('forged draft verification, changed notice, extra authority and unknown modes reject the entire list and erase old entries', async () => {
    for (const source of [
        { ...draft().source, verification: 'VERIFIED' }, { ...draft().source, verification: 'PARTIAL' },
        { ...draft().source, notice: '已核验事实' }, { ...draft().source, notice: artifactToolDraftNotice + ' ' },
        { ...draft().source, grantsAuthority: true }, { ...draft().source, mode: 'MODEL_VERIFIED' },
    ]) {
        let reads = 0;
        const f = flow(transport(async () => reads++ === 0 ? page() : page([metadata(), { ...draft(), id: key, source }])));
        assert.equal((await f.read())?.ok, true);
        assert.equal((await f.read())?.ok, false);
        assert.deepEqual(f.items, []); assert.equal(f.receipt, null);
        assert.equal(f.downloadHref(id), null); assert.equal(f.canCreate, false);
    }
});
test('forged draft create receipts remain unknown rather than auto retrying or becoming fact-verified', async () => {
    for (const verification of ['VERIFIED', 'PARTIAL']) {
        let creates = 0;
        const f = flow(transport(async (_p, request) => {
            if (request.method === 'GET') return page([]);
            creates++; return { artifact: { ...draft(), source: { ...draft().source, verification } }, replayed: false };
        }));
        await f.read(); assert.equal((await f.create('pdf'))?.ok, false);
        assert.equal(f.resultUnknown, true); assert.equal(f.receipt, null); assert.deepEqual(f.items, []);
        assert.equal(await f.create('pdf'), null); assert.equal(creates, 1);
    }
});
test('draft downloads keep permission failure and epoch cancellation behavior without reusing a ticket', async () => {
    for (const status of [401, 403]) {
        let gets = 0;
        const f = flow(transport(async () => page([draft()]), async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async () => { throw new ArtifactRequestFailure(status); }));
        await f.read(); const result = await f.download(id);
        assert.equal(result?.outcome.ok, false); assert.equal(result?.outcome.sessionLost, status === 401 ? true : undefined);
        assert.equal(gets, 0); assert.deepEqual(f.items, []);
    }
    const pending = deferred(); let gets = 0;
    const f = flow(transport(async () => page([draft()]), async () => { gets++; return { bytes, mime: artifactMime.pdf }; }, async () => pending.promise));
    await f.read(); const first = f.download(id); f.clear(); pending.resolve(ticket());
    assert.equal(await first, null); assert.equal(gets, 0); assert.deepEqual(f.items, []);
});
