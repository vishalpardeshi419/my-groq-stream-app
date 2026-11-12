import { pipeline } from "@huggingface/transformers";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { Pool } from "pg";

const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
const EMBEDDING_DIMENSIONS = 384;
const MAX_QUERY_TOKENS = 180;
const CANDIDATE_LIMIT = 20;
const RRF_K = 60;

export interface RetrievedChunk {
  content: string;
  source: string;
  chunk_index: number;
  rrf_score: number;
}

async function createExtractor() {
  return pipeline("feature-extraction", EMBEDDING_MODEL, { device: "cpu" });
}

let extractorPromise: ReturnType<typeof createExtractor> | undefined;

async function getExtractor() {
  if (!extractorPromise) extractorPromise = createExtractor();

  try {
    return await extractorPromise;
  } catch (error) {
    extractorPromise = undefined;
    throw error;
  }
}

export async function searchRelevantChunks(
  question: string,
  limit = 5,
): Promise<RetrievedChunk[]> {
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) throw new Error("Enter a question to search the PDF.");
  if (countTokens(normalizedQuestion) > MAX_QUERY_TOKENS) {
    throw new Error(
      `Keep the question under ${MAX_QUERY_TOKENS} tokens for local embedding.`,
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const extractor = await getExtractor();
  const output = await extractor(normalizedQuestion, {
    pooling: "mean",
    normalize: true,
  });

  let vectorString: string;
  try {
    const [embeddingCount, dimensions] = output.dims;
    if (
      embeddingCount !== 1 ||
      dimensions !== EMBEDDING_DIMENSIONS ||
      !(output.data instanceof Float32Array)
    ) {
      throw new Error("The local embedding model returned an unexpected query vector.");
    }
    vectorString = `[${Array.from(output.data).join(",")}]`;
  } finally {
    output.dispose();
  }

  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query<RetrievedChunk>(
      `
        WITH vector_search AS (
          SELECT
            id,
            ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector, id) AS rank
          FROM document_chunks
          ORDER BY embedding <=> $1::vector, id
          LIMIT $4
        ),
        keyword_search AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $2)) DESC, id
            ) AS rank
          FROM document_chunks
          WHERE tsv @@ plainto_tsquery('english', $2)
          ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $2)) DESC, id
          LIMIT $4
        ),
        fused_ranks AS (
          SELECT id, 1.0 / ($3 + rank) AS score FROM vector_search
          UNION ALL
          SELECT id, 1.0 / ($3 + rank) AS score FROM keyword_search
        )
        SELECT
          document_chunks.content,
          document_chunks.source,
          document_chunks.chunk_index,
          SUM(fused_ranks.score) AS rrf_score
        FROM fused_ranks
        JOIN document_chunks USING (id)
        GROUP BY document_chunks.id
        ORDER BY rrf_score DESC, document_chunks.id
        LIMIT $5
      `,
      [vectorString, normalizedQuestion, RRF_K, CANDIDATE_LIMIT, limit],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}
