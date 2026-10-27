import assert from "node:assert/strict";
import test from "node:test";
import { isStepCount } from "ai";
import type { ModelMessage } from "ai";
import { MAX_TOOL_STEPS } from "../lib/chat-tool-config";
import {
  estimateInputTokens,
  isWithinInputTokenBudget,
  TOKEN_PREFLIGHT_SAFETY_MARGIN,
} from "../lib/token-preflight";

const systemPrompt = "Be helpful. Use tools only when useful.";
const toolSchemas = [
  {
    name: "get_weather",
    inputSchema: { type: "object", properties: { location: { type: "string" } } },
  },
];

test("preflight counts system/message text, tool schemas, and safety reserve", () => {
  const estimate = estimateInputTokens({
    systemPrompt,
    toolSchemas,
    messages: [{ role: "user", content: "Weather in Pune?" }],
  });

  assert.ok(estimate);
  assert.ok(estimate.messageTokens > 0);
  assert.ok(estimate.toolSchemaTokens > 0);
  assert.equal(estimate.safetyMarginTokens, TOKEN_PREFLIGHT_SAFETY_MARGIN);
  assert.equal(
    estimate.estimatedInputTokens,
    estimate.messageTokens +
      estimate.toolSchemaTokens +
      TOKEN_PREFLIGHT_SAFETY_MARGIN,
  );
});

test("preflight counts assistant reasoning and tool call/result history", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Call weather for Pune." },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "get_weather",
          input: { location: "Pune, IN" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "get_weather",
          output: { type: "json", value: { ok: true, temperature: 31 } },
        },
      ],
    },
  ];

  const estimate = estimateInputTokens({ messages, systemPrompt, toolSchemas });
  assert.ok(estimate);
  assert.ok(estimate.messageTokens > 0);
});

test("preflight rejects unsupported image content instead of undercounting", () => {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      ],
    },
  ];

  assert.equal(
    estimateInputTokens({ messages, systemPrompt, toolSchemas }),
    null,
  );
});

test("input budget includes exactly-at-limit requests and rejects overflow", () => {
  const estimate = estimateInputTokens({
    messages: [{ role: "user", content: "A boundary test." }],
    systemPrompt,
    toolSchemas,
  });

  assert.ok(estimate);
  assert.equal(
    isWithinInputTokenBudget(estimate.estimatedInputTokens, estimate.estimatedInputTokens),
    true,
  );
  assert.equal(
    isWithinInputTokenBudget(estimate.estimatedInputTokens, estimate.estimatedInputTokens - 1),
    false,
  );
});

test("the shared stop condition allows at most five model/tool steps", async () => {
  const stopWhen = isStepCount(MAX_TOOL_STEPS);
  const steps = (length: number) => Array.from({ length }, () => ({})) as never[];

  assert.equal(await stopWhen({ steps: steps(MAX_TOOL_STEPS - 1) }), false);
  assert.equal(await stopWhen({ steps: steps(MAX_TOOL_STEPS) }), true);
});
