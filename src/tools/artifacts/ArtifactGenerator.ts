import { randomUUID } from 'node:crypto';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { formatShanghaiDate } from '../../time/shanghaiTime.js';

export type ArtifactFormat = 'md' | 'txt' | 'json' | 'html' | 'csv' | 'xlsx' | 'docx';

export interface TableSheetInput {
  name?: string;
  headers?: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
}

export interface GenerateArtifactInput {
  format: ArtifactFormat;
  fileName: string;
  /** md / txt / json / html / docx 使用的正文内容 */
  content?: string;
  /** csv / xlsx 使用的表格数据（支持单表或多工作表） */
  sheets?: TableSheetInput[];
  /** 可选标题，用于 docx 首页或 html 标题 */
  title?: string;
}

export interface GeneratedArtifactFile {
  workspaceRelativePath: string;
  absolutePath: string;
  fileName: string;
  sizeBytes: number;
  format: ArtifactFormat;
}

const VALID_FORMATS = new Set<ArtifactFormat>([
  'md',
  'txt',
  'json',
  'html',
  'csv',
  'xlsx',
  'docx',
]);

export function isArtifactFormat(value: string): value is ArtifactFormat {
  return VALID_FORMATS.has(value as ArtifactFormat);
}

/** 生成标准 IEEE 802.3 CRC-32 表（用于构造合法 ZIP 归档） */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  name: string;
  data: Buffer;
}

/** 轻量无依赖 ZIP 打包器（DEFLATE 压缩，与 ZipReader / Office / WPS 完全兼容） */
export function buildZipBuffer(entries: ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const uncompressed = entry.data;
    const compressed = deflateRawSync(uncompressed);
    const useDeflate = compressed.length < uncompressed.length;
    const payload = useDeflate ? compressed : uncompressed;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localChunks.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central dir header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attr
    centralHeader.writeUInt32LE(0, 38); // external attr
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
}

function columnName(colIndex: number): string {
  let n = colIndex + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/u.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function buildCsvBuffer(sheets: TableSheetInput[]): Buffer {
  const first = sheets[0];
  if (!first) throw new Error('生成 CSV 至少需要提供一个工作表数据');
  const lines: string[] = [];
  if (first.headers && first.headers.length > 0) {
    lines.push(first.headers.map(escapeCsvCell).join(','));
  }
  for (const row of first.rows) {
    lines.push(row.map(escapeCsvCell).join(','));
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function sanitizeSheetName(raw: string | undefined, index: number): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/*?:[\]]+/gu, '_')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

function computeColumnWidths(
  allRows: Array<Array<string | number | boolean | null | undefined>>,
): number[] {
  const widths: number[] = [];
  for (const row of allRows.slice(0, 100)) {
    row.forEach((cell, colIndex) => {
      if (cell === null || cell === undefined) return;
      const lines = String(cell).split(/\r?\n/gu);
      const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
      const estimated = Math.min(54, Math.max(12, Math.ceil(longest * 1.45) + 3));
      widths[colIndex] = Math.max(widths[colIndex] ?? 12, estimated);
    });
  }
  return widths;
}

function buildWorksheetXml(sheet: TableSheetInput): string {
  const allRows: Array<Array<string | number | boolean | null | undefined>> = [];
  if (sheet.headers && sheet.headers.length > 0) {
    allRows.push(sheet.headers);
  }
  for (const row of sheet.rows) {
    allRows.push(row);
  }

  const colWidths = computeColumnWidths(allRows);
  const colsXml =
    colWidths.length > 0
      ? `<cols>${colWidths
          .map(
            (width, idx) =>
              `<col min="${idx + 1}" max="${idx + 1}" width="${width}" customWidth="1"/>`,
          )
          .join('')}</cols>`
      : '';

  const rowXmls: string[] = [];
  allRows.forEach((row, rIdx) => {
    const rowNum = rIdx + 1;
    const isHeader = Boolean(sheet.headers?.length) && rIdx === 0;
    const cells: string[] = [];
    row.forEach((cell, cIdx) => {
      if (cell === null || cell === undefined) return;
      const ref = `${columnName(cIdx)}${rowNum}`;
      const styleAttr = isHeader ? ' s="1"' : ' s="0"';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        cells.push(`<c r="${ref}"${styleAttr}><v>${cell}</v></c>`);
      } else if (typeof cell === 'boolean') {
        cells.push(`<c r="${ref}" t="b"${styleAttr}><v>${cell ? 1 : 0}</v></c>`);
      } else {
        cells.push(
          `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(
            String(cell),
          )}</t></is></c>`,
        );
      }
    });
    rowXmls.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    colsXml +
    `<sheetData>${rowXmls.join('')}</sheetData>` +
    '</worksheet>'
  );
}

/** 构造合法的多工作表 OOXML (.xlsx) 文件 */
export function buildXlsxBuffer(sheets: TableSheetInput[]): Buffer {
  if (sheets.length === 0) {
    throw new Error('生成 Excel（.xlsx）至少需要提供一个 sheets 工作表');
  }
  const usedNames = new Set<string>();
  const normalizedSheets = sheets.map((sheet, index) => {
    let name = sanitizeSheetName(sheet.name, index);
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${name.slice(0, 27)}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());
    return { ...sheet, name };
  });

  const sheetOverrides = normalizedSheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheetOverrides +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbookSheets = normalizedSheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${workbookSheets}</sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    normalizedSheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F8"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border>' +
    '<left style="thin"><color rgb="FFD9DFE8"/></left>' +
    '<right style="thin"><color rgb="FFD9DFE8"/></right>' +
    '<top style="thin"><color rgb="FFD9DFE8"/></top>' +
    '<bottom style="thin"><color rgb="FFD9DFE8"/></bottom>' +
    '<diagonal/>' +
    '</border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '</styleSheet>';

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    ...normalizedSheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(buildWorksheetXml(sheet), 'utf8'),
    })),
  ];

  return buildZipBuffer(entries);
}

