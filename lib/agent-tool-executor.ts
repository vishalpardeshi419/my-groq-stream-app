import { countTokens } from "gpt-tokenizer/model/gpt-oss-120b";

export type ToolExecutionFailure = {
  ok: false;
  error: string;
  code: string;
  retryable: boolean;
  repeated?: true;
  previousResult?: unknown;
};

export type TruncatedToolOutput = {
  toolOutputTruncated: true;
  originalCharacters: number;
  preview: string;
  message: string;
};

export type ToolExecutionEvent = {
  type: "started" | "retry" | "completed" | "failed" | "timeout" | "compacted";
  toolName: string;
  attempt: number;
  delayMs?: number;
  code?: string;
};

type ToolExecutionErrorReporter = (
  toolName: string,
  error: unknown,
) => void;

type StructuredToolFailure = {
  ok: false;
  error: string;
  code?: string;
  retryable?: boolean;
  repeated?: true;
  previousResult?: unknown;
};

export type ToolExecutorOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  maxOutputTokens?: number;
  retryTimeouts?: boolean;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  injectFault?: (
    toolName: string,
    input: unknown,
    attempt: number,
  ) => unknown | undefined | Promise<unknown | undefined>;
  onEvent?: (event: ToolExecutionEvent) => void;
};

export const DEFAULT_TOOL_TIMEOUT_MS = 8_000;
export const DEFAULT_TOOL_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 4_000;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? String(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getErrorDetails(error: unknown): {
  code: string;
  retryable: boolean;
} {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      retryable?: unknown;
      name?: unknown;
      status?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : candidate.name === "TimeoutError"
          ? "timeout"
          : typeof candidate.status === "number"
            ? `http-${candidate.status}`
            : "tool-error";
    return {
      code,
      retryable:
        candidate.retryable === true ||
        candidate.name === "TimeoutError" ||
        candidate.status === 429 ||
        (typeof candidate.status === "number" && candidate.status >= 500),
    };
  }

  return { code: "tool-error", retryable: false };
}

function isStructuredFailure(value: unknown): value is StructuredToolFailure {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function isRetryableResult(
  value: unknown,
): value is StructuredToolFailure & { retryable: true } {
  return isStructuredFailure(value) && value.retryable === true;
}

function compactToolOutput<Result>(
  value: Result,
  maxOutputTokens: number,
): { value: Result | TruncatedToolOutput; compacted: boolean } {
  const serialized = JSON.stringify(value) ?? String(value);
  if (countTokens(serialized) <= maxOutputTokens) {
    return { value, compacted: false };
  }

  const createCompactValue = (preview: string) => ({
    toolOutputTruncated: true as const,
    originalCharacters: serialized.length,
    preview,
    message:
      "The tool result was shortened to protect the conversation context. Ask for a narrower lookup if more detail is needed.",
  });
  let low = 0;
  let high = serialized.length;
  let compactValue = createCompactValue("");
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = createCompactValue(serialized.slice(0, midpoint));
    if (countTokens(JSON.stringify(candidate)) <= maxOutputTokens) {
      compactValue = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return {
    value: compactValue,
    compacted: true,
  };
}

function createAbortError() {
  return Object.assign(new Error("Tool execution timed out."), {
    name: "TimeoutError",
    code: "timeout",
    retryable: true,
  });
}

function sleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
  });
}

async function runWithTimeout<Result>(
  execute: (signal: AbortSignal) => Result | Promise<Result>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Result> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = createAbortError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => execute(signal)),
      timeout,
      aborted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function getToolFaultInjectorFromEnv(
  env: Record<string, string | undefined> = process.env,
  random: () => number = Math.random,
) {
  const mode = env.AGENT_FAULT_MODE;
  const rate = Number(env.AGENT_FAULT_RATE ?? "0");
  if (
    !["timeout", "http-500", "bloated-output"].includes(mode ?? "") ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1
  ) {
    return undefined;
  }

  return async () => {
    if (random() >= rate) return undefined;
    if (mode === "bloated-output") {
      return {
        type: "bloated-output",
        message:
          "Simulated bloated tool output. This payload is intentionally large for context-compaction tests.",
      };
    }
    if (mode === "http-500") {
      return Object.assign(new Error("Simulated upstream HTTP 500."), {
        code: "http-500",
        status: 500,
        retryable: true,
      });
    }
    return createAbortError();
  };
}

