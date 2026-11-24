import type { ModelMessage } from "ai";
import {
  countChatCompletionTokens,
  countTokens,
} from "gpt-tokenizer/model/gpt-oss-120b";
import type { ChatMessage } from "gpt-tokenizer/functionCalling";

export const TOKEN_PREFLIGHT_SAFETY_MARGIN = 1_024;
export const MAX_TOOL_RESULT_HISTORY_TOKENS = 1_024;

export type TokenPreflightEstimate = {
  estimatedInputTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
  safetyMarginTokens: number;
};

function getMessageText(message: ModelMessage): string | null {
  if (typeof message.content === "string") return message.content;

  let text = "";
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      text += part.text;
    } else if (part.type.startsWith("tool-")) {
      text += JSON.stringify(part);
    } else {
      return null;
    }
  }
  return text;
}

export function compactToolResultHistory(
  messages: ModelMessage[],
  maxResultTokens = MAX_TOOL_RESULT_HISTORY_TOKENS,
) {
  let compactedCount = 0;
  const preserveRecentMessagesFrom = Math.max(0, messages.length - 4);
  const compactedMessages = messages.map((message, index) => {
    if (message.role !== "tool" || index >= preserveRecentMessagesFrom) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || !("output" in part)) return part;
        const output = part.output;
        if (
          !output ||
          typeof output !== "object" ||
          !("type" in output) ||
          output.type !== "json" ||
          !("value" in output)
        ) {
          return part;
        }

        const serialized = JSON.stringify(output.value);
        if (countTokens(serialized) <= maxResultTokens) return part;

        compactedCount += 1;
        const createCompactValue = (preview: string) => ({
          toolOutputTruncated: true,
          originalCharacters: serialized.length,
          preview,
          message:
            "An older tool result was shortened to protect the conversation context.",
        });
        let low = 0;
        let high = serialized.length;
        let compactValue = createCompactValue("");
        while (low <= high) {
          const midpoint = Math.floor((low + high) / 2);
          const candidate = createCompactValue(
            serialized.slice(0, midpoint),
          );
          if (countTokens(JSON.stringify(candidate)) <= maxResultTokens) {
            compactValue = candidate;
            low = midpoint + 1;
          } else {
            high = midpoint - 1;
          }
        }

        return {
          ...part,
          output: {
            type: "json" as const,
            value: compactValue,
          },
        };
      }),
    };
  });

  return { messages: compactedMessages, compactedCount };
}

export function estimateInputTokens({
  messages,
  systemPrompt,
  toolSchemas,
}: {
  messages: ModelMessage[];
  systemPrompt: string;
  toolSchemas: unknown;
}): TokenPreflightEstimate | null {
  const tokenMessages: ChatMessage[] = [{
    role: "system",
    content: systemPrompt,
  }];

  for (const message of messages) {
    const content = getMessageText(message);
    if (content === null) return null;
    tokenMessages.push({ role: message.role, content });
  }

  if (!countChatCompletionTokens) {
    throw new Error("The gpt-oss tokenizer does not support chat token counts.");
  }

  const messageTokens = countChatCompletionTokens({ messages: tokenMessages });
  const toolSchemaTokens = countTokens(JSON.stringify(toolSchemas));

  return {
    estimatedInputTokens:
      messageTokens + toolSchemaTokens + TOKEN_PREFLIGHT_SAFETY_MARGIN,
    messageTokens,
    toolSchemaTokens,
    safetyMarginTokens: TOKEN_PREFLIGHT_SAFETY_MARGIN,
  };
}

export function isWithinInputTokenBudget(
  estimate: number,
  budget: number,
) {
  return Number.isFinite(estimate) && estimate <= budget;
}
