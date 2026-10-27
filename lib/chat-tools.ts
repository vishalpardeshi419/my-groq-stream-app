import { tool } from "ai";
import { z } from "zod";
import { logStructuredEvent } from "@/lib/llm";
import { getRuntimeLogs } from "@/lib/runtime-logs";
import { fetchCurrentWeather } from "@/lib/weather";

export const CHAT_TOOL_INSTRUCTIONS = [
  "Use get_weather when the user asks for current weather. If it returns ok=false, explain the error and do not invent weather data.",
  "Use get_recent_usage when the user asks about token usage or recent request performance. This reads only this chat's locally captured usage events.",
].join(" ");

const weatherInputSchema = z.object({
  location: z.string().trim().min(1).max(120).describe("City and optionally country, such as Pune, IN"),
  units: z.enum(["metric", "imperial"]).default("metric"),
});

const usageInputSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
});

export const CHAT_TOOL_SCHEMAS = [
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
  return {
    get_weather: tool({
      description: "Get current weather for a city using OpenWeather.",
      inputSchema: weatherInputSchema,
      execute: async ({ location, units }, { abortSignal }) => {
        const result = await fetchCurrentWeather({
          location,
          units,
          signal: abortSignal,
        });
        logStructuredEvent(
          result.ok ? "tool.weather.completed" : "tool.weather.failed",
          {
            chatId,
            ...(result.ok
              ? { location: result.location }
              : { errorCode: result.code }),
          },
        );
        return result;
      },
    }),
    get_recent_usage: tool({
      description:
        "Summarize recent token usage and response latency for this chat from the app's local runtime logs.",
      inputSchema: usageInputSchema,
      execute: async ({ limit }) => {
        if (process.env.NODE_ENV !== "development") {
          return {
            ok: false as const,
            error:
              "Usage history is only available in development because no persistent usage database is configured.",
          };
        }

        try {
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
              latencyMs: entry.latencyMs,
            }));

          return {
            ok: true as const,
            scope: "current chat",
            requestCount: requests.length,
            requests,
            storage: "development in-memory runtime logs",
          };
        } catch {
          logStructuredEvent("tool.usage.failed", { chatId });
          return {
            ok: false as const,
            error: "Local usage history could not be read.",
          };
        }
      },
    }),
  };
}
