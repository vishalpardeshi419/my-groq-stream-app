# Worktree recap

This recap describes the current uncommitted changes relative to `HEAD`.

## What was added

- A PDF question-answering path alongside regular Groq chat. The chat page defaults to using the PDF knowledge base, displays Markdown-formatted assistant answers and retrieved source chunks, and allows the knowledge base to be switched off.
- Local PDF ingestion in [scripts/ingest.ts](./scripts/ingest.ts): extracts PDF text, chunks it to fit the embedding model, generates normalized 384-dimensional MiniLM embeddings on CPU, and upserts the chunks into PostgreSQL with pgvector.
- Hybrid retrieval in [lib/knowledge-base.ts](./lib/knowledge-base.ts): generates a local query embedding, combines vector and PostgreSQL full-text results with Reciprocal Rank Fusion, and returns the highest-ranked chunks.
- A terminal question/answer flow in [scripts/query.ts](./scripts/query.ts) and full-text index setup in [scripts/setup-hybrid-search.ts](./scripts/setup-hybrid-search.ts).
- Two PDF assets under `app/data/`, including the default `javascript.pdf`.
- README setup instructions and npm commands for ingesting and querying PDFs.

## Key behavior

- `/ui/root` can answer from retrieved PDF context with citations and a displayed source list, or use ordinary Groq chat when the checkbox is unchecked.
- Retrieval errors are returned explicitly; an empty knowledge base prompts the user to ingest a PDF.
- Embeddings run locally after the MiniLM model is downloaded. Groq is used to generate answers.
- PDF chunks and embeddings are stored in the `document_chunks` table. Search uses the table's vector and generated full-text (`tsv`) data.

## Diff at a glance

- `README.md`: +37 lines of PDF ingestion and RAG setup documentation, plus a project documentation link.
- `app/api/chat/route.ts`: adds knowledge-base retrieval, PDF-grounded prompting, error handling, and streamed source metadata.
- `app/ui/root/page.tsx`: adds the knowledge-base toggle, source display, and Markdown/GFM rendering.
- `package.json`: adds `ingest`, `query`, and `setup:hybrid-search` scripts plus PDF, PostgreSQL, local embedding, and Markdown dependencies.
- `package-lock.json`: updated to resolve the dependency changes.
- New files: `lib/knowledge-base.ts`, three scripts, two PDFs, `project.txt`, and `cmd's`.

## Running the PDF flow

1. Configure `GROQ_API_KEY` and `DATABASE_URL` in `.env.local`.
2. Start a PostgreSQL database with the pgvector extension.
3. Run `npm run ingest` (or pass a PDF path with `npm run ingest -- <path>`).
4. Run `npm run setup:hybrid-search`, then `npm run query -- "Your question"`.
5. Or start the app and ask from `/ui/root`.

**Database name caveat:** the `cmd's` Docker command creates a database named `rag_db`, while the README's example `DATABASE_URL` ends in `/postgres`. Set the URL's database name to match the database you actually run.

## Current status

These are worktree changes and have not been committed. No tests or build checks were run specifically while creating this recap.
