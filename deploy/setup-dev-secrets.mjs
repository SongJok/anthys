#!/usr/bin/env node
// Generates the development-only secret files consumed by
// deploy/compose/compose.dev.yml. Values are random and never leave .secrets/
// (gitignored). Database URLs for containers use the postgres service name;
// host-side tools keep using pnpm setup:dev's 127.0.0.1 URLs.
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(deployDir, '..');
const secretsDir = resolve(repoRoot, '.secrets');
const dockerDir = resolve(secretsDir, 'docker');
const companyMcpDir = resolve(secretsDir, 'company-mcp');

async function readTrimmed(path) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

let envFile = {};
try {
  envFile = parseEnv(await readFile(resolve(repoRoot, '.env'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('ENV_FILE_INVALID');
}

// Accept the same direct-value and *_FILE forms as packages/config, but write
// only a 0600 file consumed by the Compose secret mount. Values never appear in
// Compose environment or logs.
async function envCredential(names, sourceName) {
  for (const name of names) {
    const reference = (envFile[`${name}_FILE`] ?? '').trim();
    if (reference) return invalidCheck(await readTrimmed(resolve(repoRoot, reference)) ?? '', name);
  }
  for (const name of names) {
    const direct = (envFile[name] ?? '').trim();
    if (direct) return invalidCheck(direct, name);
  }
  return (await readTrimmed(resolve(secretsDir, sourceName))) || '';
}

function invalidCheck(value, name) {
  if (!value || value.length > 4096 || /[\u0000\r\n]/.test(value)) throw new Error(`ENV_CREDENTIAL_INVALID:${name}`);
  return value;
}

await mkdir(secretsDir, {recursive: true, mode: 0o700});
await mkdir(dockerDir, {recursive: true, mode: 0o700});
await mkdir(companyMcpDir, {recursive: true, mode: 0o700});
await chmod(secretsDir, 0o700);
await chmod(dockerDir, 0o700);
await chmod(companyMcpDir, 0o700);

const required = ['pg_admin_password', 'pg_app_password', 'pg_queue_password', 'pg_runtime_password', 'app_master_key', 'session_secret'];
for (const name of required) {
  const path = resolve(secretsDir, name);
  let value = await readTrimmed(path);
  if (!value) {
    value = randomBytes(32).toString('hex');
    await writeFile(path, `${value}\n`, {mode: 0o600, flag: 'wx'});
  }
  await chmod(path, 0o600);
  const dockerPath = resolve(dockerDir, name);
  await writeFile(dockerPath, `${value}\n`, {mode: 0o600});
  await chmod(dockerPath, 0o600);
}

const password = async name => {
  const value = await readTrimmed(resolve(secretsDir, name));
  if (!value) throw new Error(`SECRET_NOT_GENERATED:${name}`);
  return encodeURIComponent(value);
};

const urls = {
  database_url: `postgresql://oa_app:${await password('pg_app_password')}@postgres:5432/anthys`,
  migration_database_url: `postgresql://oa_migrator:${await password('pg_admin_password')}@postgres:5432/anthys`,
  queue_database_url: `postgresql://oa_queue:${await password('pg_queue_password')}@postgres:5432/anthys`,
  runtime_database_url: `postgresql://oa_runtime:${await password('pg_runtime_password')}@postgres:5432/anthys`
};
for (const [name, value] of Object.entries(urls)) {
  const path = resolve(dockerDir, name);
  await writeFile(path, `${value}\n`, {mode: 0o600});
  await chmod(path, 0o600);
}

// Empty files are deliberate safe defaults: secret() reads the file and returns
// an empty string, which keeps GLM/DingTalk in BLOCKED_EXTERNAL. A raw value in
// .env or a *_FILE reference is copied to a 0600 Compose secret; .secrets/<name>
// remains supported for callers that cannot use .env.
for (const [names, sourceName] of [
  [['GLM_API_KEY', 'AIDER_AI_DEFAULT_API_KEY'], 'glm_api_key'],
  [['DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_SECRET'], 'dingtalk_client_secret']
]) {
  const target = resolve(dockerDir, names[0].toLowerCase());
  const value = await envCredential(names, sourceName);
  await writeFile(target, value ? `${value}\n` : '', {mode: 0o600});
  await chmod(target, 0o600);
}

console.log('Docker development secrets ready under .secrets/docker (mode 0600).');
console.log('They are gitignored; never commit or bake them into images.');
