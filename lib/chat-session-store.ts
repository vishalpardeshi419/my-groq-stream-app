import { isDeepStrictEqual } from "node:util";
import type { UIMessage } from "ai";
import { type QueryResultRow } from "pg";
import { getDatabasePool } from "@/lib/database";

export type PendingToolCall = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ChatSession = {
  chatId: string;
  messages: UIMessage[];
  pendingToolCalls: PendingToolCall[];
  stepCount: number;
  runTokenCount: number;
  status: "running" | "ready" | "awaiting_approval" | "failed";
};

type ChatSessionRow = QueryResultRow & {
  chat_id: string;
  messages: UIMessage[];
  pending_tool_calls: PendingToolCall[];
  step_count: number;
  run_token_count: number;
  status: ChatSession["status"];
  user_id: string | null;
};

type SessionTransition = {
  messages: UIMessage[];
  stepCount: number;
  runTokenCount: number;
};

type ToolInputValidator = (toolName: string, input: unknown) => unknown;
type ChatToolPart = Extract<
  UIMessage["parts"][number],
  { type: `tool-${string}` }
>;

function getPendingToolCalls(messages: UIMessage[]): PendingToolCall[] {
  const pending: PendingToolCall[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (
        isToolPart(part) &&
        part.state === "approval-requested" &&
        "input" in part &&
        "approval" in part &&
        part.approval
      ) {
        pending.push({
          approvalId: part.approval.id,
          toolCallId: part.toolCallId,
          toolName: part.type.slice("tool-".length),
          input: part.input,
        });
      }
    }
  }

  return pending;
}

function isToolPart(part: UIMessage["parts"][number]): part is ChatToolPart {
  return part.type.startsWith("tool-") && "toolCallId" in part;
}

function isPersistedJsonEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  };

  return isDeepStrictEqual(normalize(left), normalize(right));
}

function findToolPart(
  messages: UIMessage[],
  toolCallId: string,
): { messageIndex: number; partIndex: number; part: ChatToolPart } | undefined {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant") continue;

    const partIndex = message.parts.findIndex(
      (part) => isToolPart(part) && part.toolCallId === toolCallId,
    );
    if (partIndex !== -1) {
      const part = message.parts[partIndex];
      if (!isToolPart(part)) continue;
      return {
        messageIndex,
        partIndex,
        part,
      };
    }
  }
}

function expectNewUserMessage(messages: UIMessage[]) {
  if (
    messages.length !== 1 ||
    messages[0].role !== "user" ||
    messages[0].parts.length === 0
  ) {
    throw new Error("A new chat must start with one user message.");
  }
}

export function prepareSessionTransition(
  session: Pick<
    ChatSession,
    "messages" | "pendingToolCalls" | "stepCount" | "runTokenCount" | "status"
  > | null,
  incomingMessages: UIMessage[],
  validateToolInput: ToolInputValidator,
): SessionTransition {
  if (!session) {
    expectNewUserMessage(incomingMessages);
    return { messages: incomingMessages, stepCount: 0, runTokenCount: 0 };
  }

  if (session.status === "ready") {
    if (
      incomingMessages.length !== session.messages.length + 1 ||
      incomingMessages[incomingMessages.length - 1]?.role !== "user" ||
      !isPersistedJsonEqual(
        incomingMessages.slice(0, -1),
        session.messages,
      )
    ) {
      throw new Error("The submitted chat history does not match the saved session.");
    }

    return { messages: incomingMessages, stepCount: 0, runTokenCount: 0 };
  }

  if (
    session.status !== "awaiting_approval" ||
    session.pendingToolCalls.length === 0 ||
    incomingMessages.length !== session.messages.length
  ) {
    throw new Error("This chat session is not ready for that request.");
  }

  const expectedMessages = structuredClone(session.messages);
  let respondedCount = 0;

  for (const pendingToolCall of session.pendingToolCalls) {
    const storedPart = findToolPart(expectedMessages, pendingToolCall.toolCallId);
    const incomingPart = findToolPart(incomingMessages, pendingToolCall.toolCallId);
    const storedApproval =
      storedPart && "approval" in storedPart.part
        ? storedPart.part.approval
        : undefined;
    const incomingApproval =
      incomingPart && "approval" in incomingPart.part
        ? incomingPart.part.approval
        : undefined;

    if (
      !storedPart ||
      !incomingPart ||
      storedPart.part.state !== "approval-requested" ||
      !storedApproval ||
      storedApproval.id !== pendingToolCall.approvalId ||
      incomingPart.part.state !== "approval-responded" ||
      !incomingApproval ||
      incomingApproval.id !== pendingToolCall.approvalId ||
      typeof incomingApproval.approved !== "boolean"
    ) {
      throw new Error("The tool approval response does not match the pending action.");
    }

    const validatedInput = validateToolInput(
      pendingToolCall.toolName,
      incomingPart.part.input,
    );
    const expectedPart = {
      ...storedPart.part,
      input: validatedInput,
      state: "approval-responded" as const,
      approval: {
        ...storedApproval,
        approved: incomingApproval.approved,
        ...(incomingApproval.reason
          ? { reason: incomingApproval.reason }
          : {}),
      },
    };

    if (!isPersistedJsonEqual(expectedPart, incomingPart.part)) {
      throw new Error("The chat history contains changes beyond the approval decision.");
    }

    expectedMessages[storedPart.messageIndex].parts[storedPart.partIndex] =
      expectedPart;
    respondedCount += 1;
  }

  if (respondedCount !== session.pendingToolCalls.length) {
    throw new Error("All pending actions need an approval decision before resuming.");
  }

  if (!isPersistedJsonEqual(expectedMessages, incomingMessages)) {
    throw new Error("The chat history contains changes beyond the approval decision.");
  }

  return {
    messages: expectedMessages,
    stepCount: session.stepCount,
    runTokenCount: session.runTokenCount,
  };
}

