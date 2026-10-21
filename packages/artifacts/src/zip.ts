import { inflateRawSync } from 'node:zlib';
/** Bounded local ZIP inspector, deliberately limited to the ZIP32/DEFLATE files we generate. */
export function inspectZip(bytes: Buffer, limits: {
    maxZipEntries: number;
    maxExpandedBytes: number;
    maxCompressionRatio: number;
}): Map<string, Buffer> {
    const end = bytes.length - 22;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0)
        throw Error('ARTIFACT_ZIP_INVALID');
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count || count > limits.maxZipEntries || start + size !== end)
        throw Error('ARTIFACT_ZIP_LIMIT');
    const entries = new Map<string, Buffer>();
    let offset = start, total = 0;
    for (let n = 0; n < count; n++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
            throw Error('ARTIFACT_ZIP_INVALID');
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), checksum = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
        const next = offset + 46 + nameLength + extra + comment;
        if (next > end)
            throw Error('ARTIFACT_ZIP_INVALID');
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..') || entries.has(name) || (flags & 1) !== 0 || ![0, 8].includes(method))
            throw Error('ARTIFACT_ZIP_INVALID');
        total += expanded;
        if (total > limits.maxExpandedBytes || expanded > Math.max(1, compressed) * limits.maxCompressionRatio)
            throw Error('ARTIFACT_ZIP_LIMIT');
        if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50)
            throw Error('ARTIFACT_ZIP_INVALID');
        const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLength + localExtra;
        if (bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || bytes.readUInt16LE(local + 8) !== method || dataStart + compressed > start)
            throw Error('ARTIFACT_ZIP_INVALID');
        const raw = bytes.subarray(dataStart, dataStart + compressed);
        const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(expanded, limits.maxExpandedBytes)) });
        if (data.length !== expanded || crc32(data) !== checksum)
            throw Error('ARTIFACT_ZIP_INVALID');
        entries.set(name, data);
        offset = next;
    }
    if (offset !== end)
        throw Error('ARTIFACT_ZIP_INVALID');
    return entries;
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
} return (crc ^ 0xffffffff) >>> 0; }
