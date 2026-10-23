export type RuntimeLogEntry = {
  id: string;
  timestamp: string;
  event: string;
  [key: string]: unknown;
};

const MAX_RUNTIME_LOGS = 500;

declare global {
  var __groqChatRuntimeLogs: RuntimeLogEntry[] | undefined;
}

const runtimeLogs =
  globalThis.__groqChatRuntimeLogs ??
  (globalThis.__groqChatRuntimeLogs = []);

export function storeRuntimeLog(entry: RuntimeLogEntry) {
  if (process.env.NODE_ENV !== "development") return;

  runtimeLogs.push(entry);
  if (runtimeLogs.length > MAX_RUNTIME_LOGS) {
    runtimeLogs.splice(0, runtimeLogs.length - MAX_RUNTIME_LOGS);
  }
}

export function getRuntimeLogs() {
  return runtimeLogs.slice().reverse();
}

export function clearRuntimeLogs() {
  const cleared = runtimeLogs.length;
  runtimeLogs.length = 0;
  return cleared;
}