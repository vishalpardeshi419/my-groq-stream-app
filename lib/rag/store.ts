import "server-only";

import { getDatabasePool } from "@/lib/database";
import {
  RAG_EMBEDDING_DIMENSIONS,
  RAG_EMBEDDING_MODEL,
  RAG_MAX_SEARCH_RESULTS,
} from "./constants";
import type { DocumentChunk } from "./chunking";

function toVectorLiteral(vector: number[]) {
  return `[${vector.join(",")}]`;
}

export async function findDocumentByHash(userId: string, sha256: string) {
  const result = await getDatabasePool().query<{
    id: string;
    chunk_count: number;
  }>(
    `SELECT documents.id, count(chunks.id)::integer AS chunk_count
     FROM rag_documents AS documents
     LEFT JOIN rag_chunks AS chunks
       ON chunks.document_id = documents.id
     WHERE documents.user_id = $1 AND documents.sha256 = $2
     GROUP BY documents.id`,
    [userId, sha256],
  );
  return result.rows[0] ?? null;
}

export async function saveDocumentChunks(input: {
  userId: string;
  sourceFile: string;
  mimeType: string;
  sha256: string;
  chunks: DocumentChunk[];
  embeddings: number[][];
}) {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error("Each document chunk must have one embedding.");
  }
  if (
    input.embeddings.some(
      (embedding) =>
        embedding.length !== RAG_EMBEDDING_DIMENSIONS ||
        embedding.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Document embeddings have an invalid vector shape.");
  }

  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO rag_documents
         (user_id, source_file, mime_type, sha256, embedding_model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, sha256) DO NOTHING
       RETURNING id, created_at`,
      [
        input.userId,
        input.sourceFile,
        input.mimeType,
        input.sha256,
        RAG_EMBEDDING_MODEL,
      ],
    );

    const document = inserted.rows[0];
    if (!document) {
      const existing = await client.query<{
        id: string;
        created_at: Date;
        chunk_count: number;
      }>(
        `SELECT documents.id, documents.created_at,
                count(chunks.id)::integer AS chunk_count
         FROM rag_documents AS documents
         LEFT JOIN rag_chunks AS chunks
           ON chunks.document_id = documents.id
         WHERE documents.user_id = $1 AND documents.sha256 = $2
         GROUP BY documents.id`,
        [input.userId, input.sha256],
      );
      if (!existing.rows[0]) {
        throw new Error("The duplicate document could not be loaded.");
      }
      await client.query("COMMIT");
      return {
        documentId: existing.rows[0].id,
        createdAt: existing.rows[0].created_at,
        duplicate: true,
        chunkCount: existing.rows[0].chunk_count,
      };
    }

    const values: unknown[] = [];
    const placeholders = input.chunks.map((chunk, index) => {
      const offset = index * 7;
      values.push(
        document.id,
        chunk.chunkIndex,
        chunk.text,
        chunk.tokenCount,
        chunk.pageNumber,
        chunk.sectionTitle,
        toVectorLiteral(input.embeddings[index]),
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector)`;
    });

    const savedChunks = await client.query<{
      id: string;
      chunk_index: number;
    }>(
      `INSERT INTO rag_chunks
         (document_id, chunk_index, content, token_count, page_number, section_title, embedding)
       VALUES ${placeholders.join(", ")}
       RETURNING id, chunk_index`,
      values,
    );
    await client.query("COMMIT");

    return {
      documentId: document.id,
      createdAt: document.created_at,
      duplicate: false,
      chunkCount: savedChunks.rows.length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function searchDocumentChunks(input: {
  userId: string;
  embedding: number[];
  topK: number;
}) {
  const topK = Math.min(
    Math.max(Math.trunc(input.topK), 1),
    RAG_MAX_SEARCH_RESULTS,
  );
  const vector = toVectorLiteral(input.embedding);
  const result = await getDatabasePool().query<{
    chunk_id: string;
    document_id: string;
    source_file: string;
    page_number: number | null;
    section_title: string | null;
    content: string;
    token_count: number;
    similarity: number;
  }>(
    `SELECT
       chunks.id AS chunk_id,
       documents.id AS document_id,
       documents.source_file,
       chunks.page_number,
       chunks.section_title,
       chunks.content,
       chunks.token_count,
       1 - (chunks.embedding <=> $1::vector) AS similarity
     FROM rag_chunks AS chunks
     INNER JOIN rag_documents AS documents
       ON documents.id = chunks.document_id
     WHERE documents.user_id = $2
       AND documents.embedding_model = $3
     ORDER BY chunks.embedding <=> $1::vector
     LIMIT $4`,
    [vector, input.userId, RAG_EMBEDDING_MODEL, topK],
  );

  return result.rows;
}
