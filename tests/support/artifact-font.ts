/** Self-contained TrueType fixture for the export oracle. No installed or
 * downloaded font is used; the family name is stable for the review record. */
export const artifactFontFamily = 'Anthys Artifact Fixture';

const u16 = (values: number[]): Buffer => {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => out.writeUInt16BE(value & 0xffff, index * 2));
    return out;
};

/** One rectangular outline shared by every covered code point. */
function outline(): Buffer {
    const points: number[][] = [[80, 0], [520, 0], [520, 700], [80, 700]];
    const out = Buffer.alloc(14 + points.length * 5);
    out.writeInt16BE(1, 0);
    out.writeInt16BE(80, 2);
    out.writeInt16BE(0, 4);
    out.writeInt16BE(520, 6);
    out.writeInt16BE(700, 8);
    out.writeUInt16BE(points.length - 1, 10);
    out.writeUInt16BE(0, 12);
    out.fill(1, 14, 14 + points.length);
    let at = 14 + points.length;
    for (const axis of [0, 1]) {
        let last = 0;
        for (const point of points) {
            out.writeInt16BE(point[axis]! - last, at);
            at += 2;
            last = point[axis]!;
        }
    }
    return out.length % 2 ? Buffer.concat([out, Buffer.alloc(1)]) : out;
}

/** A low code point maps to its own glyph id; a code point above the signed
 * delta range maps to the same position counted from 0x8000. */
const glyphOf = (codePoint: number): number => (codePoint < 0x8000 ? codePoint : codePoint - 0x7fff);

