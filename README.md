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
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000/ui/root](http://localhost:3000/ui/root).

## Chat behavior

- The client uses AI SDK's `TextStreamChatTransport` and the API route streams plain text from Groq.
- The API route converts incoming UI messages to model messages before generation.
- You can stop an in-progress response; the request's abort signal is forwarded to the model stream.
- The route currently uses `openai/gpt-oss-120b` and the default assistant prompt in `lib/prompts.ts`.
- Message persistence is a mock: lifecycle hooks log completed or cancelled assistant responses to the server console. No database is configured.

## Validation

```bash
npm run lint
npx tsc --noEmit
```