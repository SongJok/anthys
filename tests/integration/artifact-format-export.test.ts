import '../support/isolation.js';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, rm, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {Vault} from '../../packages/storage/src/crypto.js';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import {Sessions} from '../../packages/identity/src/sessions.js';
import {TaskResultArtifacts} from '../../packages/artifacts/src/service.js';
import {inspectCsv, safeCsvText} from '../../packages/artifacts/src/index.js';
import {inspectZip} from '../../packages/artifacts/src/zip.js';
import {inspectPdf} from '../../packages/artifacts/src/pdf-inspect.js';
import {ARTIFACT_FONT_MANIFEST_ENV, configureArtifactFonts} from '../../packages/artifacts/src/font-configuration.js';
import {artifactSourceNotice, type ArtifactMetadata} from '../../packages/artifacts/src/contracts.js';
import {createServer} from '../../apps/api/src/server.js';
import {config} from '../../packages/config/src/index.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {artifactWorld} from '../support/artifact-world.js';
import {artifactFontBytes, artifactFontFamily} from '../support/artifact-font.js';

type Server = Awaited<ReturnType<typeof createServer>>;
type World = Awaited<ReturnType<typeof artifactWorld>>;
let isolated: Awaited<ReturnType<typeof groupReminderDatabase>>, directory: string, files: EncryptedFileStore, store: RuntimeStore, gateway: Gateway, world: World, reviewed: Awaited<ReturnType<typeof configureArtifactFonts>>;
const servers: Server[] = [];
const vault = new Vault(new Map([['1', randomBytes(32)]]), '1'), origin = 'http://127.0.0.1:64702', secret = randomBytes(32).toString('hex');
const zipLimits = {maxZipEntries: 256, maxExpandedBytes: 16777216, maxCompressionRatio: 1000};
const formats = ['md', 'txt', 'csv', 'json', 'html', 'xlsx', 'docx', 'pdf'] as const;
type ExportFormat = typeof formats[number];

async function serve(service: TaskResultArtifacts, listen: boolean): Promise<Server> {
    const server = await createServer({config: {...config(), APP_ORIGIN: origin}, db: isolated.appDb, sessionSecret: secret, finalReader: gateway, artifacts: service});
    if (listen) await server.app.listen({host: '127.0.0.1', port: 64702});
    servers.push(server);
    return server;
}

beforeAll(async () => {
    isolated = await groupReminderDatabase(); await isolated.install(); expect(await isolated.db.ready()).toBe(true);
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'oa-artifact-export-')));
    files = new EncryptedFileStore(join(directory, 'files'), vault); store = new RuntimeStore(isolated.db, vault); gateway = new Gateway(store);
    world = await artifactWorld({isolated, store, gateway, sessions: new Sessions(isolated.db, secret)}, origin);
    const result = String((await isolated.root.query('SELECT result FROM runs WHERE id=$1', [world.runId])).rows[0].result);
    const fontBytes = artifactFontBytes([world.lease.goal, result, artifactSourceNotice, '来源核验状态：UNVERIFIED；截至'].join('\n'));
    const fontFile = join(directory, 'artifact-font.ttf');
    await writeFile(fontFile, fontBytes, {mode: 0o600});
    const sha256 = createHash('sha256').update(fontBytes).digest('hex');
    const manifest = join(directory, 'artifact-font.manifest.json');
    await writeFile(manifest, JSON.stringify({family: artifactFontFamily, fontFile, sha256, reviewReference: 'tests/support/artifact-font.ts synthetic reviewed fixture', sourceReviewHash: createHash('sha256').update(artifactFontFamily).digest('hex')}), {mode: 0o600});
    reviewed = await configureArtifactFonts({[ARTIFACT_FONT_MANIFEST_ENV]: manifest});
    await serve(new TaskResultArtifacts(isolated.db, vault, files, gateway, reviewed), true);
}, 60000);
afterAll(async () => {for (const server of servers) await server.app.close(); await isolated?.close(); if (directory) await rm(directory, {recursive: true, force: true});});

/** The pagers insert whitespace, the markdown escaper inserts backslashes and
 * the html writers insert entities; the exported characters are never rewritten. */
