import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
