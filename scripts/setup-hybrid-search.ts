import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), true);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`
      ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx
      ON document_chunks USING gin(tsv)
    `);
    console.log("Full-text search is ready on document_chunks.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Hybrid search setup failed:", error);
  process.exitCode = 1;
});