export function artifactFontBytes(text: string): Buffer {
    const covered = new Set<number>();
    for (const character of text) covered.add(character.codePointAt(0)!);
    for (let codePoint = 0x20; codePoint <= 0x7e; codePoint++) covered.add(codePoint);
    const points = [...covered].sort((a, b) => a - b);

    const segments: {start: number; end: number; delta: number}[] = [];
    for (const codePoint of points) {
        const last = segments[segments.length - 1];
        if (last && codePoint === last.end + 1 && (codePoint < 0x8000) === (last.start < 0x8000)) {
            last.end = codePoint;
            continue;
        }
        segments.push({start: codePoint, end: codePoint, delta: codePoint < 0x8000 ? 0 : -0x7fff});
    }
    segments.push({start: 0xffff, end: 0xffff, delta: 1});

    const segCount = segments.length;
    const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
    const entrySelector = Math.log2(searchRange / 2);
    const rangeShift = 2 * segCount - searchRange;
    const subtable = Buffer.concat([
        u16([4, 16 + 8 * segCount, 0, segCount * 2, searchRange, entrySelector, rangeShift]),
        u16(segments.map(segment => segment.end)), u16([0]),
        u16(segments.map(segment => segment.start)),
        u16(segments.map(segment => segment.delta)), u16(segments.map(() => 0)),
    ]);
    const cmap = Buffer.concat([u16([0, 1]), u16([3, 1]), Buffer.from([0, 0, 0, 12]), subtable]);

    const numGlyphs = Math.max(...points.map(glyphOf)) + 1;
    const used = new Set(points.map(glyphOf));
    const shape = outline();
    const glyf: Buffer[] = [];
    const loca: number[] = [];
    let offset = 0;
    for (let glyph = 0; glyph < numGlyphs; glyph++) {
        loca.push(offset / 2);
        if (used.has(glyph)) {
            glyf.push(shape);
            offset += shape.length;
        }
    }
    loca.push(offset / 2);

    const head = Buffer.alloc(54);
    head.writeUInt32BE(0x10000, 0);
    head.writeUInt32BE(0x10000, 4);
    head.writeUInt32BE(0x5f0f3cf5, 12);
    head.writeUInt16BE(1000, 18);
    head.writeInt16BE(0, 36);
    head.writeInt16BE(0, 38);
    head.writeInt16BE(520, 40);
    head.writeInt16BE(700, 42);
    head.writeUInt16BE(8, 46);
    head.writeInt16BE(0, 48);
    head.writeInt16BE(0, 50);

    const hhea = Buffer.alloc(36);
    hhea.writeUInt32BE(0x10000, 0);
    hhea.writeInt16BE(800, 4);
    hhea.writeInt16BE(-200, 6);
    hhea.writeUInt16BE(600, 10);
    hhea.writeInt16BE(520, 16);
    hhea.writeInt16BE(1, 18);
    hhea.writeUInt16BE(numGlyphs, 34);

    const maxp = Buffer.alloc(32);
    maxp.writeUInt32BE(0x10000, 0);
    maxp.writeUInt16BE(numGlyphs, 4);
    maxp.writeUInt16BE(points.length, 6);
    maxp.writeUInt16BE(1, 8);
    maxp.writeUInt16BE(2, 14);

    const metrics: number[] = [];
    for (let glyph = 0; glyph < numGlyphs; glyph++) metrics.push(600, 0);
    const hmtx = u16(metrics);

    const os2 = Buffer.alloc(78);
    os2.writeUInt16BE(600, 2);
    os2.writeUInt16BE(400, 4);
    os2.writeUInt16BE(5, 6);
    os2.writeUInt16BE(0, 8);
    os2.writeUInt16BE(0x40, 62);
    os2.writeUInt16BE(points[0]!, 64);
    os2.writeUInt16BE(points[points.length - 1]!, 66);
    os2.writeInt16BE(800, 68);
    os2.writeInt16BE(-200, 70);
    os2.writeUInt16BE(800, 74);
    os2.writeUInt16BE(200, 76);

    const strings = [artifactFontFamily, 'Regular', artifactFontFamily, artifactFontFamily.replace(/\s+/g, '')];
    const encoded = strings.map(value => {
        const bytes = Buffer.from(value, 'utf16le');
        bytes.swap16();
        return bytes;
    });
    let nameOffset = 0;
    const records = encoded.map((bytes, index) => {
        const record = u16([3, 1, 0x409, [1, 2, 4, 6][index]!, bytes.length, nameOffset]);
        nameOffset += bytes.length;
        return record;
    });
    const name = Buffer.concat([u16([0, 4, 54]), ...records, ...encoded]);

    const post = Buffer.alloc(32);
    post.writeUInt32BE(0x30000, 0);

    const tables = new Map<string, Buffer>([
        ['OS/2', os2], ['cmap', cmap], ['glyf', Buffer.concat(glyf)], ['head', head], ['hhea', hhea],
        ['hmtx', hmtx], ['loca', u16(loca)], ['maxp', maxp], ['name', name], ['post', post],
    ]);
    const header = Buffer.alloc(12 + tables.size * 16);
    header.writeUInt32BE(0x10000, 0);
    header.writeUInt16BE(tables.size, 4);
    header.writeUInt16BE(128, 6);
    header.writeUInt16BE(3, 8);
    header.writeUInt16BE(32, 10);
    let position = header.length;
    const parts = [header];
    let index = 0;
    for (const [tag, value] of tables) {
        const data = Buffer.alloc(Math.ceil(value.length / 4) * 4);
        value.copy(data);
        const at = 12 + index++ * 16;
        header.write(tag, at, 'ascii');
        let sum = 0;
        for (let offset = 0; offset < data.length; offset += 4) sum = (sum + data.readUInt32BE(offset)) >>> 0;
        header.writeUInt32BE(sum, at + 4);
        header.writeUInt32BE(position, at + 8);
        header.writeUInt32BE(value.length, at + 12);
        parts.push(data);
        position += data.length;
    }
    const result = Buffer.concat(parts);
    let sum = 0;
    for (let offset = 0; offset < result.length; offset += 4) sum = (sum + result.readUInt32BE(offset)) >>> 0;
    const headIndex = [...tables.keys()].indexOf('head');
    result.writeUInt32BE((0xb1b0afba - sum) >>> 0, header.readUInt32BE(12 + headIndex * 16 + 8) + 8);
    return result;
}
