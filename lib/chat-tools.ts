import { tool } from "ai";
import { z } from "zod";
import { logStructuredEvent } from "@/lib/llm";
import { getRuntimeLogs } from "@/lib/runtime-logs";
import { fetchCurrentWeather } from "@/lib/weather";
import {
  calculate,
  getCurrentTime,
  getOrderDetails,
  searchNotes,
  searchRefundPolicy,
  simulateRefund,
} from "@/lib/agent-tools";
import {
  createAgentToolExecutor,
  getToolFaultInjectorFromEnv,
} from "@/lib/agent-tool-executor";

export const CHAT_TOOL_INSTRUCTIONS = [
  "For a request that needs tools, start with a short, user-facing plan of up to three steps; before each later tool call, briefly state the next action and adapt it to the results so far.",
  "Do not reveal private chain-of-thought. If no tool is needed, answer directly. If the available tools or data cannot fulfill the request, say so clearly instead of guessing or repeating calls.",
  "Use get_time for the current system timestamp.",
  "Use calculator for arithmetic instead of estimating.",
  "Use search_notes when the user asks about saved notes.",
  "Use get_weather when the user asks for current weather. If it returns ok=false, explain the error and do not invent weather data.",
  "Use get_recent_usage when the user asks about token usage or recent request performance. This reads only this chat's locally captured usage events.",
  "For refund questions, search_refund_policy first, then get_order_details. Only call refund_order after confirming the order meets the policy. refund_order is simulated and always requires explicit human approval.",
].join(" ");

const timeInputSchema = z.object({});
const calculatorInputSchema = z.object({
  expression: z.string().trim().min(1).max(256).describe("Arithmetic using numbers, parentheses, +, -, *, and /"),
});
const searchNotesInputSchema = z.object({
  query: z.string().trim().min(1).max(120).describe("A keyword or phrase to find in saved notes"),
});
const weatherInputSchema = z.object({
  location: z.string().trim().min(1).max(120).describe("City and optionally country, such as Pune, IN"),
  units: z.enum(["metric", "imperial"]).default("metric"),
});

const usageInputSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
});

const refundPolicyInputSchema = z.object({
  query: z.string().trim().min(1).max(120).describe("Refund policy detail to look up"),
});
const orderInputSchema = z.object({
  orderId: z.string().trim().min(1).max(32).describe("Order identifier, such as 123"),
});
const refundInputSchema = z.object({
  orderId: z.string().trim().min(1).max(32).describe("Order identifier"),
  amount: z.number().positive().max(1_000_000).describe("Refund amount in INR"),
});
const toolCallErrorInputSchema = z.object({
  message: z.string().trim().min(1).max(1_200),
  exhausted: z.boolean().default(false),
});

export const CHAT_TOOL_INPUT_SCHEMAS = {
  get_time: timeInputSchema,
  calculator: calculatorInputSchema,
  search_notes: searchNotesInputSchema,
  get_weather: weatherInputSchema,
  get_recent_usage: usageInputSchema,
  search_refund_policy: refundPolicyInputSchema,
  get_order_details: orderInputSchema,
  refund_order: refundInputSchema,
  report_tool_error: toolCallErrorInputSchema,
};

export const CHAT_TOOL_SCHEMAS = [
  {
    name: "get_time",
    description: "Get the current system timestamp in ISO 8601 format.",
    inputSchema: z.toJSONSchema(timeInputSchema),
  },
  {
    name: "calculator",
    description: "Evaluate a basic arithmetic expression.",
    inputSchema: z.toJSONSchema(calculatorInputSchema),
  },
  {
    name: "search_notes",
    description: "Search the local hardcoded notes dictionary.",
    inputSchema: z.toJSONSchema(searchNotesInputSchema),
  },
  {
    name: "get_weather",
    description: "Get current weather for a city using OpenWeather.",
    inputSchema: z.toJSONSchema(weatherInputSchema),
  },
  {
    name: "get_recent_usage",
    description:
      "Summarize recent token usage and response latency for this chat from the app's local runtime logs.",
    inputSchema: z.toJSONSchema(usageInputSchema),
  },
  {
    name: "search_refund_policy",
    description: "Search the demo refund policy before making a refund decision.",
    inputSchema: z.toJSONSchema(refundPolicyInputSchema),
  },
  {
    name: "get_order_details",
    description: "Fetch details for a demo order.",
    inputSchema: z.toJSONSchema(orderInputSchema),
  },
  {
    name: "refund_order",
    description:
      "Simulate a refund for an eligible demo order. This action always requires human approval and never issues a real payment.",
    inputSchema: z.toJSONSchema(refundInputSchema),
  },
  {
    name: "report_tool_error",
    description:
      "Internal recovery tool used to return a validation correction to the model. Never use it for user requests.",
    inputSchema: z.toJSONSchema(toolCallErrorInputSchema),
  },
];