export function createAgentToolExecutor(
  reportError: ToolExecutionErrorReporter,
  options: ToolExecutorOptions = {},
) {
  const results = new Map<string, Promise<unknown>>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_TOOL_MAX_RETRIES;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const maxOutputTokens =
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  return async function executeTool<Result>(
    toolName: string,
    input: unknown,
    execute: (context: { signal: AbortSignal }) => Result | Promise<Result>,
    executionOptions: { maxRetries?: number; signal?: AbortSignal } = {},
  ): Promise<Result | ToolExecutionFailure | TruncatedToolOutput> {
    const key = `${toolName}:${stableSerialize(input)}`;
    const previous = results.get(key);

    if (previous) {
      return {
        ok: false,
        code: "repeated-call",
        retryable: false,
        repeated: true,
        error:
          "You already called this tool with these exact arguments. Use the previous result below and try a different approach.",
        previousResult: await previous,
      };
    }

    const run = async (): Promise<
      Result | ToolExecutionFailure | TruncatedToolOutput
    > => {
      const retries = executionOptions.maxRetries ?? maxRetries;
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        options.onEvent?.({ type: "started", toolName, attempt });
        try {
          const injected = await options.injectFault?.(toolName, input, attempt);
          const result = await runWithTimeout(
            async (signal) => {
              if (injected instanceof Error) throw injected;
              if (
                injected &&
                typeof injected === "object" &&
                "type" in injected &&
                injected.type === "bloated-output"
              ) {
                const output = await execute({ signal });
                const message =
                  "message" in injected &&
                  typeof injected.message === "string"
                    ? injected.message
                    : "Simulated bloated tool output.";
                return {
                  ok: true,
                  originalOutput: output,
                  injected: message,
                  payload: message.repeat(256),
                } as Result;
              }
              return execute({ signal });
            },
            timeoutMs,
            executionOptions.signal,
          );
          if (isRetryableResult(result) && attempt <= retries) {
            const delayMs = Math.min(
              maxBackoffMs,
              backoffBaseMs * 2 ** (attempt - 1),
            ) + Math.floor(random() * jitterMs);
            options.onEvent?.({
              type: "retry",
              toolName,
              attempt,
              delayMs,
              code: result.code,
            });
            await wait(delayMs, executionOptions.signal);
            continue;
          }
          const compacted = compactToolOutput(result, maxOutputTokens);
          if (compacted.compacted) {
            options.onEvent?.({
              type: "compacted",
              toolName,
              attempt,
              code: "output-truncated",
            });
          }
          options.onEvent?.({
            type: isStructuredFailure(compacted.value) ? "failed" : "completed",
            toolName,
            attempt,
            ...(isStructuredFailure(compacted.value)
              ? { code: compacted.value.code }
              : {}),
          });
          return isStructuredFailure(compacted.value)
            ? {
                ...compacted.value,
                retryable: compacted.value.retryable === true,
                code: compacted.value.code ?? "tool-error",
              }
            : compacted.value;
        } catch (error) {
          reportError(toolName, error);
          const details = getErrorDetails(error);
          const timedOut = details.code === "timeout";
          options.onEvent?.({
            type: timedOut ? "timeout" : "failed",
            toolName,
            attempt,
            code: details.code,
          });
          const retryable =
            details.retryable &&
            (options.retryTimeouts !== false || !timedOut);
          if (retryable && attempt <= retries) {
            const delayMs = Math.min(
              maxBackoffMs,
              backoffBaseMs * 2 ** (attempt - 1),
            ) + Math.floor(random() * jitterMs);
            options.onEvent?.({
              type: "retry",
              toolName,
              attempt,
              delayMs,
              code: details.code,
            });
            await wait(delayMs, executionOptions.signal);
            continue;
          }
          return {
            ok: false,
            error: timedOut
              ? `Tool execution timed out after ${timeoutMs} ms.`
              : getErrorMessage(error),
            code: details.code,
            retryable,
          };
        }
      }

      return {
        ok: false,
        error: "Tool execution failed after the retry limit.",
        code: "retry-exhausted",
        retryable: false,
      };
    };

    const result = run();
    results.set(key, result);
    return result;
  };
}
