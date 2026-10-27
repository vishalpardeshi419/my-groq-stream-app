import type { ModelMessage } from "ai";
import {
  countChatCompletionTokens,
  countTokens,
} from "gpt-tokenizer/model/gpt-oss-120b";
import type { ChatMessage } from "gpt-tokenizer/functionCalling";

export const TOKEN_PREFLIGHT_SAFETY_MARGIN = 1_024;

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
