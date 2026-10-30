import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/db/schema.ts',
    './src/db/memorySchema.ts',
    './src/db/configSchema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent',
  },
  strict: true,
  verbose: true,
});
