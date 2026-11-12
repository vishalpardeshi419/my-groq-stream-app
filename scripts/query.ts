import { loadEnvConfig } from "@next/env";
import Groq from "groq-sdk";
import { searchRelevantChunks } from "../lib/knowledge-base";

const GROQ_MODEL = "openai/gpt-oss-120b";
const RESULT_LIMIT = 5;
const DEFAULT_QUESTION = "What are closures in JavaScript?";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), true);

  const question = process.argv.slice(2).join(" ").trim() || DEFAULT_QUESTION;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is required.");

  console.log(`\nQuestion: "${question}"`);
  console.log("Running hybrid vector + keyword search...");
  const chunks = await searchRelevantChunks(question, RESULT_LIMIT);
  console.log(`Retrieved ${chunks.length} chunks via RRF fusion.`);

  if (chunks.length === 0) {
    console.log("No document chunks found. Run `npm run ingest` first.");
    return;
  }

  const context = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] (Source: ${chunk.source}, Chunk #${chunk.chunk_index})\n${chunk.content}`,
    )
    .join("\n\n");

  console.log("Generating response with Groq...");
  const groq = new Groq({ apiKey });
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content:
          'You are a precise technical assistant. Answer the user using only the provided context. Cite chunk IDs such as [1] next to each factual claim. If the context does not contain the answer, say: "I don\'t know based on the provided documents."',
      },
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.1,
  });

  console.log("\n--- Answer ---");
  console.log(
    completion.choices[0]?.message.content ?? "Groq returned an empty response.",
  );
  console.log("\n--- Retrieved Sources ---");
  chunks.forEach((chunk, index) => {
    console.log(
      `[${index + 1}] ${chunk.source} (chunk ${chunk.chunk_index}, RRF score: ${Number(chunk.rrf_score).toFixed(4)})`,
    );
  });
}

main().catch((error: unknown) => {
  console.error("RAG query failed:", error);
  process.exitCode = 1;
});