function paragraphXml(
  text: string,
  options: { bold?: boolean; sizeHalfPt?: number; indentLeft?: number; colorHex?: string } = {},
): string {
  const pPr = options.indentLeft
    ? `<w:pPr><w:ind w:left="${options.indentLeft}"/></w:pPr>`
    : '';
  const rPrParts: string[] = [];
  if (options.bold) rPrParts.push('<w:b/>');
  if (options.colorHex) rPrParts.push(`<w:color w:val="${options.colorHex}"/>`);
  if (options.sizeHalfPt) {
    rPrParts.push(`<w:sz w:val="${options.sizeHalfPt}"/><w:szCs w:val="${options.sizeHalfPt}"/>`);
  }
  const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!isMarkdownTableRow(line)) return false;
  const inner = line.trim().slice(1, -1);
  return inner
    .split('|')
    .every((cell) => /^\s*:?-{2,}:?\s*$/u.test(cell));
}

function parseMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim().slice(1, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index]!;
    if (ch === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function cleanInlineMarkdown(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/`([^`]+)`/gu, '$1');
}

function tableXml(rows: string[][]): string {
  const tblPr =
    '<w:tblPr>' +
    '<w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>' +
    '</w:tblBorders>' +
    '</w:tblPr>';
  const trs = rows.map((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    const tcs = row.map((cell) => {
      const shd = isHeader
        ? '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/></w:tcPr>'
        : '';
      const lines = cleanInlineMarkdown(cell)
        .split(/<br\s*\/?>|\r?\n/giu)
        .map((line) => line.trim())
        .filter((line, idx, arr) => line.length > 0 || (arr.length === 1 && idx === 0));
      const paras = (lines.length > 0 ? lines : ['']).map((line) =>
        paragraphXml(line, { bold: isHeader, sizeHalfPt: 18 }),
      );
      return `<w:tc>${shd}${paras.join('')}</w:tc>`;
    });
    return `<w:tr>${trsHeader(isHeader)}${tcs.join('')}</w:tr>`;
  });
  return `<w:tbl>${tblPr}${trs.join('')}</w:tbl>`;
}

function trsHeader(isHeader: boolean): string {
  return isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
}

/** 构造合法的 OOXML (.docx) Word 文档，将 Markdown 标题、列表、表格与段落转为结构化正文 */
export function buildDocxBuffer(markdown: string, title?: string): Buffer {
  const blocks: string[] = [];
  if (title?.trim()) {
    blocks.push(paragraphXml(title.trim(), { bold: true, sizeHalfPt: 36 }));
  }

  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    if (!line.trim()) {
      blocks.push('<w:p/>');
      continue;
    }
    if (
      isMarkdownTableRow(line) &&
      index + 1 < lines.length &&
      isMarkdownTableSeparator(lines[index + 1]!)
    ) {
      const tableRows: string[][] = [parseMarkdownTableCells(line)];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index]!)) {
        tableRows.push(parseMarkdownTableCells(lines[index]!));
        index += 1;
      }
      index -= 1;
      blocks.push(tableXml(tableRows));
      continue;
    }
    const h1 = /^#\s+(.+)$/u.exec(line);
    if (h1?.[1]) {
      blocks.push(paragraphXml(cleanInlineMarkdown(h1[1].trim()), { bold: true, sizeHalfPt: 32 }));
      continue;
    }
    const h2 = /^##\s+(.+)$/u.exec(line);
    if (h2?.[1]) {
      blocks.push(paragraphXml(cleanInlineMarkdown(h2[1].trim()), { bold: true, sizeHalfPt: 26 }));
      continue;
    }
    const h3 = /^###+\s+(.+)$/u.exec(line);
    if (h3?.[1]) {
      blocks.push(paragraphXml(cleanInlineMarkdown(h3[1].trim()), { bold: true, sizeHalfPt: 22 }));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote) {
      blocks.push(
        paragraphXml(cleanInlineMarkdown((quote[1] ?? '').trim()), {
          sizeHalfPt: 20,
          indentLeft: 360,
          colorHex: '57606A',
        }),
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet?.[1]) {
      blocks.push(paragraphXml(`• ${cleanInlineMarkdown(bullet[1].trim())}`, { sizeHalfPt: 21 }));
      continue;
    }
    blocks.push(paragraphXml(cleanInlineMarkdown(line), { sizeHalfPt: 21 }));
  }

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${blocks.join('')}<w:sectPr/></w:body>` +
    '</w:document>';

  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

