import { readFileSync } from 'node:fs';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schemaIndex from './schemaIndex.js';

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

function migrationSql(tag: string): string {
  return readFileSync(
    new URL(`../../drizzle/${tag}.sql`, import.meta.url),
    'utf8',
  );
}

describe('版本化迁移完整性', () => {
  it('journal 条目连续递增且文件齐全', () => {
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(() => migrationSql(entry.tag)).not.toThrow();
      if (index > 0) {
        expect(entry.when).toBeGreaterThan(journal.entries[index - 1]!.when);
      }
    });
  });

  it('基线 + 后续迁移覆盖 schemaIndex 导出的全部表', () => {
    const allSql = journal.entries
      .map((entry) => migrationSql(entry.tag))
      .join('\n');
    const tables = Object.values(schemaIndex).filter((value) =>
      is(value, PgTable),
    );
    expect(tables.length).toBeGreaterThanOrEqual(45);
    for (const table of tables) {
      const { name } = getTableConfig(table);
      expect(allSql).toContain(`CREATE TABLE "${name}"`);
    }
  });

  it('0000 基线前置 vector / pg_trgm 扩展，保证空库可直接 migrate', () => {
    const baseline = migrationSql(journal.entries[0]!.tag);
    const firstStatements = baseline.split('--> statement-breakpoint').slice(0, 2);
    expect(firstStatements[0]).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(firstStatements[1]).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  });

  it('0001 扩展迁移全部幂等，可在存量库安全执行', () => {
    const extensions = migrationSql('0001_extensions');
    const statements = extensions
      .split('--> statement-breakpoint')
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0 && !stmt.startsWith('--'));
    for (const stmt of statements) {
      const upper = stmt.toUpperCase();
      if (upper.startsWith('CREATE INDEX')) {
        expect(upper).toContain('IF NOT EXISTS');
      } else if (upper.startsWith('CREATE EXTENSION')) {
        expect(upper).toContain('IF NOT EXISTS');
      } else if (upper.startsWith('ALTER TABLE')) {
        expect(upper).toContain('IF NOT EXISTS');
      } else {
        expect(upper.startsWith('DO $$')).toBe(true);
      }
    }
    expect(extensions).toContain('pending_actions_conv_idx');
    expect(extensions).toContain('semantic_memories_embedding_idx');
    expect(extensions).toContain('glossary_terms_embedding_idx');
  });
});