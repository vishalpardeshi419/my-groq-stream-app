import { tool } from "ai";
import { z } from "zod";
import { logStructuredEvent } from "@/lib/llm";
import { getRuntimeLogs } from "@/lib/runtime-logs";
import { fetchCurrentWeather } from "@/lib/weather";
import { calculate, getCurrentTime, searchNotes } from "@/lib/agent-tools";
import { createAgentToolExecutor } from "@/lib/agent-tool-executor";

export const CHAT_TOOL_INSTRUCTIONS = [
  "For a request that needs tools, start with a short, user-facing plan of up to three steps; before each later tool call, briefly state the next action and adapt it to the results so far.",
  "Do not reveal private chain-of-thought. If no tool is needed, answer directly. If the available tools or data cannot fulfill the request, say so clearly instead of guessing or repeating calls.",
  "Use get_time for the current system timestamp.",
  "Use calculator for arithmetic instead of estimating.",
  "Use search_notes when the user asks about saved notes.",
  "Use get_weather when the user asks for current weather. If it returns ok=false, explain the error and do not invent weather data.",
  "Use get_recent_usage when the user asks about token usage or recent request performance. This reads only this chat's locally captured usage events.",
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
];

export function createChatTools(chatId: string) {
  const executeTool = createAgentToolExecutor((toolName, error) => {
    logStructuredEvent("llm.tool.execution_failed", {
      chatId,
      toolName,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  });

  return {
    get_time: tool({
      description: "Get the current system timestamp in ISO 8601 format.",
      inputSchema: timeInputSchema,
      execute: async () => executeTool("get_time", {}, getCurrentTime),
    }),
    calculator: tool({
      description: "Evaluate a basic arithmetic expression.",
      inputSchema: calculatorInputSchema,
      execute: async ({ expression }) =>
        executeTool("calculator", { expression }, () => calculate(expression)),
    }),
    search_notes: tool({
      description: "Search the local hardcoded notes dictionary.",
      inputSchema: searchNotesInputSchema,
      execute: async ({ query }) =>
        executeTool("search_notes", { query }, () => searchNotes(query)),
    }),
    get_weather: tool({
      description: "Get current weather for a city using OpenWeather.",
      inputSchema: weatherInputSchema,
      execute: async ({ location, units }, { abortSignal }) => {
        const result = await executeTool(
          "get_weather",
          { location, units },
          async () => {
            const weather = await fetchCurrentWeather({
              location,
              units,
              signal: abortSignal,
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
        );
        return result;
      },
    }),
    get_recent_usage: tool({
      description:
        "Summarize recent token usage and response latency for this chat from the app's local runtime logs.",
      inputSchema: usageInputSchema,
      execute: async ({ limit }) =>
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
        }),
    }),
  };
}