const norm = (value: string): string => decodeEntities(value).replace(/\\/g, '').replace(/\s+/g, '');
const decodeEntities = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|#39);/g, c => ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}[c]!));

interface Export {
    format: ExportFormat;
    artifact: ArtifactMetadata;
    bytes: Buffer;
    text: string;
    pages: number | null;
}

async function exportFormat(world: World, format: ExportFormat): Promise<Export> {
    const created = await world.create(format);
    const payload = await created.text();
    expect(created.status, `${format} ${payload}`).toBe(201);
    const body = JSON.parse(payload) as {data: {artifact: ArtifactMetadata; replayed: boolean}};
    expect(body.data.replayed, format).toBe(false);
    const artifact = body.data.artifact;
    expect(artifact.format, format).toBe(format);
    const ticket = await world.ticket(artifact.id);
    const response = await world.request(`/api/v1/artifacts/${artifact.id}/download`, {ticket: ticket.ticket});
    expect(response.status, format).toBe(200);
    expect(response.headers.get('content-type'), format).toBe(artifact.mime);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length, format).toBe(artifact.byteSize);
    expect(createHash('sha256').update(bytes).digest('hex'), format).toBe(artifact.sha256);
    return {format, artifact, bytes, text: '', pages: null};
}

/** Open every exported file with the real reader of its format. */
async function open(exported: Export): Promise<Export> {
    const {format, bytes} = exported;
    if (format === 'md') return {...exported, text: bytes.toString('utf8').replace(/^#\s+/, '')};
    if (format === 'txt') return {...exported, text: bytes.toString('utf8')};
    if (format === 'json') {
        const parsed = JSON.parse(bytes.toString('utf8')) as {schemaVersion: number; title: string; paragraphs: string[]};
        expect(parsed.schemaVersion, 'json').toBe(1);
        return {...exported, text: [parsed.title, ...parsed.paragraphs].join('\n')};
    }
    if (format === 'html') {
        const body = bytes.toString('utf8');
        expect(body.startsWith('<!doctype html>'), 'html').toBe(true);
        return {...exported, text: decodeEntities(body.replace(/<[^>]*>/g, ''))};
    }
    if (format === 'csv') {
        const rows = inspectCsv(bytes);
        expect(rows[0], 'csv header').toEqual(['line', 'content']);
        return {...exported, text: rows.slice(1).map(row => row[1] ?? '').join('\n')};
    }
    if (format === 'xlsx') {
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(bytes as never);
        const data = book.getWorksheet('Data')!;
        const content: string[] = [];
        data.eachRow((row, index) => {if (index > 1) content.push(String(row.getCell(2).value));});
        return {...exported, text: [String(book.getWorksheet('Document')!.getCell(1, 1).value), ...content].join('\n')};
    }
    if (format === 'docx') {
        const xml = inspectZip(bytes, zipLimits).get('word/document.xml')!.toString();
        const runs = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => decodeEntities(m[1]!));
        expect(runs.length, 'docx text runs').toBeGreaterThan(0);
        return {...exported, text: runs.join('\n')};
    }
    const pdf = inspectPdf(bytes, zipLimits.maxExpandedBytes);
    expect(pdf.pages, 'pdf pages').toBeGreaterThan(0);
    return {...exported, text: pdf.text, pages: pdf.pages};
}

it('T101 exports one certified task result into every format and every file opens with the same exact numbers', async () => {
    const row = (await isolated.root.query('SELECT result FROM runs WHERE id=$1', [world.runId])).rows[0];
    const result = String(row.result);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const title = world.lease.goal;
    const value = world.value;
    expect(value).toBe('900719925474099312345.000000000000000000001');
    const lossy = String(Number(value));
    expect(lossy, 'the fixture value must not survive a double').not.toBe(value);
    expect(reviewed.pdfFont, 'the reviewed font is configured for PDF').toBeTruthy();
    expect(reviewed.docxFont, 'the reviewed font is configured for DOCX').toBeTruthy();

    const exported: Export[] = [];
    for (const format of formats) exported.push(await open(await exportFormat(world, format)));
    expect(exported.map(entry => entry.format)).toEqual([...formats]);

    for (const entry of exported) {
        const text = norm(entry.text);
        expect(text, `${entry.format} carries the exact value`).toContain(value);
        expect(text, `${entry.format} does not round the value through a double`).not.toContain(lossy);
        for (const line of lines) expect(text, `${entry.format} keeps the result line`).toContain(norm(line));
        expect(entry.artifact.byteSize, `${entry.format} size`).toBe(entry.bytes.length);
        expect(entry.artifact.source.mode, `${entry.format} source mode`).toBe('VERIFIED_TASK_RESULT');
        expect(entry.artifact.source.verification, `${entry.format} verification`).toBe('UNVERIFIED');
        expect(entry.artifact.source.notice, `${entry.format} notice`).toBe(artifactSourceNotice);
        expect(text, `${entry.format} keeps the source notice`).toContain(norm(artifactSourceNotice));
    }

    for (const entry of exported.filter(item => item.format !== 'csv')) expect(norm(entry.text), `${entry.format} keeps the title`).toContain(norm(title));

    const pdf = exported.find(entry => entry.format === 'pdf')!;
    expect(pdf.pages, 'pdf page count').toBeGreaterThan(0);
    expect(norm(pdf.text).length, 'pdf keeps every character of the result').toBeGreaterThanOrEqual(norm([title, ...lines].join('\n')).length);
    const docx = exported.find(entry => entry.format === 'docx')!;
    expect(norm(docx.text).length, 'docx keeps every character of the result').toBeGreaterThanOrEqual(norm([title, ...lines].join('\n')).length);

    const csv = exported.find(entry => entry.format === 'csv')!;
    const csvRows = inspectCsv(csv.bytes);
    expect(csvRows[0]).toEqual(['line', 'content']);
    expect(csvRows[1]?.[0], 'csv first line number').toBe('0');
    expect(csvRows[1]?.[1], 'csv notice').toContain('来源核验状态：UNVERIFIED');
    expect(csvRows[1]?.[1], 'csv notice').toContain(artifactSourceNotice);
    for (const [index, line] of lines.entries()) expect(csvRows[index + 2]?.[1], `csv line ${index + 1}`).toBe(safeCsvText(line));

    const xlsx = exported.find(entry => entry.format === 'xlsx')!;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.bytes as never);
    const data = book.getWorksheet('Data')!;
    expect(data.getCell(1, 1).value).toBe('line');
    expect(data.getCell(1, 2).value).toBe('content');
    /** Every cell is written as text so a spreadsheet engine cannot round the exact decimal. */
    expect(data.getCell(2, 1).value).toBe('0');
    expect(String(data.getCell(2, 2).value), 'xlsx notice').toContain('来源核验状态：UNVERIFIED');
    for (const [index, line] of lines.entries()) expect(String(data.getCell(index + 3, 2).value), `xlsx line ${index + 1}`).toBe(line);

    expect(world.calls(), 'the export never re-queries the certified source').toBe(1);
}, 120000);

