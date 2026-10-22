'use client';

import { useState } from "react";
import { Square, Send } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";

type TokenAuditMetrics = {
  chatId: string;
  requestedAt: string;
  latencyMs: number;
  status: "completed" | "aborted" | "failed" | "rejected";
  estimatedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  partialOutputTokenEstimate?: number;
};

type ChatData = { "token-audit": TokenAuditMetrics };

export default function ChatComponent() {
  const [input, setInput] = useState("");
  const [auditMetrics, setAuditMetrics] = useState<TokenAuditMetrics | null>(null);
  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
  } = useChat<UIMessage<unknown, ChatData>>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onError: (err) => {
      console.error("UI Stream disconnect:", err);
    },
    onData(dataPart) {
      if (dataPart.type === "data-token-audit") {
        setAuditMetrics(dataPart.data);
      }
    },
  });

  const isLoading = status === "submitted" || status === "streaming";
  
  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto p-4">
      <header className="py-4 border-b mb-4">
        <h1 className="text-xl font-bold">Groq + Next.js Streaming Chat</h1>
        <p className="text-xs text-gray-500">
          Supports AbortController cancellation & partial state handling
        </p>
      </header>

      {auditMetrics && (
        <section
          aria-label="Latest request token metrics"
          aria-live="polite"
          className="grid grid-cols-2 gap-x-6 gap-y-1 border-b pb-3 mb-4 text-xs text-gray-600 dark:text-gray-400 sm:grid-cols-3"
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
          <span>Status: {auditMetrics.status}</span>
          <span>Requested: {new Date(auditMetrics.requestedAt).toLocaleString()}</span>
        </section>
      )}

      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${
              m.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-3 text-sm ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              <div className="whitespace-pre-wrap">
                {m.parts.map((part, index) =>
                  part.type === "text" ? (
                    <span key={`${m.id}-${index}`}>{part.text}</span>
                  ) : null,
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Error Display */}
        {error && (
          <div className="p-3 text-sm bg-red-100 text-red-600 rounded-lg">
            Stream connection failed. Please try sending your message again.
          </div>
        )}
      </div>

      {/* Input Form with Stop/Send Switcher */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || isLoading) return;
          setAuditMetrics(null);
          sendMessage({ text });
          setInput("");
        }}
        className="flex gap-2 pt-4 border-t mt-2"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="Ask Groq something..."
          className="flex-1 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-sm bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        {/* Controls toggled during stream generation */}
        {isLoading ? (
          <button
            type="button"
            onClick={stop} // Fires AbortController.abort() on the backend connection
            className="bg-red-500 hover:bg-red-600 text-white p-2 rounded-lg transition-colors flex items-center justify-center min-w-[40px]"
            title="Stop generation"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white p-2 rounded-lg transition-colors flex items-center justify-center min-w-[40px]"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </form>
    </div>
  );
}