'use client';

import { useState } from "react";
import { FileText, Square, Send } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type TokenAuditMetrics = {
  requestId: string;
  chatId: string;
  requestedAt: string;
  latencyMs: number;
  status: "completed" | "aborted" | "failed" | "rejected";
  estimatedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  partialOutputTokenEstimate?: number;
};

type RagSource = {
  citation: number;
  source: string;
  chunkIndex: number;
  rrfScore: number;
};

type ChatData = {
  "token-audit": TokenAuditMetrics;
  "rag-sources": RagSource[];
};

export default function ChatComponent() {
  const [input, setInput] = useState("");
  const [useKnowledgeBase, setUseKnowledgeBase] = useState(true);
  const [auditMetrics, setAuditMetrics] = useState<TokenAuditMetrics | null>(null);
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
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
      } else if (dataPart.type === "data-rag-sources") {
        setRagSources(dataPart.data);
      }
    },
  });

  const isLoading = status === "submitted" || status === "streaming";
  
  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto p-4">
      <header className="py-4 border-b mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Groq + Next.js Streaming Chat</h1>
            <p className="text-xs text-gray-500">
              Supports AbortController cancellation & partial state handling
            </p>
          </div>
          <a
            href="/logs"
            className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            <FileText aria-hidden="true" className="h-4 w-4" />
            Logs
          </a>
        </div>
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
        {messages.map((m) => {
          const text = m.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");

          return (
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
              {m.role === "assistant" ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => (
                      <p className="mb-3 last:mb-0 leading-7">{children}</p>
                    ),
                    h1: ({ children }) => (
                      <h1 className="mb-3 mt-5 text-xl font-bold first:mt-0">
                        {children}
                      </h1>
                    ),
                    h2: ({ children }) => (
                      <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">
                        {children}
                      </h2>
                    ),
                    h3: ({ children }) => (
                      <h3 className="mb-2 mt-4 font-semibold first:mt-0">
                        {children}
                      </h3>
                    ),
                    ul: ({ children }) => (
                      <ul className="my-3 list-disc space-y-1 pl-6">
                        {children}
                      </ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="my-3 list-decimal space-y-2 pl-6">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => (
                      <li className="pl-1 leading-7">{children}</li>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="my-3 border-l-4 border-gray-400 pl-4 text-gray-600 dark:text-gray-300">
                        {children}
                      </blockquote>
                    ),
                    pre: ({ children }) => (
                      <pre className="my-3 overflow-x-auto rounded-lg bg-gray-900 p-4 text-gray-100">
                        {children}
                      </pre>
                    ),
                    code: ({ className, children, ...props }) => (
                      <code
                        className={
                          className
                            ? `${className} font-mono text-sm`
                            : "rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/10"
                        }
                        {...props}
                      >
                        {children}
                      </code>
                    ),
                    table: ({ children }) => (
                      <div className="my-3 overflow-x-auto">
                        <table className="w-full border-collapse text-left">
                          {children}
                        </table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border border-gray-300 px-3 py-2 font-semibold dark:border-gray-600">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border border-gray-300 px-3 py-2 dark:border-gray-600">
                        {children}
                      </td>
                    ),
                    a: ({ children, ...props }) => (
                      <a
                        className="text-blue-700 underline underline-offset-2 dark:text-blue-300"
                        {...props}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {text}
                </ReactMarkdown>
              ) : (
                <div className="whitespace-pre-wrap leading-6">{text}</div>
              )}
            </div>
          </div>
          );
        })}

        {ragSources.length > 0 && (
          <section
            aria-label="Sources used for the latest answer"
            className="rounded-lg border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400"
          >
            <h2 className="mb-2 font-semibold">PDF sources</h2>
            <ul className="space-y-1">
              {ragSources.map((source) => (
                <li key={`${source.citation}-${source.source}-${source.chunkIndex}`}>
                  [{source.citation}] {source.source}, chunk {source.chunkIndex}
                  {" · "}
                  RRF score {source.rrfScore.toFixed(4)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Error Display */}
        {error && (
          <div className="p-3 text-sm bg-red-100 text-red-600 rounded-lg">
            {error.message || "Stream connection failed. Please try again."}
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
          setRagSources([]);
          sendMessage({ text }, { body: { useKnowledgeBase } });
          setInput("");
        }}
        className="flex flex-col gap-3 pt-4 border-t mt-2"
      >
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={useKnowledgeBase}
            onChange={(event) => setUseKnowledgeBase(event.currentTarget.checked)}
            className="accent-blue-600"
          />
          Use PDF knowledge base
          <span className="text-xs">(uncheck for regular Groq chat)</span>
        </label>

        <div className="flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder={
              useKnowledgeBase
                ? "Ask a question about your PDF..."
                : "Ask Groq something..."
            }
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
        </div>
      </form>
    </div>
  );
}