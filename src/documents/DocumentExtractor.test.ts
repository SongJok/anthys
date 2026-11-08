import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DocumentExtractionError, extractDocument } from './DocumentExtractor.js';

/** 测试用最小 ZIP 构造器（deflate） */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function slide(title: string, bullets: string[]): string {
  return `<p:sld ${A}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${bullets
    .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>9</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
}

describe('extractDocument pptx', () => {
  const pptx = makeZip({
    'ppt/presentation.xml': `<p:presentation ${A}><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide('机器人搭建', ['创建应用 &amp; 开通权限', '配置 Stream 模式']),
    'ppt/slides/slide2.xml': slide('封面', ['钉钉机器人的搭建和运营']),
    'ppt/slides/_rels/slide1.xml.rels':
      '<Relationships><Relationship Id="r1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': `<p:notes ${A}><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>重点讲权限</a:t></a:r></a:p></p:txBody></p:sp></p:notes>`,
  });

  it('按演示顺序提取标题/正文/备注并忽略页码', () => {
    const doc = extractDocument(pptx, '钉钉机器人的搭建和运营.pptx');
    expect(doc.format).toBe('pptx');
    expect(doc.unitCount).toBe(2);
    expect(doc.text.indexOf('封面')).toBeLessThan(doc.text.indexOf('机器人搭建'));
    expect(doc.text).toContain('## 第 1 页：封面');
    expect(doc.text).toContain('创建应用 & 开通权限');
    expect(doc.text).toContain('讲者备注：重点讲权限');
    expect(doc.text).not.toMatch(/\n9\n|- 9/);
  });
});

describe('extractDocument docx', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docx = makeZip({
    'word/document.xml': `<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>运营规范</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">第一段 </w:t></w:r><w:r><w:t>内容</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>角色</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>职责</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>管理员</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>审批</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
  });
  it('提取标题、段落与表格', () => {
    const doc = extractDocument(docx, 'a.docx');
    expect(doc.text).toContain('# 运营规范');
    expect(doc.text).toContain('第一段 内容');
    expect(doc.text).toContain('| 角色 | 职责 |');
    expect(doc.text).toContain('| 管理员 | 审批 |');
  });
});

describe('extractDocument xlsx', () => {
  const xlsx = makeZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="x"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>月份</t></si><si><t>收入</t></si><si><t>1月</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>100.5</v></c></row></sheetData></worksheet>',
  });
  it('提取工作表并生成完整 CSV（含空列补齐）', () => {
    const doc = extractDocument(xlsx, 'a.xlsx');
    expect(doc.sheets[0]!.name).toBe('销售');
    expect(doc.sheets[0]!.csv).toBe('月份,收入\n1月,,100.5');
    expect(doc.text).toContain('月份 | 收入');
  });
});

describe('extractDocument 异常路径', () => {
  it('旧版 .ppt 给出另存为提示', () => {
    expect(() => extractDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0]), 'a.ppt')).toThrow(
      /另存为/,
    );
  });
  it('损坏文件抛 corrupt', () => {
    try {
      extractDocument(Buffer.from('not a zip at all, definitely not'), 'a.pptx');
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentExtractionError).reason).toBe('corrupt');
    }
  });
  it('GBK 编码 CSV 能被正确解码', () => {
    const gbk = Buffer.from([0xd4, 0xc2, 0xb7, 0xdd, 0x2c, 0x31, 0x0a]); // 月份,1
    const doc = extractDocument(gbk, 'a.csv');
    expect(doc.text).toContain('月份,1');
    expect(doc.warnings[0]).toContain('gb18030');
  });
});

describe('图表与日期', () => {
  it('pptx 图表缓存转为数据表', () => {
    const chart = `<c:chartSpace><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>收入</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:chartSpace>`;
    const zip = makeZip({
      'ppt/slides/slide1.xml': slide('图表页', ['x']),
      'ppt/slides/_rels/slide1.xml.rels':
        '<Relationships><Relationship Id="r1" Target="../charts/chart1.xml"/></Relationships>',
      'ppt/charts/chart1.xml': chart,
    });
    const doc = extractDocument(zip, 'c.pptx');
    expect(doc.text).toContain('| 收入 |');
    expect(doc.text).toContain('| Q2 | 20 |');
  });

  it('xlsx 日期样式单元格输出 ISO 日期', () => {
    const zip = makeZip({
      'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1"><v>45000</v></c></row></sheetData></worksheet>',
    });
    expect(extractDocument(zip, 'd.xlsx').sheets[0]!.csv).toBe('2023-03-15,45000');
  });
});
