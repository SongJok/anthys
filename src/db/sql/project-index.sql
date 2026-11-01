-- 项目代码索引的扩展对象：tsv 生成列与 GIN/HNSW 索引已在 Drizzle schema 声明，
-- db:push 会创建；本脚本负责启用 vector/pg_trgm 并为旧库幂等补齐缺失对象。
-- 在 `pnpm run db:push` 之后执行，可重复运行：pnpm run db:extend

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
