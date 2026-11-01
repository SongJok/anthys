-- 项目代码索引的扩展对象：Drizzle 无法生成 tsvector 生成列与 HNSW 索引。
-- 在 `pnpm run db:push` 之后执行，可重复运行：
--   psql "$DATABASE_URL" -f src/db/sql/project-index.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE project_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

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

CREATE INDEX IF NOT EXISTS project_chunks_tsv_idx
  ON project_chunks USING GIN (tsv);

CREATE INDEX IF NOT EXISTS project_chunks_trgm_idx
  ON project_chunks USING GIN (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS project_chunks_embedding_idx
  ON project_chunks USING hnsw (embedding vector_cosine_ops);
