import { Pool } from "pg";

let pool: Pool | undefined;

export function getDatabasePool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      (process.env.NODE_ENV === "production"
        ? undefined
        : "postgresql://postgres:postgres@localhost:5432/rag_db");

    pool = connectionString
      ? new Pool({ connectionString, max: 5 })
      : new Pool({ max: 5 });
  }

  return pool;
}
