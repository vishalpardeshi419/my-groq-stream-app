import { spawnSync } from "node:child_process";

const containerName = "pgvector-db";
const databaseStartupTimeoutMs = 90_000;

function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Docker ${args[0]} failed${details ? `: ${details}` : "."}`,
    );
  }
  return result.stdout.trim();
}

function isDockerReady() {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureDockerDaemon() {
  const cliCheck = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (cliCheck.error || cliCheck.status !== 0) {
    throw new Error("Docker CLI is not installed or is not available on PATH.");
  }

  if (isDockerReady()) return;

  if (process.platform !== "darwin") {
    throw new Error(
      "Docker is installed but its daemon is not running. Start Docker, then rerun npm run dev.",
    );
  }

  console.log("Starting Docker Desktop...");
  const openResult = spawnSync("open", ["-a", "Docker"], { stdio: "inherit" });
  if (openResult.error || openResult.status !== 0) {
    throw new Error("Could not start Docker Desktop.");
  }

  const deadline = Date.now() + databaseStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (isDockerReady()) return;
    await delay(1_000);
  }

  throw new Error("Docker Desktop did not become ready within 90 seconds.");
}

async function ensureDatabase() {
  const existingContainer = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", containerName],
    { encoding: "utf8" },
  );

  if (existingContainer.error) throw existingContainer.error;

  if (existingContainer.status !== 0) {
    console.log("Creating the pgvector database container...");
    runDocker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_PASSWORD=postgres",
      "--env",
      "POSTGRES_DB=rag_db",
      "--publish",
      "5432:5432",
      "ankane/pgvector",
    ]);
  } else if (existingContainer.stdout.trim() !== "true") {
    console.log("Starting the pgvector database container...");
    runDocker(["start", containerName]);
  }

  console.log("Waiting for the pgvector database to accept connections...");
  const deadline = Date.now() + databaseStartupTimeoutMs;
  while (Date.now() < deadline) {
    const readiness = spawnSync(
      "docker",
      [
        "exec",
        containerName,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "rag_db",
      ],
      { stdio: "ignore" },
    );
    if (readiness.error) throw readiness.error;
    if (readiness.status === 0) {
      console.log("pgvector database is ready.");
      return;
    }
    await delay(1_000);
  }

  throw new Error(
    "pgvector database did not become ready within 90 seconds. Check `docker logs pgvector-db`.",
  );
}

try {
  await ensureDockerDaemon();
  await ensureDatabase();
} catch (error) {
  console.error(
    `Unable to prepare the development database: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
