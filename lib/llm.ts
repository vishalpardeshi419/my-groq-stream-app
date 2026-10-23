import { groq } from "@ai-sdk/groq";
import { streamText } from "ai";
import { randomUUID } from "node:crypto";
import {
  storeRuntimeLog,
  type RuntimeLogEntry,
} from "@/lib/runtime-logs";

const MODEL_ID = "openai/gpt-oss-120b";
export const LLM_MAX_OUTPUT_TOKENS = 4_096;

const includeRawContent = process.env.LLM_LOG_CONTENT === "true";

type StreamLlmOptions = Omit<
  Parameters<typeof streamText>[0],
  "model" | "prompt" | "messages"
> & {
  messages: NonNullable<Parameters<typeof streamText>[0]["messages"]>;
  chatId: string;
  estimatedInputTokens: number;
  requestId: string;
};

export function logStructuredEvent(
  event: string,
  details: Record<string, unknown>,
) {
  const entry: RuntimeLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  storeRuntimeLog(entry);
  console.info(JSON.stringify(entry));
}

function summarizeValue(value: unknown) {
  if (typeof value === "string") {
    return { type: "string", characters: value.length };
  }
  if (Array.isArray(value)) {
    return { type: "array", items: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value) };
  }
  return { type: typeof value };
}

export function streamLlm({
  chatId,
  estimatedInputTokens,
  requestId,
  system,
  messages,
  onAbort,
  onChunk,
  onError,
  onFinish,
  ...options
}: StreamLlmOptions) {
  const startedAt = Date.now();

  logStructuredEvent("llm.request.started", {
    requestId,
    chatId,
    provider: "groq",
    model: MODEL_ID,
    estimatedInputTokens,
    system: includeRawContent
      ? system
      : summarizeValue(typeof system === "string" ? system : JSON.stringify(system)),
    messages: messages?.map((message) => ({
      role: message.role,
      content: includeRawContent
        ? message.content
        : summarizeValue(JSON.stringify(message.content)),
    })),
  });

  return streamText({
    ...options,
    model: groq(MODEL_ID),
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    system,
    messages: messages ?? [],
    onChunk: async ({ chunk }) => {
      if (chunk.type === "tool-call") {
        logStructuredEvent("llm.tool.call", {
          requestId,
          chatId,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: includeRawContent ? chunk.input : summarizeValue(chunk.input),
        });
      } else if (chunk.type === "tool-result") {
        logStructuredEvent("llm.tool.result", {
          requestId,
          chatId,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          output: includeRawContent
            ? chunk.output
            : summarizeValue(chunk.output),
        });
      } else if (chunk.type === "tool-error") {
        logStructuredEvent("llm.tool.error", {
          requestId,
          chatId,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          errorType: typeof chunk.error,
        });
      }

      await onChunk?.({ chunk });
    },
    onFinish: async (result) => {
      logStructuredEvent("llm.response.completed", {
        requestId,
        chatId,
        provider: "groq",
        model: MODEL_ID,
        latencyMs: Date.now() - startedAt,
        finishReason: result.finishReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        responseCharacters: result.text.length,
        ...(includeRawContent ? { response: result.text } : {}),
      });
      await onFinish?.(result);
    },
    onAbort: async (result) => {
      logStructuredEvent("llm.response.aborted", {
        requestId,
        chatId,
        provider: "groq",
        model: MODEL_ID,
        latencyMs: Date.now() - startedAt,
        completedSteps: result.steps.length,
      });
      await onAbort?.(result);
    },
    onError: async (result) => {
      logStructuredEvent("llm.response.failed", {
        requestId,
        chatId,
        provider: "groq",
        model: MODEL_ID,
        latencyMs: Date.now() - startedAt,
        errorType:
          result.error instanceof Error
            ? result.error.name
            : typeof result.error,
        errorMessage:
          result.error instanceof Error ? result.error.message : undefined,
      });
      await onError?.(result);
    },
  });
}