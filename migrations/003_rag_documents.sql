CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_file text NOT NULL,
  mime_type text NOT NULL,
  sha256 char(64) NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

CREATE INDEX IF NOT EXISTS rag_documents_user_created_idx
  ON rag_documents (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  token_count integer NOT NULL CHECK (token_count BETWEEN 1 AND 500),
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  section_title text,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS rag_chunks_document_index_idx
  ON rag_chunks (document_id, chunk_index);

CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw_idx
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);
