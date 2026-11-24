import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentToolExecutor,
  getToolFaultInjectorFromEnv,
} from "../lib/agent-tool-executor";
import { calculate, searchNotes } from "../lib/agent-tools";
import { countTokens } from "gpt-tokenizer/model/gpt-oss-120b";

function createExecutor() {
  const reportedErrors: Array<{ toolName: string; error: unknown }> = [];
  const executeTool = createAgentToolExecutor((toolName, error) => {
    reportedErrors.push({ toolName, error });
  });
  return { executeTool, reportedErrors };
}

test("parallel duplicate calls execute the underlying tool only once", async () => {
  const { executeTool } = createExecutor();
  let executions = 0;

  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { result: 4 };
  };
  const results = await Promise.all([
    executeTool("calculator", { expression: "2 + 2" }, execute),
    executeTool("calculator", { expression: "2 + 2" }, execute),
  ]);

  assert.equal(executions, 1);
  assert.equal(results.filter((result) => "repeated" in result && result.repeated).length, 1);
});

test("a calculator call returns its result", async () => {
  const { executeTool } = createExecutor();
  assert.deepEqual(
    await executeTool("calculator", { expression: "2 + 2" }, () =>
      calculate("2 + 2"),
    ),
    { expression: "2 + 2", result: 4 },
  );
});

test("a saved-note lookup returns its result", async () => {
  const { executeTool } = createExecutor();
  assert.deepEqual(
    await executeTool("search_notes", { query: "meeting" }, () =>
      searchNotes("meeting"),
    ),
    {
      query: "meeting",
      results: [
        {
          title: "meeting",
          content:
            "Notes from Tuesday: review the launch checklist and assign follow-up owners.",
        },
      ],
    },
  );
});

test("a weather call returns unavailable data rather than fabricating it", async () => {
  const { executeTool } = createExecutor();
  assert.deepEqual(
    await executeTool("get_weather", { location: "Mumbai", units: "metric" }, () => ({
      ok: false,
      error: "Weather service is unavailable.",
      code: "unavailable",
      retryable: false,
    })),
    {
      ok: false,
      error: "Weather service is unavailable.",
      code: "unavailable",
      retryable: false,
    },
  );
});

test("different tools can be chained using an earlier result", async () => {
  const { executeTool } = createExecutor();
  const note = await executeTool("search_notes", { query: "meeting" }, () =>
    searchNotes("meeting"),
  );
  assert.ok(!("ok" in note));
  assert.ok("results" in note);
  const attendeeCount = note.results.length;
  assert.deepEqual(
    await executeTool(
      "calculator",
      { expression: `${attendeeCount} * 3` },
      () => calculate(`${attendeeCount} * 3`),
    ),
    { expression: "1 * 3", result: 3 },
  );
});

test("independent calls can run concurrently", async () => {
  const { executeTool } = createExecutor();
  const results = await Promise.all([
    executeTool("get_weather", { location: "Mumbai" }, async () => "Mumbai weather"),
    executeTool("get_weather", { location: "Delhi" }, async () => "Delhi weather"),
  ]);
  assert.deepEqual(results, ["Mumbai weather", "Delhi weather"]);
});

test("an impossible lookup can return an empty result without looping", async () => {
  const { executeTool } = createExecutor();
  assert.deepEqual(
    await executeTool("search_notes", { query: "secret recipe" }, () =>
      searchNotes("secret recipe"),
    ),
    { query: "secret recipe", results: [] },
  );
});

test("tool exceptions are reported and returned for the model to recover", async () => {
  const { executeTool, reportedErrors } = createExecutor();
  const failure = new Error("Division by zero is not allowed.");

  assert.deepEqual(
    await executeTool("calculator", { expression: "1 / 0" }, () =>
      calculate("1 / (2 - 2)"),
    ),
    {
      ok: false,
      error: "Division by zero is not allowed.",
      code: "tool-error",
      retryable: false,
    },
  );
  assert.deepEqual(reportedErrors, [
    { toolName: "calculator", error: failure },
  ]);
});

test("a non-Error tool failure is preserved as an actionable result", async () => {
  const { executeTool } = createExecutor();
  assert.deepEqual(
    await executeTool("get_time", {}, () => {
      throw "clock unavailable";
    }),
    {
      ok: false,
      error: "clock unavailable",
      code: "tool-error",
      retryable: false,
    },
  );
});

