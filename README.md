# Groq Streaming Chat

A Next.js chat UI powered by Groq and the AI SDK. The chat interface is available at `/ui/root`; the root route (`/`) is still the default Next.js starter page.


## confluence 
- https://vpardeshi419.atlassian.net/wiki/spaces/~5ecf824d8d2e220c254b41c2/pages/131109/Groq+Chat+Application+Implementation+Summary

## Requirements

- Node.js 22 or newer
- A Groq API key with access to `openai/gpt-oss-120b`

## Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` in the project root and add your Groq API key:

```env
GROQ_API_KEY=your_groq_api_key
OPENWEATHER_API_KEY=your_openweather_api_key
# Optional. Defaults to 120000 input tokens.
MAX_INPUT_TOKENS=120000
# Optional. Enables raw prompt and response logging; keep disabled in production by default.
LLM_LOG_CONTENT=false
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000/ui/root](http://localhost:3000/ui/root).
Open [http://localhost:3000/logs](http://localhost:3000/logs) to view development runtime logs.

## PDF ingestion

The ingestion script reads `data/javascript.pdf` by default (or `app/data/javascript.pdf` if that is where the file is stored), chunks its text by paragraph into at most 180 tokenizer-estimated tokens to fit the local MiniLM model's input limit, generates normalized 384-dimensional embeddings on the CPU, and upserts them into a local PostgreSQL database with the pgvector extension. The model is downloaded from Hugging Face on first use; embedding generation then runs locally without an API key. `GROQ_API_KEY` is only used by chat.

Add the database connection string to `.env.local`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

Run the script after starting your local pgvector Docker database:

```bash
npm run ingest
# Or pass a different PDF path:
npm run ingest -- ./data/another-document.pdf
```

The script creates a `document_chunks` table if needed, plus the generated `tsv` column and its GIN index for hybrid search. Re-running it for the same PDF source updates existing chunks and removes stale trailing chunks. An empty table with an older vector dimension is updated automatically; a populated table with incompatible embeddings is left untouched and must be re-embedded or backed up and recreated before ingestion. When using local embeddings for search, generate query vectors with this same model.

## Terminal RAG query

After ingesting a PDF, prepare PostgreSQL full-text search once and ask a question against the stored chunks using hybrid vector + keyword search:

```bash
npm run setup:hybrid-search
npm run query -- "What are closures in JavaScript?"
```

The setup command adds full-text search to this app's `document_chunks` table. The SQL from the previous step uses a separate `chunks` table, so it will not enable full-text search for this app. The query script uses `GROQ_API_KEY` and `DATABASE_URL` from `.env.local`, combines the top 20 vector and keyword results with Reciprocal Rank Fusion (RRF), then prints an answer with chunk citations and retrieved sources. If no question is supplied, it defaults to `What are closures in JavaScript?`.

The same retrieval is available in the chat UI at `/ui/root`. Leave **Use PDF knowledge base** checked to answer from the ingested PDF and see the retrieved source chunks; uncheck it for regular Groq chat.

## Chat behavior

- The client uses AI SDK's UI message stream to receive Groq responses and transient request metrics.
- The API route converts incoming UI messages to model messages before generation.
- You can stop an in-progress response; the request's abort signal is forwarded to the model stream.
- The route currently uses `openai/gpt-oss-120b` and the default assistant prompt in `lib/prompts.ts`.
- `lib/llm.ts` centralizes the Groq model, output-token limit, SDK call, and LLM lifecycle logging.
- The model can call `get_weather` for current conditions from OpenWeather and `get_recent_usage` for recent usage metrics from the current chat's development logs.
- Tool execution is limited to five model steps per request. Tool failures are returned to the model as structured results so it can explain the issue.
- Message persistence is a mock: lifecycle hooks log completed or cancelled assistant responses to the server console. No database is configured.

## Token auditing

- Before sending a request, the API route estimates input usage from the system prompt, text/reasoning/tool history, serialized tool schemas, and a 1,024-token safety reserve using the `gpt-oss-120b` tokenizer. Provider-reported usage remains authoritative.
- Requests above `MAX_INPUT_TOKENS` are rejected with HTTP 413. The configured value is capped to leave room within the model context window for the response.
- Responses are limited to 4096 output tokens.
- The UI and server logs include the request timestamp, latency, estimated input tokens, and provider-reported input/output usage when available. Aborted or failed requests may not have final provider usage; their logs include an estimate of any partial text output.
- The current chat UI is text-only. The route rejects non-text content rather than silently undercounting images or files.

## Structured LLM logs

The server emits one JSON object per event, correlated with a request ID. Event names include `llm.request.started`, `llm.response.completed`, `llm.response.aborted`, `llm.response.failed`, `llm.request.metrics`, and `llm.tool.call` / `llm.tool.result` / `llm.tool.error` when tools are configured.

Prompt, message, tool input/output, and response contents are redacted by default. Set `LLM_LOG_CONTENT=true` only in a controlled development environment when raw content is necessary for debugging; logs can contain sensitive user data.

The `/logs` page reads from a development-only in-memory buffer that retains the latest 500 events. Logs are cleared when the server restarts and are not available in production. The `get_recent_usage` tool reads token and latency metrics from this same buffer. Use a database or external log service if logs must persist across restarts or deployments.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
```