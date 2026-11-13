-- 扩展向量索引与历史约束兼容迁移（幂等执行，可在 db:push 之后运行 pnpm run db:extend）

CREATE EXTENSION IF NOT EXISTS vector;

-- 语义记忆 HNSW 余弦索引（需在 schema.ts 同步声明，避免 db:push 误删）
CREATE INDEX IF NOT EXISTS semantic_memories_embedding_idx
  ON semantic_memories USING hnsw (embedding vector_cosine_ops);

-- 术语知识库 HNSW 余弦索引
CREATE INDEX IF NOT EXISTS glossary_terms_embedding_idx
  ON glossary_terms USING hnsw (embedding vector_cosine_ops);

-- 外部事件反查任务链接索引
CREATE INDEX IF NOT EXISTS agent_task_links_ref_idx
  ON agent_task_links (ref);

-- 旧版 pending_actions 可能存在 conversation_id 单列唯一约束/索引，
-- 会阻止同一会话并发保存多条待确认写操作；这里幂等清理旧唯一索引并确保普通索引存在。
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

CREATE INDEX IF NOT EXISTS pending_actions_conv_idx
  ON pending_actions (conversation_id);
