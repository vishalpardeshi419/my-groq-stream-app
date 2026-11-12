export type ToolExecutionFailure = {
  ok: false;
  error: string;
  repeated?: true;
  previousResult?: unknown;
};

type ToolExecutionErrorReporter = (
  toolName: string,
  error: unknown,
) => void;

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

export function createAgentToolExecutor(
  reportError: ToolExecutionErrorReporter,
) {
  const results = new Map<string, Promise<unknown>>();

  return async function executeTool<Result>(
    toolName: string,
    input: unknown,
    execute: () => Result | Promise<Result>,
  ): Promise<Result | ToolExecutionFailure> {
    const key = `${toolName}:${stableSerialize(input)}`;
    const previous = results.get(key);

    if (previous) {
      return {
        ok: false,
        repeated: true,
        error:
          "You already called this tool with these exact arguments. Use the previous result below and try a different approach.",
        previousResult: await previous,
      };
    }

    const result = Promise.resolve()
      .then(execute)
      .catch((error: unknown): ToolExecutionFailure => {
        reportError(toolName, error);
        return { ok: false, error: getErrorMessage(error) };
      });

    results.set(key, result);
    return result;
  };
}
