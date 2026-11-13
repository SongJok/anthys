import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schemaIndex from './schemaIndex.js';

describe('schemaIndex and database index definitions', () => {
  it('exports every Drizzle pgTable defined under src/db', () => {
    expect(Object.keys(schemaIndex).length).toBeGreaterThanOrEqual(45);
    expect(schemaIndex.conversations).toBeDefined();
    expect(schemaIndex.semanticMemories).toBeDefined();
    expect(schemaIndex.glossaryTerms).toBeDefined();
    expect(schemaIndex.pendingActions).toBeDefined();
    expect(schemaIndex.agentTasks).toBeDefined();
    expect(schemaIndex.agentTaskLinks).toBeDefined();
  });

  it('declares HNSW vector indexes on semantic_memories and glossary_terms', () => {
    const semanticConfig = getTableConfig(schemaIndex.semanticMemories);
    const glossaryConfig = getTableConfig(schemaIndex.glossaryTerms);

    const semanticHnsw = semanticConfig.indexes.find(
      (idx) => idx.config.name === 'semantic_memories_embedding_idx',
    );
    const glossaryHnsw = glossaryConfig.indexes.find(
      (idx) => idx.config.name === 'glossary_terms_embedding_idx',
    );

    expect(semanticHnsw?.config.method).toBe('hnsw');
    expect(glossaryHnsw?.config.method).toBe('hnsw');
  });

  it('uses non-unique conversation index on pending_actions and indexes agent_task_links.ref', () => {
    const pendingConfig = getTableConfig(schemaIndex.pendingActions);
    const convIndex = pendingConfig.indexes.find(
      (idx) => idx.config.name === 'pending_actions_conv_idx',
    );
    expect(convIndex).toBeDefined();
    expect(convIndex?.config.unique).toBe(false);

    const taskLinkConfig = getTableConfig(schemaIndex.agentTaskLinks);
    const refIndex = taskLinkConfig.indexes.find(
      (idx) => idx.config.name === 'agent_task_links_ref_idx',
    );
    expect(refIndex).toBeDefined();
  });

  it('includes idempotent SQL migration statements matching the schema indexes', () => {
    const sqlText = readFileSync(
      new URL('./sql/vector-and-constraints.sql', import.meta.url),
      'utf8',
    );
    expect(sqlText).toContain('semantic_memories_embedding_idx');
    expect(sqlText).toContain('glossary_terms_embedding_idx');
    expect(sqlText).toContain('agent_task_links_ref_idx');
    expect(sqlText).toContain('pending_actions_conv_idx');
  });
});
