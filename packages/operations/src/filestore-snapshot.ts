import { constants, type BigIntStats, type ReadStream } from 'node:fs';
import { lstat, realpath, open, opendir, mkdir, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { types } from 'node:util';
import { z } from 'zod';
import { PRIVATE_ARCHIVE_MAX_BYTES, writePrivateArchive, openPrivateArchive, type ArchiveReceipt, type PlaintextLease } from './archive.js';
export const FILESTORE_SNAPSHOT_MAX_FILES = 10000;
export const FILESTORE_SNAPSHOT_MAX_DIRECTORIES = FILESTORE_SNAPSHOT_MAX_FILES * 3;
export const FILESTORE_SNAPSHOT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES = PRIVATE_ARCHIVE_MAX_BYTES - FILESTORE_SNAPSHOT_MANIFEST_MAX_BYTES - 12;
const MAGIC = Buffer.from('OAFS0001'), CHUNK = 64 * 1024;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', uuidPattern = new RegExp('^' + uuid + '$'), keyPattern = new RegExp(`^${uuid}/${uuid}/${uuid}/${uuid}\\.sealed$`);
const count = z.number().int().nonnegative().safe();
const entrySchema = z.strictObject({ key: z.string().regex(keyPattern), byteSize: count, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.strictObject({ version: z.literal(1), kind: z.literal('FILESTORE_SEALED_TREE'), sourceRootHash: z.string().regex(/^[a-f0-9]{64}$/), emptyDirectoryPolicy: z.literal('OMITTED_NO_OBJECTS'), omittedEmptyDirectoryCount: count.max(FILESTORE_SNAPSHOT_MAX_DIRECTORIES), files: z.array(entrySchema).max(FILESTORE_SNAPSHOT_MAX_FILES), totalBytes: count });
export const fileStoreSnapshotManifestSchema = manifestSchema;
export type FileStoreSnapshotManifest = z.infer<typeof manifestSchema>;
export type FileStoreSnapshotOptions = {
    sourceRoot: string;
    archiveRoot: string;
    backupId: string;
    keyId: string;
    key: Buffer;
    schemaFingerprint: string;
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    signal: AbortSignal;
};
export type RestoreFileStoreSnapshotOptions = FileStoreSnapshotOptions & {
    restoreParent: string;
    restoreId: string;
};
export type FileStoreSnapshotReceipt = {
    archive: ArchiveReceipt;
    manifest: FileStoreSnapshotManifest;
};
export type RestoredFileStoreLease = {
    root: string;
    receipt: FileStoreSnapshotReceipt;
    cleanup: () => Promise<void>;
};
export type FileStoreSnapshotErrorCode = 'SNAPSHOT_OPTIONS_INVALID' | 'SNAPSHOT_ROOT_UNSAFE' | 'SNAPSHOT_ROOT_OVERLAP' | 'SNAPSHOT_LAYOUT_INVALID' | 'SNAPSHOT_FILE_UNSAFE' | 'SNAPSHOT_SOURCE_CHANGED' | 'SNAPSHOT_LIMIT' | 'SNAPSHOT_CANCELLED' | 'SNAPSHOT_EXISTS' | 'SNAPSHOT_FORMAT_INVALID' | 'SNAPSHOT_INTEGRITY_FAILED' | 'SNAPSHOT_ARCHIVE_FAILED' | 'SNAPSHOT_IO_FAILED' | 'SNAPSHOT_CLEANUP_FAILED';
export class FileStoreSnapshotError extends Error {
    constructor(readonly code: FileStoreSnapshotErrorCode) { super(code); this.name = 'FileStoreSnapshotError'; }
}
function fail(code: FileStoreSnapshotErrorCode): never { throw new FileStoreSnapshotError(code); }
function check(signal: AbortSignal) { if (signal.aborted)
    fail('SNAPSHOT_CANCELLED'); }
const hash = () => createHash('sha256');
function plain(value: unknown) { if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('SNAPSHOT_OPTIONS_INVALID'); const descriptors = Object.getOwnPropertyDescriptors(value); if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !('value' in descriptors[k]!)))
    fail('SNAPSHOT_OPTIONS_INVALID'); }
const pathSchema = z.string().refine(p => isAbsolute(p) && resolve(p) === p && p !== parse(p).root && !p.includes('\0'));
const optionsSchema = z.strictObject({ sourceRoot: pathSchema, archiveRoot: pathSchema, backupId: z.string().regex(uuidPattern), keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), maxFiles: z.number().int().min(1).max(FILESTORE_SNAPSHOT_MAX_FILES), maxFileBytes: z.number().int().positive().safe().max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES), maxTotalBytes: z.number().int().positive().safe().max(FILESTORE_SNAPSHOT_MAX_TOTAL_BYTES), key: z.custom<Buffer>(v => typeof v === 'object' && v !== null && !types.isProxy(v) && Buffer.isBuffer(v) && v.length === 32), signal: z.custom<AbortSignal>(v => typeof v === 'object' && v !== null && !types.isProxy(v) && v instanceof AbortSignal) });
function options<T extends FileStoreSnapshotOptions>(input: T, restore = false): T { plain(input); const schema = restore ? optionsSchema.extend({ restoreParent: pathSchema, restoreId: z.string().regex(uuidPattern) }) : optionsSchema; const result = schema.safeParse(input); if (!result.success)
    fail('SNAPSHOT_OPTIONS_INVALID'); check(result.data.signal); return { ...result.data, key: Buffer.from(result.data.key) } as T; }
