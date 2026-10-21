import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactOptions } from './index.js';
import { verifyFont, verifyEmbedding, verifyDocumentFamily, reviewedLineHeight } from './font.js';

/** Operational review configuration; never a source of tenant, audience, or content authority. */
export const ARTIFACT_FONT_MANIFEST_ENV = 'ARTIFACT_FONT_MANIFEST_FILE';
const MAX_MANIFEST_BYTES = 65_536;
const MAX_FONT_BYTES = 8_388_608;
export class ArtifactFontConfigurationFailure extends Error {
    constructor(readonly code: string) { super(code); this.name = 'ArtifactFontConfigurationFailure'; }
}
export interface ArtifactFontConfigurationOptions { signal?: AbortSignal }
interface Manifest {
    family: string;
    fontFile: string;
    sha256: string;
    reviewReference: string;
    sourceReviewHash: string;
}
function fail(code: string): never { throw new ArtifactFontConfigurationFailure(code); }
function cancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) fail('ARTIFACT_FONT_CONFIGURATION_CANCELLED');
}
function absoluteFile(value: unknown): string {
    if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || path.normalize(value) !== value || value.endsWith('/') || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value))
        fail('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED');
    return value;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}
function safeFile(stat: BigIntStats, uid: bigint, max: number): void {
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n)
        fail('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
    if (stat.size < 1n || stat.size > BigInt(max)) fail('ARTIFACT_FONT_CONFIGURATION_LIMIT');
}
/** Reject symlinks in every component, including a convenient /tmp alias. Require a private containing directory. */
async function directories(file: string, uid: bigint, signal: AbortSignal | undefined): Promise<Map<string, BigIntStats>> {
    const result = new Map<string, BigIntStats>();
    let current = path.dirname(file);
    const parent = current;
    while (true) {
        cancelled(signal);
        const stat = await fs.lstat(current, { bigint: true });
        cancelled(signal);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0n)) fail('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED');
        // A root-owned sticky system temp ancestor is safe only with the private service-owned parent below it.
        if ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n))
            fail('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED');
        if (current === parent && (stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n))
            fail('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED');
        result.set(current, stat);
        if (current === path.dirname(current)) break;
        current = path.dirname(current);
    }
    return result;
}
async function readPrivateFile(file: string, max: number, uid: bigint, signal: AbortSignal | undefined): Promise<Buffer> {
    const beforeDirectories = await directories(file, uid, signal);
    const before = await fs.lstat(file, { bigint: true });
    cancelled(signal);
    safeFile(before, uid, max);
    // NOFOLLOW protects the final component; NONBLOCK prevents a raced replacement FIFO from blocking open.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        cancelled(signal);
        const opened = await handle.stat({ bigint: true });
        safeFile(opened, uid, max);
        if (!sameFile(before, opened)) fail('ARTIFACT_FONT_CONFIGURATION_CHANGED');
        const bytes = Buffer.alloc(Number(opened.size) + 1);
        let length = 0;
        while (length < bytes.length) {
            cancelled(signal);
            const read = await handle.read(bytes, length, bytes.length - length, length);
            cancelled(signal);
            if (read.bytesRead === 0) break;
            length += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const atPath = await fs.lstat(file, { bigint: true });
        safeFile(after, uid, max);
        safeFile(atPath, uid, max);
        if (!sameFile(opened, after) || !sameFile(after, atPath) || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || BigInt(length) !== opened.size)
            fail('ARTIFACT_FONT_CONFIGURATION_CHANGED');
        const afterDirectories = await directories(file, uid, signal);
        for (const [directory, stat] of beforeDirectories) {
            const now = afterDirectories.get(directory);
            if (!now || !sameFile(stat, now)) fail('ARTIFACT_FONT_CONFIGURATION_CHANGED');
        }
        cancelled(signal);
        return bytes.subarray(0, length);
    } finally {
        await handle.close();
    }
}
/** Flat JSON parser rejects duplicate keys as well as nested/unknown fields; all values are strings. */
function manifest(bytes: Buffer): Manifest {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail('ARTIFACT_FONT_CONFIGURATION_INVALID'); }
    const token = /[\t\n\r ]*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[\t\n\r ]*/y;
    let at = 0;
    const whitespace = () => { while (/[\t\n\r ]/.test(text[at] ?? '') && at < text.length) at++; };
    const string = (): string => {
        token.lastIndex = at;
        const match = token.exec(text);
        if (!match) return fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
        at = token.lastIndex;
        return JSON.parse(match[1]!) as string;
    };
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    whitespace();
    if (text[at++] !== '{') fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
    whitespace();
    while (text[at] !== '}') {
        const key = string();
        if (Object.hasOwn(fields, key)) fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
        if (text[at++] !== ':') fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
        fields[key] = string();
        if (text[at] === '}') break;
        if (text[at++] !== ',') fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
        whitespace();
        if (text[at] === '}') fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
    }
    at++;
    whitespace();
    const keys = ['family', 'fontFile', 'sha256', 'reviewReference', 'sourceReviewHash'];
    if (at !== text.length || Object.keys(fields).length !== keys.length || !keys.every(key => Object.hasOwn(fields, key)))
        fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
    const value = fields as unknown as Manifest;
    if (!value.family || value.family.length > 100 || value.family.trim() !== value.family || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value.family)
        || !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[a-f0-9]{64}$/.test(value.sourceReviewHash)
        || !value.reviewReference || value.reviewReference.length > 512 || value.reviewReference.trim() !== value.reviewReference || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value.reviewReference))
        fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
    absoluteFile(value.fontFile);
    return value;
}
/** Read once at trusted service startup. No environment aliases, font discovery, URLs, or user input fallback. */
export async function configureArtifactFonts(
    env: Readonly<Record<string, string | undefined>> = process.env,
    options: ArtifactFontConfigurationOptions = {},
): Promise<Pick<ArtifactOptions, 'pdfFont' | 'docxFont'>> {
    try {
        if (!options || Object.keys(options).some(key => key !== 'signal') || (options.signal !== undefined && !(options.signal instanceof AbortSignal)))
            fail('ARTIFACT_FONT_CONFIGURATION_INVALID');
        cancelled(options.signal);
        const configured = env[ARTIFACT_FONT_MANIFEST_ENV];
        if (configured === undefined) return {};
        const file = absoluteFile(configured);
        if (typeof process.getuid !== 'function') fail('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
        const uid = BigInt(process.getuid());
        const review = manifest(await readPrivateFile(file, MAX_MANIFEST_BYTES, uid, options.signal));
        const bytes = await readPrivateFile(review.fontFile, MAX_FONT_BYTES, uid, options.signal);
        if (bytes.length < 12 || ![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0))) fail('ARTIFACT_FONT_INVALID');
        const verified = verifyFont({ bytes, sha256: review.sha256 }, '', MAX_FONT_BYTES);
        verifyEmbedding(verified, 'pdf');
        verifyEmbedding(verified, 'docx');
        verifyDocumentFamily(verified, review.family);
        reviewedLineHeight(verified, 10);
        cancelled(options.signal);
        return {
            pdfFont: { bytes: Buffer.from(verified), sha256: review.sha256 },
            docxFont: { bytes: Buffer.from(verified), sha256: review.sha256, family: review.family },
        };
    } catch (error) {
        if (error instanceof ArtifactFontConfigurationFailure) throw error;
        if (error instanceof Error && ['ARTIFACT_FONT_INVALID', 'ARTIFACT_FONT_EMBEDDING_DENIED', 'ARTIFACT_FONT_FAMILY_MISMATCH', 'ARTIFACT_FONT_METRICS_UNSUPPORTED'].includes(error.message))
            throw new ArtifactFontConfigurationFailure(error.message);
        throw new ArtifactFontConfigurationFailure('ARTIFACT_FONT_CONFIGURATION_READ_FAILED');
    }
}
