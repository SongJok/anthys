import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * 存量库基线标记：数据库已由历史 db:push 建好全部表结构时，
 * 把 0000 基线迁移登记为「已应用」而不重复执行 DDL，
 * 之后 db:migrate 只应用 0001 及后续增量。空库直接跳过。
 */

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent';

const journalUrl = new URL('../../drizzle/meta/_journal.json', import.meta.url);
const journal = JSON.parse(await readFile(journalUrl, 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const baseline = journal.entries.find((entry) => entry.idx === 0);
if (!baseline) throw new Error('drizzle/meta/_journal.json 缺少 idx=0 基线条目');
const baselineSql = await readFile(
  new URL(`../../drizzle/${baseline.tag}.sql`, import.meta.url),
  'utf8',
);
const baselineHash = createHash('sha256').update(baselineSql).digest('hex');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const existing = await client.query(
    `SELECT to_regclass('public.conversations') AS table_name`,
  );
  if (!existing.rows[0]?.table_name) {
    console.log('empty database, baseline skipped (db:migrate will create schema)');
  } else {
    const required = [
      'conversations',
      'project_chunks',
      'semantic_memories',
      'pending_actions',
      'agent_jobs',
    ];
    const presence = await client.query(
      `SELECT t AS table_name, to_regclass('public.' || t) IS NOT NULL AS present
       FROM unnest($1::text[]) AS t`,
      [required],
    );
    const missing = presence.rows
      .filter((row) => !row.present)
      .map((row) => row.table_name);
    if (missing.length > 0) {
      throw new Error(
        `数据库表结构不完整（缺少 ${missing.join(', ')}），不能标记基线；请先用 db:push 补齐或人工核查`,
      );
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    const tracked = await client.query(
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    if (tracked.rows.length > 0) {
      console.log('migrations already tracked, baseline skipped');
    } else {
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [baselineHash, baseline.when],
      );
      console.log(
        `baseline ${baseline.tag} marked as applied (hash ${baselineHash.slice(0, 12)}…)`,
      );
    }
  }
} finally {
  await client.end();
}