import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

loadEnvConfig(process.cwd());

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
  const database = spawnSync(
    process.execPath,
    ["scripts/ensure-pgvector.mjs"],
    { stdio: "inherit" },
  );
  if (database.error) throw database.error;
  if (database.status !== 0) {
    throw new Error("Unable to prepare the local PostgreSQL database.");
  }
}

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "production"
    ? undefined
    : "postgresql://postgres:postgres@localhost:5432/rag_db");

if (!connectionString) {
  throw new Error("DATABASE_URL must be configured before running migrations.");
}

const pool = new Pool({ connectionString, max: 1 });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationDirectory = join(process.cwd(), "migrations");
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  for (const version of migrationFiles) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "my-groq-stream-app-migrations",
      ]);
      const applied = await client.query(
        "SELECT 1 FROM app_schema_migrations WHERE version = $1",
        [version],
      );
      if (applied.rowCount) {
        await client.query("COMMIT");
        continue;
      }

      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO app_schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
      console.info(`Applied migration ${version}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate()
  .catch((error: unknown) => {
    console.error("Database migration failed.", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
