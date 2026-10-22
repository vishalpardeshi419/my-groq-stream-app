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
# Optional. Defaults to 120000 input tokens.
MAX_INPUT_TOKENS=120000
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000/ui/root](http://localhost:3000/ui/root).

## Chat behavior

- The client uses AI SDK's UI message stream to receive Groq responses and transient request metrics.
- The API route converts incoming UI messages to model messages before generation.
- You can stop an in-progress response; the request's abort signal is forwarded to the model stream.
- The route currently uses `openai/gpt-oss-120b` and the default assistant prompt in `lib/prompts.ts`.
- Message persistence is a mock: lifecycle hooks log completed or cancelled assistant responses to the server console. No database is configured.

## Token auditing

- Before sending a request, the API route counts the system prompt and text conversation history with the `gpt-oss-120b` tokenizer.
- Requests above `MAX_INPUT_TOKENS` are rejected with HTTP 413. The configured value is capped to leave room within the model context window for the response.
- Responses are limited to 4096 output tokens.
- The UI and server logs include the request timestamp, latency, estimated input tokens, and provider-reported input/output usage when available. Aborted or failed requests may not have final provider usage; their logs include an estimate of any partial text output.
- The current chat UI is text-only. The route rejects non-text content rather than silently undercounting images or files.

## Validation

```bash
npm run lint
npx tsc --noEmit
```