it('T101 refuses a DOCX or PDF export while no reviewed Unicode font is configured', async () => {
    const unconfigured = await serve(new TaskResultArtifacts(isolated.db, vault, files, gateway), false);
    for (const [format, code] of [['docx', 'ARTIFACT_DOCX_FONT_REQUIRED'], ['pdf', 'ARTIFACT_PDF_FONT_REQUIRED']] as const) {
        const refused = await unconfigured.app.inject({method: 'POST', url: `/api/v1/tasks/${world.taskId}/artifacts`, headers: {cookie: `oa_session=${world.owner.cookie}`, origin, 'content-type': 'application/json', 'x-csrf-token': world.owner.csrf, 'idempotency-key': randomUUID()}, payload: {runId: world.runId, format}});
        expect(refused.statusCode, format).toBe(422);
        expect((refused.json() as {error: {code: string}}).error.code, format).toBe(code);
    }
    const control = await unconfigured.app.inject({method: 'POST', url: `/api/v1/tasks/${world.taskId}/artifacts`, headers: {cookie: `oa_session=${world.owner.cookie}`, origin, 'content-type': 'application/json', 'x-csrf-token': world.owner.csrf, 'idempotency-key': randomUUID()}, payload: {runId: world.runId, format: 'md'}});
    expect(control.statusCode, 'md stays available without a font').toBe(201);
}, 60000);