const inside = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
function disjoint(paths: readonly string[]) { for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
        if (inside(paths[i]!, paths[j]!))
            fail('SNAPSHOT_ROOT_OVERLAP'); }
type Stamp = {
    path: string;
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
};
function stamp(path: string, s: BigIntStats): Stamp { return { path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs }; }
function owned(s: BigIntStats, mode: number, dir: boolean) { if ((dir ? !s.isDirectory() : !s.isFile()) || s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o7777n) !== BigInt(mode) || !dir && s.nlink !== 1n)
    fail(dir ? 'SNAPSHOT_ROOT_UNSAFE' : 'SNAPSHOT_FILE_UNSAFE'); }
async function root(path: string): Promise<Stamp[]> { const uid = process.getuid?.(); if (uid === undefined)
    fail('SNAPSHOT_ROOT_UNSAFE'); let at = parse(path).root; const result: Stamp[] = []; for (const part of ['', ...path.slice(at.length).split(sep)]) {
    if (part)
        at = join(at, part);
    const s = await lstat(at, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(uid) && s.uid !== 0n || (s.mode & 0o022n) !== 0n && (s.mode & 0o1000n) === 0n)
        fail('SNAPSHOT_ROOT_UNSAFE');
    if (at === path)
        owned(s, 0o700, true);
    result.push(stamp(at, s));
} if (await realpath(path) !== path)
    fail('SNAPSHOT_ROOT_UNSAFE'); return result; }
async function matches(old: Stamp, content = false) { const s = await lstat(old.path, { bigint: true }); if (s.isSymbolicLink() || s.dev !== old.dev || s.ino !== old.ino || s.uid !== old.uid || s.mode !== old.mode || !s.isDirectory() && s.nlink !== old.nlink || content && (s.size !== old.size || s.mtimeNs !== old.mtimeNs || s.ctimeNs !== old.ctimeNs))
    fail('SNAPSHOT_SOURCE_CHANGED'); }
async function sourceFence(path: string): Promise<Stamp[]> { let at = parse(path).root; const result: Stamp[] = []; for (const part of ['', ...path.slice(at.length).split(sep)]) {
    if (part)
        at = join(at, part);
    let s: BigIntStats;
    try {
        s = await lstat(at, { bigint: true });
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return result;
        throw error;
    }
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1) && s.uid !== 0n || (s.mode & 0o022n) !== 0n && (s.mode & 0o1000n) === 0n)
        fail('SNAPSHOT_ROOT_UNSAFE');
    if (at === path)
        owned(s, 0o700, true);
    result.push(stamp(at, s));
} if (await realpath(path) !== path)
    fail('SNAPSHOT_ROOT_UNSAFE'); return result; }
