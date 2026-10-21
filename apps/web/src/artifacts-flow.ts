import { z } from 'zod';
export const artifactFormats = ['md', 'txt', 'csv', 'json', 'html', 'xlsx', 'docx', 'pdf'] as const;
export type ArtifactFormat = typeof artifactFormats[number];
export const artifactMime: Record<ArtifactFormat, string> = { md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', html: 'text/html; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' };
const uuid = z.uuid().transform(value => value.toLowerCase()), instant = z.iso.datetime({ offset: true });
// Wire pin shared with the trusted native host; presentation never upgrades a draft to fact evidence.
export const artifactToolDraftNotice = 'UNVERIFIED TOOL DRAFT. File checks do not verify facts, sources or external actions. Access remains protected.';
const sourceFields = { classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']), asOf: instant };
const sourceSchema = z.discriminatedUnion('mode', [
    z.object({ ...sourceFields, mode: z.literal('VERIFIED_TASK_RESULT'), verification: z.enum(['VERIFIED', 'PARTIAL', 'UNVERIFIED']), notice: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ ...sourceFields, mode: z.literal('TOOL_DRAFT'), verification: z.literal('UNVERIFIED'), notice: z.literal(artifactToolDraftNotice) }).strict(),
]);
const metadataSchema = z.object({ id: uuid, taskId: uuid, runId: uuid, format: z.enum(artifactFormats), mime: z.string(), fileName: z.string().min(1).max(255), byteSize: z.number().int().positive().max(8388608), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: instant, source: sourceSchema }).strict().superRefine((v, c) => {
    if (v.mime !== artifactMime[v.format] || !v.fileName.endsWith('.' + v.format) || /[\\/\x00-\x1f\x7f]/.test(v.fileName) || /^[. ]|[. ]$/.test(v.fileName) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(v.fileName))
        c.addIssue({ code: 'custom', message: 'INVALID_ARTIFACT_METADATA' });
});
const listSchema = z.object({ items: z.array(metadataSchema).max(1000), asOf: instant }).strict();
const receiptSchema = z.object({ artifact: metadataSchema, replayed: z.boolean() }).strict();
const createSchema = z.object({ runId: uuid, format: z.enum(artifactFormats) }).strict();
const ticketSchema = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: instant, artifactId: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive().max(8388608) }).strict();
const targetSchema = z.object({ taskId: uuid, runId: uuid }).strict();
export type ArtifactMetadata = z.infer<typeof metadataSchema>;
export type ArtifactTarget = z.infer<typeof targetSchema>;
export function validArtifactTarget(taskId: string, runId: string): boolean { return targetSchema.safeParse({ taskId, runId }).success; }
/** Visible results may still be refused by the server (for example control receipts without finalization). */
export function canShowTaskArtifacts(run: { status: string; result: string | null; result_access?: string; group_reply_pending?: boolean; source_reply_pending?: boolean }): boolean {
    return ['SUCCEEDED', 'PARTIAL'].includes(run.status) && typeof run.result === 'string' && run.result.trim().length > 0 && !run.result_access && !run.group_reply_pending && !run.source_reply_pending;
}
export interface ArtifactPage {
    items: ArtifactMetadata[];
    asOf: string;
    receivedAt: number;
}
export interface ArtifactOutcome {
    ok: boolean;
    notice: string;
    sessionLost?: boolean;
}
export interface ArtifactFile {
    bytes: Uint8Array;
    mime: string;
}
export interface ArtifactTransport {
    request(path: string, request: {
        method: 'GET' | 'POST';
        signal: AbortSignal;
        body?: unknown;
        key?: string;
    }): Promise<unknown>;
    download(path: string, ticket: string, signal: AbortSignal): Promise<ArtifactFile>;
}
export class ArtifactRequestFailure extends Error {
    constructor(readonly status: number, readonly code = 'ARTIFACT_REQUEST_FAILED') { super(code); }
}
const maxJsonBytes = 2097152;
async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
        throw new ArtifactRequestFailure(0, 'ARTIFACT_RESPONSE_INVALID');
    if (!response.body)
        throw new ArtifactRequestFailure(0, 'ARTIFACT_RESPONSE_INVALID');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            total += part.value.byteLength;
            if (total > max)
                throw new ArtifactRequestFailure(0, 'ARTIFACT_RESPONSE_INVALID');
            chunks.push(part.value);
        }
    }
    catch (error) {
        await reader.cancel().catch(() => { });
        throw error;
    }
    finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        output.set(chunk, at);
        at += chunk.byteLength;
    }
    return output;
}
/** Same-origin transport. Only a fixed API path and the exact structured export body are accepted. */
export function createArtifactsTransport(csrf: string, fetcher: typeof fetch = fetch): ArtifactTransport {
    const csrfValid = csrf.trim().length > 0 && csrf.length <= 4096 && !/[\x00-\x1f\x7f]/.test(csrf);
    const taskPath = (path: string) => /^\/api\/v1\/tasks\/[a-f0-9-]+\/artifacts$/i.test(path) && uuid.safeParse(path.split('/')[4]).success;
    const filePath = (path: string) => /^\/api\/v1\/artifacts\/[a-f0-9-]+\/download$/i.test(path) && uuid.safeParse(path.split('/')[4]).success;
    const ticketPath = (path: string) => /^\/api\/v1\/artifacts\/[a-f0-9-]+\/download-ticket$/i.test(path) && uuid.safeParse(path.split('/')[4]).success;
    const perform = async (path: string, init: RequestInit) => { const response = await fetcher(path, { ...init, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' }); if (response.redirected) { await response.body?.cancel().catch(() => {}); throw new ArtifactRequestFailure(0, 'ARTIFACT_REDIRECT_DENIED'); } if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ArtifactRequestFailure(response.status); } return response; };
    return {
        async request(path, request) {
            const isTicket = ticketPath(path);
            if ((!taskPath(path) && !isTicket) || !['GET', 'POST'].includes(request.method) || (isTicket && request.method !== 'POST'))
                throw new ArtifactRequestFailure(0, 'ARTIFACT_REQUEST_INVALID');
            request.signal.throwIfAborted();
            let init: RequestInit = { method: request.method, signal: request.signal, headers: { accept: 'application/json' } };
            if (request.method === 'POST') {
                if (!csrfValid || (isTicket ? request.key !== undefined : !uuid.safeParse(request.key).success))
                    throw new ArtifactRequestFailure(0, 'ARTIFACT_REQUEST_INVALID');
                const body = isTicket ? z.object({}).strict().parse(request.body) : createSchema.parse(request.body);
                init = { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf, ...(isTicket ? {} : { 'idempotency-key': request.key! }) }, body: JSON.stringify(body) };
            }
            else if (request.body !== undefined || request.key !== undefined)
                throw new ArtifactRequestFailure(0, 'ARTIFACT_REQUEST_INVALID');
            const response = await perform(path, init);
            if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
                throw new ArtifactRequestFailure(0, 'ARTIFACT_RESPONSE_INVALID');
            const bytes = await boundedBytes(response, maxJsonBytes), body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
            const envelope = z.object({ data: z.unknown() }).strict().parse(body);
            if (!Object.hasOwn(envelope, 'data'))
                throw new ArtifactRequestFailure(0, 'ARTIFACT_RESPONSE_INVALID');
            return envelope.data;
        },
        async download(path, ticket, signal) { if (!filePath(path) || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
            throw new ArtifactRequestFailure(0, 'ARTIFACT_REQUEST_INVALID'); signal.throwIfAborted(); const response = await perform(path, { method: 'GET', signal, headers: { accept: 'application/octet-stream', 'x-artifact-download-ticket': ticket } }); return { bytes: await boundedBytes(response, 8388608), mime: response.headers.get('content-type') ?? '' }; },
    };
}
export const artifactViewLifetimeMs = 60000;
function failure(error: unknown, write = false): ArtifactOutcome {
    const status = error instanceof ArtifactRequestFailure ? error.status : 0;
    return { ok: false, notice: status === 401 ? '登录已失效，成果入口已清除，请重新登录。' : status === 403 ? '当前无权读取或生成这份成果，旧入口已清除，请核对权限。' : status === 409 ? '任务、来源或权限依据已变化，本次生成未确认，请重新读取核对。' : status === 413 ? '文件超过允许大小，本次没有可用下载，请减少结果范围。' : status === 422 ? '当前结果或格式未通过检查，未提供成果，请核对来源与格式。' : status === 503 ? '成果服务暂不可用，结果尚未确认；请先重新读取核对，不会自动重发。' : write ? '生成结果尚未确认，可能已经生成；旧入口已清除，请先重新读取核对，不会自动重发。' : '成果资料无法核实，旧入口已清除，请重新读取。', ...(status === 401 ? { sessionLost: true } : {}) };
}
/** Client freshness/concurrency only. The server must establish identity, source authority and live download ACL. */
export class ArtifactsFlow {
    snapshot: ArtifactPage | null = null;
    receipt: {
        artifact: ArtifactMetadata;
        replayed: boolean;
        receivedAt: number;
    } | null = null;
    private pending = false;
    private generation = 0;
    private controller: AbortController | null = null;
    private operation: 'read' | 'create' | 'download' | null = null;
    private uncertain = false;
    constructor(private transport: ArtifactTransport, readonly target: ArtifactTarget, private key: () => string = () => crypto.randomUUID(), private now: () => number = Date.now) { this.target = targetSchema.parse(target); }
    get busy() { return this.pending; }
    get resultUnknown() { return this.uncertain; }
    get observedAt() { return this.snapshot?.receivedAt ?? this.receipt?.receivedAt ?? null; }
    get expiresAt() { const at = this.observedAt; return at === null ? null : Math.min(at + artifactViewLifetimeMs, this.snapshot ? Date.parse(this.snapshot.asOf) + artifactViewLifetimeMs : Infinity); }
    get fresh() { const at = this.observedAt, end = this.expiresAt; return at !== null && end !== null && this.now() >= at && this.now() < end; }
    get items(): ArtifactMetadata[] { return this.fresh ? (this.snapshot?.items ?? (this.receipt ? [this.receipt.artifact] : [])) : []; }
    get canCreate() { return !this.pending && !this.uncertain && this.fresh; }
    private erase() { this.snapshot = null; this.receipt = null; }
    clear() { if (this.pending && this.operation === 'create')
        this.uncertain = true; this.generation++; this.controller?.abort(); this.controller = null; this.pending = false; this.operation = null; this.erase(); }
    cancel(): ArtifactOutcome { const write = this.operation === 'create'; this.clear(); return { ok: false, notice: write ? '已停止等待生成回执；服务端结果仍待核对，未自动重发，请重新读取。' : '已取消读取，旧成果入口已清除。' }; }
    expire(): boolean { if (this.observedAt === null || this.fresh)
        return false; this.clear(); return true; }
    private begin(operation: 'read' | 'create' | 'download') { this.erase(); this.pending = true; this.operation = operation; this.controller = new AbortController(); return { generation: ++this.generation, signal: this.controller.signal }; }
    private finish(generation: number) { if (generation === this.generation) {
        this.pending = false;
        this.operation = null;
        this.controller = null;
    } }
    private path() { return '/api/v1/tasks/' + this.target.taskId + '/artifacts'; }
    private checkItem(item: ArtifactMetadata, asOf: number) { if (item.taskId !== this.target.taskId || Date.parse(item.createdAt) > asOf + 5000 || Date.parse(item.source.asOf) > asOf + 5000)
        throw Error('ARTIFACT_METADATA_MISMATCH'); }
    async read(): Promise<ArtifactOutcome | null> {
        if (this.pending)
            return null;
        const current = this.begin('read');
        try {
            const value = await this.transport.request(this.path(), { method: 'GET', signal: current.signal });
            if (current.generation !== this.generation)
                return null;
            const page = listSchema.parse(value), now = this.now(), asOf = Date.parse(page.asOf), ids = new Set<string>();
            if (asOf > now + 5000 || asOf < now - artifactViewLifetimeMs)
                throw Error('ARTIFACT_STALE_LIST');
            for (const item of page.items) {
                this.checkItem(item, asOf);
                if (ids.has(item.id))
                    throw Error('ARTIFACT_DUPLICATE_ID');
                ids.add(item.id);
            }
            this.snapshot = { items: page.items.filter(item => item.runId === this.target.runId), asOf: page.asOf, receivedAt: now };
            return { ok: true, notice: this.uncertain ? '当前列表已重新读取；上次生成回执仍待核对，未自动重发。' : '已读取本次运行的成果。每次下载仍会重新检查当前权限。' };
        }
        catch (error) {
            if (current.generation !== this.generation)
                return null;
            this.erase();
            return failure(error);
        }
        finally {
            this.finish(current.generation);
        }
    }
    async create(format: ArtifactFormat): Promise<ArtifactOutcome | null> {
        if (this.pending || this.uncertain)
            return null;
        if (!this.fresh) {
            this.erase();
            return { ok: false, notice: '请先重新读取当前成果，再生成。' };
        }
        let dispatched = false;
        const current = this.begin('create');
        try {
            const body = createSchema.parse({ runId: this.target.runId, format }), key = uuid.parse(this.key());
            dispatched = true;
            const value = await this.transport.request(this.path(), { method: 'POST', body, key, signal: current.signal });
            if (current.generation !== this.generation)
                return null;
            const result = receiptSchema.parse(value);
            this.checkItem(result.artifact, this.now());
            if (result.artifact.runId !== this.target.runId || result.artifact.format !== format)
                throw Error('ARTIFACT_RECEIPT_MISMATCH');
            this.receipt = { ...result, receivedAt: this.now() };
            return { ok: true, notice: result.replayed ? '已取回同一次生成的成果。下载仍需当前会话核验。' : '受保护成果已生成。下载仍需当前会话核验。' };
        }
        catch (error) {
            if (current.generation !== this.generation)
                return null;
            this.erase();
            const status = error instanceof ArtifactRequestFailure ? error.status : 0;
            this.uncertain = dispatched && ![401, 403, 409, 413, 422].includes(status);
            return dispatched ? failure(error, true) : { ok: false, notice: '生成条件无效，本次没有发送生成请求；请重新读取后重试。' };
        }
        finally {
            this.finish(current.generation);
        }
    }
    downloadHref(id: string): string | null { return !this.pending && this.items.some(item => item.id === id) ? '/api/v1/artifacts/' + id + '/download' : null; }
    async download(id: string): Promise<{
        outcome: ArtifactOutcome;
        file?: ArtifactFile & {
            fileName: string;
        };
    } | null> {
        if (this.pending)
            return null;
        const item = this.items.find(item => item.id === id), path = this.downloadHref(id);
        if (!item || !path) {
            this.erase();
            return { outcome: { ok: false, notice: '下载入口已过期或不可核实，请重新读取。' } };
        }
        const current = this.begin('download');
        try {
            // Keep this one-use credential only in this invocation, never in state, URL, storage or a receipt.
            const rawTicket = await this.transport.request('/api/v1/artifacts/' + item.id + '/download-ticket', { method: 'POST', body: {}, signal: current.signal });
            if (current.generation !== this.generation)
                return null;
            const grant = ticketSchema.parse(rawTicket), now = this.now(), expires = Date.parse(grant.expiresAt);
            if (grant.artifactId !== item.id || grant.sha256 !== item.sha256 || grant.byteSize !== item.byteSize || !Number.isFinite(expires) || expires <= now || expires > now + 30000)
                throw Error('ARTIFACT_TICKET_MISMATCH');
            current.signal.throwIfAborted();
            const file = await this.transport.download(path, grant.ticket, current.signal);
            if (current.generation !== this.generation)
                return null;
            if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== item.byteSize || file.mime !== item.mime)
                throw Error('ARTIFACT_DOWNLOAD_MISMATCH');
            const bytes = Uint8Array.from(file.bytes);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            if (current.generation !== this.generation)
                return null;
            const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            if (hash !== item.sha256)
                throw Error('ARTIFACT_DOWNLOAD_MISMATCH');
            this.receipt = { artifact: item, replayed: false, receivedAt: this.now() };
            return { outcome: { ok: true, notice: '文件已读取并核验，准备交给浏览器保存。' }, file: { ...file, bytes, fileName: item.fileName } };
        }
        catch (error) {
            if (current.generation !== this.generation)
                return null;
            this.erase();
            return { outcome: failure(error) };
        }
        finally {
            this.finish(current.generation);
        }
    }
}