export function createChatTools(chatId: string, requestId?: string) {
  const executeTool = createAgentToolExecutor((toolName, error) => {
    logStructuredEvent("llm.tool.execution_failed", {
      chatId,
      requestId,
      toolName,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }, {
    injectFault: getToolFaultInjectorFromEnv(),
    onEvent(event) {
      logStructuredEvent(`agent.tool.${event.type}`, {
        chatId,
        requestId,
        ...event,
      });
    },
  });

  return {
    get_time: tool({
      description: "Get the current system timestamp in ISO 8601 format.",
      inputSchema: timeInputSchema,
      execute: async (_input, { abortSignal }) =>
        executeTool(
          "get_time",
          {},
          () => getCurrentTime(),
          { signal: abortSignal },
        ),
    }),
    calculator: tool({
      description: "Evaluate a basic arithmetic expression.",
      inputSchema: calculatorInputSchema,
      execute: async ({ expression }, { abortSignal }) =>
        executeTool(
          "calculator",
          { expression },
          () => calculate(expression),
          { signal: abortSignal },
        ),
    }),
    search_notes: tool({
      description: "Search the local hardcoded notes dictionary.",
      inputSchema: searchNotesInputSchema,
      execute: async ({ query }, { abortSignal }) =>
        executeTool(
          "search_notes",
          { query },
          () => searchNotes(query),
          { signal: abortSignal },
        ),
    }),
    get_weather: tool({
      description: "Get current weather for a city using OpenWeather.",
      inputSchema: weatherInputSchema,
      execute: async ({ location, units }, { abortSignal }) => {
        const result = await executeTool(
          "get_weather",
          { location, units },
          async ({ signal }) => {
            const weather = await fetchCurrentWeather({
              location,
              units,
              signal,
            });
            logStructuredEvent(
              weather.ok ? "tool.weather.completed" : "tool.weather.failed",
              {
                chatId,
                ...(weather.ok
                  ? { location: weather.location }
                  : { errorCode: weather.code }),
              },
            );
            return weather;
          },
          { signal: abortSignal },
        );
        return result;
      },
    }),
    get_recent_usage: tool({
      description:
        "Summarize recent token usage and response latency for this chat from the app's local runtime logs.",
      inputSchema: usageInputSchema,
      execute: async ({ limit }, { abortSignal }) =>
        executeTool("get_recent_usage", { limit }, async () => {
          if (process.env.NODE_ENV !== "development") {
            return {
              ok: false as const,
              error:
                "Usage history is only available in development because no persistent usage database is configured.",
            };
          }

          const requests = getRuntimeLogs()
            .filter(
              (entry) =>
                entry.event === "llm.request.metrics" &&
                entry.chatId === chatId,
            )
            .slice(0, limit)
            .map((entry) => ({
              timestamp: entry.requestedAt,
              status: entry.status,
              estimatedInputTokens: entry.estimatedInputTokens,
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              totalRunTokens: entry.totalRunTokens,
              maxRunTokens: entry.maxRunTokens,
              tokenBudgetExceeded: entry.tokenBudgetExceeded,
              latencyMs: entry.latencyMs,
            }));

          return {
            ok: true as const,
            scope: "current chat",
            requestCount: requests.length,
            requests,
            storage: "development in-memory runtime logs",
          };
        }, { signal: abortSignal }),
    }),
    search_refund_policy: tool({
      description: "Search the demo refund policy before making a refund decision.",
      inputSchema: refundPolicyInputSchema,
      execute: async ({ query }, { abortSignal }) =>
        executeTool(
          "search_refund_policy",
          { query },
          () => searchRefundPolicy(query),
          { signal: abortSignal },
        ),
    }),
    get_order_details: tool({
      description: "Fetch details for a demo order.",
      inputSchema: orderInputSchema,
      execute: async ({ orderId }, { abortSignal }) =>
        executeTool(
          "get_order_details",
          { orderId },
          () => getOrderDetails(orderId),
          { signal: abortSignal },
        ),
    }),
    refund_order: tool({
      description:
        "Simulate a refund for an eligible demo order. This action always requires human approval and never issues a real payment.",
      inputSchema: refundInputSchema,
      needsApproval: true,
      execute: async ({ orderId, amount }, { abortSignal }) =>
        executeTool(
          "refund_order",
          { orderId, amount },
          () => simulateRefund(orderId, amount),
          { signal: abortSignal, maxRetries: 0 },
        ),
    }),
    report_tool_error: tool({
      description:
        "Return a bounded tool-call correction to the model. This tool performs no external action.",
      inputSchema: toolCallErrorInputSchema,
      execute: async ({ message, exhausted }, { abortSignal }) =>
        executeTool(
          "report_tool_error",
          { message, exhausted },
          () => ({
            ok: false as const,
            error: exhausted
              ? `${message} The correction limit was reached; explain the issue to the user and stop.`
              : message,
            code: "invalid-tool-call",
            retryable: false,
          }),
          { signal: abortSignal, maxRetries: 0 },
        ),
    }),
  };
}

export function validateChatToolInput(toolName: string, input: unknown) {
  if (!Object.hasOwn(CHAT_TOOL_INPUT_SCHEMAS, toolName)) {
    throw new Error(`Unknown tool "${toolName}".`);
  }

  const schema =
    CHAT_TOOL_INPUT_SCHEMAS[
      toolName as keyof typeof CHAT_TOOL_INPUT_SCHEMAS
    ];
  return schema.parse(input);
}