function toChatSession(row: ChatSessionRow): ChatSession {
  return {
    chatId: row.chat_id,
    messages: row.messages,
    pendingToolCalls: row.pending_tool_calls,
    stepCount: row.step_count,
    runTokenCount: row.run_token_count,
    status: row.status,
  };
}

export async function getChatSession(chatId: string, userId: string | null) {
  const result = await getDatabasePool().query<ChatSessionRow>(
    `SELECT chat_id, messages, pending_tool_calls, step_count, run_token_count, status, user_id
     FROM chat_agent_sessions
     WHERE chat_id = $1 AND user_id IS NOT DISTINCT FROM $2`,
    [chatId, userId],
  );

  return result.rows[0] ? toChatSession(result.rows[0]) : null;
}

export async function beginChatRun(
  chatId: string,
  userId: string | null,
  incomingMessages: UIMessage[],
  validateToolInput: ToolInputValidator,
) {
  const client = await getDatabasePool().connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<ChatSessionRow>(
      `SELECT chat_id, messages, pending_tool_calls, step_count, run_token_count, status, user_id
       FROM chat_agent_sessions
       WHERE chat_id = $1 AND user_id IS NOT DISTINCT FROM $2
       FOR UPDATE`,
      [chatId, userId],
    );
    const existing = result.rows[0] ? toChatSession(result.rows[0]) : null;
    const transition = prepareSessionTransition(
      existing,
      incomingMessages,
      validateToolInput,
    );

    if (existing) {
      await client.query(
        `UPDATE chat_agent_sessions
         SET messages = $2, pending_tool_calls = '[]'::jsonb,
             step_count = $3, run_token_count = $4,
             status = 'running', updated_at = now()
         WHERE chat_id = $1 AND user_id IS NOT DISTINCT FROM $5`,
        [
          chatId,
          JSON.stringify(transition.messages),
          transition.stepCount,
          transition.runTokenCount,
          userId,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO chat_agent_sessions
          (chat_id, user_id, messages, pending_tool_calls, step_count, run_token_count, status)
         VALUES ($1, $2, $3, '[]'::jsonb, $4, $5, 'running')`,
        [
          chatId,
          userId,
          JSON.stringify(transition.messages),
          transition.stepCount,
          transition.runTokenCount,
        ],
      );
    }

    await client.query("COMMIT");
    return transition;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishChatRun({
  chatId,
  userId,
  messages,
  stepCount,
  runTokenCount,
}: {
  chatId: string;
  userId: string | null;
  messages: UIMessage[];
  stepCount: number;
  runTokenCount: number;
}) {
  const pendingToolCalls = getPendingToolCalls(messages);
  const status = pendingToolCalls.length > 0 ? "awaiting_approval" : "ready";
  const result = await getDatabasePool().query(
    `UPDATE chat_agent_sessions
     SET messages = $2, pending_tool_calls = $3, step_count = $4,
         run_token_count = $5, status = $6, updated_at = now()
     WHERE chat_id = $1 AND user_id IS NOT DISTINCT FROM $7 AND status = 'running'`,
    [
      chatId,
      JSON.stringify(messages),
      JSON.stringify(pendingToolCalls),
      stepCount,
      runTokenCount,
      status,
      userId,
    ],
  );

  if (result.rowCount !== 1) {
    throw new Error("The chat checkpoint could not be saved.");
  }
}
