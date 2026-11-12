import assert from "node:assert/strict";
import test from "node:test";
import {
  calculate,
  getCurrentTime,
  searchNotes,
} from "../lib/agent-tools";

test("calculator respects precedence, unary operators, and parentheses", () => {
  assert.deepEqual(calculate("-(2 + 3) * 4 / 2"), {
    expression: "-(2 + 3) * 4 / 2",
    result: -10,
  });
});

test("calculator rejects unsupported input and division by zero", () => {
  assert.throws(() => calculate("1 + process.exit()"), /unsupported character/);
  assert.throws(() => calculate("1 / (2 - 2)"), /Division by zero/);
  assert.throws(() => calculate("1 2"), /unexpected input/);
});

test("search_notes finds saved notes and returns an empty result for misses", () => {
  assert.deepEqual(searchNotes("meeting").results, [
    {
      title: "meeting",
      content: "Notes from Tuesday: review the launch checklist and assign follow-up owners.",
    },
  ]);
  assert.deepEqual(searchNotes("unknown").results, []);
});

test("get_time returns an ISO timestamp", () => {
  assert.doesNotThrow(() => new Date(getCurrentTime().timestamp).toISOString());
});
