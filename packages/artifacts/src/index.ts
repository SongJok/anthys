import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, PageBreak } from 'docx';
import PDFDocument from 'pdfkit';
import { inspectPdf } from './pdf-inspect.js';
import { inspectZip } from './zip.js';
import { verifyFont, verifyEmbedding, reviewedLineHeight, verifyDocumentFamily, type ReviewedDocumentFont, type ReviewedPdfFont } from './font.js';
export type ArtifactFormat = 'markdown' | 'txt' | 'csv' | 'json' | 'html' | 'xlsx' | 'docx' | 'pdf';
export type ColumnType = 'text' | 'boolean' | 'integer' | 'decimal';
export interface ArtifactColumn {
    name: string;
    type: ColumnType;
}
/** Decimal values MUST be decimal strings; integers may be safe JS integers or integer strings. */
export interface ArtifactTable {
    columns: ArtifactColumn[];
    rows: (string | number | boolean | null)[][];
}
export interface ArtifactRequest {
    format: ArtifactFormat;
    title: string;
    paragraphs: string[];
    table?: ArtifactTable;
}
export interface ArtifactLimits {
    maxInputBytes: number;
    maxTextLength: number;
    maxRows: number;
    maxColumns: number;
    maxOutputBytes: number;
    maxPages: number;
    maxZipEntries: number;
    maxExpandedBytes: number;
    maxCompressionRatio: number;
    maxFontBytes: number;
}
export interface ArtifactOptions {
    signal?: AbortSignal;
    limits?: Partial<ArtifactLimits>;
    pdfFont?: ReviewedPdfFont;
    docxFont?: ReviewedDocumentFont;
}
export interface ArtifactInspection {
    state: 'VERIFIED';
    method: string;
    contentSha256: string;
    rowCount: number;
    columnCount: number;
    pageCount: number | null;
    pagination: 'PDF_PAGE_OBJECTS' | 'DOCX_EXPLICIT_BREAKS_NOT_VISUALLY_RENDERED' | 'NOT_APPLICABLE';
    formulaCells: 0;
    externalRelationships: 0;
    titleIncluded: boolean;
    determinism: 'CONTENT_ONLY';
    warnings: string[];
}
export interface RenderedArtifact {
    format: ArtifactFormat;
    mime: string;
    extension: string;
    bytes: Buffer;
    sha256: string;
    inspection: ArtifactInspection;
}
export class ArtifactFailure extends Error {
    constructor(readonly code: string) { super(code); this.name = 'ArtifactFailure'; }
}
const caps: ArtifactLimits = { maxInputBytes: 1048576, maxTextLength: 16384, maxRows: 1000, maxColumns: 32, maxOutputBytes: 8388608, maxPages: 100, maxZipEntries: 256, maxExpandedBytes: 16777216, maxCompressionRatio: 1000, maxFontBytes: 8388608 };
const formats: Record<ArtifactFormat, {
    mime: string;
    extension: string;
}> = { markdown: { mime: 'text/markdown; charset=utf-8', extension: '.md' }, txt: { mime: 'text/plain; charset=utf-8', extension: '.txt' }, csv: { mime: 'text/csv; charset=utf-8', extension: '.csv' }, json: { mime: 'application/json', extension: '.json' }, html: { mime: 'text/html; charset=utf-8', extension: '.html' }, xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' }, docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' }, pdf: { mime: 'application/pdf', extension: '.pdf' } };
function fail(code: string): never { throw new ArtifactFailure(code); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null))
        fail('ARTIFACT_SCHEMA_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!))
            fail('ARTIFACT_SCHEMA_UNKNOWN_KEY');
    }
    return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1)
        fail('ARTIFACT_SCHEMA_INVALID');
    for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !('value' in d))
            fail('ARTIFACT_SCHEMA_INVALID');
    }
    return value;
}
function text(value: unknown, limit: number): string {
    if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || /[\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value))
        fail('ARTIFACT_TEXT_INVALID');
    return value;
}
function parse(input: unknown, limits: ArtifactLimits): ArtifactRequest {
    let inputBytes = 0;
    const takeText = (value: unknown, max: number): string => {
        const result = text(value, max);
        inputBytes += Buffer.byteLength(result, 'utf8');
        if (inputBytes > limits.maxInputBytes)
            fail('ARTIFACT_INPUT_LIMIT');
        return result;
    };
    const v = object(input, ['format', 'title', 'paragraphs', 'table']);
    if (typeof v['format'] !== 'string' || !Object.hasOwn(formats, v['format']))
        fail('ARTIFACT_FORMAT_UNSUPPORTED');
    const format = v['format'] as ArtifactFormat;
    const title = takeText(v['title'], limits.maxTextLength);
    if (!title.trim())
        fail('ARTIFACT_EMPTY');
    const paragraphs = array(v['paragraphs'], 1000).map(p => takeText(p, limits.maxTextLength));
    let table: ArtifactTable | undefined;
    if (v['table'] !== undefined) {
        const t = object(v['table'], ['columns', 'rows']);
        const names = new Set<string>();
        const columns = array(t['columns'], limits.maxColumns).map(c => {
            const col = object(c, ['name', 'type']), name = takeText(col['name'], 200);
            if (!name.trim() || names.has(name) || (typeof col['type'] !== 'string' || !['text', 'boolean', 'integer', 'decimal'].includes(col['type'])))
                fail('ARTIFACT_COLUMN_INVALID');
            names.add(name);
            return { name, type: col['type'] as ColumnType };
        });
        if (columns.length === 0)
            fail('ARTIFACT_COLUMN_INVALID');
        const rows = array(t['rows'], limits.maxRows).map(row => {
            const cells = array(row, limits.maxColumns);
            if (cells.length !== columns.length)
                fail('ARTIFACT_ROW_INVALID');
            return cells.map((cell, i) => {
                if (cell === null)
                    return null;
                const type = columns[i]!.type;
                if (type === 'text')
                    return takeText(cell, limits.maxTextLength);
                if (type === 'boolean') {
                    if (typeof cell !== 'boolean')
                        fail('ARTIFACT_CELL_INVALID');
                    return cell;
                }
                if (type === 'integer' && typeof cell === 'number') {
                    if (!Number.isSafeInteger(cell) || Object.is(cell, -0))
                        fail('ARTIFACT_PRECISION_DENIED');
                    return cell;
                }
                if (typeof cell !== 'string' || cell.length > 128 || !(type === 'integer' ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/).test(cell))
                    fail('ARTIFACT_PRECISION_DENIED');
                takeText(cell, 128);
                return cell;
            });
        });
        table = { columns, rows };
    }
    if ((format === 'csv' || format === 'xlsx') && !table)
        fail('ARTIFACT_TABLE_REQUIRED');
    if (format === 'csv' && paragraphs.length > 0)
        fail('ARTIFACT_CSV_PARAGRAPHS_UNSUPPORTED');
    const request: ArtifactRequest = { format, title, paragraphs, ...(table ? { table } : {}) };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > limits.maxInputBytes)
        fail('ARTIFACT_INPUT_LIMIT');
    return request;
}
function options(input: ArtifactOptions): {
    limits: ArtifactLimits;
    signal: AbortSignal | undefined;
    font: ReviewedPdfFont | undefined;
    documentFont: ReviewedDocumentFont | undefined;
} {
    const o = object(input, ['signal', 'limits', 'pdfFont', 'docxFont']);
    if (o['signal'] !== undefined && !(o['signal'] instanceof AbortSignal))
        fail('ARTIFACT_SIGNAL_INVALID');
    const limits = { ...caps };
    if (o['limits'] !== undefined) {
        const l = object(o['limits'], Object.keys(caps));
        for (const key of Object.keys(l) as (keyof ArtifactLimits)[]) {
            const value = l[key];
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > caps[key])
                fail('ARTIFACT_LIMIT_INVALID');
            limits[key] = value;
        }
    }
    let font: ReviewedPdfFont | undefined;
    if (o['pdfFont'] !== undefined) {
        const f = object(o['pdfFont'], ['bytes', 'sha256']);
        if (!Buffer.isBuffer(f['bytes']) || typeof f['sha256'] !== 'string')
            fail('ARTIFACT_FONT_INVALID');
        font = { bytes: f['bytes'], sha256: f['sha256'] };
    }
    let documentFont: ReviewedDocumentFont | undefined;
    if (o['docxFont'] !== undefined) {
        const f = object(o['docxFont'], ['bytes', 'sha256', 'family']);
        if (!Buffer.isBuffer(f['bytes']) || typeof f['sha256'] !== 'string' || typeof f['family'] !== 'string')
            fail('ARTIFACT_FONT_INVALID');
        documentFont = { bytes: f['bytes'], sha256: f['sha256'], family: f['family'] };
    }
    return { limits, signal: o['signal'] as AbortSignal | undefined, font, documentFont };
}
function check(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
        fail('ARTIFACT_CANCELLED');
}
function display(value: string | number | boolean | null): string { return value === null ? '' : String(value); }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const decodeXml = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, c => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }[c]!));
const escapeMarkdown = (value: string): string => escapeHtml(value).replace(/([\\`*_{}[\]()#+.!|>~\-])/g, '\\$1').replace(/\r?\n/g, '<br>');
/** Apostrophe is deliberately part of the exported CSV value: consumers must not strip it before opening in a spreadsheet. */
export function safeCsvText(value: string): string { return /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value; }
const csvCell = (value: string): string => '"' + safeCsvText(value).replace(/"/g, '""') + '"';
function csvRows(r: ArtifactRequest): string[][] { return [r.table!.columns.map(c => c.name), ...r.table!.rows.map(row => row.map(display))]; }
/** Strict reader for our RFC4180 quoted CSV subset; used again before releasing bytes. */
export function inspectCsv(bytes: Buffer): string[][] {
    const source = new TextDecoder('utf8', { fatal: true }).decode(bytes), rows: string[][] = [];
    let at = 0;
    while (at < source.length) {
        const row: string[] = [];
        for (;;) {
            if (source[at++] !== '"')
                fail('ARTIFACT_CSV_INVALID');
            let cell = '', closed = false;
            while (at < source.length) {
                const c = source[at++]!;
                if (c === '"') {
                    if (source[at] === '"') {
                        cell += '"';
                        at++;
                    }
                    else {
                        closed = true;
                        break;
                    }
                }
                else
                    cell += c;
            }
            if (!closed)
                fail('ARTIFACT_CSV_INVALID');
            row.push(cell);
            if (source[at] === ',') {
                at++;
                continue;
            }
            if (source.slice(at, at + 2) !== '\r\n')
                fail('ARTIFACT_CSV_INVALID');
            at += 2;
            break;
        }
        rows.push(row);
    }
    return rows;
}
function lines(r: ArtifactRequest): string[] {
    const result = [r.title, ...r.paragraphs];
    if (r.table) {
        result.push(r.table.columns.map(c => c.name).join(' | '));
        for (const [i, row] of r.table.rows.entries()) {
            result.push(`Row ${i + 1}`);
            for (const [j, cell] of row.entries())
                result.push(`${r.table.columns[j]!.name}: ${cell === null ? '(null)' : display(cell)}`);
        }
    }
    return result.flatMap(s => s.replace(/\r\n?/g, '\n').split('\n'));
}
function jsonBody(r: ArtifactRequest): string { return JSON.stringify({ schemaVersion: 1, title: r.title, paragraphs: r.paragraphs, table: r.table ?? null }, null, 2) + '\n'; }
function htmlBody(r: ArtifactRequest): string { return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>' + escapeHtml(r.title) + '</title></head><body><h1>' + escapeHtml(r.title) + '</h1>' + r.paragraphs.map(p => '<p>' + escapeHtml(p) + '</p>').join('') + (r.table ? '<table><thead><tr>' + r.table.columns.map(c => '<th>' + escapeHtml(c.name) + '</th>').join('') + '</tr></thead><tbody>' + r.table.rows.map(row => '<tr>' + row.map(c => '<td>' + escapeHtml(display(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' : '') + '</body></html>\n'; }
function markdownBody(r: ArtifactRequest): string { return '# ' + escapeMarkdown(r.title) + '\n\n' + r.paragraphs.map(p => escapeMarkdown(p) + '\n\n').join('') + (r.table ? '| ' + r.table.columns.map(c => escapeMarkdown(c.name)).join(' | ') + ' |\n| ' + r.table.columns.map(() => '---').join(' | ') + ' |\n' + r.table.rows.map(row => '| ' + row.map(c => escapeMarkdown(display(c))).join(' | ') + ' |\n').join('') : ''); }
function equal(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        fail('ARTIFACT_CONTENT_MISMATCH');
}
function zipInspection(bytes: Buffer, limits: ArtifactLimits): Map<string, Buffer> {
    const zip = inspectZip(bytes, limits);
    for (const [name, data] of zip) {
        if (name.endsWith('.rels') && /TargetMode\s*=\s*["']External["']/i.test(data.toString()))
            fail('ARTIFACT_EXTERNAL_RELATIONSHIP');
        if (/(?:vbaProject|externalLinks|embeddings)\//i.test(name))
            fail('ARTIFACT_ACTIVE_CONTENT');
    }
    return zip;
}
async function xlsx(r: ArtifactRequest, limits: ArtifactLimits, signal: AbortSignal | undefined): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    book.creator = 'anthys';
    book.created = new Date('2000-01-01T00:00:00Z');
    book.modified = new Date('2000-01-01T00:00:00Z');
    const summary = book.addWorksheet('Document');
    summary.addRows([[r.title], ...r.paragraphs.map(p => [p])]);
    const sheet = book.addWorksheet('Data');
    const expected = [r.table!.columns.map(c => c.name), ...r.table!.rows.map(row => row.map((c, i) => c !== null && r.table!.columns[i]!.type === 'integer' ? String(c) : c))];
    sheet.addRows(expected);
    for (const ws of book.worksheets)
        ws.eachRow(row => row.eachCell(cell => {
            if (typeof cell.value === 'string')
                cell.numFmt = '@';
        }));
    check(signal);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    if (bytes.length > limits.maxOutputBytes)
        fail('ARTIFACT_OUTPUT_LIMIT');
    zipInspection(bytes, limits);
    check(signal);
    const read = new ExcelJS.Workbook();
    await read.xlsx.load(bytes as never);
    for (const ws of read.worksheets)
        ws.eachRow(row => row.eachCell(cell => {
            if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Hyperlink || cell.formula !== undefined || cell.hyperlink !== undefined)
                fail('ARTIFACT_XLSX_ACTIVE_CELL');
        }));
    equal(read.worksheets.map(ws => ws.name), ['Document', 'Data']);
    for (const [i, row] of expected.entries())
        for (const [j, value] of row.entries())
            equal(read.getWorksheet('Data')!.getCell(i + 1, j + 1).value, value);
    for (const [i, value] of [r.title, ...r.paragraphs].entries())
        equal(read.getWorksheet('Document')!.getCell(i + 1, 1).value, value);
    return bytes;
}
function wrap(source: string, max: number): string[] {
    const result: string[] = [];
    let line = '', units = 0;
    for (const cp of source) {
        const size = (cp.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
        if (units + size > max) {
            result.push(line);
            line = '';
            units = 0;
        }
        line += cp;
        units += size;
    }
    result.push(line);
    return result;
}
async function docx(r: ArtifactRequest, limits: ArtifactLimits, font: ReviewedDocumentFont | undefined): Promise<{
    bytes: Buffer;
    pages: number;
}> {
    const raw = lines(r).map(s => s.replace(/\t/g, '    ')), all = raw.join('\n');
    if (!font && /[^\x0a\x0d\x20-\x7e]/.test(all))
        fail('ARTIFACT_DOCX_FONT_REQUIRED');
    const fontBytes = font ? verifyFont(font, all, limits.maxFontBytes) : undefined;
    if (fontBytes) {
        verifyEmbedding(fontBytes, 'docx');
        verifyDocumentFamily(fontBytes, font!.family);
    }
    const family = font?.family ?? 'Courier New', lineHeight = fontBytes ? reviewedLineHeight(fontBytes, 10) : 14, perPage = Math.floor(648 / lineHeight);
    let source: string[];
    if (fontBytes) {
        const metrics = new PDFDocument({ autoFirstPage: false });
        try {
            metrics.font(fontBytes).fontSize(10);
            source = raw.flatMap(value => { const result: string[] = []; let line = ''; for (const cp of value) {
                if (metrics.widthOfString(line + cp) > 420) {
                    if (!line)
                        fail('ARTIFACT_DOCX_GLYPH_TOO_WIDE');
                    result.push(line);
                    line = '';
                }
                line += cp;
            } result.push(line); return result; });
        }
        finally {
            metrics.destroy();
        }
    }
    else
        source = raw.flatMap(s => wrap(s, 72));
    const pages = Math.max(1, Math.ceil(source.length / perPage));
    if (pages > limits.maxPages)
        fail('ARTIFACT_PAGE_LIMIT');
    const paragraphs = source.map((s, i) => new Paragraph({ spacing: { before: 0, after: 0, line: lineHeight * 20, lineRule: 'exact' }, children: [...(i > 0 && i % perPage === 0 ? [new PageBreak()] : []), new TextRun({ text: s, font: { ascii: family, hAnsi: family, eastAsia: family, cs: family }, size: 20 })] }));
    const bytes = await Packer.toBuffer(new Document({ creator: 'anthys', title: r.title, description: 'Structured artifact', ...(fontBytes ? { fonts: [{ name: family, data: fontBytes }] } : {}), sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: paragraphs }] }));
    if (bytes.length > limits.maxOutputBytes)
        fail('ARTIFACT_OUTPUT_LIMIT');
    const zip = zipInspection(bytes, limits), xml = zip.get('word/document.xml')?.toString();
    if (!xml)
        fail('ARTIFACT_DOCX_INVALID');
    const extracted = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => decodeXml(m[1]!));
    equal(extracted.filter(Boolean), source.filter(Boolean));
    equal((xml.match(/<w:br w:type="page"\s*\/>/g) ?? []).length, pages - 1);
    if (fontBytes) {
        const embedded = zip.get('word/fonts/font1.odttf'), fontXml = zip.get('word/fontTable.xml')?.toString(), key = fontXml?.match(/w:fontKey="\{([A-F0-9-]+)\}"/)?.[1];
        if (!embedded || !key)
            fail('ARTIFACT_DOCX_FONT_UNVERIFIED');
        const decoded = Buffer.from(embedded), mask = Buffer.from(key.replace(/-/g, ''), 'hex').reverse();
        for (let i = 0; i < Math.min(32, decoded.length); i++)
            decoded[i] = decoded[i]! ^ mask[i % 16]!;
        if (!decoded.equals(fontBytes))
            fail('ARTIFACT_DOCX_FONT_UNVERIFIED');
    }
    return { bytes, pages };
}
interface PdfResult {
    bytes: Buffer;
    pages: number;
}
async function pdf(r: ArtifactRequest, limits: ArtifactLimits, signal: AbortSignal | undefined, font: ReviewedPdfFont | undefined): Promise<PdfResult> {
    const source = lines(r), all = source.join('\n').replace(/\t/g, '    ');
    if (!font && /[^\x09\x0a\x0d\x20-\x7e]/.test(all))
        fail('ARTIFACT_PDF_FONT_REQUIRED');
    const fontBytes = font ? verifyFont(font, all, limits.maxFontBytes) : undefined;
    if (fontBytes)
        verifyEmbedding(fontBytes, 'pdf');
    const lineHeight = fontBytes ? reviewedLineHeight(fontBytes, 10) : 14;
    const document = new PDFDocument({ autoFirstPage: false, compress: false, bufferPages: true, size: 'A4', margin: 48, info: { Title: r.title, Author: 'anthys', Creator: 'anthys', CreationDate: new Date('2000-01-01T00:00:00Z'), ModDate: new Date('2000-01-01T00:00:00Z') } });
    const chunks: Buffer[] = [];
    let total = 0;
    let outputError: Error | undefined;
    const done = new Promise<Buffer>((resolve, reject) => {
        document.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > limits.maxOutputBytes) {
                outputError = new ArtifactFailure('ARTIFACT_OUTPUT_LIMIT');
                document.destroy(outputError);
            }
            else
                chunks.push(chunk);
        });
        document.once('error', reject);
        document.once('end', () => resolve(Buffer.concat(chunks)));
    });
    // Attach a rejection handler immediately so an encoding failure cannot leave an unhandled stream promise.
    void done.catch(() => { });
    const abort = () => document.destroy(new ArtifactFailure('ARTIFACT_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    let pages = 0;
    const emitted: string[] = [];
    try {
        document.font(fontBytes ?? 'Courier').fontSize(10);
        let y = 48;
        const width = 499;
        for (const raw of source) {
            check(signal);
            let current = '';
            const wrapped: string[] = [];
            for (const cp of raw.replace(/\t/g, '    ')) {
                if (document.widthOfString(current + cp) > width) {
                    if (!current)
                        fail('ARTIFACT_PDF_GLYPH_TOO_WIDE');
                    wrapped.push(current);
                    current = '';
                }
                current += cp;
            }
            wrapped.push(current);
            for (const line of wrapped) {
                if (pages === 0 || y + lineHeight > 794) {
                    pages++;
                    if (pages > limits.maxPages)
                        fail('ARTIFACT_PAGE_LIMIT');
                    document.addPage();
                    y = 48;
                }
                if (line) {
                    document.text(line, 48, y, { lineBreak: false });
                    emitted.push(line);
                }
                y += lineHeight;
            }
        }
        document.end();
        const bytes = await done;
        check(signal);
        if (outputError)
            throw outputError;
        const read = inspectPdf(bytes, limits.maxExpandedBytes);
        equal(read.pages, pages);
        equal(read.embeddedFont, Boolean(fontBytes));
        equal(read.text, emitted.join(''));
        return { bytes, pages };
    }
    catch (error) {
        document.destroy();
        throw error;
    }
    finally {
        signal?.removeEventListener('abort', abort);
    }
}
/** Pure in-memory renderer. Authorization, provenance, persistence and delivery belong to the caller. */
export async function renderArtifact(input: unknown, rawOptions: ArtifactOptions = {}): Promise<RenderedArtifact> {
    try {
        const { limits, signal, font, documentFont } = options(rawOptions);
        check(signal);
        const request = parse(input, limits);
        check(signal);
        let bytes: Buffer, pages: number | null = null, pagination: ArtifactInspection['pagination'] = 'NOT_APPLICABLE', method = 'UTF8_ROUND_TRIP';
        switch (request.format) {
            case 'txt': {
                const body = lines(request).join('\n') + '\n';
                bytes = Buffer.from(body);
                equal(new TextDecoder('utf8', { fatal: true }).decode(bytes), body);
                break;
            }
            case 'markdown': {
                const body = markdownBody(request);
                bytes = Buffer.from(body);
                equal(new TextDecoder('utf8', { fatal: true }).decode(bytes), body);
                method = 'ESCAPED_MARKDOWN_UTF8';
                break;
            }
            case 'csv': {
                const rows = csvRows(request);
                bytes = Buffer.from(rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
                equal(inspectCsv(bytes), rows.map(row => row.map(safeCsvText)));
                method = 'CSV_QUOTED_READ_BACK';
                break;
            }
            case 'json': {
                const body = jsonBody(request);
                bytes = Buffer.from(body);
                equal(JSON.parse(bytes.toString()), JSON.parse(body));
                method = 'VERSIONED_JSON_READ_BACK';
                break;
            }
            case 'html': {
                const body = htmlBody(request);
                bytes = Buffer.from(body);
                equal(new TextDecoder('utf8', { fatal: true }).decode(bytes), body);
                if ((body.match(/<[^>]+>/g) ?? []).some(tag => /<(?:script|iframe|object|embed|link|img|svg)\b|\s(?:src|href|on\w+)\s*=/i.test(tag)))
                    fail('ARTIFACT_HTML_INVALID');
                method = 'FIXED_HTML_ESCAPED_TEXT';
                break;
            }
            case 'xlsx':
                bytes = await xlsx(request, limits, signal);
                method = 'XLSX_ZIP_AND_EXCELJS_READ_BACK';
                break;
            case 'docx': {
                const result = await docx(request, limits, documentFont);
                bytes = result.bytes;
                pages = result.pages;
                pagination = 'DOCX_EXPLICIT_BREAKS_NOT_VISUALLY_RENDERED';
                method = 'DOCX_ZIP_XML_TEXT_AND_EXPLICIT_PAGE_BREAKS';
                break;
            }
            case 'pdf': {
                const result = await pdf(request, limits, signal, font);
                bytes = result.bytes;
                pages = result.pages;
                pagination = 'PDF_PAGE_OBJECTS';
                method = 'PDF_PAGE_OBJECTS_AND_TEXT_OPERATORS';
                break;
            }
        }
        check(signal);
        if (bytes.length === 0)
            fail('ARTIFACT_EMPTY');
        if (bytes.length > limits.maxOutputBytes)
            fail('ARTIFACT_OUTPUT_LIMIT');
        return { format: request.format, ...formats[request.format], bytes, sha256: createHash('sha256').update(bytes).digest('hex'), inspection: { state: 'VERIFIED', method, contentSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), rowCount: request.table?.rows.length ?? 0, columnCount: request.table?.columns.length ?? 0, pageCount: pages, pagination, formulaCells: 0, externalRelationships: 0, titleIncluded: request.format !== 'csv', determinism: 'CONTENT_ONLY', warnings: request.format === 'docx' ? ['Explicit pagination and XML text verified; Word visual layout is not rendered.'] : request.format === 'csv' ? ['Title is metadata only; CSV contains the table. Formula-like text includes a protective apostrophe.'] : [] } };
    }
    catch (error) {
        if (error instanceof ArtifactFailure)
            throw error;
        const code = error instanceof Error && /^ARTIFACT_[A-Z_]+$/.test(error.message) ? error.message : 'ARTIFACT_RENDER_FAILED';
        throw new ArtifactFailure(code);
    }
}
export type { ReviewedPdfFont, ReviewedDocumentFont } from './font.js';
