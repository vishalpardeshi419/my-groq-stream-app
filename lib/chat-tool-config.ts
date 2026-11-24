export const MAX_TOOL_STEPS = 8;
export const MAX_RUN_TOKENS = 200_000;
export const MAX_RUN_WALL_CLOCK_MS = 25_000;
export const MAX_TOOL_REPAIR_ATTEMPTS = 2;

export function getRunTokenTotal({
  steps,
  previousTokens = 0,
}: {
  steps: ReadonlyArray<{
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    };
  }>;
  previousTokens?: number;
}) {
  const totalTokens = steps.reduce(
    (total, step) =>
      total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
    previousTokens,
  );
  return totalTokens;
}

export function isRunTokenBudgetExceeded({
  steps,
  previousTokens = 0,
}: {
  steps: ReadonlyArray<{
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    };
  }>;
  previousTokens?: number;
}) {
  return getRunTokenTotal({ steps, previousTokens }) >= MAX_RUN_TOKENS;
}
