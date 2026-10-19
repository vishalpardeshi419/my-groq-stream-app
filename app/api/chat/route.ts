import { groq } from "@ai-sdk/groq";
import {
  convertToModelMessages,
  createTextStreamResponse,
  streamText,
  toTextStream,
  type UIMessage,
} from "ai";
import { SYSTEM_PROMPTS } from "@/lib/prompts";

export const maxDuration = 30; // Max execution time for serverless deployment

// Mock database helper to simulate saving messages
async function saveMessageToDatabase(data: {
  chatId: string;
  role: string;
  content: string;
  status: "completed" | "cancelled" | "failed";
}) {
  console.log(`\n[DATABASE SAVE] (${data.status.toUpperCase()}):`, data);
}

export async function POST(req: Request) {
  const { messages, chatId = "default-chat-id" }: {
    messages: UIMessage[];
    chatId?: string;
  } = await req.json();

  let partialResponse = ""; // Accumulates tokens as they arrive

  const result = streamText({
    model: groq("openai/gpt-oss-120b"),
    
    system: SYSTEM_PROMPTS.defaultAssistant,
    messages: await convertToModelMessages(messages),
    
    // 1. CANCELLATION: Automatically forwards user's AbortController signal
    abortSignal: req.signal,

    // Stream lifecycle hooks
    onChunk({ chunk }) {
      if (chunk.type === "text-delta") {
        partialResponse += chunk.text;
      }
    },

    // 2. NORMAL COMPLETION: Executed when the stream completes fully
    async onFinish({ text }) {
      await saveMessageToDatabase({
        chatId,
        role: "assistant",
        content: text,
        status: "completed",
      });
    },

    // 3. ABORT HANDLING: Executed if user cancels mid-generation
    async onAbort() {
      if (partialResponse.trim()) {
        await saveMessageToDatabase({
          chatId,
          role: "assistant",
          content: `${partialResponse} [Generation stopped by user]`,
          status: "cancelled",
        });
      }
    },

    // 4. FAILURE HANDLING: Network drop / unexpected errors
    onError(error) {
      console.error("Groq Stream Error:", error);
    },
  });

  return createTextStreamResponse({
    stream: toTextStream({ stream: result.stream }),
  });
}