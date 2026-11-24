import { randomUUID } from "node:crypto";
import {
  validateUIMessages,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  InvalidToolInputError,
  NoSuchToolError,
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
  MAX_RUN_WALL_CLOCK_MS,
  MAX_TOOL_REPAIR_ATTEMPTS,
  MAX_TOOL_STEPS,
} from "@/lib/chat-tool-config";
import {
  compactToolResultHistory,
  estimateInputTokens,
  isWithinInputTokenBudget,
  TOKEN_PREFLIGHT_SAFETY_MARGIN,
} from "@/lib/token-preflight";
import { SYSTEM_PROMPTS } from "@/lib/prompts";

export const maxDuration = 30; // Max execution time for serverless deployment

const MAX_CONTEXT_TOKENS = 131_072;
const MAX_CORRECTION_MESSAGE_CHARACTERS = 1_000;
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
  cumulativeRunTokens?: number;
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
    cumulativeRunTokens: data.cumulativeRunTokens ?? null,
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
  const compactedHistory = compactToolResultHistory(modelMessages);
  if (compactedHistory.compactedCount > 0) {
    logStructuredEvent("agent.context.tool_results_compacted", {
      requestId,
      chatId,
      compactedCount: compactedHistory.compactedCount,
    });
  }
  const estimate = estimateInputTokens({
    messages: compactedHistory.messages,
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
  const convertedTrustedMessages = await convertToModelMessages(trustedMessages);
  const trustedModelMessages =
    compactToolResultHistory(convertedTrustedMessages).messages;
  const tools = createChatTools(chatId, requestId);
  let completedSteps = runState.stepCount;

  const stream = createUIMessageStream({
    onError: () =>
      "The assistant encountered an unexpected error. Any verified partial results remain above; please try again.",
    execute: ({ writer }) => {
      let partialResponse = "";
      let metricsLogged = false;
      let tokenBudgetExceeded = false;
      let stepLimitExceeded = false;
      let wallClockExceeded = false;
      let toolRepairAttempts = 0;
      let runStopReason: "token-budget" | "step-limit" | "tool-correction-limit" | null =
        null;
      const remainingSteps = Math.max(
        1,
        MAX_TOOL_STEPS - runState.stepCount,
      );
      const wallClockController = new AbortController();
      const remainingWallClockMs = Math.max(
        0,
        MAX_RUN_WALL_CLOCK_MS - (Date.now() - startedAt),
      );
      const wallClockTimer = setTimeout(() => {
        wallClockExceeded = true;
        wallClockController.abort(
          new Error("The agent run exceeded its wall-clock limit."),
        );
      }, remainingWallClockMs);
      const runAbortSignal = AbortSignal.any([
        req.signal,
        wallClockController.signal,
      ]);
      const clearWallClockTimer = () => clearTimeout(wallClockTimer);
      let completedRunTokens = runState.runTokenCount;
      let runNotice = "";
      let runNoticeMessageId: string | undefined;
      const appendRunNotice = (notice: string) => {
        const id = randomUUID();
        runNotice = notice;
        runNoticeMessageId = id;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: notice });
        writer.write({ type: "text-end", id });
        partialResponse += notice;
      };
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
          cumulativeRunTokens: completedRunTokens,
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
          ({ steps }) => {
            tokenBudgetExceeded = isRunTokenBudgetExceeded({
              steps,
              previousTokens: runState.runTokenCount,
            });
            if (tokenBudgetExceeded) {
              runStopReason = "token-budget";
              logStructuredEvent("agent.run.token_budget_exceeded", {
                requestId,
                chatId,
                totalRunTokens: getRunTokenTotal({
                  steps,
                  previousTokens: runState.runTokenCount,
                }),
                maxRunTokens: MAX_RUN_TOKENS,
                completedSteps: steps.length,
              });
            }
            stepLimitExceeded =
              steps.length >= remainingSteps &&
              (steps.at(-1)?.toolCalls.length ?? 0) > 0;
            if (stepLimitExceeded && runStopReason === null) {
              runStopReason = "step-limit";
              logStructuredEvent("agent.run.step_limit_exceeded", {
                requestId,
                chatId,
                completedSteps: steps.length,
                maxToolSteps: MAX_TOOL_STEPS,
              });
            }
            if (
              toolRepairAttempts >= MAX_TOOL_REPAIR_ATTEMPTS &&
              runStopReason === null
            ) {
              runStopReason = "tool-correction-limit";
              logStructuredEvent("agent.tool_call.correction_limit_reached", {
                requestId,
                chatId,
                attempts: toolRepairAttempts,
              });
            }
            return (
              tokenBudgetExceeded ||
              stepLimitExceeded ||
              toolRepairAttempts >= MAX_TOOL_REPAIR_ATTEMPTS
            );
          },
        ],
        abortSignal: runAbortSignal,

        repairToolCall: async ({ toolCall, error, tools: availableTools }) => {
          toolRepairAttempts += 1;
          if (toolRepairAttempts > MAX_TOOL_REPAIR_ATTEMPTS) {
            logStructuredEvent("agent.tool_call.repair_exhausted", {
              requestId,
              chatId,
              toolName: toolCall.toolName,
              attempts: toolRepairAttempts,
            });
            return null;
          }

          const knownTools = Object.keys(availableTools).filter(
            (toolName) => toolName !== "report_tool_error",
          );
          const correction = NoSuchToolError.isInstance(error)
            ? `Tool "${error.toolName}" does not exist. Available tools: ${knownTools.join(", ")}.`
            : InvalidToolInputError.isInstance(error)
              ? `Invalid arguments for tool "${error.toolName}". Check its input schema and retry. ${error.message}`
              : "The tool call was invalid. Check the available tool names and input schemas.";
          const message = correction.slice(0, MAX_CORRECTION_MESSAGE_CHARACTERS);
          const exhausted =
            toolRepairAttempts >= MAX_TOOL_REPAIR_ATTEMPTS;
          logStructuredEvent("agent.tool_call.repaired", {
            requestId,
            chatId,
            toolName: toolCall.toolName,
            errorType: NoSuchToolError.isInstance(error)
              ? "unknown-tool"
              : "invalid-input",
            attempt: toolRepairAttempts,
            exhausted,
          });
          return {
            ...toolCall,
            toolName: "report_tool_error",
            input: JSON.stringify({ message, exhausted }),
          };
        },

        onChunk({ chunk }) {
          if (chunk.type === "text-delta") {
            partialResponse += chunk.text;
          }
        },

        onStepEnd(step) {
          completedSteps += 1;
          completedRunTokens +=
            (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0);
        },

        async onFinish({ text, usage, steps }) {
          clearWallClockTimer();
          completedRunTokens = getRunTokenTotal({
            steps,
            previousTokens: runState.runTokenCount,
          });
          runNotice =
            runStopReason === "token-budget"
              ? "\n\nThis run stopped at its token budget. I can continue if you want to proceed."
              : runStopReason === "step-limit"
                ? "\n\nThis run reached its step limit. I can continue if you want to proceed."
                : runStopReason === "tool-correction-limit"
                  ? "\n\nI could not produce a valid tool call after two corrections. Please rephrase the request."
                  : "";
          if (runNotice) appendRunNotice(runNotice);
          sendFinalMetrics(
            runStopReason ? "failed" : "completed",
            usage.inputTokens,
            usage.outputTokens,
          );
          await saveMessageToDatabase({
            chatId,
            role: "assistant",
            content: `${text}${runNotice}`,
            status: runStopReason ? "failed" : "completed",
          });
        },

        async onAbort({ steps }) {
          clearWallClockTimer();
          completedRunTokens = getRunTokenTotal({
            steps,
            previousTokens: runState.runTokenCount,
          });
          const completedUsage = steps.reduce(
            (total, step) => ({
              inputTokens: total.inputTokens + (step.usage.inputTokens ?? 0),
              outputTokens: total.outputTokens + (step.usage.outputTokens ?? 0),
            }),
            { inputTokens: 0, outputTokens: 0 },
          );
          sendFinalMetrics(
            wallClockExceeded ? "failed" : "aborted",
            steps.length ? completedUsage.inputTokens : null,
            steps.length ? completedUsage.outputTokens : null,
          );

          if (wallClockExceeded) {
            const timeoutNotice = `\n\nThis run reached its ${Math.ceil(
              MAX_RUN_WALL_CLOCK_MS / 1_000,
            )}-second time limit. The text above is partial; tell me whether you want me to continue.`;
            logStructuredEvent("agent.run.wall_clock_exceeded", {
              requestId,
              chatId,
              maxRunWallClockMs: MAX_RUN_WALL_CLOCK_MS,
              partialCharacters: partialResponse.length,
            });
            appendRunNotice(timeoutNotice);
            await saveMessageToDatabase({
              chatId,
              role: "assistant",
              content: partialResponse,
              status: "failed",
            });
          } else if (partialResponse.trim()) {
            await saveMessageToDatabase({
              chatId,
              role: "assistant",
              content: `${partialResponse} [Generation stopped by user]`,
              status: "cancelled",
            });
          }
        },

        onError({ error }) {
          clearWallClockTimer();
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
          onError: () =>
            "The assistant encountered an unexpected error. Any verified partial results remain above; please try again.",
          async onEnd({ messages: completedMessages }) {
            try {
              const checkpointMessages =
                runNoticeMessageId &&
                !completedMessages.some(
                  (message) => message.id === runNoticeMessageId,
                )
                  ? [
                      ...completedMessages,
                      {
                        id: runNoticeMessageId,
                        role: "assistant" as const,
                        parts: [{ type: "text" as const, text: runNotice }],
                      },
                    ]
                  : completedMessages;
              await finishChatRun({
                chatId,
                messages: checkpointMessages,
                stepCount: completedSteps,
                runTokenCount: completedRunTokens,
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