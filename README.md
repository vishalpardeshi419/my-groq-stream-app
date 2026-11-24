# Groq Streaming Chat

A Next.js chat UI powered by Groq and the AI SDK. The chat interface is available at `/ui/root`; the root route (`/`) is still the default Next.js starter page.

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
# Optional. Enables cross-provider fallback after Groq transient failures.
OPENAI_API_KEY=your_openai_api_key
# Optional. Defaults to gpt-4.1-mini when OPENAI_API_KEY is set.
OPENAI_FALLBACK_MODEL=gpt-4.1-mini
# Optional. Defaults to 120000 input tokens.
MAX_INPUT_TOKENS=120000
# Optional. Enables raw prompt and response logging; keep disabled in production by default.
LLM_LOG_CONTENT=false
# Optional chaos switches; uncomment only for controlled local testing.
# AGENT_FAULT_MODE=timeout
# AGENT_FAULT_RATE=0.5
# LLM_FAULT_MODE=http-500
# LLM_FAULT_RATE=0.5
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000/ui/root](http://localhost:3000/ui/root).
Open [http://localhost:3000/logs](http://localhost:3000/logs) to view development runtime logs.

## Chat behavior

- The client uses AI SDK's UI message stream to receive Groq responses and transient request metrics.
- The API route converts incoming UI messages to model messages before generation.
- You can stop an in-progress response; the request's abort signal is forwarded to the model stream.
- The route currently uses `openai/gpt-oss-120b` and the default assistant prompt in `lib/prompts.ts`.
- `lib/llm.ts` centralizes the Groq model, optional OpenAI fallback, output-token limit, retry policy, SDK call, and LLM lifecycle logging.
- The model can call `get_weather` for current conditions from OpenWeather and `get_recent_usage` for recent usage metrics from the current chat's development logs. It can execute up to five calls concurrently in a step.
- The assistant gives a brief user-facing plan before tool work and adapts its next action to each result without exposing private chain-of-thought. Exact repeated tool calls are not re-executed; the prior result and a request to try another approach are returned to the model.
- Tool calls have an 8-second timeout, at most two retries for explicitly retryable failures, exponential backoff with jitter, and a 2,048-token output cap. Retry, timeout, failure, and compaction decisions are logged as structured events. Refund execution is never automatically retried and remains behind the explicit approval gate.
- The model naturally ends when the task is complete; execution also has an eight-step limit, a cumulative 200,000-token cap (including approval pauses), and a 25-second wall-clock limit. Limit stops preserve partial output and append a clear explanation.
- Groq transient failures (429, 5xx, timeouts, and selected network errors) are retried twice with backoff and jitter. If `OPENAI_API_KEY` is configured, persistent transient errors fall back to the configured OpenAI model using the same normalized messages and tool schemas. Without that key, the request returns a sanitized error rather than provider internals.
- Invalid tool names and arguments are converted into a bounded correction result. The model gets at most two correction attempts; the second correction tells it to stop and explain the issue.
- Chat history, pending approvals, step counts, and cumulative run-token totals persist in the PostgreSQL `chat_agent_sessions` table. `DATABASE_URL` is required in production; development defaults to the local `rag_db` database. A separate lifecycle hook logs completed or cancelled assistant responses but does not write a second message table.

## Token auditing

- Before sending a request, the API route estimates input usage from the system prompt, text/reasoning/tool history, serialized tool schemas, and a 1,024-token safety reserve using the `gpt-oss-120b` tokenizer. Provider-reported usage remains authoritative.
- Requests above `MAX_INPUT_TOKENS` are rejected with HTTP 413. The configured value is capped to leave room within the model context window for the response.
- Responses are limited to 4096 output tokens.
- Tool results are capped before entering the model context. Older tool results are compacted while the most recent four messages are retained.
- The UI and server logs include the request timestamp, latency, estimated input tokens, and provider-reported input/output usage when available. Aborted or failed requests may not have final provider usage; their logs include an estimate of any partial text output.
- The current chat UI is text-only. The route rejects non-text content rather than silently undercounting images or files.

## Structured LLM logs

The server emits one JSON object per event, correlated with a request ID. Event names include `llm.request.started`, `llm.response.completed`, `llm.response.aborted`, `llm.response.failed`, `llm.request.metrics`, and `llm.tool.call` / `llm.tool.result` / `llm.tool.error` when tools are configured.

Prompt, message, tool input/output, and response contents are redacted by default. Set `LLM_LOG_CONTENT=true` only in a controlled development environment when raw content is necessary for debugging; logs can contain sensitive user data.

The `/logs` page reads from a development-only in-memory buffer that retains the latest 500 events. Logs are cleared when the server restarts and are not available in production. The `get_recent_usage` tool reads token and latency metrics from this same buffer. Use a database or external log service if logs must persist across restarts or deployments.

## Day 21 chaos testing

The tool fault injector is disabled unless both `AGENT_FAULT_MODE` and a rate between `0` and `1` are set. Supported modes are `timeout`, `http-500`, and `bloated-output`. The provider injector uses `LLM_FAULT_MODE=http-500` or `rate-limit` with `LLM_FAULT_RATE`; a configured OpenAI key exercises cross-provider fallback. These switches are for controlled local tests only.

The repository did not contain a reusable Day 18 ten-task runner, so `tests/agent-chaos.test.ts` adds a deterministic ten-scenario regression set covering the existing tools, oversized results, injected failures, and both approval decisions. The tests use fake failures and do not call live model or weather APIs.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
```