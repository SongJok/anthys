import { createHash } from 'node:crypto';
/** Only the trusted service may supply reviewed font bytes; user requests cannot contain this option. */
export interface ReviewedPdfFont {
    bytes: Buffer;
    sha256: string;
}
/** Validate TrueType/OpenType cmap coverage before PDFKit can silently emit missing glyphs. */
export function verifyFont(font: ReviewedPdfFont, text: string, maxBytes: number): Buffer {
    if (!Buffer.isBuffer(font.bytes) || font.bytes.length < 12 || font.bytes.length > maxBytes || !/^[a-f0-9]{64}$/.test(font.sha256) || createHash('sha256').update(font.bytes).digest('hex') !== font.sha256)
        throw Error('ARTIFACT_FONT_INVALID');
    const bytes = Buffer.from(font.bytes), tables = bytes.readUInt16BE(4);
    let cmap = -1, cmapEnd = 0;
    if (12 + tables * 16 > bytes.length)
        throw Error('ARTIFACT_FONT_INVALID');
    for (let n = 0; n < tables; n++) {
        const pos = 12 + n * 16, start = bytes.readUInt32BE(pos + 8), length = bytes.readUInt32BE(pos + 12);
        if (start + length > bytes.length)
            throw Error('ARTIFACT_FONT_INVALID');
        if (bytes.toString('ascii', pos, pos + 4) === 'cmap') {
            cmap = start;
            cmapEnd = start + length;
        }
    }
    if (cmap < 0 || cmap + 4 > cmapEnd)
        throw Error('ARTIFACT_FONT_INVALID');
    const subtables = bytes.readUInt16BE(cmap + 2);
    if (cmap + 4 + subtables * 8 > cmapEnd)
        throw Error('ARTIFACT_FONT_INVALID');
    const glyphs: ((cp: number) => boolean)[] = [];
    for (let n = 0; n < subtables; n++) {
        const p = cmap + 4 + n * 8, platform = bytes.readUInt16BE(p), encoding = bytes.readUInt16BE(p + 2), start = cmap + bytes.readUInt32BE(p + 4);
        if (!(platform === 0 || (platform === 3 && [1, 10].includes(encoding))) || start + 2 > cmapEnd)
            continue;
        const format = bytes.readUInt16BE(start);
        if (format === 12) {
            if (start + 16 > cmapEnd)
                throw Error('ARTIFACT_FONT_INVALID');
            const length = bytes.readUInt32BE(start + 4), count = bytes.readUInt32BE(start + 12);
            if (count > 65536 || start + length > cmapEnd || 16 + count * 12 > length)
                throw Error('ARTIFACT_FONT_INVALID');
            let previous = -1;
            for (let g = 0; g < count; g++) {
                const s = start + 16 + g * 12, a = bytes.readUInt32BE(s), z = bytes.readUInt32BE(s + 4);
                if (a <= previous || a > z || z > 0x10ffff)
                    throw Error('ARTIFACT_FONT_INVALID');
                previous = z;
            }
            glyphs.push(cp => {
                let lo = 0, hi = count - 1;
                while (lo <= hi) {
                    const g = (lo + hi) >>> 1, s = start + 16 + g * 12, a = bytes.readUInt32BE(s), z = bytes.readUInt32BE(s + 4);
                    if (cp < a)
                        hi = g - 1;
                    else if (cp > z)
                        lo = g + 1;
                    else
                        return bytes.readUInt32BE(s + 8) + cp - a !== 0;
                }
                return false;
            });
        }
        if (format === 4) {
            if (start + 14 > cmapEnd)
                throw Error('ARTIFACT_FONT_INVALID');
            const length = bytes.readUInt16BE(start + 2), count = bytes.readUInt16BE(start + 6) / 2, end = start + 14, beg = end + count * 2 + 2, delta = beg + count * 2, range = delta + count * 2;
            if (!Number.isInteger(count) || count < 1 || count > 8192 || start + length > cmapEnd || range + count * 2 > start + length)
                throw Error('ARTIFACT_FONT_INVALID');
            let previous = -1;
            for (let g = 0; g < count; g++) {
                const a = bytes.readUInt16BE(beg + g * 2), z = bytes.readUInt16BE(end + g * 2);
                if (a > z || a <= previous)
                    throw Error('ARTIFACT_FONT_INVALID');
                previous = z;
            }
            glyphs.push(cp => {
                if (cp > 0xffff)
                    return false;
                let lo = 0, hi = count - 1;
                while (lo <= hi) {
                    const g = (lo + hi) >>> 1;
                    if (cp < bytes.readUInt16BE(beg + g * 2)) {
                        hi = g - 1;
                        continue;
                    }
                    if (cp > bytes.readUInt16BE(end + g * 2)) {
                        lo = g + 1;
                        continue;
                    }
                    const shift = bytes.readInt16BE(delta + g * 2), r = bytes.readUInt16BE(range + g * 2);
                    if (r === 0)
                        return ((cp + shift) & 0xffff) !== 0;
                    const at = range + g * 2 + r + (cp - bytes.readUInt16BE(beg + g * 2)) * 2;
                    if (at + 2 > start + length)
                        return false;
                    const value = bytes.readUInt16BE(at);
                    return value !== 0 && ((value + shift) & 0xffff) !== 0;
                }
                return false;
            });
        }
    }
    for (const character of new Set(text)) {
        const cp = character.codePointAt(0)!;
        if (cp === 10 || cp === 13)
            continue;
        if (!glyphs.some(has => has(cp)))
            throw Error('ARTIFACT_FONT_GLYPH_MISSING');
    }
    return bytes;
}
export interface ReviewedDocumentFont extends ReviewedPdfFont {
    family: string;
}
function table(bytes: Buffer, name: string): Buffer | undefined {
    const count = bytes.readUInt16BE(4);
    for (let n = 0; n < count; n++) {
        const at = 12 + n * 16;
        if (bytes.toString('ascii', at, at + 4) === name)
            return bytes.subarray(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 8) + bytes.readUInt32BE(at + 12));
    }
    return undefined;
}
/** The host still reviews the license. Enforce the font's own embedding flags as an additional hard boundary. */
export function verifyEmbedding(bytes: Buffer, mode: 'pdf' | 'docx'): void {
    const os2 = table(bytes, 'OS/2');
    if (!os2 || os2.length < 10)
        throw Error('ARTIFACT_FONT_EMBEDDING_DENIED');
    const flags = os2.readUInt16BE(8), permission = flags & 15;
    if (![0, 4, 8].includes(permission) || (flags & 0xfcf0) !== 0 || (flags & 0x0200) !== 0 || (mode === 'pdf' && (flags & 0x0100) !== 0) || (mode === 'docx' && permission === 4))
        throw Error('ARTIFACT_FONT_EMBEDDING_DENIED');
}
/** A conservative vertical bound from the actual font avoids clipped or overlapping fixed-spacing lines. */
export function reviewedLineHeight(bytes: Buffer, size: number): number {
    const head = table(bytes, 'head');
    if (!head || head.length < 54)
        throw Error('ARTIFACT_FONT_INVALID');
    const units = head.readUInt16BE(18), minimum = head.readInt16BE(38), maximum = head.readInt16BE(42);
    if (units < 16 || units > 16384 || maximum <= minimum)
        throw Error('ARTIFACT_FONT_INVALID');
    const height = Math.max(14, Math.ceil((maximum - minimum) * size / units + 2));
    if (height > 48)
        throw Error('ARTIFACT_FONT_METRICS_UNSUPPORTED');
    return height;
}
export function verifyDocumentFamily(bytes: Buffer, family: string): void {
    if (!family || family.length > 100 || /[\x00-\x1f\x7f]/.test(family))
        throw Error('ARTIFACT_FONT_FAMILY_MISMATCH');
    const name = table(bytes, 'name');
    if (!name || name.length < 6)
        throw Error('ARTIFACT_FONT_INVALID');
    const count = name.readUInt16BE(2), strings = name.readUInt16BE(4);
    if (6 + count * 12 > name.length)
        throw Error('ARTIFACT_FONT_INVALID');
    const families: string[] = [];
    for (let n = 0; n < count; n++) {
        const at = 6 + n * 12, platform = name.readUInt16BE(at), id = name.readUInt16BE(at + 6), length = name.readUInt16BE(at + 8), offset = strings + name.readUInt16BE(at + 10);
        if (offset + length > name.length)
            throw Error('ARTIFACT_FONT_INVALID');
        if (![1, 16].includes(id))
            continue;
        const data = name.subarray(offset, offset + length);
        if ((platform === 0 || platform === 3) && length % 2 === 0) {
            let value = '';
            for (let i = 0; i < data.length; i += 2)
                value += String.fromCharCode(data.readUInt16BE(i));
            families.push(value);
        }
        else if (platform === 1)
            families.push(data.toString('latin1'));
    }
    if (!families.includes(family))
        throw Error('ARTIFACT_FONT_FAMILY_MISMATCH');
}
