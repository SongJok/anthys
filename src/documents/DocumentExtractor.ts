import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ZipError, ZipReader } from './ZipReader.js';
import { attr, collectText, decodeXml } from './xml.js';

export type DocumentFormat = 'pptx' | 'docx' | 'xlsx' | 'csv' | 'pdf';

export interface ExtractedSheet {
  name: string;
  rowCount: number;
  /** 完整 CSV（UTF-8），供沙盒 datasetKeys 做整表分析 */
  csv: string;
}

export interface ExtractedImage {
  /** 例如“第 3 页”或“正文” */
  label: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface ExtractedDocument {
  format: DocumentFormat;
  /** 面向模型的 Markdown 文本（可能被截断，见 truncated） */
  text: string;
  /** 页数 / 段落数 / 工作表数 */
  unitCount: number;
  unitLabel: string;
  sheets: ExtractedSheet[];
  /** 文档内嵌的有意义图片（用于视觉识别），已按数量/大小过滤 */
  images?: ExtractedImage[];
  warnings: string[];
  truncated: boolean;
}

export class DocumentExtractionError extends Error {
  constructor(
    message: string,
    /** unsupported：格式本身不支持；corrupt：文件损坏/加密；empty：无可提取文字 */
    public readonly reason: 'unsupported' | 'corrupt' | 'empty',
  ) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

export interface ExtractOptions {
  /** 提取文本上限（字符），默认 200k */
  maxChars?: number;
  /** xlsx 文本预览每表最多行数，默认 60 */
  previewRows?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_PREVIEW_ROWS = 60;

const FORMAT_BY_EXT: Record<string, DocumentFormat> = {
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.docx': 'docx',
  '.docm': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
};

const LEGACY_HINT: Record<string, string> = {
  '.ppt': 'PowerPoint 97-2003 (.ppt)',
  '.doc': 'Word 97-2003 (.doc)',
  '.xls': 'Excel 97-2003 (.xls)',
};

/** 这类扩展名值得走文档提取通道 */
export function isExtractableExtension(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return ext in FORMAT_BY_EXT || ext in LEGACY_HINT || ext === '.csv' || ext === '.pdf';
}

export function isOfficeExtension(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return ext in FORMAT_BY_EXT || ext in LEGACY_HINT || ext === '.pdf';
}

/** 解码文本：优先 UTF-8（含 BOM），失败回退 GB18030（国内 Excel 导出 CSV 常见） */
export function decodeTextBuffer(buffer: Buffer): { text: string; encoding: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
    } catch {
      return { text: buffer.toString('utf8'), encoding: 'utf-8-lossy' };
    }
  }
}

export async function extractDocumentFile(
  path: string,
  options: ExtractOptions = {},
): Promise<ExtractedDocument> {
  return extractDocument(await readFile(path), path, options);
}

export function extractDocument(
  buffer: Buffer,
  fileName: string,
  options: ExtractOptions = {},
): ExtractedDocument {
  const ext = extname(fileName).toLowerCase();
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const previewRows = options.previewRows ?? DEFAULT_PREVIEW_ROWS;

  if (ext === '.csv') return extractCsv(buffer, maxChars, previewRows);

  const isOle = buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (ext in LEGACY_HINT || isOle) {
    const label = LEGACY_HINT[ext] ?? '旧版 Office 二进制格式';
    throw new DocumentExtractionError(
      `${label} 为旧版二进制格式，暂不能直接解析。请在 Office/WPS 中“另存为”新版格式（.pptx/.docx/.xlsx）后重新上传。`,
      'unsupported',
    );
  }

  let zip: ZipReader;
  try {
    zip = new ZipReader(buffer);
  } catch (error) {
    throw new DocumentExtractionError(
      error instanceof ZipError ? error.message : '文件无法作为 Office 文档打开',
      'corrupt',
    );
  }
  const format = FORMAT_BY_EXT[ext] ?? sniffFormat(zip);
  if (!format) {
    throw new DocumentExtractionError('无法识别的文档格式', 'unsupported');
  }
  try {
    const doc =
      format === 'pptx'
        ? extractPptx(zip)
        : format === 'docx'
          ? extractDocx(zip)
          : extractXlsx(zip, previewRows);
    return finalize(doc, maxChars);
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError(
      `解析 ${format} 失败：${(error as Error).message}`,
      'corrupt',
    );
  }
}

function sniffFormat(zip: ZipReader): DocumentFormat | undefined {
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  return undefined;
}

function finalize(doc: ExtractedDocument, maxChars: number): ExtractedDocument {
  const body = doc.text.trim();
  if (!body && doc.sheets.every((s) => s.rowCount === 0)) {
    throw new DocumentExtractionError(
      '文档中没有可提取的文字（可能全是图片/扫描件），建议导出为图片或文本后再上传',
      'empty',
    );
  }
  if (body.length > maxChars) {
    return {
      ...doc,
      text: `${body.slice(0, maxChars)}\n…（已截断）`,
      truncated: true,
    };
  }
  return { ...doc, text: body };
}

/* ---------------------------------- 通用段落 --------------------------------- */

function paragraphText(xml: string, ns: 'a' | 'w'): string {
  const re = new RegExp(
    `<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:br\\s*/?>|<${ns}:tab\\s*/?>`,
    'g',
  );
  let out = '';
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else out += m[0].includes(':tab') ? '\t' : '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

function paragraphsOf(xml: string, ns: 'a' | 'w'): string[] {
  const re = new RegExp(`<${ns}:p(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:p>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const text = paragraphText(m[1]!, ns);
    if (text) out.push(text);
  }
  return out;
}

function tableRows(xml: string, ns: 'a' | 'w'): string[][] {
  const rowRe = new RegExp(`<${ns}:tr(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:tr>`, 'g');
  const cellRe = new RegExp(`<${ns}:tc(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:tc>`, 'g');
  const rows: string[][] = [];
  for (const row of xml.matchAll(rowRe)) {
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(cellRe)) {
      cells.push(paragraphsOf(cell[1]!, ns).join(' / ').replace(/\|/g, '\\|'));
    }
    if (cells.some((c) => c)) rows.push(cells);
  }
  return rows;
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
  const head = line(rows[0]!);
  const sep = `| ${Array(width).fill('---').join(' | ')} |`;
  return [head, sep, ...rows.slice(1).map(line)].join('\n');
}

/* ---------------------------------- 图片/图表 --------------------------------- */

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_EMBEDDED_IMAGES = 8;
const MIN_IMAGE_BYTES = 8 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function pickImage(
  zip: ZipReader,
  path: string,
  label: string,
  seen: Set<string>,
  out: ExtractedImage[],
): void {
  if (out.length >= MAX_EMBEDDED_IMAGES || seen.has(path)) return;
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return;
  seen.add(path);
  try {
    const data = zip.read(path);
    if (!data || data.length < MIN_IMAGE_BYTES || data.length > MAX_IMAGE_BYTES) return;
    out.push({ label, fileName: path.split('/').pop() ?? path, mimeType: mime, data });
  } catch {
    // 单张图片损坏不影响整体
  }
}

/** 解析图表缓存（系列名/分类/数值），转为 Markdown 表 */
function extractChart(xml: string): string {
  const cache = (block: string): string[] =>
    [...block.matchAll(/<c:pt\b[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)].map((m) => decodeXml(m[1]!));
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((m) => {
    const body = m[1]!;
    const name = cache(/<c:tx>[\s\S]*?<\/c:tx>/.exec(body)?.[0] ?? '')[0] ?? '系列';
    const cats = cache(/<c:cat>[\s\S]*?<\/c:cat>/.exec(body)?.[0] ?? '');
    const vals = cache(/<c:val>[\s\S]*?<\/c:val>/.exec(body)?.[0] ?? '');
    return { name, cats, vals };
  });
  if (series.length === 0) return '';
  const cats = series.find((x) => x.cats.length)?.cats ?? series[0]!.vals.map((_, i) => String(i + 1));
  const rows = [['', ...series.map((x) => x.name)]];
  cats.forEach((c, i) => rows.push([c, ...series.map((x) => x.vals[i] ?? '')]));
  return markdownTable(rows);
}

/* ----------------------------------- PPTX ----------------------------------- */

function relTargets(zip: ZipReader, relPath: string): Map<string, string> {
  const xml = zip.readText(relPath);
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function slidePaths(zip: ZipReader): string[] {
  const ordered: string[] = [];
  const pres = zip.readText('ppt/presentation.xml');
  if (pres) {
    const rels = relTargets(zip, 'ppt/_rels/presentation.xml.rels');
    for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
      const rid = attr(m[0], 'r:id');
      const target = rid ? rels.get(rid) : undefined;
      if (target) {
        const path = resolveTarget('ppt', target);
        if (zip.has(path)) ordered.push(path);
      }
    }
  }
  if (ordered.length > 0) return ordered;
  return zip
    .list()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => num(a) - num(b));
}

function num(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function extractPptx(zip: ZipReader): ExtractedDocument {
  const slides = slidePaths(zip);
  if (slides.length === 0) {
    throw new DocumentExtractionError('PPTX 中未找到幻灯片', 'corrupt');
  }
  const warnings: string[] = [];
  const parts: string[] = [];
  const images: ExtractedImage[] = [];
  const seenImages = new Set<string>();
  let pictures = 0;
  slides.forEach((path, index) => {
    const xml = zip.readText(path) ?? '';
    const blocks = xml.match(
      /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>|<p:graphicFrame(?:\s[^>]*)?>[\s\S]*?<\/p:graphicFrame>/g,
    ) ?? [];
    let title = '';
    const body: string[] = [];
    for (const block of blocks) {
      if (block.startsWith('<p:graphicFrame')) {
        const rows = tableRows(block, 'a');
        if (rows.length > 0) body.push(markdownTable(rows));
        else {
          const paras = paragraphsOf(block, 'a');
          if (paras.length > 0) body.push(...paras.map((p) => `- ${p}`));
        }
        continue;
      }
      const phType = /<p:ph\b[^>]*\btype="([^"]+)"/.exec(block)?.[1];
      if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr') continue;
      const paras = paragraphsOf(block, 'a');
      if (paras.length === 0) continue;
      if (!title && (phType === 'title' || phType === 'ctrTitle')) {
        title = paras.join(' ');
      } else {
        body.push(...paras.map((p) => (paras.length > 1 ? `- ${p}` : p)));
      }
    }
    pictures += (xml.match(/<p:pic>/g) ?? []).length;

    let notes = '';
    const slideRels = relTargets(
      zip,
      `ppt/slides/_rels/${path.split('/').pop()}.rels`,
    );
    for (const target of slideRels.values()) {
      if (/(^|\/)charts\/chart\d+\.xml$/.test(target)) {
        const chartXml = zip.readText(resolveTarget('ppt/slides', target));
        const table = chartXml ? extractChart(chartXml) : '';
        body.push(table ? `[图表数据]\n${table}` : '[本页含图表，未能提取数据]');
      } else if (/media\//.test(target)) {
        pickImage(zip, resolveTarget('ppt/slides', target), `第 ${index + 1} 页`, seenImages, images);
      }
      if (target.includes('notesSlide')) {
        const notesXml = zip.readText(resolveTarget('ppt/slides', target));
        if (notesXml) {
          const noteBlocks = notesXml.match(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g) ?? [];
          notes = noteBlocks
            .filter((b) => /<p:ph\b[^>]*\btype="body"/.test(b))
            .flatMap((b) => paragraphsOf(b, 'a'))
            .join('\n');
        }
      }
    }
    const head = `## 第 ${index + 1} 页${title ? `：${title}` : ''}`;
    const sections = [head, ...body];
    if (notes) sections.push(`> 讲者备注：${notes.replace(/\n/g, ' ')}`);
    parts.push(sections.join('\n'));
  });
  if (pictures > 0) {
    warnings.push(`文档含 ${pictures} 张图片，图片内容仅在视觉模型启用时识别`);
  }
  return {
    format: 'pptx',
    text: parts.join('\n\n'),
    unitCount: slides.length,
    unitLabel: '页',
    sheets: [],
    images,
    warnings,
    truncated: false,
  };
}

/* ----------------------------------- DOCX ----------------------------------- */

function extractDocx(zip: ZipReader): ExtractedDocument {
  const xml = zip.readText('word/document.xml');
  if (!xml) throw new DocumentExtractionError('DOCX 中未找到正文', 'corrupt');
  const out: string[] = [];
  let paragraphs = 0;
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    if (block.startsWith('<w:tbl>')) {
      const table = markdownTable(tableRows(block, 'w'));
      if (table) out.push(table);
      continue;
    }
    const text = paragraphText(block, 'w');
    if (!text) continue;
    paragraphs += 1;
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(block)?.[1] ?? '';
    const level = /^(?:heading|标题)\s*(\d)$/i.exec(style)?.[1];
    if (level) out.push(`${'#'.repeat(Math.min(6, Number(level)))} ${text}`);
    else if (/^title$/i.test(style)) out.push(`# ${text}`);
    else if (/<w:numPr>/.test(block)) out.push(`- ${text}`);
    else out.push(text);
  }
  const warnings: string[] = [];
  const mediaPaths = zip.list().filter((n) => n.startsWith('word/media/'));
  const images: ExtractedImage[] = [];
  const seenImages = new Set<string>();
  for (const path of mediaPaths) pickImage(zip, path, '正文', seenImages, images);
  if (mediaPaths.length > 0) {
    warnings.push(`文档含 ${mediaPaths.length} 张图片，图片内容仅在视觉模型启用时识别`);
  }
  return {
    format: 'docx',
    text: out.join('\n\n'),
    unitCount: paragraphs,
    unitLabel: '段',
    sheets: [],
    images,
    warnings,
    truncated: false,
  };
}

/* ----------------------------------- XLSX ----------------------------------- */

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function extractXlsx(zip: ZipReader, previewRows: number): ExtractedDocument {
  const workbook = zip.readText('xl/workbook.xml');
  if (!workbook) throw new DocumentExtractionError('XLSX 中未找到工作簿', 'corrupt');
  const rels = relTargets(zip, 'xl/_rels/workbook.xml.rels');

  const shared: string[] = [];
  const sst = zip.readText('xl/sharedStrings.xml');
  if (sst) {
    for (const m of sst.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
      shared.push(collectText(m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't'));
    }
  }

  const dateStyles = dateStyleSet(zip.readText('xl/styles.xml'));
  const epoch1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/.test(workbook);
  const sheets: ExtractedSheet[] = [];
  const textParts: string[] = [];
  const warnings: string[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const target = rid ? rels.get(rid) : undefined;
    const path = target ? resolveTarget('xl', target) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = zip.readText(path);
    if (xml === undefined) continue;
    if (/\bstate="(?:hidden|veryHidden)"/.test(m[0])) {
      warnings.push(`工作表「${name}」为隐藏表`);
    }
    const rows = parseSheetRows(xml, shared, dateStyles, epoch1904);
    const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    sheets.push({ name, rowCount: rows.length, csv });
    const shown = rows.slice(0, previewRows);
    const lines = shown.map((r) => r.join(' | '));
    textParts.push(
      [
        `## 工作表「${name}」（${rows.length} 行）`,
        ...lines,
        rows.length > shown.length
          ? `…（仅预览前 ${shown.length} 行，完整数据已另存为 CSV）`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (sheets.length === 0) {
    throw new DocumentExtractionError('XLSX 中未找到工作表', 'corrupt');
  }
  warnings.push('公式输出为缓存值（Excel 最后一次保存时的计算结果）');
  return {
    format: 'xlsx',
    text: textParts.join('\n\n'),
    unitCount: sheets.length,
    unitLabel: '个工作表',
    sheets,
    warnings,
    truncated: false,
  };
}

const BUILTIN_DATE_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50,
  51, 52, 53, 54, 55, 56, 57, 58,
]);

/** 解析 styles.xml，返回“属于日期格式”的 cellXfs 下标集合 */
function dateStyleSet(styles: string | undefined): Set<number> {
  const result = new Set<number>();
  if (!styles) return result;
  const customDate = new Set<number>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = (attr(m[0], 'formatCode') ?? '')
      .replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '');
    if (/[ymdhs]/i.test(code)) customDate.add(id);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    if (BUILTIN_DATE_IDS.has(id) || customDate.has(id)) result.add(i);
    i += 1;
  }
  return result;
}

function serialToDate(serial: number, epoch1904: boolean): string {
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(base + Math.round(serial * 86_400_000));
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function parseSheetRows(
  xml: string,
  shared: string[],
  dateStyles: Set<number> = new Set(),
  epoch1904 = false,
): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  for (const rowMatch of xml.matchAll(rowRe)) {
    const inner = rowMatch[1];
    if (!inner) continue;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let next = 0;
    for (const c of inner.matchAll(cellRe)) {
      const head = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = attr(head, 'r');
      const idx = ref ? columnIndex(ref) : next;
      const type = attr(head, 't');
      let value = '';
      if (type === 'inlineStr') value = collectText(body, 't');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else {
            value = decodeXml(v);
            const style = Number(attr(head, 's'));
            const n = Number(value);
            if (!type || type === 'n') {
              if (dateStyles.has(style) && Number.isFinite(n) && n > 0 && n < 2_958_466) {
                value = serialToDate(n, epoch1904);
              }
            }
          }
        }
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value.replace(/\r?\n/g, ' ');
      next = idx + 1;
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/* ------------------------------------ CSV ----------------------------------- */

function extractCsv(buffer: Buffer, maxChars: number, previewRows: number): ExtractedDocument {
  const { text, encoding } = decodeTextBuffer(buffer);
  const lines = text.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const preview = lines.slice(0, previewRows).join('\n');
  const warnings = encoding === 'utf-8' ? [] : [`原文件编码为 ${encoding}，已转为 UTF-8`];
  return finalize(
    {
      format: 'csv',
      text: lines.length > previewRows
        ? `${preview}\n…（仅预览前 ${previewRows} 行，共 ${lines.length} 行）`
        : preview,
      unitCount: lines.length,
      unitLabel: '行',
      sheets: [{ name: 'csv', rowCount: lines.length, csv: text }],
      warnings,
      truncated: false,
    },
    maxChars,
  );
}
