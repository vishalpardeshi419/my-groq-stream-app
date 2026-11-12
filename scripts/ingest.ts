import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { pipeline } from "@huggingface/transformers";
import { PDFParse } from "pdf-parse";
import { Pool } from "pg";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";

const MAX_CHUNK_TOKENS = 180;
const TARGET_CHUNK_TOKENS = 160;
const EMBEDDING_BATCH_SIZE = 16;
const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
const EMBEDDING_DIMENSIONS = 384;

function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/u);
  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (countTokens(sentence) > MAX_CHUNK_TOKENS) {
      if (current) {
        parts.push(current);
        current = "";
      }

      let wordPart = "";
      for (const word of sentence.split(/\s+/u)) {
        const candidate = wordPart ? `${wordPart} ${word}` : word;
        if (countTokens(candidate) > MAX_CHUNK_TOKENS) {
          if (!wordPart) {
            throw new Error("A single word exceeds the maximum chunk token count.");
          }
          parts.push(wordPart);
          wordPart = word;
        } else {
          wordPart = candidate;
        }
      }
      if (wordPart) parts.push(wordPart);
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && countTokens(candidate) > MAX_CHUNK_TOKENS) {
      parts.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current) parts.push(current);
  return parts;
}

export function chunkText(text: string): Array<{ content: string; tokenCount: number }> {
  const paragraphs = text
    .replace(/\f/gu, "\n\n")
    .replace(/\r\n?/gu, "\n")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/gu, " ").trim())
    .filter(Boolean);

  const chunks: Array<{ content: string; tokenCount: number }> = [];
  let current = "";

  const flush = () => {
    if (!current) return;
    chunks.push({ content: current, tokenCount: countTokens(current) });
    current = "";
  };

  for (const paragraph of paragraphs) {
    const units =
      countTokens(paragraph) > MAX_CHUNK_TOKENS
        ? splitLongParagraph(paragraph)
        : [paragraph];

    for (const unit of units) {
      const candidate = current ? `${current}\n\n${unit}` : unit;
      if (current && countTokens(candidate) > MAX_CHUNK_TOKENS) flush();
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  flush();

  const last = chunks.at(-1);
  const previous = chunks.at(-2);
  const mergedContent =
    last && previous ? `${previous.content}\n\n${last.content}` : "";
  if (
    last &&
    previous &&
    last.tokenCount < TARGET_CHUNK_TOKENS - 40 &&
    countTokens(mergedContent) <= MAX_CHUNK_TOKENS
  ) {
    previous.content = mergedContent;
    previous.tokenCount = countTokens(previous.content);
    chunks.pop();
  }

  return chunks;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolvePdfPath(argument?: string): Promise<string> {
  if (argument) return resolve(process.cwd(), argument);

  const candidates = [
    resolve(process.cwd(), "data/javascript.pdf"),
    resolve(process.cwd(), "app/data/javascript.pdf"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  throw new Error(
    "PDF not found. Place it at data/javascript.pdf or pass a PDF path as an argument.",
  );
}

async function extractPdfText(pdfPath: string): Promise<string> {
  const parser = new PDFParse({ data: await readFile(pdfPath) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id text PRIMARY KEY,
      source text NOT NULL,
      chunk_index integer NOT NULL CHECK (chunk_index >= 0),
      content text NOT NULL,
      token_count integer NOT NULL CHECK (token_count > 0),
      embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source, chunk_index)
    )
  `);
  await pool.query(`
    ALTER TABLE document_chunks
    ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx
    ON document_chunks USING gin(tsv)
  `);

  const { rows } = await pool.query<{ dimensions: number }>(`
    SELECT atttypmod - 4 AS dimensions
    FROM pg_attribute
    WHERE attrelid = 'document_chunks'::regclass
      AND attname = 'embedding'
      AND attnum > 0
      AND NOT attisdropped
  `);
  const dimensions = rows[0]?.dimensions;
  if (dimensions === undefined) {
    throw new Error("The document_chunks table is missing its embedding column.");
  }
  if (dimensions === EMBEDDING_DIMENSIONS) return;

  const { rows: existingRows } = await pool.query<{ has_rows: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM document_chunks) AS has_rows",
  );
  if (existingRows[0]?.has_rows) {
    throw new Error(
      `document_chunks contains ${dimensions}-dimensional embeddings. ` +
      `${EMBEDDING_MODEL} requires ${EMBEDDING_DIMENSIONS} dimensions; re-embed or back up and recreate the table before ingesting.`,
    );
  }

  await pool.query(`
    ALTER TABLE document_chunks
    ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIMENSIONS})
    USING NULL::vector(${EMBEDDING_DIMENSIONS})
  `);
}

async function createEmbeddings(
  chunks: Array<{ content: string; tokenCount: number }>,
): Promise<number[][]> {
  const embeddings: number[][] = [];
  console.log(`Loading local embedding model ${EMBEDDING_MODEL} on CPU...`);
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    device: "cpu",
  });

  try {
    for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
      const output = await extractor(
        batch.map(({ content }) => content),
        { pooling: "mean", normalize: true },
      );

      try {
        const [embeddingCount, dimensions] = output.dims;
        if (
          embeddingCount !== batch.length ||
          dimensions !== EMBEDDING_DIMENSIONS ||
          !(output.data instanceof Float32Array)
        ) {
          throw new Error("The local embedding model returned an unexpected response shape.");
        }

        for (let index = 0; index < batch.length; index += 1) {
          const startIndex = index * EMBEDDING_DIMENSIONS;
          embeddings.push(
            Array.from(output.data.slice(startIndex, startIndex + EMBEDDING_DIMENSIONS)),
          );
        }
      } finally {
        output.dispose();
      }

      console.log(
        `Created embeddings for ${Math.min(start + batch.length, chunks.length)} / ${chunks.length} chunks.`,
      );
    }
  } finally {
    await extractor.dispose();
  }

  return embeddings;
}

async function saveChunks(
  pool: Pool,
  source: string,
  chunks: Array<{ content: string; tokenCount: number }>,
  embeddings: number[][],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const embedding = embeddings[index];
      const id = createHash("sha256")
        .update(`${source}\0${index}`)
        .digest("hex");

      await client.query(
        `
          INSERT INTO document_chunks
            (id, source, chunk_index, content, token_count, embedding)
          VALUES ($1, $2, $3, $4, $5, $6::vector)
          ON CONFLICT (source, chunk_index) DO UPDATE SET
            id = EXCLUDED.id,
            content = EXCLUDED.content,
            token_count = EXCLUDED.token_count,
            embedding = EXCLUDED.embedding,
            updated_at = now()
        `,
        [
          id,
          source,
          index,
          chunk.content,
          chunk.tokenCount,
          `[${embedding.join(",")}]`,
        ],
      );
    }

    await client.query(
      "DELETE FROM document_chunks WHERE source = $1 AND chunk_index >= $2",
      [source, chunks.length],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), true);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const pdfPath = await resolvePdfPath(process.argv[2]);
  const text = await extractPdfText(pdfPath);
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error(`No extractable text was found in ${basename(pdfPath)}.`);
  }

  const source = relative(process.cwd(), pdfPath).split(sep).join("/");
  const pool = new Pool({ connectionString });

  try {
    await ensureSchema(pool);
    const embeddings = await createEmbeddings(chunks);
    await saveChunks(pool, source, chunks, embeddings);
    console.log(`Ingested ${chunks.length} chunks from ${source}.`);
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error("PDF ingestion failed:", error);
    process.exitCode = 1;
  });
}
