import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/db/schema.ts',
    './src/db/memorySchema.ts',
    './src/db/configSchema.ts',
    './src/db/schedulerSchema.ts',
    './src/db/dwsIdentitySchema.ts',
    './src/db/usageSchema.ts',
    './src/db/clusterSchema.ts',
    './src/db/governanceSchema.ts',
    './src/db/glossarySchema.ts',
    './src/db/skillSchema.ts',
    './src/db/pluginSchema.ts',
    './src/db/projectSchema.ts',
    './src/db/jobSchema.ts',
    './src/db/taskSchema.ts',
    './src/db/approvalSchema.ts',
    './src/db/investigationSchema.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/dingtalk_agent',
  },
  strict: true,
  verbose: true,
});
