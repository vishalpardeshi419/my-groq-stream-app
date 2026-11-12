import assert from "node:assert/strict";
import test from "node:test";
import { createAgentToolExecutor } from "../lib/agent-tool-executor";
import { calculate, searchNotes } from "../lib/agent-tools";

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
    })),
    { ok: false, error: "Weather service is unavailable." },
  );
});

test("different tools can be chained using an earlier result", async () => {
  const { executeTool } = createExecutor();
  const note = await executeTool("search_notes", { query: "meeting" }, () =>
    searchNotes("meeting"),
  );
  assert.ok(!("ok" in note));
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
    { ok: false, error: "Division by zero is not allowed." },
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
    { ok: false, error: "clock unavailable" },
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
    repeated: true,
    error:
      "You already called this tool with these exact arguments. Use the previous result below and try a different approach.",
    previousResult: firstResult,
  });
});
