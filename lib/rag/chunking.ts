import {
  decode,
  encode,
} from "gpt-tokenizer/encoding/cl100k_base";
import {
  RAG_CHUNK_OVERLAP_TOKENS,
  RAG_CHUNK_SIZE_TOKENS,
} from "./constants";

const TOKENIZER_OPTIONS = { disallowedSpecial: new Set<string>() };

export type DocumentSection = {
  text: string;
  pageNumber: number | null;
  sectionTitle: string | null;
};

export type DocumentChunk = DocumentSection & {
  chunkIndex: number;
  tokenCount: number;
};

export function countDocumentTokens(sections: DocumentSection[]) {
  return sections.reduce(
    (total, section) =>
      total + encode(section.text, TOKENIZER_OPTIONS).length,
    0,
  );
}

export function chunkDocumentSections(sections: DocumentSection[]) {
  const chunks: DocumentChunk[] = [];

  for (const section of sections) {
    const tokens = encode(section.text, TOKENIZER_OPTIONS);
    for (let start = 0; start < tokens.length; ) {
      const end = Math.min(start + RAG_CHUNK_SIZE_TOKENS, tokens.length);
      const text = decode(tokens.slice(start, end)).trim();

      if (text) {
        chunks.push({
          chunkIndex: chunks.length,
          text,
          pageNumber: section.pageNumber,
          sectionTitle: section.sectionTitle,
          tokenCount: end - start,
        });
      }

      if (end === tokens.length) break;
      start = end - RAG_CHUNK_OVERLAP_TOKENS;
    }
  }

  return chunks;
}
