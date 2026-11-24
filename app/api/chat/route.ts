import { randomUUID } from "node:crypto";
import {
  validateUIMessages,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { countTokens } from "gpt-tokenizer/model/gpt-oss-120b";
import { z } from "zod";
import {
  LLM_MAX_OUTPUT_TOKENS,
  logStructuredEvent,
  streamLlm,
} from "@/lib/llm";
import {
  CHAT_TOOL_INSTRUCTIONS,
  CHAT_TOOL_SCHEMAS,
  createChatTools,
  validateChatToolInput,
} from "@/lib/chat-tools";
import {
  beginChatRun,
  finishChatRun,
  getChatSession,
  prepareSessionTransition,
} from "@/lib/chat-session-store";
import {
  getRunTokenTotal,
  isRunTokenBudgetExceeded,
  MAX_RUN_TOKENS,
  MAX_TOOL_STEPS,
} from "@/lib/chat-tool-config";
import {
  estimateInputTokens,
  isWithinInputTokenBudget,
  TOKEN_PREFLIGHT_SAFETY_MARGIN,
} from "@/lib/token-preflight";
import { SYSTEM_PROMPTS } from "@/lib/prompts";

export const maxDuration = 30; // Max execution time for serverless deployment

const MAX_CONTEXT_TOKENS = 131_072;
const chatRequestSchema = z.object({
  chatId: z.string().uuid(),
  messages: z.array(z.unknown()).min(1).max(100),
});
const CHAT_SYSTEM_PROMPT = `${SYSTEM_PROMPTS.defaultAssistant}\n\n${CHAT_TOOL_INSTRUCTIONS}`;
const DEFAULT_INPUT_TOKEN_BUDGET = 120_000;
const configuredInputTokenBudget = Number(
  process.env.MAX_INPUT_TOKENS ?? DEFAULT_INPUT_TOKEN_BUDGET,
);
const MAX_INPUT_TOKENS =
  Number.isInteger(configuredInputTokenBudget) && configuredInputTokenBudget > 0
    ? Math.min(
        configuredInputTokenBudget,
        MAX_CONTEXT_TOKENS -
          LLM_MAX_OUTPUT_TOKENS -
          TOKEN_PREFLIGHT_SAFETY_MARGIN,
      )
    : DEFAULT_INPUT_TOKEN_BUDGET;

function logRequestMetrics(data: {
  requestId: string;
  chatId: string;
  requestedAt: string;
  startedAt: number;
  estimatedInputTokens: number | null;
  messageTokens?: number | null;
  toolSchemaTokens?: number | null;
  safetyMarginTokens?: number;
  status: "completed" | "aborted" | "failed" | "rejected";
  inputTokens?: number | null;
  outputTokens?: number | null;
  partialOutputTokenEstimate?: number;
  tokenBudgetExceeded?: boolean;
}) {
  const totalRunTokens =
    data.inputTokens == null && data.outputTokens == null
      ? null
      : (data.inputTokens ?? 0) + (data.outputTokens ?? 0);
  const metrics = {
    requestId: data.requestId,
    chatId: data.chatId,
    requestedAt: data.requestedAt,
    latencyMs: Date.now() - data.startedAt,
    status: data.status,
    estimatedInputTokens: data.estimatedInputTokens,
    messageTokens: data.messageTokens ?? null,
    toolSchemaTokens: data.toolSchemaTokens ?? null,
    safetyMarginTokens: data.safetyMarginTokens ?? null,
    inputTokens: data.inputTokens ?? null,
    outputTokens: data.outputTokens ?? null,
    partialOutputTokenEstimate: data.partialOutputTokenEstimate,
    totalRunTokens,
    maxRunTokens: MAX_RUN_TOKENS,
    tokenBudgetExceeded: data.tokenBudgetExceeded ?? false,
  };
  logStructuredEvent("llm.request.metrics", metrics);
  return metrics;
}

// Mock database helper to simulate saving messages
async function saveMessageToDatabase(data: {
  chatId: string;
  role: string;
  content: string;
  status: "completed" | "cancelled" | "failed";
}) {
  logStructuredEvent("chat.message.persisted", {
    chatId: data.chatId,
    role: data.role,
    status: data.status,
    contentCharacters: data.content.length,
  });
}

export async function GET(req: Request) {
  const chatIdResult = z.string().uuid().safeParse(
    new URL(req.url).searchParams.get("chatId"),
  );
  if (!chatIdResult.success) {
    return Response.json({ error: "A valid chatId is required." }, { status: 400 });
  }

  try {
    const session = await getChatSession(chatIdResult.data);
    return Response.json(
      session ?? {
        chatId: chatIdResult.data,
        messages: [],
        pendingToolCalls: [],
        stepCount: 0,
        status: "ready",
      },
    );
  } catch (error) {
    logStructuredEvent("chat.session.persistence.error", {
      chatId: chatIdResult.data,
      operation: "load",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return Response.json(
      { error: "Unable to load the saved chat session." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedBody = chatRequestSchema.safeParse(requestBody);
  if (!parsedBody.success) {
    return Response.json(
      { error: "A valid chatId and message history are required." },
      { status: 400 },
    );
  }

  const { chatId } = parsedBody.data;
  const tools = createChatTools(chatId);
  let messages: UIMessage[];
  try {
    messages = await validateUIMessages<UIMessage>({
      messages: parsedBody.data.messages,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? `Invalid chat messages: ${error.message}`
            : "Invalid chat messages.",
      },
      { status: 400 },
    );
  }

  let session;
  try {
    session = await getChatSession(chatId);
    prepareSessionTransition(session, messages, validateChatToolInput);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The saved chat session is not available.",
      },
      { status: 409 },
    );
  }

  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestedAt = new Date(startedAt).toISOString();
  const modelMessages = await convertToModelMessages(messages);
  const estimate = estimateInputTokens({
    messages: modelMessages,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    toolSchemas: CHAT_TOOL_SCHEMAS,
  });

  if (estimate === null) {
    logRequestMetrics({
      requestId,
      chatId,
      requestedAt,
      startedAt,
      estimatedInputTokens: null,
      status: "rejected",
    });

    return Response.json(
      { error: "Only text and tool messages are supported by token preflight." },
      { status: 400 },
    );
  }

  const estimatedInputTokens = estimate.estimatedInputTokens;

  if (!isWithinInputTokenBudget(estimatedInputTokens, MAX_INPUT_TOKENS)) {
    logRequestMetrics({
      requestId,
      chatId,
      requestedAt,
      startedAt,
      estimatedInputTokens,
      messageTokens: estimate.messageTokens,
      toolSchemaTokens: estimate.toolSchemaTokens,
      safetyMarginTokens: estimate.safetyMarginTokens,
      status: "rejected",
    });

    return Response.json(
      {
        error: "Conversation exceeds the input token budget.",
        estimatedInputTokens,
        messageTokens: estimate.messageTokens,
        toolSchemaTokens: estimate.toolSchemaTokens,
        safetyMarginTokens: estimate.safetyMarginTokens,
        maxInputTokens: MAX_INPUT_TOKENS,
      },
      { status: 413 },
    );
  }

  let runState;
  try {
    runState = await beginChatRun(chatId, messages, validateChatToolInput);
  } catch (error) {
    logStructuredEvent("chat.session.persistence.error", {
      chatId,
      operation: "begin",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start the chat session.",
      },
      { status: 409 },
    );
  }

  const trustedMessages = runState.messages;
  const trustedModelMessages = await convertToModelMessages(trustedMessages);
  let completedSteps = runState.stepCount;

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      let partialResponse = "";
      let metricsLogged = false;
      let tokenBudgetExceeded = false;
      const sendFinalMetrics = (
        status: "completed" | "aborted" | "failed",
        inputTokens?: number | null,
        outputTokens?: number | null,
      ) => {
        if (metricsLogged) return;
        metricsLogged = true;
        const metrics = logRequestMetrics({
          requestId,
          chatId,
          requestedAt,
          startedAt,
          estimatedInputTokens,
          messageTokens: estimate.messageTokens,
          toolSchemaTokens: estimate.toolSchemaTokens,
          safetyMarginTokens: estimate.safetyMarginTokens,
          status,
          inputTokens,
          outputTokens,
          tokenBudgetExceeded,
          partialOutputTokenEstimate: countTokens(partialResponse),
        });
        writer.write({
          type: "data-token-audit",
          data: metrics,
          transient: true,
        });
      };

      const result = streamLlm({
        requestId,
        chatId,
        estimatedInputTokens,
        system: CHAT_SYSTEM_PROMPT,
        messages: trustedModelMessages,
        tools,
        toolCallConcurrency: 5,
        stopWhen: [
          isStepCount(Math.max(1, MAX_TOOL_STEPS - runState.stepCount)),
          ({ steps }) => {
            tokenBudgetExceeded = isRunTokenBudgetExceeded({ steps });
            if (tokenBudgetExceeded) {
              logStructuredEvent("agent.run.token_budget_exceeded", {
                requestId,
                chatId,
                totalRunTokens: getRunTokenTotal({ steps }),
                maxRunTokens: MAX_RUN_TOKENS,
                completedSteps: steps.length,
              });
            }
            return tokenBudgetExceeded;
          },
        ],

        // Automatically forwards the user's AbortController signal.
        abortSignal: req.signal,

        onChunk({ chunk }) {
          if (chunk.type === "text-delta") {
            partialResponse += chunk.text;
          }
        },

        onStepEnd() {
          completedSteps += 1;
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

        onError({ error }) {
          sendFinalMetrics("failed");
          logStructuredEvent("chat.generation.error", {
            requestId,
            chatId,
            errorType: error instanceof Error ? error.name : typeof error,
            errorMessage:
              error instanceof Error ? error.message : undefined,
          });
        },
      });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          tools,
          originalMessages: trustedMessages,
          async onEnd({ messages: completedMessages }) {
            try {
              await finishChatRun({
                chatId,
                messages: completedMessages,
                stepCount: completedSteps,
              });
            } catch (error) {
              logStructuredEvent("chat.session.persistence.error", {
                chatId,
                operation: "checkpoint",
                errorType: error instanceof Error ? error.name : typeof error,
              });
              throw error;
            }
          },
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}