import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent';
const sqlPath = new URL('./sql/project-index.sql', import.meta.url);
const sql = await readFile(sqlPath, 'utf8');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(sql);
  console.log('project-index.sql applied');
} finally {
  await client.end();
}
