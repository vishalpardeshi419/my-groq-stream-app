import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { createAgentToolExecutor } from "../lib/agent-tool-executor";
import {
  calculate,
  getCurrentTime,
  getOrderDetails,
  searchNotes,
  searchRefundPolicy,
} from "../lib/agent-tools";
import { prepareSessionTransition } from "../lib/chat-session-store";
import { createChatTools } from "../lib/chat-tools";

type ChaosTask = {
  name: string;
  run: () => Promise<unknown>;
};

function createApprovalMessages(approved: boolean) {
  const pendingPart: UIMessage["parts"][number] = {
    type: "tool-refund_order",
    toolCallId: "refund-call",
    state: "approval-requested",
    input: { orderId: "123", amount: 5_000 },
    approval: { id: "refund-approval" },
  };
  const storedMessages: UIMessage[] = [
    { id: "assistant-1", role: "assistant", parts: [pendingPart] },
  ];
  const respondedPart: UIMessage["parts"][number] = {
    ...pendingPart,
    state: "approval-responded",
    approval: { id: "refund-approval", approved },
  };
  const incomingMessages: UIMessage[] = [
    { id: "assistant-1", role: "assistant", parts: [respondedPart] },
  ];

  return {
    session: {
      messages: storedMessages,
      pendingToolCalls: [
        {
          approvalId: "refund-approval",
          toolCallId: "refund-call",
          toolName: "refund_order",
          input: { orderId: "123", amount: 5_000 },
        },
      ],
      stepCount: 2,
      runTokenCount: 120,
      status: "awaiting_approval" as const,
    },
    incomingMessages,
  };
}

test("ten Day 18-style tool and approval scenarios recover without stack traces", async () => {
  const trace: string[] = [];
  const attemptCounts = new Map<string, number>();
  const executeTool = createAgentToolExecutor(() => {}, {
    maxOutputTokens: 128,
    backoffBaseMs: 0,
    jitterMs: 0,
    sleep: async () => {},
    injectFault: (toolName, _input, attempt) => {
      attemptCounts.set(toolName, attempt);
      if (toolName === "get_time" && attempt === 1) {
        return Object.assign(new Error("Simulated HTTP 500."), {
          code: "http-500",
          status: 500,
          retryable: true,
        });
      }
      if (toolName === "search_notes") {
        return {
          type: "bloated-output",
          message: "Injected oversized result.",
        };
      }
      if (toolName === "get_weather" && attempt === 1) {
        return Object.assign(new Error("Simulated timeout."), {
          name: "TimeoutError",
        });
      }
      return undefined;
    },
    onEvent: ({ type, toolName }) => trace.push(`${toolName}:${type}`),
  });

  const tasks: ChaosTask[] = [
    {
      name: "current time",
      run: () => executeTool("get_time", {}, () => getCurrentTime()),
    },
    {
      name: "calculator",
      run: () =>
        executeTool("calculator", { expression: "2 + 2" }, () =>
          calculate("2 + 2"),
        ),
    },
    {
      name: "saved notes with oversized output",
      run: () =>
        executeTool("search_notes", { query: "meeting" }, () =>
          searchNotes("meeting"),
        ),
    },
    {
      name: "weather after timeout",
      run: () =>
        executeTool("get_weather", { location: "Pune" }, async () => ({
          ok: true,
          location: "Pune",
          temperature: 24,
        })),
    },
    {
      name: "recent usage",
      run: () =>
        executeTool("get_recent_usage", { limit: 5 }, () => ({
          ok: true,
          requestCount: 1,
          requests: [{ status: "completed", totalRunTokens: 120 }],
        })),
    },
    {
      name: "refund policy",
      run: () =>
        executeTool("search_refund_policy", { query: "eligibility" }, () =>
          searchRefundPolicy("eligibility"),
        ),
    },
    {
      name: "existing order",
      run: () =>
        executeTool("get_order_details", { orderId: "123" }, () =>
          getOrderDetails("123"),
        ),
    },
    {
      name: "missing order",
      run: () =>
        executeTool("get_order_details", { orderId: "404" }, () =>
          getOrderDetails("404"),
        ),
    },
    {
      name: "declined refund approval",
      run: async () => {
        const { session, incomingMessages } = createApprovalMessages(false);
        return prepareSessionTransition(
          session,
          incomingMessages,
          (_toolName, input) => input,
        );
      },
    },
    {
      name: "approved refund approval",
      run: async () => {
        const { session, incomingMessages } = createApprovalMessages(true);
        return prepareSessionTransition(
          session,
          incomingMessages,
          (_toolName, input) => input,
        );
      },
    },
  ];

  const taskResults = new Map<string, unknown>();
  for (const task of tasks) {
    const result = await task.run();
    taskResults.set(task.name, result);
    assert.doesNotMatch(
      JSON.stringify(result),
      /(?:Error:|at\s+\S+\s+\()/,
      `${task.name} leaked a stack trace`,
    );
  }

  const notesResult = taskResults.get("saved notes with oversized output");
  assert.ok(
    notesResult &&
      typeof notesResult === "object" &&
      "toolOutputTruncated" in notesResult,
  );
  assert.equal(trace.includes("get_time:retry"), true);
  assert.equal(trace.includes("get_weather:retry"), true);
  assert.equal(trace.includes("search_notes:compacted"), true);
  const declinedApproval = taskResults.get("declined refund approval");
  assert.ok(
    declinedApproval &&
      typeof declinedApproval === "object" &&
      "runTokenCount" in declinedApproval,
  );
  if (
    declinedApproval &&
    typeof declinedApproval === "object" &&
    "runTokenCount" in declinedApproval
  ) {
    assert.equal(declinedApproval.runTokenCount, 120);
  }

  const refundTool = createChatTools("00000000-0000-4000-8000-000000000001")
    .refund_order;
  assert.equal(refundTool.needsApproval, true);
});
