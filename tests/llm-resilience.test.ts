import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderFaultInjectorFromEnv,
  isTransientProviderError,
  runWithProviderFallback,
} from "../lib/llm";

test("provider retry classification limits fallback to transient failures", () => {
  assert.equal(isTransientProviderError({ statusCode: 429 }), true);
  assert.equal(isTransientProviderError({ status: 503 }), true);
  assert.equal(isTransientProviderError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientProviderError({ statusCode: 400 }), false);
  assert.equal(isTransientProviderError(new Error("invalid request")), false);
});

test("provider chaos mode can deterministically inject an upstream 500", () => {
  const injectFault = getProviderFaultInjectorFromEnv(
    { LLM_FAULT_MODE: "http-500", LLM_FAULT_RATE: "1" },
    () => 0,
  );
  assert.ok(injectFault);
  const error = injectFault();
  assert.ok(error instanceof Error);
  assert.equal(isTransientProviderError(error), true);

  const disabled = getProviderFaultInjectorFromEnv(
    { LLM_FAULT_MODE: "http-500", LLM_FAULT_RATE: "0" },
    () => 0,
  );
  assert.equal(disabled, undefined);
});

test("fallback receives the exact same messages and tool schemas", async () => {
  const params = {
    messages: [{ role: "assistant", content: "Use the same tool call." }],
    tools: { search_docs: { inputSchema: { type: "object" } } },
  };
  const events: string[] = [];
  const retries: Array<{ attempt: number; delayMs: number }> = [];
  let primaryParams: typeof params | undefined;
  let fallbackParams: typeof params | undefined;

  const result = await runWithProviderFallback(
    params,
    async (receivedParams) => {
      primaryParams = receivedParams;
      throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    },
    async (receivedParams) => {
      fallbackParams = receivedParams;
      return "recovered";
    },
    () => events.push("fallback"),
    {
      backoffBaseMs: 10,
      jitterMs: 5,
      random: () => 0.5,
      sleep: async () => {},
      onRetry: (_error, attempt, delayMs) =>
        retries.push({ attempt, delayMs }),
    },
  );

  assert.equal(result, "recovered");
  assert.equal(primaryParams, params);
  assert.equal(fallbackParams, params);
  assert.deepEqual(events, ["fallback"]);
  assert.deepEqual(retries, [
    { attempt: 1, delayMs: 12 },
    { attempt: 2, delayMs: 22 },
  ]);
});

test("non-transient provider errors are not sent to fallback", async () => {
  let fallbackCalls = 0;
  const error = Object.assign(new Error("invalid request"), {
    statusCode: 400,
  });

  await assert.rejects(
    runWithProviderFallback(
      { prompt: "hello" },
      async () => {
        throw error;
      },
      async () => {
        fallbackCalls += 1;
        return "unexpected";
      },
      () => {},
    ),
    error,
  );
  assert.equal(fallbackCalls, 0);
});
