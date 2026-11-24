import { isDeepStrictEqual } from "node:util";
import type { UIMessage } from "ai";
import { Pool, type QueryResultRow } from "pg";

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
  status: "running" | "ready" | "awaiting_approval" | "failed";
};

type ChatSessionRow = QueryResultRow & {
  chat_id: string;
  messages: UIMessage[];
  pending_tool_calls: PendingToolCall[];
  step_count: number;
  status: ChatSession["status"];
};

type SessionTransition = {
  messages: UIMessage[];
  stepCount: number;
};

type ToolInputValidator = (toolName: string, input: unknown) => unknown;

let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

function getPool() {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ??
      (process.env.NODE_ENV === "production"
        ? undefined
        : "postgresql://postgres:postgres@localhost:5432/rag_db");

    if (!connectionString) {
      throw new Error("DATABASE_URL must be configured for chat persistence.");
    }

    pool = new Pool({ connectionString, max: 5 });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS chat_agent_sessions (
          chat_id uuid PRIMARY KEY,
          messages jsonb NOT NULL,
          pending_tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
          step_count integer NOT NULL DEFAULT 0,
          status text NOT NULL CHECK (
            status IN ('running', 'ready', 'awaiting_approval', 'failed')
          ),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaPromise = undefined;
        throw error;
      });
  }

  await schemaPromise;
}

function getPendingToolCalls(messages: UIMessage[]): PendingToolCall[] {
  const pending: PendingToolCall[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) {
      if (
        part.type.startsWith("tool-") &&
        "state" in part &&
        part.state === "approval-requested" &&
        "input" in part &&
        "approval" in part
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

function findToolPart(
  messages: UIMessage[],
  toolCallId: string,
): { messageIndex: number; partIndex: number; part: UIMessage["parts"][number] } | undefined {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant") continue;

    const partIndex = message.parts.findIndex(
      (part) => part.type.startsWith("tool-") && part.toolCallId === toolCallId,
    );
    if (partIndex !== -1) {
      return {
        messageIndex,
        partIndex,
        part: message.parts[partIndex],
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
  session: Pick<ChatSession, "messages" | "pendingToolCalls" | "stepCount" | "status"> | null,
  incomingMessages: UIMessage[],
  validateToolInput: ToolInputValidator,
): SessionTransition {
  if (!session) {
    expectNewUserMessage(incomingMessages);
    return { messages: incomingMessages, stepCount: 0 };
  }

  if (session.status === "ready") {
    if (
      incomingMessages.length !== session.messages.length + 1 ||
      incomingMessages[incomingMessages.length - 1]?.role !== "user" ||
      !isDeepStrictEqual(
        incomingMessages.slice(0, -1),
        session.messages,
      )
    ) {
      throw new Error("The submitted chat history does not match the saved session.");
    }

    return { messages: incomingMessages, stepCount: 0 };
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

    if (
      !storedPart ||
      !incomingPart ||
      storedPart.part.state !== "approval-requested" ||
      !("approval" in storedPart.part) ||
      storedPart.part.approval.id !== pendingToolCall.approvalId ||
      incomingPart.part.state !== "approval-responded" ||
      !("approval" in incomingPart.part) ||
      incomingPart.part.approval.id !== pendingToolCall.approvalId ||
      typeof incomingPart.part.approval.approved !== "boolean"
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
        ...storedPart.part.approval,
        approved: incomingPart.part.approval.approved,
        ...(incomingPart.part.approval.reason
          ? { reason: incomingPart.part.approval.reason }
          : {}),
      },
    };

    if (!isDeepStrictEqual(expectedPart, incomingPart.part)) {
      throw new Error("The chat history contains changes beyond the approval decision.");
    }

    expectedMessages[storedPart.messageIndex].parts[storedPart.partIndex] =
      expectedPart;
    respondedCount += 1;
  }

  if (respondedCount !== session.pendingToolCalls.length) {
    throw new Error("All pending actions need an approval decision before resuming.");
  }

  if (!isDeepStrictEqual(expectedMessages, incomingMessages)) {
    throw new Error("The chat history contains changes beyond the approval decision.");
  }

  return { messages: expectedMessages, stepCount: session.stepCount };
}

function toChatSession(row: ChatSessionRow): ChatSession {
  return {
    chatId: row.chat_id,
    messages: row.messages,
    pendingToolCalls: row.pending_tool_calls,
    stepCount: row.step_count,
    status: row.status,
  };
}

export async function getChatSession(chatId: string) {
  await ensureSchema();
  const result = await getPool().query<ChatSessionRow>(
    `SELECT chat_id, messages, pending_tool_calls, step_count, status
     FROM chat_agent_sessions
     WHERE chat_id = $1`,
    [chatId],
  );

  return result.rows[0] ? toChatSession(result.rows[0]) : null;
}

export async function beginChatRun(
  chatId: string,
  incomingMessages: UIMessage[],
  validateToolInput: ToolInputValidator,
) {
  await ensureSchema();
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<ChatSessionRow>(
      `SELECT chat_id, messages, pending_tool_calls, step_count, status
       FROM chat_agent_sessions
       WHERE chat_id = $1
       FOR UPDATE`,
      [chatId],
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
             step_count = $3, status = 'running', updated_at = now()
         WHERE chat_id = $1`,
        [chatId, JSON.stringify(transition.messages), transition.stepCount],
      );
    } else {
      await client.query(
        `INSERT INTO chat_agent_sessions
          (chat_id, messages, pending_tool_calls, step_count, status)
         VALUES ($1, $2, '[]'::jsonb, $3, 'running')`,
        [chatId, JSON.stringify(transition.messages), transition.stepCount],
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
  messages,
  stepCount,
}: {
  chatId: string;
  messages: UIMessage[];
  stepCount: number;
}) {
  await ensureSchema();
  const pendingToolCalls = getPendingToolCalls(messages);
  const status = pendingToolCalls.length > 0 ? "awaiting_approval" : "ready";
  const result = await getPool().query(
    `UPDATE chat_agent_sessions
     SET messages = $2, pending_tool_calls = $3, step_count = $4,
         status = $5, updated_at = now()
     WHERE chat_id = $1 AND status = 'running'`,
    [
      chatId,
      JSON.stringify(messages),
      JSON.stringify(pendingToolCalls),
      stepCount,
      status,
    ],
  );

  if (result.rowCount !== 1) {
    throw new Error("The chat checkpoint could not be saved.");
  }
}
