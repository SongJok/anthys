import assert from 'node:assert/strict';
import {test} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {preserveTestArtifacts} from '../../scripts/preserve-test-artifacts.mjs';

test('untracked and nested report bytes survive replacement, with deduplicated private backups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oa-artifact-'));
  try {
    await mkdir(join(root, 'reports/ui'), {recursive: true});
    const original = Buffer.from([0, 255, 17, 128]);
    await writeFile(join(root, 'reports/gateway-matrix-latest.json'), original);
    await writeFile(join(root, 'reports/ui/image.png'), original);
    const first = await preserveTestArtifacts(root);
    const second = await preserveTestArtifacts(root);
    assert.notEqual(first.manifest, second.manifest);
    const manifest = JSON.parse(await readFile(first.manifest, 'utf8'));
    assert.equal(first.files, 2);
    assert.equal((await readdir(join(root, '.data/test-artifact-backups/objects'))).length, 1);
    await writeFile(join(root, 'reports/gateway-matrix-latest.json'), 'new result');
    for (const entry of manifest.entries) {
      const object = join(root, '.data/test-artifact-backups/objects', entry.sha256);
      assert.deepEqual(await readFile(object), original);
      assert.equal((await lstat(object)).mode & 0o777, 0o600);
    }
    assert.equal((await lstat(first.manifest)).mode & 0o777, 0o600);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the real runner refuses to launch its child when report preservation fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oa-artifact-runner-')));
  try {
    for (const directory of ['reports', '.data/test-environment', 'node_modules/vitest'])
      await mkdir(join(root, directory), {recursive: true});
    const prepared = {APP_ENV: 'test', OA_TEST_ISOLATED: 'true'};
    for (const [name, role] of [['DATABASE_URL', 'oa_app'], ['RUNTIME_DATABASE_URL', 'oa_runtime'], ['QUEUE_DATABASE_URL', 'oa_queue'], ['MIGRATION_DATABASE_URL', 'oa_migrator']])
      prepared[name] = `postgresql://${role}:${'x'.repeat(32)}@127.0.0.1:53331/open_aider_test`;
    for (const [name, file] of [['APP_MASTER_KEY_FILE', 'app_master_key'], ['SESSION_SECRET_FILE', 'session_secret'], ['BUDGET_POLICY_FILE', 'budget-policy.json']])
      prepared[name] = join(root, '.data/test-environment', file);
    await writeFile(join(root, '.data/test-environment/environment.json'), JSON.stringify(prepared));
    await writeFile(join(root, 'node_modules/vitest/vitest.mjs'), "console.log('CHILD_WAS_STARTED');");
    await symlink(join(root, 'outside'), join(root, 'reports/escape'));
    let error;
    try { execFileSync(process.execPath, [resolve('scripts/run-tests.mjs'), 'vitest', 'run'], {cwd: root, env: {PATH: process.env.PATH}, stdio: 'pipe'}); }
    catch (failure) { error = failure; }
    assert.ok(error);
    assert.match(String(error.stderr), /ARTIFACT_BACKUP_REGULAR_FILES_REQUIRED/);
    assert.doesNotMatch(String(error.stdout), /CHILD_WAS_STARTED/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('symlinks and corrupted existing backup objects fail before a test can start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oa-artifact-'));
  try {
    await mkdir(join(root, 'reports'));
    await writeFile(join(root, 'reports/result.json'), 'original');
    const first = await preserveTestArtifacts(root);
    const manifest = JSON.parse(await readFile(first.manifest, 'utf8'));
    await writeFile(join(root, '.data/test-artifact-backups/objects', manifest.entries[0].sha256), 'corrupt');
    await assert.rejects(preserveTestArtifacts(root), /ARTIFACT_BACKUP_OBJECT_CORRUPT/);
    await symlink(join(root, 'outside'), join(root, 'reports/escape'));
    await assert.rejects(preserveTestArtifacts(root), /ARTIFACT_BACKUP_REGULAR_FILES_REQUIRED/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('concurrent preservers publish complete immutable objects without false corruption or abandoned partial files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oa-artifact-concurrent-'));
  try {
    await mkdir(join(root, 'reports'));
    const original = Buffer.alloc(8 * 1024 * 1024, 0xa7);
    await writeFile(join(root, 'reports/concurrent.bin'), original);
    const preserved = await Promise.all(Array.from({length: 12}, () => preserveTestArtifacts(root)));
    assert.equal(new Set(preserved.map(item => item.manifest)).size, 12);
    const objects = await readdir(join(root, '.data/test-artifact-backups/objects'));
    assert.equal(objects.length, 1);
    assert.match(objects[0], /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(join(root, '.data/test-artifact-backups/objects', objects[0])), original);
    for (const item of preserved) {
      const manifest = JSON.parse(await readFile(item.manifest, 'utf8'));
      assert.equal(item.files, 1);
      assert.equal(manifest.entries[0].sha256, objects[0]);
      assert.equal(manifest.entries[0].bytes, original.length);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
