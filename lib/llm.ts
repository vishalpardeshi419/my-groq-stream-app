import { groq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, wrapLanguageModel } from "ai";
import type { LanguageModelMiddleware } from "ai";
import { randomUUID } from "node:crypto";
import {
  storeRuntimeLog,
  type RuntimeLogEntry,
} from "@/lib/runtime-logs";

const MODEL_ID = "openai/gpt-oss-120b";
const FALLBACK_MODEL_ID = process.env.OPENAI_FALLBACK_MODEL ?? "gpt-4.1-mini";
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

export function isTransientProviderError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    code?: unknown;
  };
  const status =
    typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : candidate.status;
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    candidate.name === "TimeoutError" ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(
      typeof candidate.code === "string" ? candidate.code : "",
    )
  );
}

export function getProviderFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
  random: () => number = Math.random,
) {
  const mode = env.LLM_FAULT_MODE;
  const rate = Number(env.LLM_FAULT_RATE ?? "0");
  if (
    !["http-500", "rate-limit"].includes(mode ?? "") ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1
  ) {
    return undefined;
  }

  return () => {
    if (random() >= rate) return undefined;
    const statusCode = mode === "rate-limit" ? 429 : 500;
    return Object.assign(
      new Error(`Simulated provider HTTP ${statusCode}.`),
      { statusCode },
    );
  };
}

export async function runWithProviderFallback<Params, Result>(
  params: Params,
  primaryCall: (params: Params) => PromiseLike<Result>,
  fallbackCall: ((params: Params) => PromiseLike<Result>) | undefined,
  onFallback: (error: unknown) => void,
  options: {
    maxRetries?: number;
    backoffBaseMs?: number;
    jitterMs?: number;
    random?: () => number;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<Result> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const jitterMs = options.jitterMs ?? 250;
  const random = options.random ?? Math.random;
  const wait =
    options.sleep ??
    ((milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, milliseconds);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }));

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return await primaryCall(params);
    } catch (error) {
      if (
        !isTransientProviderError(error) ||
        options.signal?.aborted
      ) {
        throw error;
      }
      if (attempt <= maxRetries) {
        const delayMs =
          backoffBaseMs * 2 ** (attempt - 1) +
          Math.floor(random() * jitterMs);
        options.onRetry?.(error, attempt, delayMs);
        await wait(delayMs, options.signal);
        continue;
      }
      if (!fallbackCall) throw error;
      onFallback(error);
      return fallbackCall(params);
    }
  }

  throw new Error("Provider retry limit was exhausted.");
}

function createResilientModel({
  onPrimaryCall,
  onFallback,
}: {
  onPrimaryCall: () => void;
  onFallback: (error: unknown) => void;
}) {
  const primary = groq(MODEL_ID);
  const fallback = process.env.OPENAI_API_KEY
    ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(FALLBACK_MODEL_ID)
    : undefined;
  const injectFault = getProviderFaultInjectorFromEnv();
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    async wrapStream({ doStream, params, model }) {
      try {
        return await runWithProviderFallback(
          params,
          () => {
            onPrimaryCall();
            const injected = injectFault?.();
            if (injected) throw injected;
            return doStream();
          },
          fallback
            ? (sameParams) => fallback.doStream(sameParams)
            : undefined,
          onFallback,
          {
            signal: params.abortSignal,
            onRetry(error, attempt, delayMs) {
              logStructuredEvent("llm.provider.retry", {
                provider: model.provider,
                model: model.modelId,
                attempt,
                delayMs,
                errorStatus:
                  error &&
                  typeof error === "object" &&
                  "statusCode" in error &&
                  typeof error.statusCode === "number"
                    ? error.statusCode
                    : undefined,
              });
            },
          },
        );
      } catch (error) {
        logStructuredEvent("llm.provider.exhausted", {
          provider: model.provider,
          model: model.modelId,
          fallbackConfigured: fallback !== undefined,
          transient: isTransientProviderError(error),
        });
        throw error;
      }
    },
  };
  return wrapLanguageModel({ model: primary, middleware });
}

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
  onStepEnd,
  ...options
}: StreamLlmOptions) {
  const startedAt = Date.now();
  let activeProvider = "groq";
  let activeModel = MODEL_ID;
  const model = createResilientModel({
    onPrimaryCall() {
      activeProvider = "groq";
      activeModel = MODEL_ID;
    },
    onFallback(error) {
      activeProvider = "openai";
      activeModel = FALLBACK_MODEL_ID;
      logStructuredEvent("llm.provider.fallback", {
        requestId,
        chatId,
        primaryProvider: "groq",
        primaryModel: MODEL_ID,
        fallbackProvider: "openai",
        fallbackModel: FALLBACK_MODEL_ID,
        errorStatus:
          error &&
          typeof error === "object" &&
          "statusCode" in error &&
          typeof error.statusCode === "number"
            ? error.statusCode
            : undefined,
        compatibleToolSchemasForwarded: true,
      });
    },
  });

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
    model,
    maxRetries: options.maxRetries ?? 0,
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
    onStepEnd: async (step) => {
      const interactions = step.toolCalls.map((toolCall) => {
        const result = step.toolResults.find(
          (toolResult) => toolResult.toolCallId === toolCall.toolCallId,
        );
        return {
          tool: toolCall.toolName,
          args: toolCall.input,
          result: result?.output,
          latencyMs: step.performance.toolExecutionMs[toolCall.toolCallId] ?? null,
        };
      });
      logStructuredEvent("agent.step.completed", {
        requestId,
        chatId,
        step: step.stepNumber + 1,
        tools: includeRawContent
          ? interactions
          : interactions.map((interaction) => ({
              tool: interaction.tool,
              args: summarizeValue(interaction.args),
              result:
                interaction.result === undefined
                  ? null
                  : summarizeValue(interaction.result),
              latencyMs: interaction.latencyMs,
            })),
        latencyMs: step.performance.stepTimeMs,
        inputTokens: step.usage.inputTokens ?? null,
        outputTokens: step.usage.outputTokens ?? null,
        totalTokens:
          (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
      });
      await onStepEnd?.(step);
    },
    onFinish: async (result) => {
      logStructuredEvent("llm.response.completed", {
        requestId,
        chatId,
        provider: activeProvider,
        model: activeModel,
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
        provider: activeProvider,
        model: activeModel,
        latencyMs: Date.now() - startedAt,
        completedSteps: result.steps.length,
      });
      await onAbort?.(result);
    },
    onError: async (result) => {
      logStructuredEvent("llm.response.failed", {
        requestId,
        chatId,
        provider: activeProvider,
        model: activeModel,
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