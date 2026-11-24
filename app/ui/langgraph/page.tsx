"use client";

import { useEffect, useState } from "react";

export default function LangGraphEvaluationPage() {
  const [threadId, setThreadId] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [interrupt, setInterrupt] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("groq-langgraph-thread-id");
    const next = saved ?? crypto.randomUUID();
    window.localStorage.setItem("groq-langgraph-thread-id", next);
    setThreadId(next);
  }, []);

  async function start(message: string, resume?: { approved: boolean; reason?: string }) {
    if (!threadId) return;
    setLoading(true);
    setOutput([]);
    setInterrupt(null);

    const response = await fetch("/api/langgraph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, ...(resume ? { resume } : { message }) }),
    });
    if (!response.body) throw new Error("No stream returned.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("");
        if (!data) continue;
        const parsed = JSON.parse(data);
        setOutput((current) => [...current, JSON.stringify(parsed, null, 2)]);

        const interruptValue =
          parsed.tools?.__interrupt__ ??
          parsed.llm?.__interrupt__;
        if (interruptValue) setInterrupt(interruptValue);
      }
    }
    setLoading(false);
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">Day 19: LangGraph evaluation</h1>
      <p className="mt-2 text-sm text-gray-600">
        Thread: <code>{threadId}</code>
      </p>
      <form
        className="mt-6 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) void start(input);
          setInput("");
        }}
      >
        <input
          className="flex-1 border px-3 py-2"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Try: Refund order 123 for 5000"
        />
        <button className="border px-4 py-2" disabled={loading}>
          Run graph
        </button>
      </form>

      {interrupt && (
        <section className="mt-6 border border-amber-400 p-4">
          <h2 className="font-semibold">Human approval required</h2>
          <pre className="mt-2 overflow-auto text-xs">
            {JSON.stringify(interrupt, null, 2)}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              className="border px-3 py-2"
              onClick={() => void start("", { approved: true })}
            >
              Approve
            </button>
            <button
              className="border px-3 py-2"
              onClick={() =>
                void start("", {
                  approved: false,
                  reason: "Policy requires manager sign-off.",
                })
              }
            >
              Decline
            </button>
          </div>
        </section>
      )}

      <section className="mt-6 space-y-3">
        {output.map((item, index) => (
          <pre key={index} className="overflow-auto border p-3 text-xs">
            {item}
          </pre>
        ))}
      </section>
    </main>
  );
}
