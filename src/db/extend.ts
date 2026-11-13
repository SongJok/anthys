import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const SQL_FILES = ['project-index.sql', 'vector-and-constraints.sql'] as const;

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent';

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  for (const fileName of SQL_FILES) {
    const sqlPath = new URL(`./sql/${fileName}`, import.meta.url);
    const sql = await readFile(sqlPath, 'utf8');
    await client.query(sql);
    console.log(`${fileName} applied`);
  }
} finally {
  await client.end();
}
