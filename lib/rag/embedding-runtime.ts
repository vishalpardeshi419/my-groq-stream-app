import { GoogleGenAI } from "@google/genai";
import { RAG_EMBEDDING_DIMENSIONS, RAG_EMBEDDING_MODEL } from "./constants";

const EMBEDDING_BATCH_SIZE = 8;

type RetrievalTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

let client: GoogleGenAI | undefined;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY must be configured for document embeddings.");
  }

  client ??= new GoogleGenAI({ apiKey });
  return client;
}

export function normalizeEmbedding(vector: number[]) {
  if (
    vector.length !== RAG_EMBEDDING_DIMENSIONS ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Gemini returned an invalid embedding vector.");
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm)) {
    throw new Error("Gemini returned an invalid embedding norm.");
  }
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

async function embedBatch(
  texts: string[],
  taskType: RetrievalTaskType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await getGeminiClient().models.embedContent({
    model: RAG_EMBEDDING_MODEL,
    contents: texts,
    config: {
      taskType,
      outputDimensionality: RAG_EMBEDDING_DIMENSIONS,
    },
  });
  const embeddings = response.embeddings;
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error("Gemini returned an unexpected number of embeddings.");
  }

  return embeddings.map((embedding) => {
    if (!embedding.values) {
      throw new Error("Gemini returned an empty embedding.");
    }
    return normalizeEmbedding(embedding.values);
  });
}

export async function embedDocument(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], "RETRIEVAL_DOCUMENT");
  if (!embedding) throw new Error("Gemini returned no document embedding.");
  return embedding;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
    embeddings.push(
      ...(await embedBatch(
        texts.slice(offset, offset + EMBEDDING_BATCH_SIZE),
        "RETRIEVAL_DOCUMENT",
      )),
    );
  }
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], "RETRIEVAL_QUERY");
  if (!embedding) throw new Error("Gemini returned no query embedding.");
  return embedding;
}
