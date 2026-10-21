import {createHash, randomUUID} from 'node:crypto';
import {mkdir, lstat, readdir, readFile, writeFile, link, unlink} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';

// Tests intentionally refresh reports. Preserve existing bytes before any child
// starts, including untracked reports; shared immutable objects avoid full copies
// on every invocation. Backups remain private and are never auto-deleted.
export async function preserveTestArtifacts(workspace = process.cwd()) {
  const source = resolve(workspace, 'reports');
  const destination = resolve(workspace, '.data/test-artifact-backups');
  const objects = join(destination, 'objects');
  for (const directory of [destination, objects]) {
    await mkdir(directory, {recursive: true, mode: 0o700});
    if (!(await lstat(directory)).isDirectory()) throw Error('ARTIFACT_BACKUP_DIRECTORY_REQUIRED');
  }
  const entries = [];
  async function existingObject(object, sha256) {
    try {
      if (!(await lstat(object)).isFile() || createHash('sha256').update(await readFile(object)).digest('hex') !== sha256)
        throw Error('ARTIFACT_BACKUP_OBJECT_CORRUPT');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function visit(path) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT' && path === source) return; throw error; }
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    if (!stat.isFile()) throw Error('ARTIFACT_BACKUP_REGULAR_FILES_REQUIRED');
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const object = join(objects, sha256);
    if (!await existingObject(object, sha256)) {
      // Publish only a complete immutable object. Direct wx publication exposes
      // a partially written file to another preserving process's integrity check.
      const pending = join(objects, `.pending-${randomUUID()}`);
      try {
        await writeFile(pending, bytes, {flag: 'wx', mode: 0o600});
        try { await link(pending, object); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!await existingObject(object, sha256)) throw Error('ARTIFACT_BACKUP_OBJECT_CORRUPT');
        }
      } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    entries.push({path: relative(workspace, path), sha256, bytes: bytes.length, mode: stat.mode & 0o777});
  }
  await visit(source);
  const manifest = join(destination, `${randomUUID()}.json`);
  await writeFile(manifest, JSON.stringify({version: 1, createdAt: new Date().toISOString(), entries}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return {manifest, files: entries.length};
}
