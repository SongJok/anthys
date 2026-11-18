-- 幂等扩展迁移：为旧库补齐 vector/pg_trgm 扩展对象，并清理历史唯一约束。
-- 新库在 0000 基线中已创建这些对象，本迁移全部 IF NOT EXISTS，可安全重复执行。

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
ALTER TABLE project_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
--> statement-breakpoint
ALTER TABLE project_chunks
  ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(path, '') || ' ' ||
      coalesce(symbol, '') || ' ' ||
      coalesce(content, '')
    )
  ) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_chunks_tsv_idx
  ON project_chunks USING GIN (tsv);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_chunks_trgm_idx
  ON project_chunks USING GIN (content gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_chunks_embedding_idx
  ON project_chunks USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS semantic_memories_embedding_idx
  ON semantic_memories USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS glossary_terms_embedding_idx
  ON glossary_terms USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_task_links_ref_idx
  ON agent_task_links (ref);
--> statement-breakpoint
DO $$
DECLARE
  idx_name text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'pending_actions' AND n.nspname = current_schema()
  ) THEN
    FOR idx_name IN
      SELECT i.relname
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relname = 'pending_actions'
        AND ix.indisunique = true
        AND NOT ix.indisprimary
        AND array_length(ix.indkey, 1) = 1
        AND a.attname = 'conversation_id'
    LOOP
      EXECUTE format('ALTER TABLE pending_actions DROP CONSTRAINT IF EXISTS %I', idx_name);
      EXECUTE format('DROP INDEX IF EXISTS %I', idx_name);
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pending_actions_conv_idx
  ON pending_actions (conversation_id);