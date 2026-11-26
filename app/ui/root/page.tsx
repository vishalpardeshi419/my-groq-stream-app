"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Pencil, Send, ShieldAlert, Square, X } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { authClient } from "@/lib/auth-client";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";

type TokenAuditMetrics = {
  requestId: string;
  chatId: string;
  requestedAt: string;
  latencyMs: number;
  status: "completed" | "aborted" | "failed" | "rejected";
  estimatedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalRunTokens: number | null;
  maxRunTokens: number;
  tokenBudgetExceeded: boolean;
  cumulativeRunTokens?: number | null;
  partialOutputTokenEstimate?: number;
};

type ChatData = { "token-audit": TokenAuditMetrics };
type ChatMessage = UIMessage<unknown, ChatData>;
type ChatToolPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

const defaultDeclineReason =
  "Policy requires manager sign-off for amounts over ₹1,000.";

function isToolPart(
  part: ChatMessage["parts"][number],
): part is ChatToolPart {
  return part.type.startsWith("tool-") && "toolCallId" in part;
}

function partInput(part: ChatMessage["parts"][number]) {
  return isToolPart(part) && "input" in part ? part.input : undefined;
}

export default function ChatComponent() {
  const router = useRouter();
  const { data: authSession, isPending: isAuthPending } = authClient.useSession();
  const [input, setInput] = useState("");
  const [auditMetrics, setAuditMetrics] = useState<TokenAuditMetrics | null>(null);
  const [chatId, setChatId] = useState("");
  const [loadedOwnerKey, setLoadedOwnerKey] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [editedInputs, setEditedInputs] = useState<Record<string, string>>({});
  const [declineReason, setDeclineReason] = useState(defaultDeclineReason);
  const transport = useMemo(
    () => new DefaultChatTransport<ChatMessage>({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { chatId, messages },
      }),
    }),
    [chatId],
  );
  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
    setMessages,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (err) => {
      console.error("UI Stream disconnect:", err);
    },
    onData(dataPart) {
      if (dataPart.type === "data-token-audit") {
        setAuditMetrics(dataPart.data);
      }
    },
  });

  useEffect(() => {
    if (isAuthPending) return;

    const ownerKey = authSession?.user.id ?? "anonymous";
    const storageKey = authSession?.user.id
      ? `groq-stream-chat-id:${authSession.user.id}`
      : "groq-stream-chat-id";
    const savedChatId = window.localStorage.getItem(storageKey);
    const nextChatId = savedChatId ?? window.crypto.randomUUID();
    window.localStorage.setItem(storageKey, nextChatId);
    fetch(`/api/chat?chatId=${encodeURIComponent(nextChatId)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Unable to load the saved conversation.");
        }
        return (await response.json()) as { messages: ChatMessage[] };
      })
      .then(({ messages: savedMessages }) => {
        setMessages(savedMessages);
        setRestoreError("");
      })
      .catch((restoreError: unknown) => {
        setRestoreError(
          restoreError instanceof Error
            ? restoreError.message
            : "Unable to load the saved conversation.",
        );
      })
      .finally(() => {
        setChatId(nextChatId);
        setLoadedOwnerKey(ownerKey);
      });
  }, [authSession?.user.id, isAuthPending, setMessages]);

  const isRestoring =
    isAuthPending ||
    loadedOwnerKey !== (authSession?.user.id ?? "anonymous");
  const isLoading = status === "submitted" || status === "streaming";
  const pendingApproval = messages.some((message) =>
    message.parts.some(
      (part) => isToolPart(part) && part.state === "approval-requested",
    ),
  );

  async function respondToApproval({
    approvalId,
    approved,
    reason,
    editedInput,
  }: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    editedInput?: unknown;
  }) {
    if (editedInput !== undefined) {
      setMessages((currentMessages) =>
        currentMessages.map((message) => ({
          ...message,
          parts: message.parts.map((part) => {
            if (
              !isToolPart(part) ||
              part.state !== "approval-requested" ||
              part.approval.id !== approvalId
            ) {
              return part;
            }
            return { ...part, input: editedInput };
          }),
        })),
      );
    }

    try {
      await addToolApprovalResponse({
        id: approvalId,
        approved,
        ...(reason ? { reason } : {}),
      });
      setEditingApprovalId(null);
    } catch (approvalError) {
      setRestoreError(
        approvalError instanceof Error
          ? approvalError.message
          : "Unable to submit the approval decision.",
      );
    }
  }

  return (
    <div className="flex h-screen max-w-3xl flex-col mx-auto p-4">
      <header className="mb-4 border-b py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Groq + Next.js Streaming Chat</h1>
            <p className="text-xs text-gray-500">
              Risky actions pause for your approval and resume from a saved chat.
            </p>
          </div>
          <a
            href="/logs"
            className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            <FileText aria-hidden="true" className="h-4 w-4" />
            Logs
          </a>
          <div className="flex items-center gap-3 text-sm">
            {isAuthPending ? (
              <span className="text-gray-500" role="status">Checking session…</span>
            ) : authSession ? (
              <>
                <a
                  href="/account/security"
                  className="text-blue-600 hover:underline"
                >
                  Security
                </a>
                <span className="hidden text-gray-500 sm:inline">
                  {authSession.user.email}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const result = await authClient.signOut();
                      if (result.error) {
                        setRestoreError("Unable to sign out. Please try again.");
                        return;
                      }
                      router.replace("/login");
                    } catch {
                      setRestoreError("Unable to sign out. Please try again.");
                    }
                  }}
                  className="text-blue-600 hover:underline"
                >
                  Sign out
                </button>
              </>
            ) : (
              <a href="/login" className="text-blue-600 hover:underline">
                Sign in
              </a>
            )}
          </div>
        </div>
      </header>

      {auditMetrics && (
        <section
          aria-label="Latest request token metrics"
          aria-live="polite"
          className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 border-b pb-3 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-3"
        >
          <span>
            Input: {auditMetrics.inputTokens ?? auditMetrics.estimatedInputTokens ?? "N/A"}
            {auditMetrics.inputTokens == null ? " estimated" : " tokens"}
          </span>
          <span>
            Output: {auditMetrics.outputTokens ?? auditMetrics.partialOutputTokenEstimate ?? "N/A"}
            {auditMetrics.outputTokens == null ? " estimated" : " tokens"}
          </span>
          <span>Latency: {auditMetrics.latencyMs} ms</span>
          <span>
            Run tokens: {auditMetrics.totalRunTokens ?? "N/A"} / {auditMetrics.maxRunTokens}
          </span>
          {auditMetrics.tokenBudgetExceeded && <span>Token budget reached</span>}
          <span>Status: {auditMetrics.status}</span>
          <span>Requested: {new Date(auditMetrics.requestedAt).toLocaleString()}</span>
        </section>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto pr-2">
        {isRestoring && (
          <p className="text-sm text-gray-500" role="status">
            Loading saved conversation…
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[90%] rounded-lg p-3 text-sm ${
                message.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <p
                      key={`${message.id}-${index}`}
                      className="whitespace-pre-wrap"
                    >
                      {part.text}
                    </p>
                  );
                }

                if (!isToolPart(part)) return null;

                const toolName = part.type.slice("tool-".length);
                const toolInput = partInput(part);
                const approval =
                  "approval" in part ? part.approval : undefined;
                const isAwaitingApproval =
                  part.state === "approval-requested" && approval != null;

                return (
                  <section
                    key={`${message.id}-${part.toolCallId}`}
                    className="mt-3 min-w-64 rounded-md border border-gray-300 bg-white p-3 text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    aria-label={`Tool ${toolName}`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {isAwaitingApproval && (
                        <ShieldAlert className="h-4 w-4 text-amber-600" />
                      )}
                      <span>{toolName}</span>
                      {isAwaitingApproval && (
                        <span className="ml-auto text-xs text-amber-700 dark:text-amber-400">
                          Approval required
                        </span>
                      )}
                    </div>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">
                      {JSON.stringify(toolInput, null, 2)}
                    </pre>

                    {isAwaitingApproval && (
                      <div className="mt-3 space-y-2 border-t pt-3">
                        {editingApprovalId === approval.id ? (
                          <>
                            <label
                              className="block text-xs font-medium"
                              htmlFor={`tool-input-${approval.id}`}
                            >
                              Edit arguments (JSON)
                            </label>
                            <textarea
                              id={`tool-input-${approval.id}`}
                              value={
                                editedInputs[approval.id] ??
                                JSON.stringify(toolInput, null, 2)
                              }
                              onChange={(event) =>
                                setEditedInputs((current) => ({
                                  ...current,
                                  [approval.id]: event.currentTarget.value,
                                }))
                              }
                              rows={5}
                              className="w-full rounded border border-gray-300 bg-transparent p-2 font-mono text-xs dark:border-gray-700"
                            />
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => {
                                  try {
                                    const nextInput = JSON.parse(
                                      editedInputs[approval.id] ??
                                        JSON.stringify(toolInput),
                                    ) as unknown;
                                    void respondToApproval({
                                      approvalId: approval.id,
                                      approved: true,
                                      editedInput: nextInput,
                                    });
                                  } catch {
                                    setRestoreError(
                                      "Edited arguments must be valid JSON.",
                                    );
                                  }
                                }}
                                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                              >
                                <Check className="h-3.5 w-3.5" />
                                Approve edited action
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingApprovalId(null)}
                                className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
                              >
                                <X className="h-3.5 w-3.5" />
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <label
                              className="block text-xs font-medium"
                              htmlFor={`decline-reason-${approval.id}`}
                            >
                              If rejecting, tell the assistant why
                            </label>
                            <textarea
                              id={`decline-reason-${approval.id}`}
                              value={declineReason}
                              onChange={(event) =>
                                setDeclineReason(event.currentTarget.value)
                              }
                              rows={2}
                              className="w-full rounded border border-gray-300 bg-transparent p-2 text-xs dark:border-gray-700"
                            />
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() =>
                                  void respondToApproval({
                                    approvalId: approval.id,
                                    approved: true,
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                              >
                                <Check className="h-3.5 w-3.5" />
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingApprovalId(approval.id)}
                                className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                Edit
                              </button>
                              <button
                                type="button"
                                disabled={isLoading || !declineReason.trim()}
                                onClick={() =>
                                  void respondToApproval({
                                    approvalId: approval.id,
                                    approved: false,
                                    reason: `User declined: ${declineReason.trim()}`,
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                              >
                                <X className="h-3.5 w-3.5" />
                                Reject
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {part.state === "output-available" && (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border-t pt-2 text-xs">
                        {JSON.stringify(part.output, null, 2)}
                      </pre>
                    )}
                    {part.state === "output-error" && (
                      <p className="mt-2 border-t pt-2 text-xs text-red-600">
                        {part.errorText}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        ))}

        {(error || restoreError) && (
          <div className="rounded-lg bg-red-100 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {restoreError || "Stream connection failed. Please try again."}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || isLoading || isRestoring || pendingApproval || !chatId) {
            return;
          }
          setAuditMetrics(null);
          setRestoreError("");
          void sendMessage({ text });
          setInput("");
        }}
        className="mt-2 flex gap-2 border-t pt-4"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder={
            pendingApproval
              ? "Respond to the pending action above"
              : "Ask Groq something..."
          }
          disabled={isRestoring || pendingApproval}
          className="flex-1 rounded-lg border border-gray-300 bg-transparent px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 dark:border-gray-700"
        />

        {isLoading ? (
          <button
            type="button"
            onClick={stop}
            className="flex min-w-[40px] items-center justify-center rounded-lg bg-red-500 p-2 text-white transition-colors hover:bg-red-600"
            title="Stop generation"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || isRestoring || pendingApproval || !chatId}
            className="flex min-w-[40px] items-center justify-center rounded-lg bg-blue-600 p-2 text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </form>
    </div>
  );
}