test("repeated calls with equivalent arguments are not executed again", async () => {
  const { executeTool } = createExecutor();
  let executions = 0;
  const firstResult = await executeTool(
    "search_notes",
    { query: "meeting", limit: 3 },
    () => {
      executions += 1;
      return { results: ["launch checklist"] };
    },
  );
  const duplicateResult = await executeTool(
    "search_notes",
    { limit: 3, query: "meeting" },
    () => {
      executions += 1;
      return { results: ["should not run"] };
    },
  );

  assert.equal(executions, 1);
  assert.deepEqual(duplicateResult, {
    ok: false,
    code: "repeated-call",
    retryable: false,
    repeated: true,
    error:
      "You already called this tool with these exact arguments. Use the previous result below and try a different approach.",
    previousResult: firstResult,
  });
});

test("retryable tool failures use exponential backoff and jitter", async () => {
  const delays: number[] = [];
  const events: string[] = [];
  const executeTool = createAgentToolExecutor(() => {}, {
    backoffBaseMs: 10,
    maxBackoffMs: 100,
    jitterMs: 5,
    random: () => 0.5,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    onEvent: ({ type }) => events.push(type),
  });
  let executions = 0;

  const result = await executeTool("get_weather", {}, async () => {
    executions += 1;
    return executions < 3
      ? {
          ok: false as const,
          error: "Temporary provider failure.",
          code: "http-503",
          retryable: true,
        }
      : { ok: true as const, temperature: 18 };
  });

  assert.deepEqual(result, { ok: true, temperature: 18 });
  assert.equal(executions, 3);
  assert.deepEqual(delays, [12, 22]);
  assert.equal(events.filter((event) => event === "retry").length, 2);
});

test("non-retryable failures are not retried", async () => {
  const { executeTool } = createExecutor();
  let executions = 0;

  const result = await executeTool("get_order_details", {}, async () => {
    executions += 1;
    return {
      ok: false as const,
      error: "Order not found.",
      code: "not-found",
      retryable: false,
    };
  });

  assert.equal(executions, 1);
  assert.equal("retryable" in result && result.retryable, false);
});

test("a timed-out execution aborts its signal and retries within the limit", async () => {
  let executions = 0;
  const executeTool = createAgentToolExecutor(() => {}, {
    timeoutMs: 5,
    maxRetries: 1,
    backoffBaseMs: 0,
    jitterMs: 0,
    sleep: async () => {},
  });

  const result = await executeTool(
    "get_weather",
    {},
    ({ signal }) => {
      executions += 1;
      if (executions > 1) return "recovered";
      return new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );

  assert.equal(result, "recovered");
  assert.equal(executions, 2);
});

test("oversized tool results are compacted to a bounded preview", async () => {
  const executeTool = createAgentToolExecutor(() => {}, {
    maxOutputTokens: 64,
  });
  const result = await executeTool("search_notes", {}, () => ({
    content: "launch checklist ".repeat(1_000),
  }));

  assert.ok(result && typeof result === "object" && "toolOutputTruncated" in result);
  assert.equal(
    countTokens(JSON.stringify(result)) <= 64,
    true,
  );
});

test("fault-injection mode and probability can be controlled per run", async () => {
  const injector = getToolFaultInjectorFromEnv(
    { AGENT_FAULT_MODE: "http-500", AGENT_FAULT_RATE: "0.5" },
    () => 0.25,
  );
  assert.ok(injector);
  const failure = await injector();
  assert.ok(failure instanceof Error);
  if (failure instanceof Error) {
    assert.equal("status" in failure && failure.status, 500);
  }

  const noFault = getToolFaultInjectorFromEnv(
    { AGENT_FAULT_MODE: "timeout", AGENT_FAULT_RATE: "0.5" },
    () => 0.75,
  );
  assert.equal(await noFault?.(), undefined);
  assert.equal(
    getToolFaultInjectorFromEnv(
      { AGENT_FAULT_MODE: "http-500", AGENT_FAULT_RATE: "2" },
      () => 0,
    ),
    undefined,
  );
});