async function rootsUnchanged(stamps: readonly Stamp[]) { for (const s of stamps)
    await matches(s); }
function same(a: Stamp, b: Stamp) { return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
async function close(handle: FileHandle | undefined) { if (handle)
    await handle.close(); }
async function write(handle: FileHandle, bytes: Buffer) { let at = 0; while (at < bytes.length) {
    const r = await handle.write(bytes, at, bytes.length - at);
    if (!r.bytesWritten)
        fail('SNAPSHOT_IO_FAILED');
    at += r.bytesWritten;
} }
async function* fileBytes(file: Stamp, signal: AbortSignal) { let handle: FileHandle | undefined; try {
    check(signal);
    await matches(file, true);
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    owned(before, 0o600, false);
    if (!same(file, stamp(file.path, before)))
        fail('SNAPSHOT_SOURCE_CHANGED');
    for (let position = 0; position < Number(file.size);) {
        check(signal);
        const bytes = Buffer.alloc(Math.min(CHUNK, Number(file.size) - position)), r = await handle.read(bytes, 0, bytes.length, position);
        if (!r.bytesRead)
            fail('SNAPSHOT_SOURCE_CHANGED');
        position += r.bytesRead;
        yield bytes.subarray(0, r.bytesRead);
    }
    check(signal);
    if (!same(file, stamp(file.path, await handle.stat({ bigint: true }))))
        fail('SNAPSHOT_SOURCE_CHANGED');
    await matches(file, true);
}
finally {
    await close(handle);
} }
type Tree = {
    emptyDirectories: number;
    stamps: Stamp[];
    files: {
        stamp: Stamp;
        entry: {
            key: string;
            byteSize: number;
            sha256: string;
        };
    }[];
    totalBytes: number;
};
async function scan(input: FileStoreSnapshotOptions, withHashes: boolean): Promise<Tree> { const tree: Tree = { emptyDirectories: 0, stamps: [], files: [], totalBytes: 0 }; let dirs = 0; async function visit(path: string, parts: string[]) { check(input.signal); const startFiles = tree.files.length; const before = await lstat(path, { bigint: true }); owned(before, 0o700, true); tree.stamps.push(stamp(path, before)); if (++dirs > FILESTORE_SNAPSHOT_MAX_DIRECTORIES + 1)
    fail('SNAPSHOT_LIMIT'); const names: string[] = []; const directory = await opendir(path); for await (const entry of directory) {
    check(input.signal);
    if (names.length >= FILESTORE_SNAPSHOT_MAX_DIRECTORIES + FILESTORE_SNAPSHOT_MAX_FILES)
        fail('SNAPSHOT_LIMIT');
    names.push(entry.name);
} names.sort(); for (const name of names) {
    check(input.signal);
    const member = join(path, name), s = await lstat(member, { bigint: true });
    if (parts.length < 3) {
        if (!uuidPattern.test(name) || !s.isDirectory() || s.isSymbolicLink())
            fail('SNAPSHOT_LAYOUT_INVALID');
        await visit(member, [...parts, name]);
    }
    else {
        const key = [...parts, name].join('/');
        if (!keyPattern.test(key))
            fail('SNAPSHOT_LAYOUT_INVALID');
        owned(s, 0o600, false);
        if (s.size > BigInt(input.maxFileBytes))
            fail('SNAPSHOT_LIMIT');
        tree.totalBytes += Number(s.size);
        if (!Number.isSafeInteger(tree.totalBytes) || tree.totalBytes > input.maxTotalBytes || tree.files.length >= input.maxFiles)
            fail('SNAPSHOT_LIMIT');
        const f = stamp(member, s), digest = hash();
        if (withHashes)
            for await (const bytes of fileBytes(f, input.signal))
                digest.update(bytes);
        tree.files.push({ stamp: f, entry: { key, byteSize: Number(s.size), sha256: withHashes ? digest.digest('hex') : '' } });
        tree.stamps.push(f);
    }
} if (parts.length && tree.files.length === startFiles) tree.emptyDirectories++; const after = stamp(path, await lstat(path, { bigint: true })); if (!same(stamp(path, before), after))
    fail('SNAPSHOT_SOURCE_CHANGED'); } await visit(input.sourceRoot, []); return tree; }
function frozenManifest(value: FileStoreSnapshotManifest): FileStoreSnapshotManifest { for (const entry of value.files)
    Object.freeze(entry); Object.freeze(value.files); return Object.freeze(value); }
function archiveMetadata(input: FileStoreSnapshotOptions) { return { keyId: input.keyId, sourceSchemaFingerprint: input.schemaFingerprint, type: 'FILESTORE_SNAPSHOT' as const }; }
function safe(error: unknown, signal: AbortSignal) { if (error instanceof FileStoreSnapshotError)
    return error; if (signal.aborted)
    return new FileStoreSnapshotError('SNAPSHOT_CANCELLED'); if (error instanceof Error && error.name === 'ArchiveError')
    return new FileStoreSnapshotError('SNAPSHOT_ARCHIVE_FAILED'); return new FileStoreSnapshotError('SNAPSHOT_IO_FAILED'); }
/** Requires stopped writers and an exclusively administered source/root hierarchy.
 * Before/after scans are change detection, not a filesystem MVCC snapshot. */
export async function snapshotFileStore(value: FileStoreSnapshotOptions): Promise<FileStoreSnapshotReceipt> {
    const input = options(value);
    try {
        disjoint([input.sourceRoot, input.archiveRoot]);
        const parents = [...await root(input.sourceRoot), ...await root(input.archiveRoot)], tree = await scan(input, true), manifest = frozenManifest({ version: 1, kind: 'FILESTORE_SEALED_TREE', sourceRootHash: hash().update(input.sourceRoot).digest('hex'), emptyDirectoryPolicy: 'OMITTED_NO_OBJECTS', omittedEmptyDirectoryCount: tree.emptyDirectories, files: tree.files.map(f => f.entry), totalBytes: tree.totalBytes }), encoded = Buffer.from(JSON.stringify(manifest));
        if (encoded.length > FILESTORE_SNAPSHOT_MANIFEST_MAX_BYTES)
            fail('SNAPSHOT_LIMIT');
        const prefix = Buffer.alloc(12);
        MAGIC.copy(prefix);
        prefix.writeUInt32BE(encoded.length, 8);
        let payloadError: unknown;
        async function* payload() { try {
            yield prefix;
            yield encoded;
            for (const file of tree.files) {
                const digest = hash();
                for await (const bytes of fileBytes(file.stamp, input.signal)) {
                    digest.update(bytes);
                    yield bytes;
                }
                if (digest.digest('hex') !== file.entry.sha256)
                    fail('SNAPSHOT_SOURCE_CHANGED');
            }
            const after = await scan(input, false);
            if (tree.stamps.length !== after.stamps.length || tree.stamps.some((s, i) => !same(s, after.stamps[i]!)))
                fail('SNAPSHOT_SOURCE_CHANGED');
            await rootsUnchanged(parents);
            check(input.signal);
        }
        catch (error) {
            payloadError = error;
            throw error;
        } }
        let archive: ArchiveReceipt;
        try {
            archive = await writePrivateArchive({ root: input.archiveRoot, backupId: input.backupId, key: input.key, maxBytes: 12 + encoded.length + tree.totalBytes, signal: input.signal, metadata: archiveMetadata(input), input: Readable.from(payload()) });
        }
        catch (error) {
            throw payloadError ?? error;
        }
        return { archive, manifest };
    }
    catch (error) {
        throw safe(error, input.signal);
    }
    finally {
        input.key.fill(0);
    }
}
class Reader {
    private pending: Buffer = Buffer.alloc(0);
    private ended = false;
    private iterator: AsyncIterator<Buffer>;
    constructor(readonly stream: ReadStream, private signal: AbortSignal) { this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>; }
    async read(length: number) { check(this.signal); const chunks: Buffer[] = []; let size = 0; while (size < length) {
        if (!this.pending.length) {
            const next = await this.iterator.next();
            if (next.done) {
                this.ended = true;
                fail('SNAPSHOT_FORMAT_INVALID');
            }
            if (!Buffer.isBuffer(next.value))
                fail('SNAPSHOT_FORMAT_INVALID');
            this.pending = next.value;
        }
        const n = Math.min(length - size, this.pending.length);
        chunks.push(this.pending.subarray(0, n));
        this.pending = this.pending.subarray(n);
        size += n;
    } check(this.signal); return Buffer.concat(chunks, length); }
    async end() { check(this.signal); if (this.pending.length)
        fail('SNAPSHOT_FORMAT_INVALID'); if (!this.ended) {
        const next = await this.iterator.next();
        if (!next.done)
            fail('SNAPSHOT_FORMAT_INVALID');
        this.ended = true;
    } }
}
async function removeOwned(files: readonly Stamp[], dirs: readonly Stamp[], parents: readonly Stamp[]) { await rootsUnchanged(parents); const fileSet = new Set(files); for (const old of [...files, ...[...dirs].reverse()]) {
    try {
        await matches(old);
        if (fileSet.has(old))
            await unlink(old.path);
        else
            await rmdir(old.path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            continue;
        fail('SNAPSHOT_CLEANUP_FAILED');
    }
} }
async function newDirectory(path: string, dirs: Stamp[]) { try {
    await mkdir(path, { mode: 0o700 });
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        fail('SNAPSHOT_EXISTS');
    throw error;
} let s: BigIntStats; try {
    s = await lstat(path, { bigint: true });
}
catch {
    fail('SNAPSHOT_CLEANUP_FAILED');
} dirs.push(stamp(path, s)); owned(s, 0o700, true); if (await realpath(path) !== path)
    fail('SNAPSHOT_ROOT_UNSAFE'); }
/** Authenticates the whole encrypted archive before creating an independent tree.
 * Only sealed bytes are restored; this never installs a live FileStore or key. */
export async function restoreFileStoreSnapshot(value: RestoreFileStoreSnapshotOptions): Promise<RestoredFileStoreLease> {
    const input = options(value, true);
    let archived: PlaintextLease | undefined, stream: ReadStream | undefined;
    const files: Stamp[] = [], dirs: Stamp[] = [];
    let parents: Stamp[] = [];
    try {
        disjoint([input.sourceRoot, input.archiveRoot, input.restoreParent]);
        const sourceParents = await sourceFence(input.sourceRoot), archiveParents = await root(input.archiveRoot);
        parents = await root(input.restoreParent);
        await rootsUnchanged(sourceParents);
        await rootsUnchanged(archiveParents);
        archived = await openPrivateArchive({ root: input.archiveRoot, backupId: input.backupId, key: input.key, maxBytes: input.maxTotalBytes + FILESTORE_SNAPSHOT_MANIFEST_MAX_BYTES + 12, signal: input.signal, expectedMetadata: archiveMetadata(input) });
        check(input.signal);
        stream = await archived.openReadStream();
        const reader = new Reader(stream, input.signal), prefix = await reader.read(12);
        if (!prefix.subarray(0, 8).equals(MAGIC))
            fail('SNAPSHOT_FORMAT_INVALID');
        const size = prefix.readUInt32BE(8);
        if (size < 1 || size > FILESTORE_SNAPSHOT_MANIFEST_MAX_BYTES)
            fail('SNAPSHOT_LIMIT');
        const encoded = await reader.read(size);
        let manifest: FileStoreSnapshotManifest;
        try {
            manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)));
        }
        catch {
            fail('SNAPSHOT_FORMAT_INVALID');
        }
        if (!Buffer.from(JSON.stringify(manifest)).equals(encoded))
            fail('SNAPSHOT_FORMAT_INVALID');
        if (manifest.sourceRootHash !== hash().update(input.sourceRoot).digest('hex'))
            fail('SNAPSHOT_INTEGRITY_FAILED');
        if (manifest.files.length > input.maxFiles || manifest.totalBytes > input.maxTotalBytes)
            fail('SNAPSHOT_LIMIT');
        let total = 0, previous = '';
        for (const entry of manifest.files) {
            if (entry.key <= previous)
                fail('SNAPSHOT_FORMAT_INVALID');
            previous = entry.key;
            if (entry.byteSize > input.maxFileBytes)
                fail('SNAPSHOT_LIMIT');
            total += entry.byteSize;
            if (!Number.isSafeInteger(total) || total > input.maxTotalBytes)
                fail('SNAPSHOT_LIMIT');
        }
        if (total !== manifest.totalBytes || 12 + size + total !== archived.receipt.plaintext.byteSize)
            fail('SNAPSHOT_INTEGRITY_FAILED');
        const restored = join(input.restoreParent, input.restoreId);
        await rootsUnchanged(sourceParents);
        await rootsUnchanged(archiveParents);
        await rootsUnchanged(parents);
        check(input.signal);
        await newDirectory(restored, dirs);
        const createdDirectories = new Map<string, Stamp>();
        for (const entry of manifest.files) {
            check(input.signal);
            let at = restored;
            for (const component of entry.key.split('/').slice(0, -1)) {
                at = join(at, component);
                if (!createdDirectories.has(at)) {
                    await newDirectory(at, dirs);
                    createdDirectories.set(at, dirs.at(-1)!);
                }
                else
                    await matches(createdDirectories.get(at)!);
            }
            const path = join(restored, entry.key);
            let file: FileHandle | undefined;
            try {
                file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
                const s = await file.stat({ bigint: true });
                files.push(stamp(path, s));
                owned(s, 0o600, false);
                const digest = hash();
                for (let remaining = entry.byteSize; remaining > 0;) {
                    const bytes = await reader.read(Math.min(remaining, CHUNK));
                    digest.update(bytes);
                    await write(file, bytes);
                    remaining -= bytes.length;
                }
                if (digest.digest('hex') !== entry.sha256)
                    fail('SNAPSHOT_INTEGRITY_FAILED');
                await file.sync();
                await matches(files.at(-1)!);
                check(input.signal);
            }
            finally {
                await close(file);
            }
        }
        await reader.end();
        stream.destroy();
        stream = undefined;
        await archived.cleanup();
        const archive = archived.receipt;
        archived = undefined;
        await rootsUnchanged(parents);
        for (const s of [...dirs, ...files])
            await matches(s);
        for (const dir of [...dirs].reverse()) {
            const handle = await open(dir.path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
        check(input.signal);
        const receipt = { archive, manifest: frozenManifest(manifest) };
        let cleaned = false, closing: Promise<void> | undefined;
        return { root: restored, receipt, cleanup: async () => { if (cleaned)
                return; if (closing)
                return closing; closing = (async () => { await removeOwned(files, dirs, parents); cleaned = true; })(); try {
                await closing;
            }
            finally {
                closing = undefined;
            } } };
    }
    catch (error) {
        stream?.destroy();
        let clean = true;
        try {
            if (files.length || dirs.length)
                await removeOwned(files, dirs, parents);
        }
        catch {
            clean = false;
        }
        try {
            await archived?.cleanup();
            archived = undefined;
        }
        catch {
            clean = false;
        }
        if (!clean)
            fail('SNAPSHOT_CLEANUP_FAILED');
        throw safe(error, input.signal);
    }
    finally {
        input.key.fill(0);
    }
}
