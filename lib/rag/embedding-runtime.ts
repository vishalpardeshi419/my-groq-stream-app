import {
  layer_norm,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import {
  RAG_EMBEDDING_DIMENSIONS,
  RAG_EMBEDDING_MODEL,
} from "./constants";

const EMBEDDING_BATCH_SIZE = 8;
const POOLING_OPTIONS = { pooling: "mean" as const };

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor() {
  if (!extractorPromise) {
    const loading = pipeline(
      "feature-extraction",
      RAG_EMBEDDING_MODEL,
      { dtype: "q8" },
    ).catch((error: unknown) => {
      if (extractorPromise === loading) extractorPromise = null;
      throw error;
    });
    extractorPromise = loading;
  }
  return extractorPromise;
}

async function embedBatch(texts: string[], prefix: string) {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const output = await extractor(
    texts.map((text) => `${prefix}: ${text}`),
    POOLING_OPTIONS,
  );
  if (
    output.dims.length !== 2 ||
    output.dims[0] !== texts.length ||
    output.dims[1] !== RAG_EMBEDDING_DIMENSIONS
  ) {
    throw new Error("The local embedding model returned an unexpected shape.");
  }

  const normalized = layer_norm(output, [RAG_EMBEDDING_DIMENSIONS]).normalize(
    2,
    -1,
  );
  const values = Array.from(normalized.data);
  if (
    values.length !== texts.length * RAG_EMBEDDING_DIMENSIONS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("The local embedding model returned invalid values.");
  }

  return Array.from({ length: texts.length }, (_, index) =>
    values.slice(
      index * RAG_EMBEDDING_DIMENSIONS,
      (index + 1) * RAG_EMBEDDING_DIMENSIONS,
    ),
  );
}

export async function embedDocument(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], "search_document");
  if (!embedding) throw new Error("The local embedding model returned no vector.");
  return embedding;
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
    embeddings.push(
      ...(await embedBatch(
        texts.slice(offset, offset + EMBEDDING_BATCH_SIZE),
        "search_document",
      )),
    );
  }
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], "search_query");
  if (!embedding) throw new Error("The local embedding model returned no vector.");
  return embedding;
}
