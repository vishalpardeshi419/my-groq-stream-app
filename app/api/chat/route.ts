import { groq } from "@ai-sdk/groq";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type UIMessage,
} from "ai";
import {
  countChatCompletionTokens,
  countTokens,
} from "gpt-tokenizer/model/gpt-oss-120b";
import type { ChatMessage } from "gpt-tokenizer/functionCalling";
import { SYSTEM_PROMPTS } from "@/lib/prompts";

export const maxDuration = 30; // Max execution time for serverless deployment

const MAX_OUTPUT_TOKENS = 4_096;
const MAX_CONTEXT_TOKENS = 131_072;
const DEFAULT_INPUT_TOKEN_BUDGET = 120_000;
const configuredInputTokenBudget = Number(
  process.env.MAX_INPUT_TOKENS ?? DEFAULT_INPUT_TOKEN_BUDGET,
);
const MAX_INPUT_TOKENS =
  Number.isInteger(configuredInputTokenBudget) && configuredInputTokenBudget > 0
    ? Math.min(
        configuredInputTokenBudget,
        MAX_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS,
      )
    : DEFAULT_INPUT_TOKEN_BUDGET;

function getTextContent(message: ModelMessage): string | null {
  if (typeof message.content === "string") return message.content;

  let text = "";
  for (const part of message.content) {
    if (part.type !== "text") return null;
    text += part.text;
  }
  return text;
}

function countInputTokens(messages: ModelMessage[]): number | null {
  const tokenMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPTS.defaultAssistant },
  ];

  for (const message of messages) {
    const content = getTextContent(message);
    if (content === null) return null;
    tokenMessages.push({ role: message.role, content });
  }

  if (!countChatCompletionTokens) {
    throw new Error("The gpt-oss tokenizer does not support chat token counts.");
  }

  return countChatCompletionTokens({ messages: tokenMessages });
}

function logRequestMetrics(data: {
  chatId: string;
  requestedAt: string;
  startedAt: number;
  estimatedInputTokens: number | null;
  status: "completed" | "aborted" | "failed" | "rejected";
  inputTokens?: number | null;
  outputTokens?: number | null;
  partialOutputTokenEstimate?: number;
}) {
  const metrics = {
    chatId: data.chatId,
    requestedAt: data.requestedAt,
    latencyMs: Date.now() - data.startedAt,
    status: data.status,
    estimatedInputTokens: data.estimatedInputTokens,
    inputTokens: data.inputTokens ?? null,
    outputTokens: data.outputTokens ?? null,
    partialOutputTokenEstimate: data.partialOutputTokenEstimate,
  };
  console.info("[TOKEN AUDIT]", metrics);
  return metrics;
}

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

  const startedAt = Date.now();
  const requestedAt = new Date(startedAt).toISOString();
  const modelMessages = await convertToModelMessages(messages);
  const estimatedInputTokens = countInputTokens(modelMessages);

  if (estimatedInputTokens === null) {
    logRequestMetrics({
      chatId,
      requestedAt,
      startedAt,
      estimatedInputTokens: null,
      status: "rejected",
    });

    return Response.json(
      { error: "Only text messages are supported by token preflight." },
      { status: 400 },
    );
  }

  if (estimatedInputTokens > MAX_INPUT_TOKENS) {
    logRequestMetrics({
      chatId,
      requestedAt,
      startedAt,
      estimatedInputTokens,
      status: "rejected",
    });

    return Response.json(
      {
        error: "Conversation exceeds the input token budget.",
        estimatedInputTokens,
        maxInputTokens: MAX_INPUT_TOKENS,
      },
      { status: 413 },
    );
  }

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      let partialResponse = "";
      let metricsLogged = false;
      const sendFinalMetrics = (
        status: "completed" | "aborted" | "failed",
        inputTokens?: number | null,
        outputTokens?: number | null,
      ) => {
        if (metricsLogged) return;
        metricsLogged = true;
        const metrics = logRequestMetrics({
          chatId,
          requestedAt,
          startedAt,
          estimatedInputTokens,
          status,
          inputTokens,
          outputTokens,
          partialOutputTokenEstimate: countTokens(partialResponse),
        });
        writer.write({
          type: "data-token-audit",
          data: metrics,
          transient: true,
        });
      };

      const result = streamText({
        model: groq("openai/gpt-oss-120b"),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPTS.defaultAssistant,
        messages: modelMessages,

        // Automatically forwards the user's AbortController signal.
        abortSignal: req.signal,

        onChunk({ chunk }) {
          if (chunk.type === "text-delta") {
            partialResponse += chunk.text;
          }
        },

        async onFinish({ text, usage }) {
          sendFinalMetrics("completed", usage.inputTokens, usage.outputTokens);
          await saveMessageToDatabase({
            chatId,
            role: "assistant",
            content: text,
            status: "completed",
          });
        },

        async onAbort({ steps }) {
          const completedUsage = steps.reduce(
            (total, step) => ({
              inputTokens: total.inputTokens + (step.usage.inputTokens ?? 0),
              outputTokens: total.outputTokens + (step.usage.outputTokens ?? 0),
            }),
            { inputTokens: 0, outputTokens: 0 },
          );
          sendFinalMetrics(
            "aborted",
            steps.length ? completedUsage.inputTokens : null,
            steps.length ? completedUsage.outputTokens : null,
          );

          if (partialResponse.trim()) {
            await saveMessageToDatabase({
              chatId,
              role: "assistant",
              content: `${partialResponse} [Generation stopped by user]`,
              status: "cancelled",
            });
          }
        },

        onError(error) {
          sendFinalMetrics("failed");
          console.error("Groq Stream Error:", error);
        },
      });

      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}