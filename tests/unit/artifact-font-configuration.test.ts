import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureArtifactFonts, ArtifactFontConfigurationFailure } from '../../packages/artifacts/src/font-configuration.js';
import { renderArtifact } from '../../packages/artifacts/src/index.js';
// Preserve real filesystem behavior, with configurable wrappers only for deterministic race/owner injection.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
// Original fixture from testFont() in artifact-rendering.test.ts: .notdef, A, 中; no installed/downloaded font.
const font = Buffer.from('AAEAAAAKAIAAAwAgT1MvMgW6UyIAAACsAAAATmNtYXCcKrKSAAAA/AAAADRnbHlmFFkJJQAAATAAAACQaGVhZGFrRAUAAAHAAAAANmhoZWEDIgGUAAAB+AAAACRobXR4BwgAAAAAAhwAAAAMbG9jYQAhAEgAAAIoAAAACG1heHAABwAWAAACMAAAACBuYW1lC8wcUgAAAlAAAACscG9zdAADAAAAAAL8AAAAIAAAAlgBkAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAQU4tAyD/OAAAAyAAyAAAAAAAAQADAAEAAAAMAAQAKAAAAAYABAABAAIAQU4t//8AAABBTi3////AsdUAAQAAAAAAAAACAAAAAAJYAyAABgAJAAABAQEBAQEBAQEBADIA+gD6/5z/zv84/84AUACM/7oAAAK8/UQAAACWAAD/agD6AAAA+gADAAAAAAJYAyAAAwAHAAsAAAEBAQEBAQEBAQEBAQBkAZAAAP5wADIAAAEsAAD/UQAyAAD/zgDIAAABkAAA/qIBLAAA/tT/BgAAAyAAAAABAAAAAQAASgO2K18PPPUAAAPoAAAAAAAAAAAAAAAAAAAAAAAAAAACWAMgAAAACAACAAAAAAAAAAEAAAMg/zgAAAJYAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAADAlgAAAJYAAACWAAAAAAAAAAhAEgAAQAAAAMAFAADAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAQANgADAAEECQABACQAAAADAAEECQACAA4AJAADAAEECQAEACQAMgADAAEECQAGACAAVgBBAHIAdABpAGYAYQBjAHQAIABUAGUAcwB0ACAARgBvAG4AdABSAGUAZwB1AGwAYQByAEEAcgB0AGkAZgBhAGMAdAAgAFQAZQBzAHQAIABGAG8AbgB0AEEAcgB0AGkAZgBhAGMAdABUAGUAcwB0AEYAbwBuAHQAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let directory: string, fontFile: string, manifestFile: string;
let review: { family: string; fontFile: string; sha256: string; reviewReference: string; sourceReviewHash: string };
const environment = () => ({ ARTIFACT_FONT_MANIFEST_FILE: manifestFile });
async function writeReview(value: unknown = review): Promise<void> {
    await fs.writeFile(manifestFile, JSON.stringify(value), { mode: 0o600 });
}
async function writeFont(bytes: Buffer): Promise<void> {
    await fs.writeFile(fontFile, bytes, { mode: 0o600 });
    review.sha256 = sha(bytes);
    await writeReview();
}
async function denied(code: string, env: Readonly<Record<string, string | undefined>> = environment(), signal?: AbortSignal): Promise<void> {
    await expect(configureArtifactFonts(env, signal ? { signal } : {})).rejects.toMatchObject({ name: 'ArtifactFontConfigurationFailure', code, message: code });
}
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'artifact-font-config-'));
    await fs.chmod(directory, 0o700);
    fontFile = path.join(directory, 'synthetic.ttf');
    manifestFile = path.join(directory, 'review.json');
    review = { family: 'Artifact Test Font', fontFile, sha256: sha(font), reviewReference: 'SYNTHETIC-OFFLINE-REVIEW-001', sourceReviewHash: sha(Buffer.from('self-created fixture license review')) };
    await fs.writeFile(fontFile, font, { mode: 0o600 });
    await writeReview();
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
});
describe('trusted service artifact font configuration (not business authorization)', () => {
    it('returns independent reviewed buffers and renders actual Chinese PDF and embedded DOCX bytes', async () => {
        const result = await configureArtifactFonts(environment());
        expect(Object.keys(result)).toEqual(['pdfFont', 'docxFont']);
        expect(result.pdfFont?.bytes).toEqual(font);
        expect(result.docxFont).toMatchObject({ sha256: sha(font), family: review.family });
        expect(result.pdfFont?.bytes).not.toBe(result.docxFont?.bytes);
        for (const format of ['pdf', 'docx'] as const) {
            const rendered = await renderArtifact({ format, title: '中A', paragraphs: ['A中'] }, result);
            expect(rendered.inspection.state).toBe('VERIFIED');
            expect(rendered.bytes.length).toBeGreaterThan(1000);
            expect(rendered.sha256).toBe(sha(rendered.bytes));
        }
        // A reviewed small font is not assumed to contain all Chinese characters.
        await expect(renderArtifact({ format: 'pdf', title: '文', paragraphs: [] }, result)).rejects.toThrow('ARTIFACT_FONT_GLYPH_MISSING');
    });
    it('ignores every noncanonical environment key; no configuration leaves Unicode controlled rejection', async () => {
        const result = await configureArtifactFonts({ PDF_FONT: fontFile, ARTIFACT_FONT_PATH: fontFile });
        expect(result).toEqual({});
        for (const format of ['pdf', 'docx'] as const)
            await expect(renderArtifact({ format, title: '中', paragraphs: [] }, result)).rejects.toThrow(format === 'pdf' ? 'ARTIFACT_PDF_FONT_REQUIRED' : 'ARTIFACT_DOCX_FONT_REQUIRED');
    });
    it.each(['', ' ', './review.json', 'https://invalid/review.json', '/private/../private/review.json', '/private//review.json', '/private/review.json/'])('rejects noncanonical manifest path %j', async value => {
        await denied('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED', { ARTIFACT_FONT_MANIFEST_FILE: value });
    });
    it.each([
        { extra: true }, { family: '' }, { family: 'wrong family' }, { family: 'Artifact Test Font\u0000' },
        { sha256: '0'.repeat(64) }, { sha256: 'A'.repeat(64) }, { sourceReviewHash: 'bad' },
        { reviewReference: '' }, { reviewReference: 'unreviewed\nentry' }, { fontFile: './synthetic.ttf' },
        { fontFile: 'https://invalid/font.ttf' },
    ])('rejects invalid review fields %j', async change => {
        await writeReview({ ...review, ...change });
        await expect(configureArtifactFonts(environment())).rejects.toBeInstanceOf(ArtifactFontConfigurationFailure);
    });
    it('requires every review field, rejects duplicate JSON keys, invalid UTF8 and non-JSON whitespace', async () => {
        const { sourceReviewHash: _omitted, ...missing } = review;
        await writeReview(missing);
        await denied('ARTIFACT_FONT_CONFIGURATION_INVALID');
        for (const bytes of [Buffer.from(JSON.stringify(review).replace('{', '{"family":"forged",')), Buffer.from([0xff]), Buffer.from('\u00a0' + JSON.stringify(review)), Buffer.from(JSON.stringify(review).replace('}', ',}'))]) {
            await fs.writeFile(manifestFile, bytes);
            await denied('ARTIFACT_FONT_CONFIGURATION_INVALID');
        }
    });
    it('detects changed font bytes even when their container type stays valid', async () => {
        const altered = Buffer.from(font); altered[altered.length - 1] = 1;
        await fs.writeFile(fontFile, altered);
        await denied('ARTIFACT_FONT_INVALID');
    });
    it.each(['manifest', 'font'] as const)('rejects public permissions on %s', async target => {
        await fs.chmod(target === 'manifest' ? manifestFile : fontFile, 0o644);
        await denied('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
    });
    it('rejects a nonprivate containing directory', async () => {
        await fs.chmod(directory, 0o755);
        await denied('ARTIFACT_FONT_CONFIGURATION_PATH_DENIED');
    });
    it.each(['manifest', 'font'] as const)('rejects foreign file owner metadata on %s without changing host ownership', async target => {
        const lstat = fs.lstat;
        vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
            const stat = await lstat(...args);
            if (args[0] === (target === 'manifest' ? manifestFile : fontFile))
                Object.defineProperty(stat, 'uid', { value: BigInt(process.getuid!()) + 1n });
            return stat;
        }) as typeof fs.lstat);
        await denied('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
    });
    it.each(['manifest', 'font', 'ancestor'] as const)('rejects symlink %s', async target => {
        if (target === 'ancestor') {
            const alias = path.join(directory, 'alias');
            await fs.symlink(directory, alias);
            manifestFile = path.join(alias, 'review.json');
        } else {
            const file = target === 'manifest' ? manifestFile : fontFile;
            await fs.rename(file, file + '.real');
            await fs.symlink(file + '.real', file);
        }
        await expect(configureArtifactFonts(environment())).rejects.toBeInstanceOf(ArtifactFontConfigurationFailure);
    });
    it('rejects hardlinks, directories and files over either byte limit', async () => {
        await fs.link(fontFile, path.join(directory, 'hardlink.ttf'));
        await denied('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
        await fs.unlink(path.join(directory, 'hardlink.ttf'));
        await fs.truncate(fontFile, 8_388_609);
        await denied('ARTIFACT_FONT_CONFIGURATION_LIMIT');
        await fs.writeFile(manifestFile, ' '.repeat(65_537));
        await denied('ARTIFACT_FONT_CONFIGURATION_LIMIT');
        await fs.unlink(manifestFile);
        await fs.mkdir(manifestFile, { mode: 0o700 });
        await denied('ARTIFACT_FONT_CONFIGURATION_FILE_DENIED');
    });
    it('checks signature, embedding permissions and actual family against reviewed manifest', async () => {
        const invalidType = Buffer.from(font); invalidType.write('wOFF', 0);
        await writeFont(invalidType);
        await denied('ARTIFACT_FONT_INVALID');
        const restricted = Buffer.from(font);
        const os2 = restricted.readUInt32BE(20);
        for (const flags of [2, 4, 0x100, 0x200]) {
            restricted.writeUInt16BE(flags, os2 + 8);
            await writeFont(restricted);
            await denied('ARTIFACT_FONT_EMBEDDING_DENIED');
        }
        await writeFont(font);
        review.family = 'Forged font family';
        await writeReview();
        await denied('ARTIFACT_FONT_FAMILY_MISMATCH');
    });
    it('never reads a file for a pre-aborted call, including an unconfigured one', async () => {
        const controller = new AbortController(); controller.abort();
        const open = vi.spyOn(fs, 'open');
        await denied('ARTIFACT_FONT_CONFIGURATION_CANCELLED', environment(), controller.signal);
        await denied('ARTIFACT_FONT_CONFIGURATION_CANCELLED', {}, controller.signal);
        expect(open).not.toHaveBeenCalled();
    });
    it('closes an opened handle and returns no partial configuration on mid-read cancellation', async () => {
        const controller = new AbortController();
        const open = fs.open;
        let close: ReturnType<typeof vi.spyOn> | undefined;
        vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
            const handle = await open(...args);
            if (args[0] === fontFile) {
                close = vi.spyOn(handle, 'close');
                const read = handle.read;
                vi.spyOn(handle, 'read').mockImplementation((async (...readArgs: unknown[]) => {
                    const result = await Reflect.apply(read, handle, readArgs) as { bytesRead: number; buffer: Buffer };
                    controller.abort();
                    return result;
                }) as typeof handle.read);
            }
            return handle;
        });
        await denied('ARTIFACT_FONT_CONFIGURATION_CANCELLED', environment(), controller.signal);
        expect(close).toHaveBeenCalledOnce();
    });
    it('detects file replacement after open rather than accepting bytes from an obsolete pathname', async () => {
        const open = fs.open;
        vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
            const handle = await open(...args);
            if (args[0] === fontFile) {
                await fs.rename(fontFile, fontFile + '.old');
                await fs.writeFile(fontFile, font, { mode: 0o600 });
            }
            return handle;
        });
        await denied('ARTIFACT_FONT_CONFIGURATION_CHANGED');
    });
    it('sanitizes filesystem failures instead of disclosing host paths or partial data', async () => {
        await fs.unlink(fontFile);
        await denied('ARTIFACT_FONT_CONFIGURATION_READ_FAILED');
    });
    it('does not accept request-supplied font options or authority fields through renderer input', async () => {
        const configured = await configureArtifactFonts(environment());
        await expect(renderArtifact({ format: 'pdf', title: '中', paragraphs: [], pdfFont: configured.pdfFont, tenantId: 'forged', classification: 'PUBLIC' })).rejects.toThrow('ARTIFACT_SCHEMA_UNKNOWN_KEY');
    });
});
