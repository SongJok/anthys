import { inflateSync } from 'node:zlib';
interface PdfObject {
    id: number;
    header: string;
    stream?: Buffer;
}
/** Read only the classic, single-xref PDF shape emitted by pinned PDFKit. No general PDF execution. */
export function inspectPdf(bytes: Buffer, maxExpandedBytes: number): {
    pages: number;
    text: string;
    embeddedFont: boolean;
} {
    const raw = bytes.toString('latin1'), end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw);
    if (!raw.startsWith('%PDF-') || !end)
        throw Error('ARTIFACT_PDF_INVALID');
    const xref = Number(end[1]);
    const lines = raw.slice(xref).split(/\r?\n/);
    if (lines[0] !== 'xref' || !/^0 \d+$/.test(lines[1] ?? ''))
        throw Error('ARTIFACT_PDF_INVALID');
    const count = Number(lines[1]!.split(' ')[1]);
    if (count > 10000 || count < 1)
        throw Error('ARTIFACT_PDF_INVALID');
    const offsets: {
        id: number;
        at: number;
    }[] = [];
    for (let id = 1; id < count; id++) {
        const line = lines[id + 2];
        if (!line || !/^\d{10} 00000 n $/.test(line))
            throw Error('ARTIFACT_PDF_INVALID');
        const at = Number(line.slice(0, 10));
        if (at < 9 || at >= xref)
            throw Error('ARTIFACT_PDF_INVALID');
        offsets.push({ id, at });
    }
    offsets.sort((a, b) => a.at - b.at);
    const objects = new Map<number, PdfObject>();
    let expanded = 0;
    for (const [n, entry] of offsets.entries()) {
        const source = raw.slice(entry.at, offsets[n + 1]?.at ?? xref), start = `${entry.id} 0 obj\n`;
        if (!source.startsWith(start) || !source.endsWith('endobj\n'))
            throw Error('ARTIFACT_PDF_INVALID');
        const body = source.slice(start.length, -7), streamAt = body.indexOf('\nstream\n');
        let header = body, stream: Buffer | undefined;
        if (streamAt >= 0) {
            header = body.slice(0, streamAt);
            const lengthMatch = /\/Length (\d+)\b/.exec(header);
            if (!lengthMatch)
                throw Error('ARTIFACT_PDF_INVALID');
            const length = Number(lengthMatch[1]), at = streamAt + 8;
            if (body.slice(at + length) !== '\nendstream\n')
                throw Error('ARTIFACT_PDF_INVALID');
            const compressed = Buffer.from(body.slice(at, at + length), 'latin1');
            stream = /\/Filter \/FlateDecode\b/.test(header) ? inflateSync(compressed, { maxOutputLength: maxExpandedBytes }) : compressed;
            expanded += stream.length;
            if (expanded > maxExpandedBytes)
                throw Error('ARTIFACT_PDF_LIMIT');
        }
        // Strip literal and hex strings before inspecting dictionary names; their content is inert.
        const names = header.replace(/\((?:\\[\s\S]|[^\\)])*\)/g, '()').replace(/<(?!<)[a-fA-F0-9\s]*>/g, '<>');
        if (/\/(?:JavaScript|JS|OpenAction|AA|Launch|URI|EmbeddedFile|Filespec)\b/.test(names))
            throw Error('ARTIFACT_PDF_ACTIVE_CONTENT');
        objects.set(entry.id, { id: entry.id, header, ...(stream ? { stream } : {}) });
    }
    const root = [...objects.values()].find(o => /\/Type \/Pages\b/.test(o.header));
    if (!root)
        throw Error('ARTIFACT_PDF_INVALID');
    const kids = /\/Kids \[([^\]]*)\]/.exec(root.header), declared = /\/Count (\d+)/.exec(root.header);
    if (!kids || !declared)
        throw Error('ARTIFACT_PDF_INVALID');
    const pageIds = [...kids[1]!.matchAll(/(\d+) 0 R/g)].map(m => Number(m[1]));
    if (pageIds.length !== Number(declared[1]))
        throw Error('ARTIFACT_PDF_INVALID');
    const encoded: string[] = [];
    for (const id of pageIds) {
        const page = objects.get(id);
        if (!page || !/\/Type \/Page\b/.test(page.header))
            throw Error('ARTIFACT_PDF_INVALID');
        const content = /\/Contents (\d+) 0 R/.exec(page.header);
        const stream = content ? objects.get(Number(content[1]))?.stream : undefined;
        if (!stream)
            throw Error('ARTIFACT_PDF_INVALID');
        for (const run of stream.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g))
            encoded.push([...run[1]!.matchAll(/<([a-fA-F0-9]*)>/g)].map(h => h[1]!).join(''));
    }
    const maps = [...objects.values()].flatMap(o => [...o.header.matchAll(/\/ToUnicode (\d+) 0 R/g)].map(m => objects.get(Number(m[1]))?.stream));
    if (maps.some(m => !m))
        throw Error('ARTIFACT_PDF_INVALID');
    if (maps.length === 0)
        return { pages: pageIds.length, text: encoded.map(h => Buffer.from(h, 'hex').toString('ascii')).join(''), embeddedFont: false };
    if (maps.length !== 1)
        throw Error('ARTIFACT_PDF_TEXT_UNVERIFIABLE');
    const map = new Map<string, string>();
    for (const block of maps[0]!.toString('latin1').matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
        for (const range of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
            let code = Number.parseInt(range[1]!, 16);
            const end = Number.parseInt(range[2]!, 16);
            for (const pair of range[3]!.matchAll(/<([0-9a-fA-F\s]+)>/g)) {
                if (code > end)
                    throw Error('ARTIFACT_PDF_INVALID');
                const value = Buffer.from(pair[1]!.replace(/\s/g, ''), 'hex');
                let decoded = '';
                for (let i = 0; i + 1 < value.length; i += 2)
                    decoded += String.fromCharCode(value.readUInt16BE(i));
                map.set((code++).toString(16).padStart(4, '0'), decoded);
            }
            if (code !== end + 1)
                throw Error('ARTIFACT_PDF_INVALID');
        }
    const text = encoded.map(h => { let value = ''; for (let i = 0; i < h.length; i += 4) {
        const cp = map.get(h.slice(i, i + 4).toLowerCase());
        if (cp === undefined)
            throw Error('ARTIFACT_PDF_TEXT_UNVERIFIABLE');
        value += cp;
    } return value; }).join('');
    return { pages: pageIds.length, text, embeddedFont: true };
}