function buildHtmlBuffer(content: string, title?: string): Buffer {
  const trimmed = content.trim();
  if (/^<!doctype\s+html|^<html\b/iu.test(trimmed)) {
    return Buffer.from(trimmed, 'utf8');
  }
  const safeTitle = escapeXml(title?.trim() || '报告文档');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;max-width:900px;margin:32px auto;padding:0 20px;line-height:1.7;color:#1f2329;}pre{background:#f5f6f7;padding:12px;border-radius:6px;overflow-x:auto;}</style>
</head>
<body>
${trimmed}
</body>
</html>`;
  return Buffer.from(html, 'utf8');
}

function normalizeFileName(raw: string, format: ArtifactFormat): string {
  const base = basename(raw.trim());
  const currentExt = extname(base).toLowerCase();
  const stemRaw =
    currentExt === `.${format}` ? base.slice(0, base.length - currentExt.length) : base;
  const stem = stemRaw
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._-]+/u, '')
    .slice(0, 80);
  return `${stem || 'artifact'}.${format}`;
}

export async function generateWorkspaceArtifact(
  workspaceRoot: string,
  input: GenerateArtifactInput,
  options: { maxBytes?: number; now?: () => number; subdirPrefix?: string } = {},
): Promise<GeneratedArtifactFile> {
  if (!isArtifactFormat(input.format)) {
    throw new Error(`不支持的产物格式：${String(input.format)}`);
  }
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const now = options.now ?? Date.now;
  const fileName = normalizeFileName(input.fileName, input.format);

  let payload: Buffer;
  switch (input.format) {
    case 'md':
    case 'txt': {
      const text = input.content ?? '';
      if (!text.trim()) throw new Error(`生成 ${input.format} 需要非空 content`);
      payload = Buffer.from(text, 'utf8');
      break;
    }
    case 'json': {
      const text = input.content ?? '';
      if (!text.trim()) throw new Error('生成 json 需要非空 content');
      try {
        payload = Buffer.from(JSON.stringify(JSON.parse(text), null, 2), 'utf8');
      } catch {
        payload = Buffer.from(text, 'utf8');
      }
      break;
    }
    case 'html': {
      const text = input.content ?? '';
      if (!text.trim()) throw new Error('生成 html 需要非空 content');
      payload = buildHtmlBuffer(text, input.title);
      break;
    }
    case 'csv': {
      if (input.sheets && input.sheets.length > 0) {
        payload = buildCsvBuffer(input.sheets);
      } else if (input.content?.trim()) {
        const raw = input.content.startsWith('\uFEFF')
          ? input.content
          : `\uFEFF${input.content}`;
        payload = Buffer.from(raw, 'utf8');
      } else {
        throw new Error('生成 csv 需要提供 sheets 或 content');
      }
      break;
    }
    case 'xlsx': {
      if (!input.sheets || input.sheets.length === 0) {
        throw new Error('生成 xlsx 需要提供 sheets 数组');
      }
      payload = buildXlsxBuffer(input.sheets);
      break;
    }
    case 'docx': {
      const text = input.content ?? '';
      if (!text.trim()) throw new Error('生成 docx 需要非空 Markdown/文本 content');
      payload = buildDocxBuffer(text, input.title);
      break;
    }
  }

  if (payload.length > maxBytes) {
    throw new Error(
      `生成的文件体积（${payload.length} 字节）超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`,
    );
  }

  const rootReal = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const dateSegment = formatShanghaiDate(now()).replaceAll('-', '');
  const subdir = join(
    options.subdirPrefix ?? 'generated',
    dateSegment,
    `doc_${randomUUID().slice(0, 12)}`,
  );
  const targetDir = resolve(rootReal, subdir);
  if (targetDir !== rootReal && !targetDir.startsWith(`${rootReal}${sep}`)) {
    throw new Error('产物输出路径越界');
  }
  await mkdir(targetDir, { recursive: true });
  const targetDirReal = await realpath(targetDir);
  if (
    targetDirReal !== rootReal &&
    !targetDirReal.startsWith(`${rootReal}${sep}`)
  ) {
    throw new Error('产物输出目录符号链接越界');
  }

  const absolutePath = join(targetDirReal, fileName);
  await writeFile(absolutePath, payload);
  await chmod(absolutePath, 0o644);

  return {
    workspaceRelativePath: relative(rootReal, absolutePath).replaceAll('\\', '/'),
    absolutePath,
    fileName,
    sizeBytes: payload.length,
    format: input.format,
  };
}
