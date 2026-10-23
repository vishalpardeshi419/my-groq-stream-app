'use client';

import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, Search, Trash2 } from "lucide-react";
import type { RuntimeLogEntry } from "@/lib/runtime-logs";

export default function LogsPage() {
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refreshLogs = async () => {
      setRefreshing(true);
      try {
        const response = await fetch("/api/logs", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "Runtime log viewing is available only in development."
              : "Could not load runtime logs.",
          );
        }
        const result: { logs: RuntimeLogEntry[] } = await response.json();
        if (active) {
          setLogs(result.logs);
          setError(null);
        }
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load runtime logs.",
          );
        }
      } finally {
        if (active) setRefreshing(false);
      }
    };

    void refreshLogs();
    const interval = autoRefresh
      ? window.setInterval(() => void refreshLogs(), 3_000)
      : undefined;

    return () => {
      active = false;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [autoRefresh, refreshVersion]);

  const events = Array.from(new Set(logs.map((entry) => entry.event))).sort();
  const normalizedSearch = search.trim().toLowerCase();
  const filteredLogs = logs.filter((entry) => {
    if (eventFilter !== "all" && entry.event !== eventFilter) return false;
    if (!normalizedSearch) return true;
    return JSON.stringify(entry).toLowerCase().includes(normalizedSearch);
  });

  async function clearLogs() {
    try {
      const response = await fetch("/api/logs", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not clear runtime logs.");
      setLogs([]);
      setError(null);
    } catch (clearError) {
      setError(
        clearError instanceof Error
          ? clearError.message
          : "Could not clear runtime logs.",
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-black/10 pb-5 dark:border-white/15">
        <div>
          <a
            href="/ui/root"
            className="mb-3 inline-flex items-center gap-2 text-sm text-foreground/65 hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Chat
          </a>
          <h1 className="text-2xl font-semibold">Runtime logs</h1>
          <p className="mt-1 text-sm text-foreground/60">
            Development session · latest 500 structured events · resets on server restart
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          In-memory capture
        </div>
      </header>

      <section aria-label="Log controls" className="flex flex-wrap items-center gap-3 border-b border-black/10 py-4 dark:border-white/15">
        <label className="relative min-w-52 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/45"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search events or request IDs"
            aria-label="Search logs"
            className="h-10 w-full border border-black/15 bg-transparent pl-9 pr-3 text-sm outline-none focus:border-emerald-600 dark:border-white/20 dark:focus:border-emerald-400"
          />
        </label>

        <select
          value={eventFilter}
          onChange={(event) => setEventFilter(event.currentTarget.value)}
          aria-label="Filter by event type"
          className="h-10 min-w-48 border border-black/15 bg-background px-3 text-sm outline-none focus:border-emerald-600 dark:border-white/20 dark:focus:border-emerald-400"
        >
          <option value="all">All event types</option>
          {events.map((event) => (
            <option key={event} value={event}>
              {event}
            </option>
          ))}
        </select>

        <label className="flex h-10 items-center gap-2 px-1 text-sm text-foreground/75">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
            className="accent-emerald-600"
          />
          Auto-refresh
        </label>

        <button
          type="button"
          onClick={() => setRefreshVersion((version) => version + 1)}
          aria-label="Refresh logs"
          title="Refresh logs"
          className="inline-flex h-10 w-10 items-center justify-center border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={clearLogs}
          disabled={logs.length === 0}
          aria-label="Clear logs"
          title="Clear logs"
          className="inline-flex h-10 w-10 items-center justify-center border border-black/15 text-red-700 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/20 dark:text-red-400"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </section>

      <div className="flex items-center justify-between gap-4 py-3 text-xs text-foreground/60">
        <span>{filteredLogs.length} shown · {logs.length} retained</span>
        <span>Refreshes every 3 seconds when enabled</span>
      </div>

      {error && (
        <div role="alert" className="mb-3 border border-red-600/30 bg-red-600/5 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <section aria-label="Log events" className="flex-1">
        {filteredLogs.length === 0 ? (
          <div className="border-y border-black/10 py-14 text-center dark:border-white/15">
            <p className="text-sm font-medium">{logs.length ? "No matching events" : "No runtime events yet"}</p>
            <p className="mt-1 text-sm text-foreground/55">
              {logs.length
                ? "Try changing the search or event filter."
                : "Events will appear here as the app handles requests."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-black/10 dark:divide-white/15">
            {filteredLogs.map((entry) => (
              <details key={entry.id} className="group py-3">
                <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_10rem_8rem_8rem]">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[13px] text-foreground">
                      {entry.event}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-foreground/50">
                      {typeof entry.requestId === "string" ? entry.requestId : entry.id}
                    </span>
                  </span>
                  <time className="text-xs tabular-nums text-foreground/60">
                    {new Date(entry.timestamp).toLocaleString()}
                  </time>
                  <span className="text-xs text-foreground/65">
                    {typeof entry.status === "string" ? entry.status : "—"}
                  </span>
                  <span className="text-right text-xs tabular-nums text-foreground/65">
                    {typeof entry.latencyMs === "number" ? `${entry.latencyMs} ms` : "—"}
                  </span>
                </summary>
                <pre className="mt-3 max-h-96 overflow-auto border-l-2 border-emerald-600/50 bg-black/[.03] p-3 text-xs leading-5 text-foreground/80 dark:bg-white/[.04]">
                  {JSON.stringify(entry, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
