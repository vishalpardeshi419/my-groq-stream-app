import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { embedDocuments } from "../lib/rag/embedding-runtime";
import {
  RAG_EMBEDDING_DIMENSIONS,
  RAG_EMBEDDING_MODEL,
} from "../lib/rag/constants";

loadEnvConfig(process.cwd());

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "production"
    ? undefined
    : "postgresql://postgres:postgres@localhost:5432/rag_db");

if (!connectionString) {
  throw new Error("DATABASE_URL must be configured before re-embedding documents.");
}

const pool = new Pool({ connectionString, max: 1 });

function toVectorLiteral(vector: number[]) {
  if (
    vector.length !== RAG_EMBEDDING_DIMENSIONS ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Gemini returned an invalid embedding vector.");
  }
  return `[${vector.join(",")}]`;
}

async function reembedDocuments() {
  const { rows: documents } = await pool.query<{ id: string }>(
    `SELECT documents.id
     FROM rag_documents AS documents
     WHERE documents.embedding_model <> $1
        OR EXISTS (
          SELECT 1
          FROM rag_chunks AS chunks
          WHERE chunks.document_id = documents.id
            AND chunks.embedding IS NULL
        )
     ORDER BY documents.id`,
    [RAG_EMBEDDING_MODEL],
  );

  for (const [index, document] of documents.entries()) {
    const { rows: chunks } = await pool.query<{
      id: string;
      content: string;
    }>(
      `SELECT id, content
       FROM rag_chunks
       WHERE document_id = $1
       ORDER BY chunk_index`,
      [document.id],
    );
    const embeddings = await embedDocuments(
      chunks.map((chunk) => chunk.content),
    );
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch for document ${document.id}.`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [chunkIndex, chunk] of chunks.entries()) {
        await client.query(
          `UPDATE rag_chunks
           SET embedding = $2::vector
           WHERE id = $1 AND document_id = $3`,
          [
            chunk.id,
            toVectorLiteral(embeddings[chunkIndex]),
            document.id,
          ],
        );
      }
      await client.query(
        `UPDATE rag_documents
         SET embedding_model = $2
         WHERE id = $1`,
        [document.id, RAG_EMBEDDING_MODEL],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    console.info(
      `Re-embedded document ${index + 1}/${documents.length} (${chunks.length} chunks).`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "LOCK TABLE rag_documents, rag_chunks IN ACCESS EXCLUSIVE MODE",
    );
    const remaining = await client.query<{
      outdated_documents: string;
      missing_embeddings: string;
    }>(
      `SELECT
         (SELECT count(*) FROM rag_documents
          WHERE embedding_model <> $1)::text AS outdated_documents,
         (SELECT count(*) FROM rag_chunks
          WHERE embedding IS NULL)::text AS missing_embeddings`,
      [RAG_EMBEDDING_MODEL],
    );
    const state = remaining.rows[0];
    if (
      !state ||
      Number(state.outdated_documents) > 0 ||
      Number(state.missing_embeddings) > 0
    ) {
      throw new Error(
        "Re-embedding is incomplete; the original vectors have been retained.",
      );
    }

    await client.query(
      `ALTER TABLE rag_chunks
       ALTER COLUMN embedding SET NOT NULL`,
    );
    await client.query(
      `ALTER TABLE rag_chunks
       DROP COLUMN IF EXISTS embedding_1536`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.info(
    `Re-embedded ${documents.length} documents and finalized ${RAG_EMBEDDING_DIMENSIONS}-dimension vectors.`,
  );
}

reembedDocuments()
  .catch((error: unknown) => {
    console.error("Document re-embedding failed.", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
