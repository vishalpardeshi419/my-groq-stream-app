ALTER INDEX rag_chunks_embedding_hnsw_idx
  RENAME TO rag_chunks_embedding_1536_hnsw_idx;

ALTER TABLE rag_chunks
  RENAME COLUMN embedding TO embedding_1536;

ALTER TABLE rag_chunks
  ALTER COLUMN embedding_1536 DROP NOT NULL;

ALTER TABLE rag_chunks
  ADD COLUMN embedding vector(768);

CREATE INDEX rag_chunks_embedding_hnsw_idx
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);
